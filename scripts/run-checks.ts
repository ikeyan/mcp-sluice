/**
 * run-checks.ts — verify.sh の検査の段を並行に回す。verify.sh が hook を揃えた後に exec で起動する。
 *
 * 流れ:
 * 1. 段より前の確かめ。外れたものを全部出して、段の前で exit 1 する。
 *    - git が知るファイルの一覧と、その名前 (下の「名前」)。
 *    - 作業ツリーに無い追跡ファイル (`git ls-files --deleted`)。deno lint はその名前を黙って飛ばす (canon: facts/deno/missing-file-args)。deno lint が存在しない引数を error にするようになったら外せる。
 *    - deno と shellcheck の版 (下の「版」)。
 * 2. 段 (下の steps) を回し、全部を待つ。段が共有して書くのは deno の cache (DENO_DIR) だけ。deno.lock は `--frozen-lockfile` で読むだけ。
 * 3. 段の出力を steps の順に出す。
 *    - 通った段: 見出しと標準出力を stdout へ、標準エラーを stderr へ。
 *    - 落ちた段: 見出しと両方を stderr へ。
 *    - 書き込みは 1 つずつ行い、失敗しても残りを出す。
 *      - BrokenPipe (`./verify.sh | head`。canon: facts/deno/stdout-broken-pipe): 終了コードを変えない。
 *      - 他の失敗 (`> /dev/full` など): 理由を stderr に出し、exit 1。
 * 4. どれかの段が落ちたか、引数が 1 なら exit 1。
 *
 * 段の子のプロセスグループ:
 * - 子は各自のプロセスグループで起動し (Deno.Command の detached。canon: facts/deno/command-spawn)、exec は正常終了でも中断でも、戻る前にグループを空にする (emptyGroup)。先頭が終わった後に残る孫も、段が終わる前に止まる。自分で setsid してグループを抜けた子孫は止めない。
 * - exec が待つものと、その上限:
 *   - 先頭の終わり: 上限を置かない (段の実行そのもの)。中断では emptyGroup の SIGKILL で終わる。
 *   - emptyGroup: SIGTERM の後、先頭の終わりと出力の pipe が閉じるのを graceMs まで待つ。SIGKILL の後の先頭の回収は、SIGKILL を捕まえられないので返る。
 *   - 出力の pipe: emptyGroup の後、graceMs まで待つ。閉じなければ読み端を cancel し (読めた分が返る。canon: facts/deno/command-spawn の「出力の pipe を持ったまま残る子孫と、読み端の cancel」)、その子を「pipe が閉じない」の失敗にする。
 * - pipe の書き端を持ちうるもの: 先頭 (終われば閉じる)、グループの中の子孫 (emptyGroup が止める)、グループを抜けた子孫 (止めない。cancel の後の書き込みは EPIPE になる)。
 * - 状態 (groups):
 *   - 対象: exec が起動した子のプロセスグループ。起動から emptyGroup の終わりまで記録する。
 *   - 鍵: 子 (pgid は子の pid)。
 *   - 等しいとみなす条件: 同じ exec の呼び出し。
 *
 * 中断 (SIGHUP・SIGINT・SIGTERM。終了コードは 128 + シグナルの番号で、下の signals):
 * - 最初の 1 回で、記録している全部のグループを同時に空にし、deno test の段の TMPDIR を消し、そのシグナルの終了コードで終わる。TMPDIR を消せなければ、理由を stderr に出してから同じ終了コードで終わる。
 * - 終了を決めるのはこの経路だけ。中断の後の本流は何も出さず、この経路の exit を待つ。
 * - 2 回目以降のシグナルは何もしない。
 * - 中断の後は子を起動しない。
 * - 中断の時点ごとの扱い (run-checks_test.ts が固定する):
 *   - 段より前 (git ls-files などの最中): その子のグループを空にして終わる。
 *   - 段の最中: 全部の段のグループを空にし、TMPDIR を消して終わる。
 *   - 先頭は SIGTERM で終わったが、孫が残っている: 孫は猶予の後の SIGKILL で止まる。
 *   - SIGTERM を無視するもの: 猶予の後の SIGKILL で止まる。
 *
 * deno test の段の TMPDIR:
 * - TMPDIR の下にこのプロセスが作ったディレクトリを段の TMPDIR にし、段の後と中断で消す。
 * - test が中断で消さずに終わる一時ディレクトリ (canon: facts/deno/test-signal-listeners) を、これで消す。
 * - 外せる条件: deno test が SIGTERM で finally を回し、SIGINT でも test の後始末を終えてから終わるようになったとき。
 *
 * 入力と環境の定義域:
 * - 引数は 1 つで、verify.sh が hook を揃えた結果 (0 か 1)。外れていれば理由を出して exit 1。
 * - 環境変数 TMPDIR: verify.sh が symlink を解決した絶対パスを渡す。空なら理由を出して exit 1。
 * - cwd はリポのルート。読むファイルは deno.json だけ。書くのは TMPDIR の下だけ。許可は verify.sh が渡す。
 * - 環境はそのまま段の子に渡す。差し替えるのは次だけ:
 *   - deno test の段: TMPDIR。
 *   - shellcheck (段と版の確かめ): SHELLCHECK_OPTS を消し、`--norc` を付ける。shellcheck は引数の他に SHELLCHECK_OPTS と .shellcheckrc (script の dir とその親、HOME、XDG_CONFIG_HOME) を読み (canon: facts/shellcheck/environment-and-config-inputs)、利用者の指定で手元と CI の結果が分かれる。リポの .shellcheckrc も読まないので、directive は各 script に書く。
 * - git の場所を決める環境変数 (canon: facts/git/local-env-vars-and-hook-env) は verify.sh が消してから起動するので、git は cwd のリポを見る。
 * - 版:
 *   - deno: denoRange (下の定数)。このプロセスを動かす deno を見る (段の子も同じ PATH で引く)。
 *   - shellcheck: shellcheckVersion だけ。版で出す指摘が違う (canon: facts/shellcheck/sc2015-version-difference)。
 *   - git: verify.sh の事前条件 (verify.sh が確かめる)。
 *   - 範囲を広げる・版を上げるとき: 次を新しい版で測り直し、同じ commit で .github/workflows/verify.yml・AGENTS.md・この定数を揃える。
 *     - このファイルが引く canon の事実。
 *     - deno lint の `--rules-tags=` (空の値) の挙動と、deno info --json の形 (どちらも下の「deno lint」「deno.json の imports」)。
 * - 名前: git が知るファイル (追跡と、無視されない未追跡) を -z で受ける (canon: facts/git/path-output-quoting)。次の述語を全部満たす名前だけを処理する。外れる名前が 1 つでもあれば、理由と名前 (バイトを escape したもの) を出して、段の前で落ちる。
 *   - UTF-8 として正しい。不正な名前はコマンドへ渡す引数 (文字列) で表せない。
 *   - 改行を含まない。
 *   - `*`・`?` を含まない。deno check・fmt・lint・test は引数の `*`・`?` を glob として展開し、git が知らないファイルまで検査する。エスケープの手段は無い (canon: facts/deno/check-file-args-glob、facts/deno/lint-file-args-and-rules)。deno がファイルの引数を文字どおりに受ける手段を持てば、この述語は外せる。
 *   - `/` で終わらない。未追跡の入れ子のリポジトリは `nested/` の形で出る (canon: facts/git/untracked-entry-kinds)。
 * - 名前の渡し方:
 *   - shellcheck・git・deno (check-json-md.ts を除く): 名前に `./` を前置する。先頭の `-` (option)・`!` (deno の除外)・`npm:` など (deno の URL) が名前として読まれる。deno check は `--` の後の名前を無視して cwd 全体を検査する (canon: facts/deno/check-double-dash)。
 *   - check-json-md.ts: 名前を全部、そのまま渡す (canon: facts/deno/run-args-passthrough)。check-json-md.ts はこのファイルの隣のものを起動する。
 * - 拡張子で対象を決める: shellcheck は `*.sh`、deno は `*.ts` (test は `*_test.ts`)。拡張子の無い shell は検査しないので、このリポの shell は `*.sh` と名付ける。対象が無い段は通す (shellcheck は引数が無いと落ちる。canon: facts/shellcheck/no-files-argument)。
 * - deno lint は cwd の deno.json の lint 設定を読む (canon: facts/deno/lint-file-args-and-rules)。この段は deno.json に lint の設定が無いことを前提にし、規則を no-unused-vars 1 つに絞る。recommended は deno の版で規則が増え、コードを変えていない CI が落ちうるため。足すときは `--rules-include` を足す。
 *   - `--rules-tags=` (空の値) で recommended を外せるのは、文書に無い実測の挙動。この段の試験 (run-checks_test.ts) が固定し、deno の版を上げたら測り直す。recommended に戻すのは、版を上げて増えた規則の修正が済んだとき。
 * - deno test の許可:
 *   - write: 段の TMPDIR だけ (canon: facts/deno/make-temp-dir-permissions)。Deno.symlink は絞らない write を要る (canon: facts/deno/symlink-requires-unscoped-permissions) ので、test は symlink を ln -s で作る。
 *   - read・env・run: 絞らない。test はリポのファイル (verify.sh・hooks/pre-push など) を読み、環境を丸ごと子に渡し、verify.sh・run-checks.ts・check-json-md.ts と PATH を差し替えた fake を子として起動する。
 *   - 外せる条件: `--allow-run=deno` で、差し替えた PATH の dir の deno を起動できるようになったら (canon: facts/deno/allow-run-name-with-child-path)、run を起動するものに絞る。
 * - deno.json の imports の各キー (importKeys 段): git が知る .ts のそれぞれに `deno info --json` を回し (canon: facts/deno/info-json-dependencies)、graph の esm の module (相対 import で辿った先を含む) の dependencies[].specifier のどれかと一致するとき使われているとみなす。末尾が / のキーは、指定子がその接頭辞のときも使われているとみなす。
 *   - 指定子に入る構文: 静的 import (`import x from "a"`・`import "a"`)、`export … from "a"`、`import type`、リテラルの動的 import (`import("a")`)。入らないもの: コメント・文字列の中、`/// <reference>`、JSDoc の `@import`、リテラルでない動的 import。
 *   - deno info --json の形 (modules[].dependencies[].specifier・modules[].error) は文書の schema が無い。この段の試験が固定し、deno の版を上げたら測り直す。
 *   - deno info は `--no-config` (deno.json を読まない)・`--no-lock` (deno.lock を読み書きしない)・`--no-npm`・`--no-remote` (ネットワークに出ない) で回す。指定子は書かれた文字列のまま出る。
 *   - deno info が落ちるか、graph の file: の module に error (ファイルが無い、構文が壊れている、相対 import 先が無い。deno info は exit 0) があれば、それを報告して落ちる。
 *   - 数える参照は .ts の import の指定子だけ。
 */

