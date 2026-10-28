/**
 * run-checks.ts — verify.sh の検査の段を並行に回す。verify.sh が hook を揃えた後に exec で起動する。
 *
 * 流れ:
 * 1. 段より前の確かめ。外れたものを全部出して、段の前で exit 1 する。
 *    - git が知る項目と、その種類と名前 (下の「名前」)。
 *    - 作業ツリーに無い追跡ファイル (`git ls-files --deleted`)。deno lint はその名前を黙って飛ばす (canon: facts/deno/missing-file-args)。deno lint が存在しない引数を error にするようになったら外せる。
 *    - deno と shellcheck の版 (下の「版」)。
 * 2. 段 (下の steps) を回し、全部を待つ。段が共有して書くのは deno の cache (DENO_DIR) だけ。deno.lock は `--frozen-lockfile` で読むだけ。
 * 3. 段の出力を steps の順に出す。
 *    - 通った段: 見出しと標準出力を stdout へ、標準エラーを stderr へ。
 *    - 落ちた段: 見出しと両方を stderr へ。
 *    - 書き込みは 1 つずつ行い、失敗しても残りを出す。
 *      - BrokenPipe (`./verify.sh | head`。canon: facts/deno/stdout-broken-pipe): 終了コードを変えない。
 *      - 他の失敗 (`/dev/full`、ファイルの大きさの上限など。canon: facts/deno/stdout-write-error-kinds): 理由を stderr に出し、exit 1。
 * 4. どれかの段が落ちたか、引数が 1 (下の「入力と環境の定義域」) なら exit 1。
 *
 * 段の子のプロセスグループ:
 * - 子は各自のプロセスグループで起動し (Deno.Command の detached。canon: facts/deno/command-spawn)、exec は正常終了でも中断でも、戻る前にグループに SIGTERM と SIGKILL を送る (emptyGroup)。
 *   - 先頭が終わった後に残る孫も、段が終わる前に止まる。
 *   - 自分で setsid してグループを抜けた子孫は止めない。
 *   - Linux では、この uid で送れない子孫 (別の uid のもの) は止まらない。グループの中に送れたものが 1 つでもあれば kill は通るので、残ったことも検出しない (canon: facts/deno/command-spawn の「別の uid のグループへの kill」)。
 * - グループを空にできない (kill が投げる。別の uid のものだけが残ったグループなど) とき: emptyGroup が pgid と止め方 (`kill -KILL -- -<pgid>`) を含むエラーを投げる。
 *   - 通常の経路では、その段がその文言で落ちる。
 *   - そのグループの記録は消さないので、後で中断しても、中断の経路が同じ文言を出す。
 * - exec が待つものと、その上限:
 *   - 先頭の終わり: 上限を置かない (段の実行そのもの)。中断では emptyGroup の SIGKILL で終わる。
 *   - emptyGroup: SIGTERM の後、先頭の終わりと出力の pipe が閉じるのを graceMs まで待つ。SIGKILL の後の先頭の回収は、SIGKILL を捕まえられないので返る。
 *   - 出力の pipe: emptyGroup の後、graceMs まで待つ。閉じなければ読み端を cancel し (読めた分が返る。canon: facts/deno/command-spawn の「出力の pipe を持ったまま残る子孫と、読み端の cancel」)、その子を「pipe が閉じない」の失敗にする。
 * - pipe の書き端を持ちうるもの:
 *   - 先頭: 終われば閉じる。
 *   - グループの中の子孫: emptyGroup が止める。
 *   - グループを抜けた子孫: 止めない。cancel の後の書き込みは EPIPE になる。
 * - 状態 (groups):
 *   - 対象: exec が起動した子のプロセスグループ。起動から、emptyGroup が成功するまで記録する。
 *   - 鍵: pgid (子の pid)。
 *   - 等しいとみなす条件: 同じ exec の呼び出し。
 *
 * 中断 (SIGHUP・SIGINT・SIGTERM。終了コードは 128 + シグナルの番号で、下の signals):
 * - 最初の 1 回で、次の後始末をしてから、そのシグナルの終了コードで終わる。後始末が失敗したら、理由と手で直す方法を stderr に出して次へ進む。
 *   1. 記録している全部のグループを同時に空にする。失敗の文言は emptyGroup のもの (上の「段の子のプロセスグループ」)。
 *   2. deno test の段の TMPDIR を消す。失敗するのは、消せないものがあるとき (グループを抜けた子孫が書き続けているなど)。
 * - 終了を決めるのはこの経路だけ。中断の後の本流は何も出さず、この経路の exit を待つ。
 * - 2 回目以降のシグナルは何もしない。
 * - 中断の後は子を起動しない。
 * - 中断の時点ごとの扱い (run-checks_test.ts が固定する):
 *   - 段より前 (git ls-files などの最中): その子のグループを空にして終わる。
 *   - 先頭は SIGTERM で終わったが、孫が残っている: 孫は猶予の後の SIGKILL で止まる。
 *   - SIGTERM を無視するもの: 猶予の後の SIGKILL で止まる。
 *
 * deno test の段の TMPDIR:
 * - TMPDIR の下にこのプロセスが作ったディレクトリを段の TMPDIR にし、段の後と中断で消す。
 * - test が中断で消さずに終わる一時ディレクトリ (canon: facts/deno/test-signal-listeners) を、これで消す。
 * - 外せる条件: deno test が SIGTERM で finally を回し、SIGINT でも test の後始末を終えてから終わるようになったとき。
 *
 * 入力と環境の定義域:
 * - 引数は 1 つで、verify.sh が hook を揃えた結果。外れていれば理由を出して exit 2。
 *   - 0: 揃えた。
 *   - 1: 揃えられなかった (理由は verify.sh が出した)。段は回し、最後に exit 1。
 * - 環境変数 TMPDIR: verify.sh が symlink を解決した絶対パスを渡す。空なら理由を出して exit 2。
 * - cwd はリポのルート。読むファイルは deno.json だけ。書くのは TMPDIR の下だけ。許可は verify.sh が渡す。
 * - 環境はそのまま段の子に渡す。差し替えるのは次だけ:
 *   - git (git()): git の場所を決める変数 (git rev-parse --local-env-vars の一覧。canon: facts/git/local-env-vars-and-hook-env) を消す。git は cwd のリポを見る。一覧は、どの環境でも同じものを出す (canon の同じページ) ので、このプロセスの環境のまま聞く。
 *   - deno (deno()): 検査の結果を変える変数 (canon: facts/deno/environment-and-config-inputs の「結果を変える」) を消し、DENO_NO_PACKAGE_JSON=1 を渡す。同じ canon の「取得だけを変える」「出力の形だけ」の変数は残す。
 *     - deno test の段は、さらに TMPDIR を差し替える。
 *     - リポの祖先に、このリポを workspace の member に含む deno.json があると、deno はその設定を読む。flag で止められず、検出もしない (同じ canon の「設定ファイル」)。
 *   - shellcheck (shellcheck()。段と版の確かめ): SHELLCHECK_OPTS を消し、`--norc` を付ける。
 *     - shellcheck は引数の他に SHELLCHECK_OPTS と .shellcheckrc を読み (canon: facts/shellcheck/environment-and-config-inputs)、利用者の指定で手元と CI の結果が分かれる。
 *     - リポの .shellcheckrc も読まないので、directive は各 script に書く。
 * - 版:
 *   - deno: denoMinor と denoMinPatch (下の定数) の 2.<minor>.<patch> で、patch が denoMinPatch 以上。このプロセスを動かす deno を見る (段の子も同じ PATH で引く)。
 *   - shellcheck: shellcheckVersion だけ。版で出す指摘が違う (canon: facts/shellcheck/sc2015-version-difference)。
 *   - git: verify.sh の事前条件 (verify.sh が確かめる)。
 *   - 範囲を広げる・版を上げるとき:
 *     1. 次を新しい版で測り直す。このファイルが引く canon の事実と、deno info --json の形 (下の「deno.json の imports」)。
 *     2. deno lint の recommended に増えた規則の指摘を直す。
 *     3. 同じ commit で .github/workflows/verify.yml とこの定数を揃える。
 * - 名前: git が知る項目を -z で受ける (canon: facts/git/path-output-quoting)。
 *   - 追跡された項目は `git ls-files -s -t --cached` で種類も受け、次の全部を満たすものだけを処理する (canon: facts/git/repository-shapes の「作業ツリーの項目」)。
 *     - 通常ファイル (mode 100644・100755)。symlink (120000) は、deno がリンク先 (ディレクトリならその中の git の知らない .ts) まで検査する。gitlink (160000) はサブモジュールで、検査する対象でない。
 *     - skip-worktree でない (tag が S でない)。作業ツリーから消えていても `--deleted` に出ない。
 *     - 解決していない merge の項目でない (stage が 0)。
 *   - 未追跡の項目は `git ls-files --others --exclude-standard` で名前だけを受ける。種類は受けないので、下の名前の述語だけで決める (未追跡の symlink は通る)。
 *   - 名前は次の全部を満たすこと。
 *     - UTF-8 として正しい。不正な名前はコマンドへ渡す引数 (文字列) で表せない。
 *     - 改行を含まない。
 *     - `*`・`?` を含まない。deno check・fmt・lint・test は引数の `*`・`?` を glob として展開し、git が知らないファイルまで検査する (canon: facts/deno/check-file-args-glob、facts/deno/lint-file-args-and-rules)。deno がファイルの引数を文字どおりに受ける手段を持てば、この述語は外せる。
 *     - `/` で終わらない。未追跡の入れ子のリポジトリは `nested/` の形で出る (canon: facts/git/untracked-entry-kinds)。
 *   - 外れる項目が 1 つでもあれば、項目ごとに名前 (バイトを escape したもの) と理由を出して、段の前で落ちる。
 * - 名前の渡し方:
 *   - shellcheck・git・deno (check-json-md.ts を除く): 名前に `./` を前置する。先頭の `-` (option)・`!` (deno の除外)・`npm:` など (deno の URL) が名前として読まれる。deno check は `--` の後の名前を無視して cwd 全体を検査する (canon: facts/deno/check-double-dash)。
 *   - check-json-md.ts: 名前を全部、そのまま渡す (canon: facts/deno/run-args-passthrough)。
 * - 拡張子で対象を決める: shellcheck は `*.sh`、deno は `*.ts` (test は `*_test.ts`)。対象が無い段は通す (shellcheck は引数が無いと落ちる。canon: facts/shellcheck/no-files-argument)。
 *   - 拡張子の無い shell は検査しないので、このリポの shell は `*.sh` と名付ける。
 *   - 例外は hooks/pre-push で、名前は git が決め、agent-sync が置く。検査は配る側 (ikeyan/agent-files の verify) が受け持つ。
 * - deno lint は recommended の規則で回し、cwd の deno.json の lint 設定を読む (canon: facts/deno/lint-file-args-and-rules)。規則は deno の版で増えるので、版を上げる commit で増えた指摘を直す (上の「版」)。
 * - deno test の許可:
 *   - write: 段の TMPDIR だけ (canon: facts/deno/make-temp-dir-permissions)。Deno.symlink は絞らない write を要る (canon: facts/deno/symlink-requires-unscoped-permissions) ので、test は symlink を ln -s で作る。
 *   - read・env・run: 絞らない。test は次をする:
 *     - リポのファイル (verify.sh・hooks/pre-push など) を読む。
 *     - 環境を丸ごと子に渡す。
 *     - verify.sh・run-checks.ts・check-json-md.ts と、PATH を差し替えた fake を起動する。
 *   - 外せる条件: `--allow-run=deno` で、差し替えた PATH の dir の deno を起動できるようになったら (canon: facts/deno/allow-run-name-with-child-path)、run を起動するものに絞る。
 * - deno.json の imports の各キー (importKeys 段): git が知る .ts のそれぞれに `deno info --json` を回し (canon: facts/deno/info-json-dependencies)、graph の module (相対 import で辿った先を含む) の dependencies[].specifier のどれかと一致するとき使われているとみなす。末尾が / のキーは、指定子がその接頭辞のときも使われているとみなす。
 *   - 指定子に入る構文:
 *     - 静的 import (`import x from "a"`・`import "a"`・`import { type W } from "a"`)。
 *     - `export … from "a"`。
 *     - `import type`。
 *     - リテラルの動的 import (`import("a")`)。
 *     - 文より前の `/// <reference types="a" />`。
 *   - 入らないもの:
 *     - コメント・文字列の中。
 *     - 文の後の `/// <reference>`。
 *     - JSDoc の `@import`。
 *     - リテラルでない動的 import。
 *   - deno info --json の形 (modules[].dependencies[].specifier・modules[].error) は canon の実測。この段の試験が固定し、deno の版を上げたら測り直す。
 *   - deno info は次のフラグで回し、ネットワークに出ず、deno.json と deno.lock を読み書きしない。指定子は書かれた文字列のまま出る。
 *     - `--no-config`
 *     - `--no-lock`
 *     - `--no-npm`
 *     - `--no-remote`
 *   - 落ちる (未使用の判定をしない) とき:
 *     - deno info が非 0 で終わる。
 *     - graph の file: の module に error がある (ファイルが無い、構文が壊れている、相対 import 先が無い。deno info は exit 0)。npm: などの file: でない module の error (--no-npm で取らないもの) は見ない。
 *   - 数える参照は .ts の import の指定子だけ。
 */

