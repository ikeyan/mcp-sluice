/**
 * run-checks.ts — verify.sh の検査の段を並行に回す。verify.sh が状態を揃えた後に exec で起動する。
 *
 * 性質:
 * - 段は互いに独立で、書くものも無い (deno.lock は verify.sh が `--frozen-lockfile` を渡すので書き換えない) ので、全部を同時に始める。
 * - 段ごとに標準出力と標準エラーを分けて残し、全部を待ってから、下の steps に並べた順で出す (終わった順でない)。
 *   - 通った段: 見出しと標準出力を stdout へ、標準エラーを stderr へ。
 *   - 落ちた段: 見出しと両方を stderr へ。落ちた段は全部出す。
 * - どれかの段が落ちるか、引数が 1 なら exit 1。
 * - シグナルは扱わない。段の子は同じプロセスグループなので端末の Ctrl-C は子にも届き、SIGTERM をこのプロセスだけが受けても、子は読むだけの検査なので数秒で終わって何も残さない。段が長く動くものや一時ファイルを作るものを持つようになったら、グループごとに止める仕組みを足す (agent-files の scripts/run-checks.ts が参考になる)。
 *
 * 入力と環境の定義域:
 * - 引数は 1 つで、verify.sh が先に回した状態を揃える段の結果 (0 か 1)。外れていれば理由を出して落ちる。
 * - cwd はリポのルート。読むファイルは deno.json と .agent-sync/generated だけ (許可は verify.sh が `--allow-read` で渡す)。
 * - git は GIT_DIR・GIT_WORK_TREE・GIT_INDEX_FILE など (canon: facts/git/local-env-vars-and-hook-env) をこのプロセスの環境から継承して読む。ファイルの一覧は、その git が指すリポジトリのもの。
 * - 検査するのは git が知っているファイル (追跡と、無視されない未追跡) で、作業ツリーに無い追跡ファイルも一覧に出る。その名前は各コマンドが無いことを知らせて落ちる。
 *   - 名前は次の述語を全部満たすものだけを処理する。外れる名前が 1 つでもあれば、理由と名前 (バイトを escape したもの) を出して、何も検査せずに落ちる。
 *     - UTF-8 として正しい (引数の文字列で表せない)。
 *     - 改行を含まない。
 *     - `*`・`?` を含まない。deno 2.9.7 の deno check・deno lint は引数の `*`・`?` を glob として展開し、git が知らないファイルまで検査する。エスケープの手段は無い (canon: facts/deno/check-file-args-glob、facts/deno/lint-file-args-and-rules)。deno fmt・deno test は同じ形のファイル引数を取る。
 *   - 満たす名前は shellcheck・deno・check-json-md.ts へ `./` を前置して渡し、先頭の `-` (option)・`!` (deno の除外)・`npm:` など (deno の URL) が来ないようにする。`--` は使わない (deno check は `--` の後の名前を無視して cwd 全体を検査する。canon: facts/deno/check-double-dash)。
 * - 拡張子で対象を決める: shellcheck は `*.sh` (`.agent-sync/generated` に載るものを除く。上流が検査する)、deno は `*.ts` (test は `*_test.ts`)、check-json-md.ts は `*.json`・`*.md`。拡張子の無い shell は検査しないので、このリポの shell は `*.sh` と名付ける。
 * - deno lint は cwd の deno.json の lint 設定を読む (canon: facts/deno/lint-file-args-and-rules)。この段は lint が空であることを前提にし、規則を no-unused-vars 1 つに絞る。recommended 全体にしないのは、deno 2.x の更新で recommended に規則が増え、コードを変えていない CI が落ちるのを避けるため。足すときは `--rules-include` を足す。
 * - deno.json の imports の各キー (importKeys 段): git が知る .ts のそれぞれに `deno info --json` を回し (canon: facts/deno/info-json-dependencies)、graph の esm の module (相対 import で辿った先を含む) の dependencies[].specifier のどれかと一致するとき使われているとみなす。末尾が / のキーは、指定子がその接頭辞のときも使われているとみなす。
 *   - deno info には `--no-config --no-lock --no-npm --no-remote` を付け、deno.json・deno.lock を読み書きせず、ネットワークにも出ない。指定子は書かれた文字列のまま出るので解決は要らない。
 *   - 指定子に入るのは静的 import・export from・import type・リテラルの動的 import。コメント・文字列の中、`/// <reference>`、JSDoc の `@import`、リテラルでない動的 import は入らない。
 *   - graph の file: の module に error (ファイルが無い、構文が壊れている、相対 import 先が無い) があれば、deno info は exit 0 なので、その module と error を報告して落ちる。
 *   - deno.json の他の設定 (tasks など) からの参照は見ない。
 * - PATH に shellcheck (0.11.0 だけ。違えばその段が落ちる)・git・deno があること。deno は 2.x で、2.9.7 と 2.9.8 で確かめた。
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

async function exec(cmd: string, args: string[]): Promise<Run> {
  const { code, stdout, stderr } = await new Deno.Command(cmd, {
    args,
    stdin: "null",
  }).output();
  return { code, out: stdout, err: stderr };
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

/** git が知っているファイル。-z でなければ git は非 ASCII の名前を quote して出す (canon: facts/git/path-output-quoting)。 */
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
const dotSlash = (fs: string[]) => fs.map((f) => `./${f}`);