const self = "run-checks.ts";
const dec = new TextDecoder();
const enc = new TextEncoder();

if (Deno.args.length !== 1 || !["0", "1"].includes(Deno.args[0])) {
  console.error(
    `${self}: 引数は hook を揃えた結果 (0 か 1) の 1 つだけ。./verify.sh から起動する (${
      Deno.args.join(" ")
    })`,
  );
  Deno.exit(1);
}
const tmpdir = Deno.env.get("TMPDIR");
if (!tmpdir) {
  console.error(`${self}: TMPDIR が空。./verify.sh から起動する`);
  Deno.exit(1);
}

interface Run {
  code: number;
  out: Uint8Array;
  err: Uint8Array;
}

const fail = (message: string): Run => ({
  code: 1,
  out: new Uint8Array(),
  err: enc.encode(`${message}\n`),
});
const pass = (message: string): Run => ({
  code: 0,
  out: enc.encode(`${message}\n`),
  err: new Uint8Array(),
});

/** deno test の段の TMPDIR。 */
let testTmp: string | undefined;
let testTmpRemoval: Promise<void> | undefined;
/** 並行に 2 回消さないように、2 回目以降の呼び出しには同じ Promise を返す。 */
function removeTestTmp(): Promise<void> {
  if (testTmp === undefined) return Promise.resolve();
  return testTmpRemoval ??= Deno.remove(testTmp, { recursive: true });
}

