/**
 * run-checks.ts — verify.sh の検査の段を並行に回す。verify.sh が状態を揃えた後に exec で起動する。
 *
 * 性質:
 * - 段は互いに独立なので、全部を同時に始める。段が共有して書くのは deno の cache (DENO_DIR) だけ。deno.lock は `--frozen-lockfile` で読むだけ。
 * - 段ごとに標準出力と標準エラーを分けて残し、全部を待ってから、下の steps に並べた順で出す。段の出力を混ぜず、毎回同じ順にするため。
 *   - 通った段: 見出しと標準出力を stdout へ、標準エラーを stderr へ。
 *   - 落ちた段: 見出しと両方を stderr へ。落ちた段は全部出す。
 *   - 書き込みは 1 つずつ独立で、出力先が閉じても (`./verify.sh | head` の BrokenPipe) 残りを出す。
 * - どれかの段が落ちるか、引数が 1 なら exit 1。
 * - 段の子は、それぞれ自分のプロセスグループの先頭として起動する (Deno.Command の detached。canon: facts/deno/command-spawn)。
 * - SIGHUP・SIGINT・SIGTERM: 最初の 1 回で、動いている段の子のグループに SIGTERM を送り、子が終わるまで (上限 graceMs) 待ち、deno test の段の TMPDIR を消して、128 + シグナルの番号で終わる。段の出力は出さない。
 *   - 2 回目以降は何もしない。
 *   - 中断の後は段の子を起動しない (その段は落ちた扱いになるが、出力は出さない)。
 * - deno test の段は、TMPDIR の下にこのプロセスが作ったディレクトリを TMPDIR にして回し、段の後と中断でそれを消す。deno test は SIGTERM で finally を回さずに終わり、SIGINT は自分で受けて終わる (deno 2.9.8 で実測) ので、test が作った一時ディレクトリはこれで消える。
 *
 * 入力と環境の定義域:
 * - 引数は 1 つで、verify.sh が先に回した状態を揃える段の結果 (0 か 1)。外れていれば理由を出して落ちる。
 * - cwd はリポのルート。読むファイルは deno.json と .agent-sync/generated だけ。書くのは TMPDIR (未設定か空なら /tmp) の下だけ。許可は verify.sh が渡す。
 * - 環境はそのまま段の子に渡す。git の場所を決める環境変数 (canon: facts/git/local-env-vars-and-hook-env) は verify.sh が消してから起動するので、git は cwd のリポを見る。
 * - 版:
 *   - deno: 2.9.x で x が 7 以上 (2.9.7・2.9.8 で確かめた)。このプロセスを動かす deno (段の子も同じ PATH で引く) の版を見て、外れればその段が落ちる。
 *   - shellcheck: 0.11.0 だけ。版で出す指摘が違う (canon: facts/shellcheck/sc2015-version-difference)。外れればその段が落ちる。
 *   - git: 2.31 以降 (verify.sh の --path-format)。
 * - 検査するのは git が知っているファイル (追跡と、無視されない未追跡) で、作業ツリーに無い追跡ファイルも一覧に出る。その名前は各コマンドが無いことを知らせて落ちる。
 *   - git は -z で quote せずに出す (canon: facts/git/path-output-quoting)。名前は次の述語を全部満たすものだけを処理する。外れる名前が 1 つでもあれば、理由と名前 (バイトを escape したもの) を出して、何も検査せずに落ちる。
 *     - UTF-8 として正しい。不正な名前はコマンドへ渡す引数 (文字列) で表せない。
 *     - 改行を含まない。
 *     - `*`・`?` を含まない。deno check・deno lint は引数の `*`・`?` を glob として展開し、git が知らないファイルまで検査する。エスケープの手段は無い (canon: facts/deno/check-file-args-glob、facts/deno/lint-file-args-and-rules)。deno 2.9.8 の deno fmt・deno test も同じく展開する (実測)。deno がファイルの引数を文字どおりに受ける手段を持てば、この述語は外せる。
 *   - shellcheck・git・deno (check-json-md.ts を除く) へは名前に `./` を前置して渡し、先頭の `-` (option)・`!` (deno の除外)・`npm:` など (deno の URL) が名前として読まれるようにする。deno check は `--` の後の名前を無視して cwd 全体を検査する (canon: facts/deno/check-double-dash)。
 *   - check-json-md.ts へは名前を全部、そのまま渡す (canon: facts/deno/run-args-passthrough)。check-json-md.ts はこのファイルの隣のものを起動する。
 * - 拡張子で対象を決める: shellcheck は `*.sh`、deno は `*.ts` (test は `*_test.ts`)。拡張子の無い shell は検査しないので、このリポの shell は `*.sh` と名付ける。
 * - shellcheck から除くもの: `.agent-sync/generated` の行 `<path>\t<id>` のうち、そのファイルの今の `git hash-object --no-filters` が id と等しいもの (agent-sync が置いたままのもので、上流が検査する)。手を入れた写しと、hash を取れないもの (作業ツリーに無い) は検査する。
 * - deno lint は cwd の deno.json の lint 設定を読む (canon: facts/deno/lint-file-args-and-rules)。この段は lint が空であることを前提にし、規則を no-unused-vars 1 つに絞る。recommended は deno の版で規則が増え、コードを変えていない CI が落ちうるため。足すときは `--rules-include` を足す。
 * - deno test には read・write・env・run を絞らずに許す。test は TMPDIR の下に fixture を作り、verify.sh・run-checks.ts・check-json-md.ts と、PATH を差し替えた fake を子として回す。`--allow-run=deno` は、差し替えた PATH の dir に置いた deno への symlink の起動を NotCapable にする (deno 2.9.8 で実測)。
 * - deno.json の imports の各キー (importKeys 段): git が知る .ts のそれぞれに `deno info --json` を回し (canon: facts/deno/info-json-dependencies)、graph の esm の module (相対 import で辿った先を含む) の dependencies[].specifier のどれかと一致するとき使われているとみなす。末尾が / のキーは、指定子がその接頭辞のときも使われているとみなす。
 *   - deno info には `--no-config --no-lock --no-npm --no-remote` を付け、deno.json・deno.lock を読み書きせず、ネットワークにも出ない。指定子は書かれた文字列のまま出るので解決は要らない。
 *   - deno info が落ちるか、graph の file: の module に error (ファイルが無い、構文が壊れている、相対 import 先が無い。deno info は exit 0) があれば、それを報告して落ち、指定子の一覧が欠けるので未使用の判定はしない。
 *   - deno.json の他の設定 (tasks など) からの参照は見ない。
 */