const self = "run-checks.ts";
const dec = new TextDecoder();
const enc = new TextEncoder();

const [state] = Deno.args;
if (Deno.args.length !== 1 || (state !== "0" && state !== "1")) {
  console.error(
    `${self}: 引数は hook を揃えた結果 (0 か 1) の 1 つだけ。./verify.sh から起動する (${
      Deno.args.join(" ")
    })`,
  );
  Deno.exit(2);
}
const tmpdir = Deno.env.get("TMPDIR");
if (!tmpdir) {
  console.error(`${self}: TMPDIR が空。./verify.sh から起動する`);
  Deno.exit(2);
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

const messageOf = (e: unknown) => e instanceof Error ? e.message : String(e);
const describe = (e: unknown) =>
  e instanceof Error ? e.stack ?? String(e) : String(e);
/** 子が非 0 で終わったことと、その stderr。 */
const exited = (command: string, r: Run) =>
  `${command} が exit ${r.code}。下のエラーを直す\n${dec.decode(r.err)}`;

/** 受けるシグナルと、それで終わるときの終了コード。 */
const signals: [Deno.Signal, number][] = [
  ["SIGHUP", 129],
  ["SIGINT", 130],
  ["SIGTERM", 143],
];
/** 記録しているグループ (上の「状態 (groups)」)。pgid → そのグループを空にする関数。 */
const groups = new Map<number, () => Promise<void>>();
const killGroup = (child: Deno.ChildProcess, signal: Deno.Signal) => {
  try {
    Deno.kill(-child.pid, signal);
  } catch (e) {
    // ESRCH: グループに誰も残っていない
    if (e instanceof Deno.errors.NotFound) return;
    // EPERM: macOS の、終わりかけのものだけのグループで観測した (canon: facts/deno/command-spawn の「Deno.kill」)。機構は未確認。外す判定: canon の表の測定 (先頭に SIGKILL を送った直後に、この関数と同じ Deno.kill(-pid) でグループへ送る) を macOS の新しい版ごとに 1000 回回し、EPERM が 0 回の版から外す
    if (
      Deno.build.os === "darwin" && e instanceof Deno.errors.PermissionDenied
    ) return;
    throw e;
  }
};
/** emptyGroup の SIGTERM の後の待ちと、exec の出力の pipe の待ちの上限 (同じ値を使う)。 */
const graceMs = 2000;
/** p が graceMs 以内に決着すれば true。 */
async function settlesWithin(p: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p.then(() => true, () => true),
      new Promise<boolean>((r) => timer = setTimeout(() => r(false), graceMs)),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function emptyGroup(
  child: Deno.ChildProcess,
  outputs: Promise<unknown>,
) {
  try {
    // SIGTERM の送信が投げても SIGKILL を送る
    try {
      killGroup(child, "SIGTERM");
      // SIGTERM で終わるものに、後始末の猶予を与える
      await settlesWithin(Promise.allSettled([child.status, outputs]));
    } finally {
      try {
        killGroup(child, "SIGKILL");
      } finally {
        await child.status;
      }
    }
  } catch (e) {
    throw new Error(
      `段のプロセスグループ (pgid ${child.pid}) を空にできない。残ったものを手で止める (kill -KILL -- -${child.pid}) — ${
        messageOf(e)
      }`,
    );
  }
}

/** deno test の段の TMPDIR。消すのは remove で、並行に呼んでも 1 回だけ消す。 */
let testTmp: { path: string; remove: () => Promise<void> } | undefined;

/** 中断が始まっていれば、その経路 (解決しない)。 */
let interruption: Promise<never> | undefined;
for (const [signal, code] of signals) {
  Deno.addSignalListener(signal, () => {
    interruption ??= (async () => {
      const emptied = await Promise.allSettled(
        [...groups.values()].map((empty) => empty()),
      );
      for (const r of emptied) {
        if (r.status === "rejected") {
          console.error(`${self}: ${messageOf(r.reason)}`);
        }
      }
      try {
        await testTmp?.remove();
      } catch (e) {
        console.error(
          `${self}: deno test の段の TMPDIR (${testTmp?.path}) を消せない。手で消す — ${
            messageOf(e)
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
  groups.set(child.pid, empty);
  try {
    const { code } = await child.status;
    await empty();
    // グループの外に残った子孫が pipe を持っていれば閉じないので、上限を置く
    const closed = await settlesWithin(outputs);
    if (!closed) await Promise.all(readers.map((r) => r.cancel()));
    const [out, err] = await outputs;
    return closed ? { code, out, err } : {
      code: 1,
      out,
      err: concat([
        err,
        enc.encode(
          `${self}: ${cmd} の出力の pipe が、グループを空にしてから ${graceMs} ms の内に閉じない。pipe を持つ子孫がグループを抜けて残っている (止めていない)。ps -eo pid,ppid,pgid,args で探して止め、その子孫がグループを抜けないようにする\n`,
        ),
      ]),
    };
  } finally {
    // 空にできなければ記録を残し、中断の経路からも報告する
    await empty();
    groups.delete(child.pid);
  }
}

/** git の場所を決める変数 (上の「入力と環境の定義域」)。 */
const localEnvVars = dec.decode(
  (await exec("git", ["rev-parse", "--local-env-vars"])).out,
).split("\n").filter(Boolean);
const git = (args: string[]) => exec("git", args, { unset: localEnvVars });

/** 検査の結果を変える deno の変数 (canon: facts/deno/environment-and-config-inputs)。 */
const denoResultVars = [
  "DENO_COMPAT",
  "DENO_CONDITIONS",
  "DENO_COVERAGE_DIR",
  "DENO_TSC_BIN",
  "DENO_V8_FLAGS",
];
const deno = (args: string[], set: Record<string, string> = {}) =>
  exec("deno", args, {
    set: { DENO_NO_PACKAGE_JSON: "1", ...set },
    unset: denoResultVars,
  });

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

/** 段より前の確かめの、外れたものの理由。 */
type Problems = string[];

/** git が知る項目のうち処理するものの名前と、処理できない項目の理由。 */
async function gitFiles(): Promise<{ files: string[]; problems: Problems }> {
  const [cached, others] = await Promise.all([
    git(["ls-files", "-z", "-s", "-t", "--cached"]),
    git(["ls-files", "-z", "--others", "--exclude-standard"]),
  ]);
  if (cached.code !== 0) {
    return { files: [], problems: [exited("git ls-files --cached", cached)] };
  }
  if (others.code !== 0) {
    return { files: [], problems: [exited("git ls-files --others", others)] };
  }
  const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const files: string[] = [];
  const rejected = new Set<string>();
  const rename = "名前を変えるか、消す (未追跡なら .gitignore に足してもよい)";
  const accept = (name: Uint8Array, kind: string | undefined) => {
    let reason = kind;
    if (reason === undefined) {
      try {
        const f = utf8.decode(name);
        reason = f.includes("\n")
          ? `名前が改行を含む。${rename}`
          : /[*?]/.test(f)
          ? `名前が、deno が glob として展開する * か ? を含む。${rename}`
          : f.endsWith("/")
          ? "未追跡の入れ子のリポジトリ (/ で終わる)。消すか .gitignore に足す"
          : undefined;
        if (reason === undefined) files.push(f);
      } catch (e) {
        if (!(e instanceof TypeError)) throw e;
        reason = `名前が UTF-8 として不正。${rename}`;
      }
    }
    if (reason !== undefined) rejected.add(`${escapeBytes(name)}: ${reason}`);
  };
  // 各項目は `<tag> <mode> <object> <stage>\t<名前>` (git ls-files の --stage と -t)
  for (const entry of splitNul(cached.out)) {
    const tab = entry.indexOf(0x09);
    const [tag, mode, , stage] = dec.decode(entry.subarray(0, tab)).split(" ");
    accept(
      entry.subarray(tab + 1),
      mode === "120000"
        ? "追跡された symlink (deno がリンク先まで検査する)。通常ファイルにするか git rm --cached する"
        : mode === "160000"
        ? "gitlink (サブモジュール)。git rm --cached する"
        : tag === "S"
        ? "skip-worktree の項目。git update-index --no-skip-worktree する"
        : stage !== "0"
        ? "解決していない merge の項目。解決して git add する"
        : undefined,
    );
  }
  for (const name of splitNul(others.out)) accept(name, undefined);
  return {
    files,
    problems: rejected.size
      ? [
        `処理できない項目がある:\n${
          [...rejected].map((r) => `- ${r}`).join("\n")
        }`,
      ]
      : [],
  };
}

async function deletedFiles(): Promise<Problems> {
  const r = await git(["ls-files", "-z", "--deleted"]);
  if (r.code !== 0) return [exited("git ls-files --deleted", r)];
  const names = splitNul(r.out);
  return names.length
    ? [
      `作業ツリーに無い追跡ファイルがある。戻すか git rm する: ${
        names.map(escapeBytes).join(" ")
      }`,
    ]
    : [];
}

const denoMinor = 9;
const denoMinPatch = 7;
function denoVersion(): Promise<Problems> {
  const v = Deno.version.deno;
  const [major, minor, patch] = v.split(".").map(Number);
  return Promise.resolve(
    major === 2 && minor === denoMinor && patch >= denoMinPatch ? [] : [
      `deno の版が ${v} で、2.${denoMinor}.${denoMinPatch} 以上の 2.${denoMinor}.x でない。.github/workflows/verify.yml の deno-version の版を入れる: deno upgrade --version <その版>`,
    ],
  );
}

const shellcheckVersion = "0.11.0";
const shellcheck = (args: string[]) =>
  exec("shellcheck", ["--norc", ...args], { unset: ["SHELLCHECK_OPTS"] });
const shellcheckInstall = [
  `shellcheck ${shellcheckVersion} を PATH の先に置く。次のどれか:`,
  `- https://github.com/koalaman/shellcheck/releases/tag/v${shellcheckVersion} から OS と CPU に合う shellcheck-v${shellcheckVersion}.<os>.<arch>.tar.xz を取り、展開した shellcheck を PATH の先のディレクトリ (~/.local/bin など) に置く。Linux の x86_64 は .github/workflows/verify.yml の shellcheck の手順と同じ (sha256 もそこにある)。`,
  `- macOS で Homebrew の版が ${shellcheckVersion} なら、brew install shellcheck。`,
  `置いたら shellcheck --version で確かめる。`,
].join("\n");
async function shellcheckProbe(): Promise<Problems> {
  const problem = (message: string): Problems => [
    `${message}\n${shellcheckInstall}`,
  ];
  let probe: Run;
  try {
    probe = await shellcheck(["--version"]);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
    return problem("shellcheck が PATH に無い。");
  }
  // 版は version: の行にある (canon: facts/shellcheck/version-output-form)
  const actual = probe.code === 0
    ? dec.decode(probe.out).match(/^version: (.*)$/m)?.[1]
    : undefined;
  if (actual === undefined) {
    return problem(
      `shellcheck --version から版が読めない (exit ${probe.code})\n${
        dec.decode(probe.out)
      }${dec.decode(probe.err)}`,
    );
  }
  if (actual !== shellcheckVersion) {
    return problem(
      `shellcheck の版が ${actual} で、${shellcheckVersion} でない。`,
    );
  }
  return [];
}

const [listing, others] = await Promise.all([
  gitFiles().catch((e) => ({ files: [], problems: [describe(e)] })),
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
  const path = Deno.makeTempDirSync({ dir: tmpdir, prefix: "run-checks-" });
  let removal: Promise<void> | undefined;
  testTmp = {
    path,
    remove: () => removal ??= Deno.remove(path, { recursive: true }),
  };
}

/** targets があれば、`./` を前置した名前を run に渡す。 */
const onFiles = (
  targets: string[],
  run: (names: string[]) => Promise<Run>,
) =>
  targets.length
    ? run(targets.map(dotSlash))
    : Promise.resolve(pass("対象のファイルが無い"));

/** deno.json の imports の各キーが、.ts の import の指定子から使われていること。 */
async function importKeys(): Promise<Run> {
  const keys = Object.keys(
    JSON.parse(await Deno.readTextFile("deno.json")).imports ?? {},
  );
  const infos = await Promise.all(ts.map(async (f) => ({
    f,
    r: await deno([
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
      problems.push(`${f}: ${exited("deno info", r)}`);
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
        `deno.json: imports の "${key}" が、どの .ts の静的な import・export・リテラルの動的 import の指定子にも見つからない (リテラルでない動的 import は判定しない)。使うか deno.json から消す`
      ).join("\n"),
    )
    : pass(`ok: imports ${keys.length} 件、.ts ${ts.length} 件`);
}

async function denoTest(): Promise<Run> {
  if (tests.length === 0) return pass("対象のファイルが無い");
  if (testTmp === undefined) throw new Error("deno test の段の TMPDIR が無い");
  try {
    return await deno([
      "test",
      frozen,
      "--allow-read",
      `--allow-write=${testTmp.path}`,
      "--allow-env",
      "--allow-run",
      ...tests.map(dotSlash),
    ], { TMPDIR: testTmp.path });
  } finally {
    await testTmp.remove();
  }
}

const steps: [string, () => Promise<Run>][] = [
  ["shellcheck", () => onFiles(withExt(".sh"), shellcheck)],
  [
    "deno fmt",
    () => onFiles(ts, (names) => deno(["fmt", "--check", ...names])),
  ],
  ["deno lint", () => onFiles(ts, (names) => deno(["lint", ...names]))],
  [
    "deno check",
    () => onFiles(ts, (names) => deno(["check", frozen, ...names])),
  ],
  ["deno test", denoTest],
  ["deno.json の imports", importKeys],
  [
    "JSON と Markdown",
    () =>
      deno([
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
      `${name} に書けない。書ける先に出して回し直す — ${messageOf(e)}`,
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
  state === "1" || writeErrors.size > 0 || results.some((r) => r.code !== 0)
    ? 1
    : 0,
);