/** 受けるシグナルと、それで終わるときの終了コード。 */
const signals: [Deno.Signal, number][] = [
  ["SIGHUP", 129],
  ["SIGINT", 130],
  ["SIGTERM", 143],
];
const groups = new Set<() => Promise<void>>();
const killGroup = (child: Deno.ChildProcess, signal: Deno.Signal) => {
  try {
    Deno.kill(-child.pid, signal);
  } catch (e) {
    // ESRCH: グループに誰も残っていない
    if (e instanceof Deno.errors.NotFound) return;
    // EPERM: macOS で終わりかけのものだけのグループでだけ観測した (canon: facts/deno/command-spawn の「Deno.kill」)。機構は未確認。macOS が EPERM を返さなくなったら外せる
    if (
      Deno.build.os === "darwin" && e instanceof Deno.errors.PermissionDenied
    ) return;
    throw e;
  }
};
/** SIGTERM の後に先頭の終わりと出力の pipe が閉じるのを待つ上限と、emptyGroup の後に pipe が閉じるのを待つ上限。 */
const graceMs = 2000;
/** p が ms 以内に決着すれば true。 */
async function settlesWithin(p: Promise<unknown>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p.then(() => true, () => true),
      new Promise<boolean>((r) => timer = setTimeout(() => r(false), ms)),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function emptyGroup(
  child: Deno.ChildProcess,
  outputs: Promise<unknown>,
) {
  // SIGTERM の送信が投げても SIGKILL を送る
  try {
    killGroup(child, "SIGTERM");
    await settlesWithin(Promise.allSettled([child.status, outputs]), graceMs);
  } finally {
    try {
      killGroup(child, "SIGKILL");
    } finally {
      await child.status;
    }
  }
}
/** 中断が始まっていれば、その経路 (解決しない)。 */
let interruption: Promise<never> | undefined;
for (const [signal, code] of signals) {
  Deno.addSignalListener(signal, () => {
    interruption ??= (async () => {
      await Promise.allSettled([...groups].map((empty) => empty()));
      try {
        await removeTestTmp();
      } catch (e) {
        console.error(
          `${self}: deno test の段の TMPDIR (${testTmp}) を消せない。手で消す — ${
            e instanceof Error ? e.message : e
          }`,
        );
      }
      Deno.exit(code);
    })();
  });
}
/** 中断が始まっていれば、その経路の exit を待つ (戻らない)。 */
const unlessInterrupted = async () => {
  if (interruption) await interruption;
};

/** 子の環境の、このプロセスの環境からの差分。 */
interface EnvChange {
  set?: Record<string, string>;
  unset?: string[];
}

const concat = (chunks: Uint8Array[]) => {
  const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let i = 0;
  for (const c of chunks) {
    all.set(c, i);
    i += c.length;
  }
  return all;
};

/** 閉じるか cancel されるまで読む。Response の読みは cancel できない (canon: facts/deno/command-spawn の「出力の pipe を持ったまま残る子孫と、読み端の cancel」)。 */
async function readAll(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return concat(chunks);
    chunks.push(value);
  }
}