/** 対象が 1 件以上あるときだけコマンドを回す。無ければ通す (deno test は引数が無いと cwd から探すので、空のまま回さない)。 */
const onFiles = (cmd: string, args: string[], targets: string[]) =>
  targets.length
    ? exec(cmd, [...args, ...dotSlash(targets)])
    : Promise.resolve(pass("対象のファイルが無い"));

// 版で出す指摘が違う (SC2015 は 0.9.0 が出し 0.11.0 は出さない。canon: facts/shellcheck) ので、手元と CI で同じ版に揃える。
const shellcheckVersion = "0.11.0";
async function shellcheck(): Promise<Run> {
  let actual = "";
  try {
    actual = dec.decode((await exec("shellcheck", ["--version"])).out).match(
      /^version: (.*)$/m,
    )?.[1] ?? "";
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  if (actual !== shellcheckVersion) {
    return fail(
      `shellcheck の版が ${
        actual || "不明 (shellcheck が無い)"
      } で、${shellcheckVersion} でない。macOS: brew install shellcheck (Homebrew の版が ${shellcheckVersion} でなければ https://github.com/koalaman/shellcheck/releases/tag/v${shellcheckVersion} の成果物を PATH に置く)。Linux: .github/workflows/verify.yml の shellcheck の手順と同じに入れる`,
    );
  }
  // 各行は `<path>\t<id>`
  const generated = new Set(
    (await Deno.readTextFile(".agent-sync/generated")).split("\n").filter(
      Boolean,
    ).map((l) => l.split("\t")[0]),
  );
  return onFiles(
    "shellcheck",
    [],
    withExt(".sh").filter((f) => !generated.has(f)),
  );
}

/** deno.json の imports の各キーが、.ts の import の指定子から使われていること。 */
async function importKeys(): Promise<Run> {
  const ts = withExt(".ts");
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
      `./${f}`,
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
  for (const key of keys) {
    if (
      ![...specifiers].some((s) =>
        s === key || (key.endsWith("/") && s.startsWith(key))
      )
    ) {
      problems.push(
        `deno.json: imports の "${key}" がどの .ts からも使われていない`,
      );
    }
  }
  return problems.length
    ? fail(problems.join("\n"))
    : pass(`ok: imports ${keys.length} 件、.ts ${ts.length} 件`);
}

const steps: [string, () => Promise<Run>][] = [
  ["shellcheck", shellcheck],
  ["deno fmt", () => onFiles("deno", ["fmt", "--check"], withExt(".ts"))],
  // --rules-tags= で recommended を外し、no-unused-vars だけを走らせる (canon: facts/deno/lint-file-args-and-rules)
  [
    "deno lint",
    () =>
      onFiles("deno", [
        "lint",
        "--rules-tags=",
        "--rules-include=no-unused-vars",
      ], withExt(".ts")),
  ],
  [
    "deno check",
    () => onFiles("deno", ["check", "--frozen-lockfile"], withExt(".ts")),
  ],
  [
    "deno test",
    () => onFiles("deno", ["test", "--frozen-lockfile"], withExt("_test.ts")),
  ],
  ["deno.json の imports", importKeys],
  [
    "JSON と Markdown",
    () =>
      onFiles("deno", [
        "run",
        "--frozen-lockfile",
        "--allow-read=.",
        "scripts/check-json-md.ts",
      ], files.filter((f) => /\.(json|md)$/.test(f))),
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
  for (let i = 0; i < data.length;) i += w.writeSync(data.subarray(i));
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