const self = "run-checks.ts";
const dec = new TextDecoder();
const enc = new TextEncoder();

if (Deno.args.length !== 1 || !["0", "1"].includes(Deno.args[0])) {
  console.error(
    `${self}: 引数は状態を揃える段の結果 (0 か 1) 1 つ (${
      Deno.args.join(" ")
    })`,
  );
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

/** deno test の段の TMPDIR。中断の handler が作りかけを見落とさないように、同期で作る。 */
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
/** 動いている段の子 (それぞれ自分のプロセスグループの先頭)。 */
const children = new Set<Deno.ChildProcess>();
/** 中断で段のグループに SIGTERM を送ってから、先頭が終わるのを待つ上限。 */
const graceMs = 2000;
let interrupted = false;
for (const [signal, code] of signals) {
  Deno.addSignalListener(signal, async () => {
    if (interrupted) return;
    interrupted = true;
    for (const child of children) {
      try {
        Deno.kill(-child.pid, "SIGTERM");
      } catch (e) {
        // ESRCH: グループに誰も残っていない。EPERM: 終わりかけのものだけ (macOS。canon: facts/deno/command-spawn の「Deno.kill」。macOS が EPERM を返さなくなったら PermissionDenied を外せる)
        if (
          !(e instanceof Deno.errors.NotFound ||
            e instanceof Deno.errors.PermissionDenied)
        ) throw e;
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled([...children].map((c) => c.status)),
      new Promise((r) => timer = setTimeout(r, graceMs)),
    ]);
    clearTimeout(timer);
    await removeTestTmp();
    Deno.exit(code);
  });
}

async function exec(
  cmd: string,
  args: string[],
  env?: Record<string, string>,
): Promise<Run> {
  if (interrupted) return fail("中断した");
  const child = new Deno.Command(cmd, {
    args,
    env,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    detached: true,
  }).spawn();
  children.add(child);
  try {
    const { code, stdout, stderr } = await child.output();
    return { code, out: stdout, err: stderr };
  } finally {
    children.delete(child);
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

async function gitFiles(): Promise<string[]> {
  const r = await exec("git", [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  ]);
  if (r.code !== 0) {
    console.error(
      `${self}: git ls-files が exit ${r.code}\n${dec.decode(r.err)}`,
    );
    Deno.exit(1);
  }
  const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const files: string[] = [];
  const rejected: Uint8Array[] = [];
  for (let i = 0; i < r.out.length;) {
    const end = r.out.indexOf(0, i);
    const name = r.out.subarray(i, end < 0 ? r.out.length : end);
    i += name.length + 1;
    try {
      const f = utf8.decode(name);
      if (/[\n*?]/.test(f)) rejected.push(name);
      else files.push(f);
    } catch (e) {
      if (!(e instanceof TypeError)) throw e;
      rejected.push(name);
    }
  }
  if (rejected.length) {
    console.error(
      `${self}: 処理できない名前のファイルがある (UTF-8 として不正、改行を含む、deno が glob として展開する * か ? を含む)。名前を変えるか消す: ${
        rejected.map(escapeBytes).join(" ")
      }`,
    );
    Deno.exit(1);
  }
  return files;
}

const files = await gitFiles();
const withExt = (ext: string) => files.filter((f) => f.endsWith(ext));
const dotSlash = (f: string) => `./${f}`;
const ts = withExt(".ts");
const tests = ts.filter((f) => f.endsWith("_test.ts"));
const frozen = "--frozen-lockfile";
if (tests.length) {
  testTmp = Deno.makeTempDirSync({
    dir: Deno.env.get("TMPDIR") || "/tmp",
    prefix: "run-checks-",
  });
}

/** 引数が無いと deno は cwd 全体を対象にし、shellcheck は使い方の誤りで落ちるので、対象が無ければ回さずに通す。 */
const onFiles = (cmd: string, args: string[], targets: string[]) =>
  targets.length
    ? exec(cmd, [...args, ...targets])
    : Promise.resolve(pass("対象のファイルが無い"));

const denoVersionRange = "2.9.x (x は 7 以上)";
function denoVersion(): Promise<Run> {
  const patch = Deno.version.deno.match(/^2\.9\.(\d+)$/)?.[1];
  return Promise.resolve(
    patch !== undefined && Number(patch) >= 7
      ? pass(`deno ${Deno.version.deno}`)
      : fail(
        `deno の版が ${Deno.version.deno} で、${denoVersionRange} でない。.github/workflows/verify.yml の CI と同じ版にするなら Execute: deno upgrade --version 2.9.8`,
      ),
  );
}

const shellcheckVersion = "0.11.0";
const shellcheckInstall = [
  `shellcheck ${shellcheckVersion} を PATH の先に置く:`,
  `- https://github.com/koalaman/shellcheck/releases/tag/v${shellcheckVersion} から OS と CPU に合う shellcheck-v${shellcheckVersion}.<os>.<arch>.tar.xz を取り、展開した shellcheck を PATH の先のディレクトリ (~/.local/bin など) に置く。Linux の x86_64 は .github/workflows/verify.yml の shellcheck の手順と同じ (sha256 もそこにある)。`,
  `- macOS は、Homebrew の版が ${shellcheckVersion} なら brew install shellcheck でもよい。`,
  `- 置いたら shellcheck --version で確かめる。`,
].join("\n");
async function shellcheck(): Promise<Run> {
  let probe: Run;
  try {
    probe = await exec("shellcheck", ["--version"]);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
    return fail(`shellcheck が PATH に無い。\n${shellcheckInstall}`);
  }
  if (probe.code !== 0) {
    return fail(
      `shellcheck --version が exit ${probe.code}\n${
        dec.decode(probe.err)
      }\n${shellcheckInstall}`,
    );
  }
  const actual = dec.decode(probe.out).match(/^version: (.*)$/m)?.[1];
  if (actual === undefined) {
    return fail(
      `shellcheck --version の出力に version: の行が無い\n${
        dec.decode(probe.out)
      }\n${shellcheckInstall}`,
    );
  }
  if (actual !== shellcheckVersion) {
    return fail(
      `shellcheck の版が ${actual} で、${shellcheckVersion} でない。\n${shellcheckInstall}`,
    );
  }
  const recorded = new Map(
    (await Deno.readTextFile(".agent-sync/generated")).split("\n").filter(
      Boolean,
    ).map((l) => l.split("\t") as [string, string]),
  );
  const sh = withExt(".sh");
  const unchanged = await Promise.all(sh.map(async (f) => {
    if (!recorded.has(f)) return false;
    const r = await exec("git", ["hash-object", "--no-filters", dotSlash(f)]);
    return r.code === 0 && dec.decode(r.out).trim() === recorded.get(f);
  }));
  return onFiles(
    "shellcheck",
    [],
    sh.filter((_, i) => !unchanged[i]).map(dotSlash),
  );
}

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
      "deno.json: 指定子の一覧が欠けるので、imports の未使用の判定はしていない",
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
        `deno.json: imports の "${key}" がどの .ts からも使われていない`
      ).join("\n"),
    )
    : pass(`ok: imports ${keys.length} 件、.ts ${ts.length} 件`);
}