/** 子を自分のプロセスグループで起動し、終わってグループを空にするまで待つ。 */
async function exec(
  cmd: string,
  args: string[],
  { set = {}, unset = [] }: EnvChange = {},
): Promise<Run> {
  if (interruption) throw new Error("中断した");
  const env = Deno.env.toObject();
  for (const name of unset) delete env[name];
  const child = new Deno.Command(cmd, {
    args,
    env: { ...env, ...set },
    clearEnv: true,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    detached: true,
  }).spawn();
  const readers = [child.stdout.getReader(), child.stderr.getReader()];
  const outputs = Promise.all(readers.map(readAll));
  // 待つまでに reject すると unhandled rejection でこのプロセスが落ち、グループが残る
  outputs.catch(() => {});
  let emptied: Promise<void> | undefined;
  // 中断の経路と exec の finally の両方が呼ぶので、2 回目以降は同じ Promise を返す
  const empty = () => emptied ??= emptyGroup(child, outputs);
  groups.add(empty);
  try {
    const { code } = await child.status;
    await empty();
    const closed = await settlesWithin(outputs, graceMs);
    if (!closed) await Promise.all(readers.map((r) => r.cancel()));
    const [out, err] = await outputs;
    return closed ? { code, out, err } : {
      code: 1,
      out,
      err: concat([
        err,
        enc.encode(
          `${self}: ${cmd} の出力の pipe が閉じない (グループを抜けた子孫が保持している)\n`,
        ),
      ]),
    };
  } finally {
    try {
      await empty();
    } finally {
      groups.delete(empty);
    }
  }
}

/** 印字できる ASCII (空白と \ を除く) の他のバイトを \xHH にする。 */
const escapeBytes = (b: Uint8Array) =>
  Array.from(
    b,
    (c) =>
      c > 0x20 && c < 0x7f && c !== 0x5c
        ? String.fromCharCode(c)
        : `\\x${c.toString(16).padStart(2, "0")}`,
  ).join("");

const splitNul = (b: Uint8Array): Uint8Array[] => {
  const names: Uint8Array[] = [];
  for (let i = 0; i < b.length;) {
    const end = b.indexOf(0, i);
    const name = b.subarray(i, end < 0 ? b.length : end);
    names.push(name);
    i += name.length + 1;
  }
  return names;
};

/** git が知るファイルの一覧。files は problems が空のときだけ使う。 */
interface Listing {
  files: string[];
  problems: string[];
}

async function gitFiles(): Promise<Listing> {
  const r = await exec("git", [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  ]);
  if (r.code !== 0) {
    return {
      files: [],
      problems: [`git ls-files が exit ${r.code}\n${dec.decode(r.err)}`],
    };
  }
  const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const files: string[] = [];
  const rejected: Uint8Array[] = [];
  for (const name of splitNul(r.out)) {
    try {
      const f = utf8.decode(name);
      if (/[\n*?]|\/$/.test(f)) rejected.push(name);
      else files.push(f);
    } catch (e) {
      if (!(e instanceof TypeError)) throw e;
      rejected.push(name);
    }
  }
  return {
    files,
    problems: rejected.length
      ? [
        `処理できない名前のファイルがある (UTF-8 として不正、改行を含む、deno が glob として展開する * か ? を含む、/ で終わる入れ子のリポジトリ)。名前を変えるか、消すか、.gitignore に足す: ${
          rejected.map(escapeBytes).join(" ")
        }`,
      ]
      : [],
  };
}

/** 段より前の確かめの、外れたものの理由。 */
type Problems = string[];

async function deletedFiles(): Promise<Problems> {
  const r = await exec("git", ["ls-files", "-z", "--deleted"]);
  if (r.code !== 0) {
    return [`git ls-files --deleted が exit ${r.code}\n${dec.decode(r.err)}`];
  }
  const names = splitNul(r.out);
  return names.length
    ? [
      `作業ツリーに無い追跡ファイルがある。戻すか git rm する: ${
        names.map(escapeBytes).join(" ")
      }`,
    ]
    : [];
}

const denoMinor = "2.9";
const denoMinPatch = 7;
const denoRange = `${denoMinor}.x (x は ${denoMinPatch} 以上)`;
function denoVersion(): Promise<Problems> {
  const v = Deno.version.deno;
  const patch = v.startsWith(`${denoMinor}.`)
    ? v.slice(denoMinor.length + 1)
    : undefined;
  const ok = patch !== undefined && /^\d+$/.test(patch) &&
    Number(patch) >= denoMinPatch;
  return Promise.resolve(
    ok ? [] : [
      `deno の版が ${v} で、${denoRange} でない。.github/workflows/verify.yml の deno-version の版を入れる: deno upgrade --version <その版>`,
    ],
  );
}