async function denoTest(): Promise<Run> {
  if (testTmp === undefined) return pass("対象のファイルが無い");
  try {
    return await exec("deno", [
      "test",
      frozen,
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-run",
      ...tests.map(dotSlash),
    ], { TMPDIR: testTmp });
  } finally {
    await removeTestTmp();
  }
}

const steps: [string, () => Promise<Run>][] = [
  ["deno の版", denoVersion],
  ["shellcheck", shellcheck],
  ["deno fmt", () => onFiles("deno", ["fmt", "--check"], ts.map(dotSlash))],
  // --rules-tags= で recommended を外し、no-unused-vars だけを走らせる (canon: facts/deno/lint-file-args-and-rules)
  [
    "deno lint",
    () =>
      onFiles("deno", [
        "lint",
        "--rules-tags=",
        "--rules-include=no-unused-vars",
      ], ts.map(dotSlash)),
  ],
  ["deno check", () => onFiles("deno", ["check", frozen], ts.map(dotSlash))],
  ["deno test", denoTest],
  ["deno.json の imports", importKeys],
  [
    "JSON と Markdown",
    () =>
      onFiles(
        "deno",
        [
          "run",
          frozen,
          "--allow-read=.",
          import.meta.resolve("./check-json-md.ts"),
        ],
        files,
      ),
  ],
];

const results = await Promise.all(
  steps.map(([, run]) =>
    run().catch((e): Run =>
      fail(e instanceof Error ? e.stack ?? String(e) : String(e))
    )
  ),
);

const write = (w: { writeSync(p: Uint8Array): number }, data: Uint8Array) => {
  try {
    for (let i = 0; i < data.length;) i += w.writeSync(data.subarray(i));
  } catch (e) {
    if (!(e instanceof Deno.errors.BrokenPipe)) throw e;
  }
};
results.forEach((r, i) => {
  const name = steps[i][0];
  if (r.code === 0) {
    write(Deno.stdout, enc.encode(`== ${name}: 通った\n`));
    write(Deno.stdout, r.out);
    write(Deno.stderr, r.err);
  } else {
    write(Deno.stderr, enc.encode(`== ${name}: 落ちた (exit ${r.code})\n`));
    write(Deno.stderr, r.out);
    write(Deno.stderr, r.err);
  }
});
Deno.exit(Deno.args[0] === "1" || results.some((r) => r.code !== 0) ? 1 : 0);