const shellcheckVersion = "0.11.0";
const shellcheckEnv: EnvChange = { unset: ["SHELLCHECK_OPTS"] };
const shellcheckInstall = [
  `shellcheck ${shellcheckVersion} を PATH の先に置く:`,
  `- https://github.com/koalaman/shellcheck/releases/tag/v${shellcheckVersion} から OS と CPU に合う shellcheck-v${shellcheckVersion}.<os>.<arch>.tar.xz を取り、展開した shellcheck を PATH の先のディレクトリ (~/.local/bin など) に置く。Linux の x86_64 は .github/workflows/verify.yml の shellcheck の手順と同じ (sha256 もそこにある)。`,
  `- macOS は、Homebrew の版が ${shellcheckVersion} なら brew install shellcheck でもよい。`,
  `- 置いたら shellcheck --version で確かめる。`,
].join("\n");
async function shellcheckProbe(): Promise<Problems> {
  const problem = (message: string): Problems => [
    `${message}\n${shellcheckInstall}`,
  ];
  let probe: Run;
  try {
    probe = await exec("shellcheck", ["--norc", "--version"], shellcheckEnv);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
    return problem("shellcheck が PATH に無い。");
  }
  if (probe.code !== 0) {
    return problem(
      `shellcheck --version が exit ${probe.code}\n${dec.decode(probe.err)}`,
    );
  }
  const actual = dec.decode(probe.out).match(/^version: (.*)$/m)?.[1];
  if (actual === undefined) {
    return problem(
      `shellcheck --version の出力に version: の行が無い\n${
        dec.decode(probe.out)
      }`,
    );
  }
  if (actual !== shellcheckVersion) {
    return problem(
      `shellcheck の版が ${actual} で、${shellcheckVersion} でない。`,
    );
  }
  return [];
}

const describe = (e: unknown) =>
  e instanceof Error ? e.stack ?? String(e) : String(e);
const [listing, others] = await Promise.all([
  gitFiles().catch((e): Listing => ({ files: [], problems: [describe(e)] })),
  Promise.all(
    [deletedFiles, denoVersion, shellcheckProbe].map((check) =>
      check().catch((e): Problems => [describe(e)])
    ),
  ),
]);
await unlessInterrupted();
const preProblems = [...listing.problems, ...others.flat()];
if (preProblems.length) {
  console.error(
    preProblems.map((p) => `${self}: ${p}`).join("\n") +
      "\n検査の段は回していない",
  );
  Deno.exit(1);
}
const files = listing.files;
const withExt = (ext: string) => files.filter((f) => f.endsWith(ext));
const dotSlash = (f: string) => `./${f}`;
const ts = withExt(".ts");
const tests = ts.filter((f) => f.endsWith("_test.ts"));
const frozen = "--frozen-lockfile";
if (tests.length) {
  // 中断の経路が作りかけを見落とさないように、同期で作る
  testTmp = Deno.makeTempDirSync({ dir: tmpdir, prefix: "run-checks-" });
}

const onFiles = (
  cmd: string,
  args: string[],
  targets: string[],
  env?: EnvChange,
) =>
  targets.length
    ? exec(cmd, [...args, ...targets.map(dotSlash)], env)
    : Promise.resolve(pass("対象のファイルが無い"));

/** deno.json の imports の各キーが、.ts の import の指定子から使われていること。 */
async function importKeys(): Promise<Run> {
  const keys = Object.keys(
    JSON.parse(await Deno.readTextFile("deno.json")).imports ?? {},
  );
  const infos = await Promise.all(ts.map(async (f) => ({
    f,
    r: await exec("deno", [
      "info",
      "--json",
      "--no-config",
      "--no-lock",
      "--no-npm",
      "--no-remote",
      dotSlash(f),
    ]),
  })));
  const problems: string[] = [];
  const specifiers = new Set<string>();
  for (const { f, r } of infos) {
    if (r.code !== 0) {
      problems.push(`${f}: deno info が exit ${r.code}\n${dec.decode(r.err)}`);
      continue;
    }
    for (const m of JSON.parse(dec.decode(r.out)).modules) {
      if (m.error && m.specifier.startsWith("file:")) {
        problems.push(`${f}: ${m.specifier}: ${m.error}`);
      }
      for (const d of m.dependencies ?? []) specifiers.add(d.specifier);
    }
  }
  if (problems.length) {
    problems.push(
      "deno.json: 指定子の一覧が欠けるので、imports の未使用の判定はしていない。上を直してから回す",
    );
    return fail(problems.join("\n"));
  }
  const unused = keys.filter((key) =>
    ![...specifiers].some((s) =>
      s === key || (key.endsWith("/") && s.startsWith(key))
    )
  );
  return unused.length
    ? fail(
      unused.map((key) =>
        `deno.json: imports の "${key}" がどの .ts からも使われていない。使うか deno.json から消す`
      ).join("\n"),
    )
    : pass(`ok: imports ${keys.length} 件、.ts ${ts.length} 件`);
}

async function denoTest(): Promise<Run> {
  if (tests.length === 0) return pass("対象のファイルが無い");
  if (testTmp === undefined) throw new Error("deno test の段の TMPDIR が無い");
  try {
    return await onFiles(
      "deno",
      [
        "test",
        frozen,
        "--allow-read",
        `--allow-write=${testTmp}`,
        "--allow-env",
        "--allow-run",
      ],
      tests,
      { set: { TMPDIR: testTmp } },
    );
  } finally {
    await removeTestTmp();
  }
}

const steps: [string, () => Promise<Run>][] = [
  [
    "shellcheck",
    () =>
      onFiles(
        "shellcheck",
        ["--norc"],
        withExt(".sh"),
        shellcheckEnv,
      ),
  ],
  ["deno fmt", () => onFiles("deno", ["fmt", "--check"], ts)],
  [
    "deno lint",
    () =>
      onFiles("deno", [
        "lint",
        "--rules-tags=",
        "--rules-include=no-unused-vars",
      ], ts),
  ],
  ["deno check", () => onFiles("deno", ["check", frozen], ts)],
  ["deno test", denoTest],
  ["deno.json の imports", importKeys],
  [
    "JSON と Markdown",
    () =>
      exec("deno", [
        "run",
        frozen,
        "--allow-read=.",
        import.meta.resolve("./check-json-md.ts"),
        ...files,
      ]),
  ],
];

const results = await Promise.all(
  steps.map(async ([name, run]) => ({
    name,
    ...await run().catch((e): Run => fail(describe(e))),
  })),
);
await unlessInterrupted();

const writeErrors = new Set<string>();
const write = (
  name: string,
  w: { writeSync(p: Uint8Array): number },
  data: Uint8Array,
) => {
  try {
    for (let i = 0; i < data.length;) i += w.writeSync(data.subarray(i));
  } catch (e) {
    if (e instanceof Deno.errors.BrokenPipe) return;
    writeErrors.add(
      `${name} に書けない — ${e instanceof Error ? e.message : e}`,
    );
  }
};
const out = (data: Uint8Array) => write("stdout", Deno.stdout, data);
const err = (data: Uint8Array) => write("stderr", Deno.stderr, data);
for (const r of results) {
  if (r.code === 0) {
    out(enc.encode(`== ${r.name}: 通った\n`));
    out(r.out);
    err(r.err);
  } else {
    err(enc.encode(`== ${r.name}: 落ちた (exit ${r.code})\n`));
    err(r.out);
    err(r.err);
  }
}
for (const message of writeErrors) err(enc.encode(`${self}: ${message}\n`));
Deno.exit(
  Deno.args[0] === "1" || writeErrors.size > 0 ||
    results.some((r) => r.code !== 0)
    ? 1
    : 0,
);
