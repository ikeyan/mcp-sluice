/**
 * run-checks.ts を子として、fixture のリポで回す。
 * - fixture は TMPDIR の下の一時ディレクトリの git のリポ。run-checks.ts が読む deno.json を必ず置く。
 * - run-checks.ts に渡す deno の引数は、verify.sh が exec するもの (verifyFlags) と同じにする。
 * - 子の環境: このプロセスの環境から git の場所を決める変数 (canon: facts/git/local-env-vars-and-hook-env) を消し、GIT_CONFIG_GLOBAL=/dev/null・GIT_CONFIG_NOSYSTEM=1 で利用者の git の設定を読まないもの。git 2.32 以降を要る (canon: facts/git/config-sources-and-scopes)。
 * - symlink は ln -s で作る。Deno.symlink は絞らない read・write を要り (canon: facts/deno/symlink-requires-unscoped-permissions)、deno test の段の許可では作れない。Deno.symlink が絞った write で通るようになったら替える。
 * - test と、test が起動したものが書くもの:
 *   - 書く場所は fixture の下だけ。run-checks.ts に渡す TMPDIR は fixture の .git/tmp で、deno test の段の TMPDIR もその下にできる。
 *   - 消すのは withTempDir。
 * - test が起動したもの (fake の段とその孫、fixture の deno test とその子、グループを抜けた子孫) の寿命:
 *   - どれも lifetimeMs 以内に自分で終わる (sleep は有限、ループは回数で抜ける)。run-checks.ts が止め損ねる回帰でも、その上限で消える。
 *   - 止め損ねたものが fixture を消す間に書き足しても、withTempDir が lifetimeMs まで消し直す。
 */
import fc from "fast-check";
import { deepStrictEqual } from "node:assert/strict";

const root = Deno.realPathSync(`${import.meta.dirname}/..`);
const dec = new TextDecoder();
const enc = new TextEncoder();
const tmpdirEnv = Deno.env.get("TMPDIR");
if (!tmpdirEnv) throw new Error("TMPDIR が空。./verify.sh から回す");
const tmpdir = Deno.realPathSync(tmpdirEnv);

const localEnv = dec.decode(
  (await new Deno.Command("git", { args: ["rev-parse", "--local-env-vars"] })
    .output()).stdout,
).split("\n").filter(Boolean);
const baseEnv: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(Deno.env.toObject()).filter(([k]) => !localEnv.includes(k)),
  ),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  TMPDIR: tmpdir,
};

/** 子の PATH で name を引いたパス (command -v)。 */
const which = (name: string): string => {
  const r = new Deno.Command("sh", {
    args: ["-c", 'command -v "$1"', "sh", name],
    env: baseEnv,
    clearEnv: true,
  }).outputSync();
  if (!r.success) throw new Error(`${name} が PATH に無い`);
  return dec.decode(r.stdout).trim();
};

/** test が起動したものが自分で終わるまでの上限。 */
const lifetimeMs = 10_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 止め損ねたものが書き足しても消えるように、lifetimeMs まで消し直す。 */
async function removeEventually(dir: string) {
  const deadline = Date.now() + lifetimeMs;
  for (;;) {
    try {
      return await Deno.remove(dir, { recursive: true });
    } catch (e) {
      if (Date.now() > deadline) throw e;
      await sleep(100);
    }
  }
}

const withTempDir = async <T>(fn: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await Deno.makeTempDir({ dir: tmpdir });
  try {
    return await fn(dir);
  } finally {
    await removeEventually(dir);
  }
};

const spawn = (cmd: string, options: Deno.CommandOptions) =>
  new Deno.Command(cmd, {
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    ...options,
  }).spawn();

async function run(cmd: string, args: string[], cwd?: string) {
  const r = await spawn(cmd, { args, cwd, env: baseEnv, clearEnv: true })
    .output();
  if (!r.success) {
    throw new Error(`${cmd} ${args.join(" ")}\n${dec.decode(r.stderr)}`);
  }
  return dec.decode(r.stdout);
}

const ln = (target: string, path: string) => run("ln", ["-s", target, path]);

async function writeFiles(dir: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    await Deno.mkdir(`${dir}/${path.slice(0, path.lastIndexOf("/") + 1)}`, {
      recursive: true,
    });
    await Deno.writeTextFile(`${dir}/${path}`, content, { mode: 0o644 });
  }
}

/** dir を git のリポにし、deno.json (files に無ければ {})・files・.git/tmp (run-checks.ts に渡す TMPDIR) を置く。 */
async function makeRepo(dir: string, files: Record<string, string>) {
  await run("git", ["init", "-q", "--template=", dir]);
  await Deno.mkdir(fixtureTmp(dir));
  await writeFiles(dir, { "deno.json": "{}", ...files });
}

/** fixture のリポに渡す TMPDIR。 */
const fixtureTmp = (dir: string) => `${dir}/.git/tmp`;

/** fixture のリポを作って fn に渡し、終われば消す。 */
const withRepo = <T>(
  files: Record<string, string>,
  fn: (dir: string) => Promise<T>,
): Promise<T> =>
  withTempDir(async (dir) => {
    await makeRepo(dir, files);
    return await fn(dir);
  });

/** verify.sh が `deno run` の後、scripts/run-checks.ts の前に置く引数。 */
const verifyFlags = await withTempDir(async (dir) => {
  await run("git", ["init", "-q", "--template=", dir]);
  await Deno.mkdir(`${dir}/hooks`);
  await Deno.copyFile(`${root}/verify.sh`, `${dir}/verify.sh`);
  await Deno.copyFile(`${root}/hooks/pre-push`, `${dir}/hooks/pre-push`);
  await Deno.mkdir(`${dir}/bin`);
  await Deno.writeTextFile(
    `${dir}/bin/deno`,
    `#!/bin/sh\nprintf '%s\\0' "$@" > "${dir}/args"\n`,
    { mode: 0o755 },
  );
  await spawn("bash", {
    args: [`${dir}/verify.sh`],
    env: { ...baseEnv, PATH: `${dir}/bin:${baseEnv.PATH}` },
    clearEnv: true,
  }).output();
  const args = (await Deno.readTextFile(`${dir}/args`)).split("\0").slice(
    0,
    -1,
  );
  const script = args.indexOf("scripts/run-checks.ts");
  if (args[0] !== "run" || script < 0) {
    throw new Error(
      `verify.sh の exec の引数が想定と違う: ${JSON.stringify(args)}`,
    );
  }
  return args.slice(1, script);
});

/** env の undefined の変数は消す。 */
type EnvChange = Record<string, string | undefined>;

/** verify.sh と同じ形で run-checks.ts を起動する deno の引数。 */
const checksArgs = (state: string) => [
  "run",
  ...verifyFlags,
  `${root}/scripts/run-checks.ts`,
  state,
];

const spawnChecks = (dir: string, state: string, change: EnvChange = {}) => {
  const env: Record<string, string> = {};
  for (
    const [name, value] of Object.entries({
      ...baseEnv,
      TMPDIR: fixtureTmp(dir),
      ...change,
    })
  ) {
    if (value !== undefined) env[name] = value;
  }
  return spawn("deno", {
    args: checksArgs(state),
    cwd: dir,
    env,
    clearEnv: true,
  });
};

async function runChecks(dir: string, state: string, env: EnvChange = {}) {
  const r = await spawnChecks(dir, state, env).output();
  return {
    code: r.code,
    stdout: dec.decode(r.stdout),
    stderr: dec.decode(r.stderr),
  };
}

/** git・deno・sleep と、fakes (名前 → 中身) だけを置いた PATH の dir を作る。PATH をこの dir だけにすると、shellcheck は fakes に置いたときだけ在る。 */
async function fakePath(dir: string, fakes: Record<string, string>) {
  const bin = `${dir}/.git/fake-bin`;
  await Deno.mkdir(bin);
  for (const name of ["git", "deno", "sleep"]) {
    if (!(name in fakes)) await ln(which(name), `${bin}/${name}`);
  }
  for (const [name, content] of Object.entries(fakes)) {
    await Deno.writeTextFile(`${bin}/${name}`, content, { mode: 0o755 });
  }
  return bin;
}

const bad = "#!/bin/sh\necho $1\n";
/** 段の見出し。 */
const failedHead = (name: string) => `== ${name}: 落ちた`;
const passedHead = (name: string) => `== ${name}: 通った`;
/** 表の行ごとの失敗を集め、最後にまとめて比べる。 */
const collector = () => {
  const failures: string[] = [];
  return {
    failures,
    expect: (name: string, ok: boolean, detail: string) => {
      if (!ok) failures.push(`${name}\n${detail}`);
    },
  };
};

/** HOME を差し替えても deno が同じ cache を使うように、DENO_DIR を固定する。 */
const denoDir: string =
  JSON.parse(await run("deno", ["info", "--json"])).denoDir;

Deno.test("shellcheck は利用者の SHELLCHECK_OPTS と .shellcheckrc を読まない", async () => {
  // 次元: canon: facts/shellcheck/environment-and-config-inputs の入力の目録
  const { failures, expect } = collector();
  /**
   * 行ごとに、SC2086 を外す rc をどこに置くかと、子の環境の差分。
   * outer はリポの親、home はリポの祖先でない dir (HOME・XDG_CONFIG_HOME の rc を、リポの親の rc と分ける)。
   */
  type Row = [
    string,
    (outer: string, home: string) => { rc?: string; env: EnvChange },
  ];
  const rows: Row[] = [
    [
      "SHELLCHECK_OPTS",
      () => ({ env: { SHELLCHECK_OPTS: "--exclude=SC2086" } }),
    ],
    [
      "リポの親の .shellcheckrc",
      (o) => ({ rc: `${o}/.shellcheckrc`, env: {} }),
    ],
    ["リポの親の shellcheckrc", (o) => ({ rc: `${o}/shellcheckrc`, env: {} })],
    [
      "HOME の .shellcheckrc",
      (_, h) => ({
        rc: `${h}/.shellcheckrc`,
        env: { HOME: h, DENO_DIR: denoDir },
      }),
    ],
    [
      "XDG_CONFIG_HOME の shellcheckrc",
      (_, h) => ({ rc: `${h}/shellcheckrc`, env: { XDG_CONFIG_HOME: h } }),
    ],
    [
      "XDG_CONFIG_HOME が未設定で HOME/.config の shellcheckrc",
      (_, h) => ({
        rc: `${h}/.config/shellcheckrc`,
        env: { HOME: h, DENO_DIR: denoDir, XDG_CONFIG_HOME: undefined },
      }),
    ],
  ];
  await Promise.all(
    rows.map(([name, place]) =>
      withTempDir((outer) =>
        withTempDir(async (home) => {
          const dir = `${outer}/repo`;
          await makeRepo(dir, { "bad.sh": bad });
          const { rc, env } = place(outer, home);
          if (rc !== undefined) {
            await Deno.mkdir(rc.slice(0, rc.lastIndexOf("/")), {
              recursive: true,
            });
            await Deno.writeTextFile(rc, "disable=SC2086\n");
          }
          const r = await runChecks(dir, "0", env);
          expect(
            name,
            r.code === 1 && r.stderr.includes(failedHead("shellcheck")) &&
              r.stderr.includes("SC2086"),
            r.stderr,
          );
        })
      )
    ),
  );
  deepStrictEqual(failures, []);
});

/** stdout に書けない行の fixture: 段が全部通るものと、落ちる段があるもの。 */
const writeFailFixtures: Record<string, string>[] = [{}, { "bad.sh": bad }];

Deno.test("引数・TMPDIR・出力の経路と順", async () => {
  const { failures, expect } = collector();
  await Promise.all([
    withRepo({}, async (dir) => {
      const r = await runChecks(dir, "2");
      expect(
        "引数が 0 か 1 でない",
        r.code === 2 && r.stderr.includes("引数は hook を揃えた結果"),
        r.stderr,
      );
    }),
    withRepo({}, async (dir) => {
      const r = await runChecks(dir, "0", { TMPDIR: "" });
      expect(
        "TMPDIR が空",
        r.code === 2 && r.stderr.includes("TMPDIR が空"),
        r.stderr,
      );
    }),
    withRepo({ "a_test.ts": 'Deno.test("t", () => {});\n' }, async (dir) => {
      const r = await runChecks(dir, "0", { TMPDIR: `${dir}/.git/nowhere` });
      expect(
        "deno test の段の TMPDIR を作れない",
        r.code === 1 && !r.stdout.includes("==") &&
          r.stderr.includes("deno test の段の TMPDIR を ") &&
          r.stderr.includes("の下に作れない") &&
          r.stderr.includes("検査の段は回していない"),
        r.stderr,
      );
    }),
    withRepo({ "a.ts": "export {};\n" }, async (dir) => {
      const r = await runChecks(dir, "0", { TMPDIR: `${dir}/.git/nowhere` });
      expect(
        "test が無ければ、TMPDIR に作れなくても通る",
        r.code === 0 && r.stdout.includes(passedHead("deno check")),
        `${r.stdout}\n${r.stderr}`,
      );
    }),
    ...["0", "1"].map((state) =>
      withRepo({}, async (dir) => {
        const r = await runChecks(dir, state);
        const stages = [
          "shellcheck",
          "deno fmt",
          "deno lint",
          "deno check",
          "deno test",
        ];
        expect(
          `対象のファイルが無い段は通る。引数が ${state}`,
          r.code === Number(state) && !r.stderr.includes("==") &&
            stages.every((name) =>
              r.stdout.includes(`${passedHead(name)}\n対象のファイルが無い\n`)
            ),
          `${r.stdout}\n${r.stderr}`,
        );
      })
    ),
    withRepo(
      { "bad.sh": bad, "fmt.ts": "export const a=1;\n" },
      async (dir) => {
        const r = await runChecks(dir, "0");
        const shellcheck = r.stderr.indexOf(failedHead("shellcheck"));
        const fmt = r.stderr.indexOf(failedHead("deno fmt"));
        expect(
          "通った段は stdout、落ちた段は stderr に steps の順",
          r.code === 1 && shellcheck >= 0 && fmt > shellcheck &&
            r.stdout.includes(passedHead("deno lint")) &&
            r.stdout.includes(passedHead("deno check")) &&
            !r.stdout.includes("落ちた") && !r.stdout.includes("bad.sh"),
          `${r.stdout}\n${r.stderr}`,
        );
      },
    ),
    withRepo({ "bad.sh": bad }, async (dir) => {
      const child = spawnChecks(dir, "0");
      await child.stdout.cancel();
      const [{ code }, stderr] = await Promise.all([
        child.status,
        new Response(child.stderr).text(),
      ]);
      expect(
        "stdout が閉じている (BrokenPipe)",
        code === 1 && stderr.includes(failedHead("shellcheck")) &&
          stderr.includes("./bad.sh") && !stderr.includes("書けない"),
        stderr,
      );
    }),
    // 書き込みの失敗は RLIMIT_FSIZE (ulimit -f) で起こす。Linux と macOS の両方で EFBIG になる (canon: facts/deno/stdout-write-error-kinds)
    ...writeFailFixtures.map((files) =>
      withRepo(files, async (dir) => {
        const r = await spawn("sh", {
          args: [
            "-c",
            'trap "" XFSZ; ulimit -f 0; exec "$@" >"$0"',
            `${dir}/.git/out`,
            "deno",
            ...checksArgs("0"),
          ],
          cwd: dir,
          env: { ...baseEnv, TMPDIR: fixtureTmp(dir) },
          clearEnv: true,
        }).output();
        const stderr = dec.decode(r.stderr);
        expect(
          `stdout に書けない (${Object.keys(files).join(" ")})`,
          r.code === 1 && stderr.includes("run-checks.ts: stdout に書けない") &&
            ("bad.sh" in files) === stderr.includes(failedHead("shellcheck")),
          stderr,
        );
      })
    ),
  ]);
  deepStrictEqual(failures, []);
});

Deno.test("段は指摘があれば落ちる: fmt・lint (recommended)・check・JSON と Markdown", async () => {
  await withRepo({
    "unused.ts": "const unused = 1;\nexport {};\n",
    // recommended の prefer-const に当たる (canon: facts/deno/lint-file-args-and-rules)
    "prefer.ts": "let q = 1;\nconsole.log(q);\nexport {};\n",
    "type.ts": 'const n: number = "s";\nexport { n };\n',
    "fmt.ts": "export const a=1;\n",
    "a.md": "[x](gone.md)\n",
  }, async (dir) => {
    const r = await runChecks(dir, "0");
    const section = (name: string) => {
      const start = r.stderr.indexOf(failedHead(name));
      if (start < 0) return "";
      const end = r.stderr.indexOf("\n== ", start + 1);
      return r.stderr.slice(start, end < 0 ? undefined : end);
    };
    deepStrictEqual({
      code: r.code,
      lint: section("deno lint").includes("no-unused-vars"),
      recommended: section("deno lint").includes("prefer-const"),
      fmt: section("deno fmt").includes("fmt.ts"),
      check: section("deno check").includes("TS2322"),
      markdown: section("JSON と Markdown").includes("a.md: リンク先が無い"),
    }, {
      code: 1,
      lint: true,
      recommended: true,
      fmt: true,
      check: true,
      markdown: true,
    }, r.stderr);
  });
});

Deno.test("deno の子の環境と --frozen-lockfile", async () => {
  // 次元: canon: facts/deno/environment-and-config-inputs の「結果を変える」の変数と、canon: facts/deno/frozen-lockfile-subcommands の subcommand
  const resultVars = [
    "DENO_COMPAT",
    "DENO_CONDITIONS",
    "DENO_COVERAGE_DIR",
    "DENO_TSC_BIN",
    "DENO_V8_FLAGS",
  ];
  await withRepo({
    "a.ts": "export {};\n",
    "a_test.ts": 'Deno.test("t", () => {});\n',
    "a.md": "",
  }, async (dir) => {
    const g = `${dir}/.git`;
    const calls = `${g}/calls`;
    await Deno.mkdir(calls);
    // run-checks.ts 自身の起動は記録しない。記録は 1 行目が引数、続く行が変数ごとの値 (無ければ <名前>=-)
    const bin = await fakePath(dir, {
      deno: [
        "#!/bin/sh",
        `case " $* " in *" ${root}/scripts/run-checks.ts "*) ;; *)`,
        `  { echo "$*"; for v in DENO_NO_PACKAGE_JSON ${
          resultVars.join(" ")
        }; do printenv "$v" || echo "$v=-"; done; } > "${calls}/$$" ;;`,
        "esac",
        `exec "${which("deno")}" "$@"`,
      ].join("\n"),
    });
    const r = await runChecks(dir, "0", {
      PATH: `${bin}:${baseEnv.PATH}`,
      DENO_COMPAT: "1",
      DENO_CONDITIONS: "probe",
      DENO_COVERAGE_DIR: `${g}/coverage`,
      DENO_TSC_BIN: `${g}/no-tsc`,
      DENO_V8_FLAGS: "--stack-size=2000",
    });
    const got: Record<string, { frozen: boolean; env: string[] }> = {};
    for await (const e of Deno.readDir(calls)) {
      const [args, ...env] = (await Deno.readTextFile(`${calls}/${e.name}`))
        .trimEnd().split("\n");
      got[args.split(" ")[0]] = {
        frozen: args.split(" ").includes("--frozen-lockfile"),
        env,
      };
    }
    const env = ["1", ...resultVars.map((v) => `${v}=-`)];
    deepStrictEqual(got, {
      fmt: { frozen: false, env },
      lint: { frozen: false, env },
      check: { frozen: true, env },
      test: { frozen: true, env },
      info: { frozen: false, env },
      run: { frozen: true, env },
    }, `exit ${r.code}\n${r.stderr}`);
  });
});

/** import の構文と、deno info の指定子に入る (数える) か。範囲は canon: facts/deno/info-json-dependencies。 */
const syntaxes: [(key: string) => string, string, boolean][] = [
  [(k) => `import x from "${k}";\nconsole.log(x);\n`, "default", true],
  [(k) => `import "${k}";\n`, "side-effect", true],
  [(k) => `export * from "${k}";\n`, "export-star", true],
  [(k) => `export { y } from "${k}";\n`, "export-named", true],
  [(k) => `import type { Z } from "${k}";\nexport type W = Z;\n`, "type", true],
  [
    (k) => `import { type Z } from "${k}";\nexport type W = Z;\n`,
    "inline-type",
    true,
  ],
  [(k) => `await import("${k}");\n`, "dynamic", true],
  [(k) => `await import(\`${k}\`);\n`, "dynamic-template", true],
  [(k) => `// import "${k}";\nexport {};\n`, "comment", false],
  [(k) => `export const s = 'import "${k}"';\n`, "string", false],
  [(k) => `/// <reference types="${k}" />\nexport {};\n`, "reference", true],
  [
    (k) => `// head\n/// <reference types="${k}" />\nexport {};\n`,
    "reference-second-line",
    true,
  ],
  [
    (k) => `export {};\n/// <reference types="${k}" />\n`,
    "reference-after-statement",
    false,
  ],
  [
    (k) => `/** @import { Q } from "${k}" */\nexport {};\n`,
    "jsdoc-import",
    false,
  ],
  [(k) => `const n = "${k}";\nawait import(n);\n`, "dynamic-variable", false],
];

Deno.test("deno.json の imports の未使用の判定", async () => {
  const { failures, expect } = collector();
  await Promise.all([
    withRepo({
      "deno.json": JSON.stringify({
        imports: { a: "./lib/a.ts", "dir/": "./lib/", unused: "./lib/u.ts" },
      }),
      "lib/a.ts": "export const a = 1;\n",
      "lib/b.ts": "export const b = 1;\n",
      "lib/u.ts": "export const u = 1;\n",
      "main.ts":
        'import { a } from "a";\nimport { b } from "dir/b.ts";\nconsole.log(a, b);\n',
    }, async (dir) => {
      const r = await runChecks(dir, "0");
      expect(
        "使うキー・接頭辞のキーは通り、使わないキーは落ちる",
        r.code === 1 && r.stderr.includes(failedHead("deno.json の imports")) &&
          r.stderr.includes('imports の "unused" が、どの .ts の') &&
          !r.stderr.includes('"a" が、どの') &&
          !r.stderr.includes('"dir/" が、どの') &&
          r.stdout.includes(passedHead("deno check")),
        `${r.stdout}\n${r.stderr}`,
      );
    }),
    withRepo({
      "deno.json": JSON.stringify({
        imports: Object.fromEntries(
          syntaxes.map(([, key]) => [key, "./lib/t.ts"]),
        ),
      }),
      "lib/t.ts":
        "export default 1;\nexport const y = 1;\nexport type Z = number;\n",
      ...Object.fromEntries(
        syntaxes.map(([code, key], i) => [`s${i}.ts`, code(key)]),
      ),
    }, async (dir) => {
      const r = await runChecks(dir, "0");
      const wrong = syntaxes.filter(([, key, counted]) =>
        r.stderr.includes(`imports の "${key}" が、どの .ts の`) === counted
      ).map(([, key]) => key);
      expect(
        `数える構文と数えない構文 (違ったもの: ${wrong.join(" ")})`,
        wrong.length === 0,
        r.stderr,
      );
    }),
    withRepo({
      "deno.json": '{"imports": {"x": "./x.ts"}}',
      "x.ts": "export {};\n",
      "main.ts": 'import "x";\n',
    }, async (dir) => {
      const real = which("deno");
      const r = await runChecks(dir, "0", {
        PATH: `${await fakePath(dir, {
          deno:
            `#!/bin/sh\n[ "$1" = info ] && { echo boom >&2; exit 4; }\nexec "${real}" "$@"\n`,
        })}:${baseEnv.PATH}`,
      });
      expect(
        "deno info が非 0 なら未使用の判定をしない",
        r.code === 1 && r.stderr.includes(failedHead("deno.json の imports")) &&
          r.stderr.includes(
            "main.ts: deno info が exit 4。下のエラーを直す\nboom",
          ) &&
          r.stderr.includes("未使用の判定はしていない") &&
          !r.stderr.includes("見つからない"),
        r.stderr,
      );
    }),
    ...[
      ["構文が壊れている", "import x from 'x';\nconst = ;\n", "SyntaxError"],
      [
        "相対 import 先が無い",
        'import "x";\nimport "./missing.ts";\n',
        "Module not found",
      ],
    ].map(([name, code, error]) =>
      withRepo({
        "deno.json": '{"imports": {"x": "./x.ts"}}',
        "x.ts": "export {};\n",
        "main.ts": code,
      }, async (dir) => {
        const r = await runChecks(dir, "0");
        expect(
          `deno info の file: の module の error があれば未使用の判定をしない (${name})`,
          r.code === 1 && r.stderr.includes(error) &&
            r.stderr.includes("未使用の判定はしていない") &&
            !r.stderr.includes("見つからない"),
          r.stderr,
        );
      })
    ),
    withRepo({
      "deno.json": '{"imports": {"x": "./x.ts"}}',
      "x.ts": "export {};\n",
      "main.ts": 'import "x";\nimport "npm:left-pad@1.3.0";\n',
    }, async (dir) => {
      // deno check が npm から取ろうとするのを、届かない registry ですぐ落とす
      const r = await runChecks(dir, "0", {
        NPM_CONFIG_REGISTRY: "http://127.0.0.1:9/",
      });
      expect(
        "npm: の module の error (--no-npm) は報告しない",
        r.stdout.includes(passedHead("deno.json の imports")) &&
          !r.stderr.includes("--no-npm is specified"),
        `${r.stdout}\n${r.stderr}`,
      );
    }),
  ]);
  deepStrictEqual(failures, []);
});

const install = "releases/tag/v0.11.0";
const probes: [string, Record<string, string>, string][] = [
  ["無い", {}, "shellcheck が PATH に無い"],
  [
    "--version が非 0",
    { shellcheck: "#!/bin/sh\necho boom >&2\nexit 3\n" },
    "shellcheck --version から版が読めない (exit 3)\nboom",
  ],
  [
    "version: の行が無い",
    { shellcheck: "#!/bin/sh\necho nothing\n" },
    "shellcheck --version から版が読めない (exit 0)\nnothing",
  ],
  [
    "版が違う",
    { shellcheck: "#!/bin/sh\necho 'version: 0.9.0'\n" },
    "shellcheck の版が 0.9.0 で、0.11.0 でない",
  ],
];

/** 段より前の git の呼び方 (run-checks.ts が渡す引数) と、落ちたときに出す名前。 */
const gitCalls: [string, string][] = [
  ["rev-parse --local-env-vars", "git rev-parse --local-env-vars"],
  ["ls-files -z -s -t --cached", "git ls-files --cached"],
  ["ls-files -z --others --exclude-standard", "git ls-files --others"],
  ["ls-files -z --deleted", "git ls-files --deleted"],
];

/** git に追跡させてから作業ツリーを変え、処理できない項目として出るものの行: 名前、作り方、出る行。 */
const trackedKinds: [string, (dir: string) => Promise<unknown>, string][] = [
  [
    "ファイルへの symlink",
    (dir) => ln("f.ts", `${dir}/link.ts`),
    "- link.ts: 追跡された symlink",
  ],
  [
    "ディレクトリへの symlink",
    (dir) => ln("d", `${dir}/dirlink.ts`),
    "- dirlink.ts: 追跡された symlink",
  ],
  [
    "壊れた symlink",
    (dir) => ln("nowhere", `${dir}/dangling.ts`),
    "- dangling.ts: 追跡された symlink",
  ],
  [
    "gitlink",
    async (dir) => {
      await run("git", ["init", "-q", "--template=", `${dir}/sub`]);
      await run("git", [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.com",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "x",
      ], `${dir}/sub`);
    },
    "- sub: gitlink (サブモジュール)",
  ],
];

Deno.test("段より前の確かめ: shellcheck の版、git ls-files、項目の種類、作業ツリーに無い追跡ファイル", async () => {
  const { failures, expect } = collector();
  const unstaged = (r: Awaited<ReturnType<typeof runChecks>>) =>
    r.code === 1 && !r.stdout.includes("==") && !r.stderr.includes("==") &&
    r.stderr.includes("検査の段は回していない");
  const commit = (dir: string) =>
    run("git", [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "commit",
      "-q",
      "-m",
      "x",
    ], dir);
  await Promise.all([
    ...probes.map(([name, fakes, message]) =>
      withRepo({ "a.sh": "#!/bin/sh\n" }, async (dir) => {
        const r = await runChecks(dir, "0", {
          PATH: await fakePath(dir, fakes),
        });
        expect(
          name,
          unstaged(r) && r.stderr.includes(message) &&
            r.stderr.includes(install),
          r.stdout + r.stderr,
        );
      })
    ),
    ...gitCalls.map(([args, shown]) =>
      withRepo({}, async (dir) => {
        const r = await runChecks(dir, "0", {
          PATH: `${await fakePath(dir, {
            git: [
              "#!/bin/sh",
              `[ "$*" = "${args}" ] && { echo boom >&2; exit 3; }`,
              `exec "${which("git")}" "$@"`,
            ].join("\n"),
          })}:${baseEnv.PATH}`,
        });
        expect(
          `${shown} が非 0`,
          unstaged(r) &&
            r.stderr.includes(`${shown} が exit 3。下のエラーを直す\nboom`),
          r.stdout + r.stderr,
        );
      })
    ),
    withRepo({ "f.ts": "export {};\n" }, async (dir) => {
      for (const name of ["tool", "x.SH", "hooks/pre-push", "ok.sh"]) {
        await Deno.mkdir(`${dir}/${name.slice(0, name.lastIndexOf("/") + 1)}`, {
          recursive: true,
        });
        await Deno.writeTextFile(`${dir}/${name}`, "#!/bin/sh\n", {
          mode: 0o755,
        });
      }
      await run("git", ["add", "-A"], dir);
      const r = await runChecks(dir, "0");
      const listed = (name: string) =>
        r.stderr.includes(`- ${name}: 検査の段が無い名前`);
      expect(
        "検査の段が無い名前の実行ファイル (hooks/pre-push を除く)",
        unstaged(r) && listed("tool") && listed("x.SH") &&
          !listed("hooks/pre-push") && !listed("ok.sh") &&
          !r.stderr.includes("- f.ts"),
        r.stdout + r.stderr,
      );
    }),
    withRepo({}, async (dir) => {
      const entries = [
        "H 100644 e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 0\tok.ts",
        "H e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 0\tnomode.ts",
        "H 100600 e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 0\todd.ts",
        "notab.ts",
      ];
      const r = await runChecks(dir, "0", {
        PATH: `${await fakePath(dir, {
          git: [
            "#!/bin/sh",
            `[ "$*" = "ls-files -z -s -t --cached" ] && { printf '${
              entries.map((e) => `${e}\\0`).join("")
            }'; exit 0; }`,
            `exec "${which("git")}" "$@"`,
          ].join("\n"),
        })}:${baseEnv.PATH}`,
      });
      expect(
        "git ls-files -s -t の項目の形と mode",
        unstaged(r) &&
          r.stderr.includes(
            "- nomode.ts: git ls-files -s -t の項目の形でない",
          ) &&
          r.stderr.includes(
            "- notab.ts: git ls-files -s -t の項目の形でない",
          ) &&
          r.stderr.includes("- odd.ts: 想定外の mode (100600)") &&
          !r.stderr.includes("- ok.ts"),
        r.stdout + r.stderr,
      );
    }),
    withRepo({}, async (dir) => {
      await run("git", ["init", "-q", "--template=", `${dir}/nested`]);
      const r = await runChecks(dir, "0");
      expect(
        "未追跡の入れ子のリポジトリ",
        unstaged(r) &&
          r.stderr.includes(
            "処理できない項目がある:\n- nested/: 未追跡の入れ子のリポジトリ",
          ),
        r.stdout + r.stderr,
      );
    }),
    ...trackedKinds.map(([name, make, line]) =>
      withRepo(
        { "f.ts": "export {};\n", "d/x.ts": "export {};\n" },
        async (dir) => {
          await make(dir);
          await run("git", ["add", "-A"], dir);
          const r = await runChecks(dir, "0");
          expect(
            name,
            unstaged(r) && r.stderr.includes(line) &&
              !r.stderr.includes("- f.ts") && !r.stderr.includes("- d/x.ts"),
            r.stdout + r.stderr,
          );
        },
      )
    ),
    withRepo({ "s.ts": "export {};\n" }, async (dir) => {
      await run("git", ["add", "-A"], dir);
      await commit(dir);
      await run("git", ["update-index", "--skip-worktree", "s.ts"], dir);
      await Deno.remove(`${dir}/s.ts`);
      const r = await runChecks(dir, "0");
      expect(
        "作業ツリーから消した skip-worktree の項目",
        unstaged(r) && r.stderr.includes("- s.ts: skip-worktree の項目"),
        r.stdout + r.stderr,
      );
    }),
    withRepo({ "c.ts": "export const c = 0;\n" }, async (dir) => {
      const commitAs = async (content: string) => {
        await Deno.writeTextFile(`${dir}/c.ts`, content);
        await run("git", ["add", "-A"], dir);
        await commit(dir);
      };
      await commitAs("export const c = 0;\n");
      await run("git", ["checkout", "-q", "-b", "other"], dir);
      await commitAs("export const c = 1;\n");
      await run("git", ["checkout", "-q", "-"], dir);
      await commitAs("export const c = 2;\n");
      // 衝突して非 0 で終わる
      await run("git", [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.com",
        "merge",
        "-q",
        "other",
      ], dir).catch(() => {});
      const r = await runChecks(dir, "0");
      expect(
        "解決していない merge の項目",
        unstaged(r) &&
          r.stderr.split("- c.ts: 解決していない merge の項目").length === 2,
        r.stdout + r.stderr,
      );
    }),
    withTempDir((other) =>
      withRepo({ "bad.sh": bad }, async (dir) => {
        await run("git", ["init", "-q", "--template=", other]);
        const r = await runChecks(dir, "0", {
          GIT_DIR: `${other}/.git`,
          GIT_WORK_TREE: other,
          GIT_INDEX_FILE: `${other}/.git/index`,
        });
        expect(
          "git の場所を決める変数が別のリポを指していても、cwd のリポを見る",
          r.stderr.includes(failedHead("shellcheck")) &&
            r.stderr.includes("./bad.sh"),
          r.stdout + r.stderr,
        );
      })
    ),
    withRepo(
      { "gone.ts": "export {};\n", "kept.ts": "export {};\n" },
      async (dir) => {
        await run("git", ["add", "-A"], dir);
        await Deno.remove(`${dir}/gone.ts`);
        const r = await runChecks(dir, "0");
        expect(
          "作業ツリーに無い追跡ファイル",
          unstaged(r) &&
            r.stderr.includes(
              "作業ツリーに無い追跡ファイルがある。戻すか git rm する: gone.ts",
            ),
          r.stdout + r.stderr,
        );
      },
    ),
  ]);
  deepStrictEqual(failures, []);
});

/** 名前の先頭の U+FEFF を落とさない (canon: facts/git/path-output-quoting)。 */
const keepBom = new TextDecoder("utf-8", { ignoreBOM: true });

Deno.test("名前: 処理できない名前があれば段の前で名前を出して落ち、他は ./ を前置して検査する", async () => {
  /*
   * 次元:
   * - canon: facts/git/path-output-quoting: UTF-8 として不正・改行・BOM・"・\・タブ。
   * - canon: facts/deno/check-file-args-glob: *・?・先頭の -・!・npm:。
   */
  const prefixes: [number[], string][] = [
    [[], ""],
    [[0xef, 0xbb, 0xbf], "\\xef\\xbb\\xbf"],
    [[0x2d], "-"],
    [[0x21], "!"],
    [[...enc.encode("npm:")], "npm:"],
  ];
  /** 処理する名前の中に入る片。 */
  const mids: [number[], string][] = [
    [[], ""],
    [[0x22], '"'],
    [[0x5c], "\\x5c"],
    [[0x09], "\\x09"],
  ];
  const bads: [number[], string][] = [
    [[0x0a], "\\x0a"],
    [[0x2a], "*"],
    [[0x3f], "?"],
    [[0xff], "\\xff"],
  ];
  const nameArb = fc.record({
    prefix: fc.constantFrom(...prefixes),
    mid: fc.constantFrom(...mids),
    bad: fc.oneof(
      { arbitrary: fc.constant(null), weight: 4 },
      { arbitrary: fc.constantFrom(...bads), weight: 1 },
    ),
    ext: fc.constantFrom(".sh", ".ts"),
  }).map(({ prefix, mid, bad, ext }) => ({
    bytes: new Uint8Array([
      ...prefix[0],
      0x6e,
      ...mid[0],
      ...(bad?.[0] ?? []),
      ...enc.encode(ext),
    ]),
    escaped: `${prefix[1]}n${mid[1]}${bad?.[1] ?? ""}${ext}`,
    bad: bad !== null,
    ext,
  }));
  await fc.assert(
    fc.asyncProperty(
      fc.uniqueArray(nameArb, {
        minLength: 1,
        maxLength: 3,
        selector: (n) => n.escaped,
      }),
      (names) =>
        withRepo({}, async (dir) => {
          for (const n of names) {
            if (n.bytes.includes(0xff)) {
              // 不正な UTF-8 の名前は Deno の文字列で表せないので、index にだけ入れる
              await run("sh", [
                "-c",
                'git update-index --add --cacheinfo "100644,$(git hash-object -w --stdin </dev/null),$(printf "$1")"',
                "sh",
                Array.from(
                  n.bytes,
                  (b) => `\\${b.toString(8).padStart(3, "0")}`,
                )
                  .join(""),
              ], dir);
            } else {
              await Deno.writeTextFile(
                `${dir}/${keepBom.decode(n.bytes)}`,
                n.ext === ".sh" ? bad : "export const a=1;\n",
              );
            }
          }
          const r = await runChecks(dir, "0");
          const anyBad = names.some((n) => n.bad);
          const listed = (n: (typeof names)[number]) =>
            r.stderr.includes(`\n- ${n.escaped}: `);
          const checked = (n: (typeof names)[number]) => {
            const name = keepBom.decode(n.bytes);
            return n.ext === ".sh"
              ? r.stderr.includes(`In ./${name} line 2`)
              : r.stderr.includes(`/${name}:`);
          };
          deepStrictEqual(
            {
              code: r.code,
              staged: r.stderr.includes("== "),
              names: names.map((n) =>
                anyBad ? (n.bad ? listed(n) : !listed(n)) : checked(n)
              ),
            },
            { code: 1, staged: !anyBad, names: names.map(() => true) },
            r.stderr,
          );
        }),
    ),
    { numRuns: 10, includeErrorInReport: true },
  );
});

const poll = async (found: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i++) {
    if (await found()) return true;
    await sleep(100);
  }
  return false;
};
const exists = (path: string) =>
  Deno.stat(path).then(() => true, (e) => {
    if (e instanceof Deno.errors.NotFound) return false;
    throw e;
  });
const version =
  "case \" $* \" in *' --version '*) echo 'version: 0.11.0'; exit 0 ;; esac";

/** 終わった子への ChildProcess.kill は TypeError を投げる (canon: facts/deno/command-spawn) ので、それだけを捕まえる。 */
const killChild = (child: Deno.ChildProcess, signal: Deno.Signal) => {
  try {
    child.kill(signal);
  } catch (e) {
    if (!(e instanceof TypeError)) throw e;
  }
};

/** 中断の test で、run-checks.ts が終わってから survived を確かめるまでの待ち。 */
const afterMs = 3500;

/**
 * fake の shellcheck を段で回し、started が出たら signals を送る。返す値:
 * - started: fake が started を書いたか。
 * - code・stdout・stderr: run-checks.ts の結果。
 * - secs: 最初のシグナルから終わるまでの秒。
 * - terminated: fake が TERM の trap で terminated を書いたか。
 * - survived: afterMs の後に survived が書かれていたか。
 */
async function interrupt(
  shellcheck: (dir: string) => string,
  signals: Deno.Signal[],
) {
  return await withRepo({ "a.sh": "#!/bin/sh\n" }, async (dir) => {
    const g = `${dir}/.git`;
    const bin = await fakePath(dir, { shellcheck: shellcheck(g) });
    const child = spawnChecks(dir, "0", { PATH: `${bin}:${baseEnv.PATH}` });
    const started = await poll(() => exists(`${g}/started`));
    const sent = performance.now();
    for (const [i, signal] of signals.entries()) {
      if (i > 0) await sleep(200);
      killChild(child, signal);
    }
    const r = await child.output();
    const secs = (performance.now() - sent) / 1000;
    await sleep(afterMs);
    return {
      started,
      code: r.code,
      stdout: dec.decode(r.stdout),
      stderr: dec.decode(r.stderr),
      secs,
      terminated: await exists(`${g}/terminated`),
      survived: await exists(`${g}/survived`),
    };
  });
}

/** 受けるシグナルと、それで終わるときの終了コード。 */
const signalCodes: [Deno.Signal, number][] = [
  ["SIGHUP", 129],
  ["SIGINT", 130],
  ["SIGTERM", 143],
];
/** TERM を無視する先頭に送る列。2 回目のシグナルは何もしない。 */
const termThenOthers: Deno.Signal[][] = [["SIGTERM"], ["SIGTERM", "SIGINT"]];
/** fake が g の下に印のファイル name を書く shell の文。 */
const mark = (g: string, name: string) => `echo > "${g}/${name}"`;

Deno.test("中断: 段のグループを空にし、128 + シグナルの番号で終わる", async () => {
  const { failures, expect } = collector();
  const quiet = (r: { stdout: string; stderr: string }) =>
    r.stdout === "" && !r.stderr.includes("==");
  await Promise.all([
    // 段の最中。先頭は TERM で終わり、孫は TERM で止まる
    ...signalCodes.map(([signal, code]) =>
      interrupt(
        (g) =>
          [
            "#!/bin/sh",
            version,
            `trap '${mark(g, "terminated")}; exit 143' TERM`,
            `(sleep 3; ${mark(g, "survived")}) &`,
            mark(g, "started"),
            "wait",
          ].join("\n"),
        [signal],
      ).then((r) =>
        expect(
          `段の最中の ${signal}`,
          r.started && r.code === code && quiet(r) && r.terminated &&
            !r.survived,
          JSON.stringify(r),
        )
      )
    ),
    // 先頭は TERM で終わったが、TERM を無視する孫が出力の pipe を開いたまま残る
    interrupt(
      (g) =>
        [
          "#!/bin/sh",
          version,
          "trap 'exit 143' TERM",
          `(trap '' TERM; sleep 5; ${mark(g, "survived")}) &`,
          mark(g, "started"),
          "wait",
        ].join("\n"),
      ["SIGTERM"],
    ).then((r) =>
      expect(
        "孫が残る",
        r.started && r.code === 143 && quiet(r) && !r.survived && r.secs >= 1.5,
        JSON.stringify(r),
      )
    ),
    // 先頭が TERM を無視する。2 回目のシグナル (SIGINT) は何もしない
    ...termThenOthers.map((signals) =>
      interrupt(
        (g) =>
          [
            "#!/bin/sh",
            version,
            "trap '' TERM",
            mark(g, "started"),
            "sleep 5",
            mark(g, "survived"),
          ].join("\n"),
        signals,
      ).then((r) =>
        expect(
          `TERM を無視する先頭 (${signals.join(" → ")})`,
          r.started && r.code === 143 && quiet(r) && !r.survived &&
            r.secs >= 1.5,
          JSON.stringify(r),
        )
      )
    ),
    // 段より前 (git ls-files の最中)
    withRepo({}, async (dir) => {
      const g = `${dir}/.git`;
      const bin = await fakePath(dir, {
        git: [
          "#!/bin/sh",
          `if [ "$*" = "ls-files -z -s -t --cached" ]; then ${
            mark(g, "started")
          }; sleep 4; ${mark(g, "survived")}; exit 0; fi`,
          `exec "${which("git")}" "$@"`,
        ].join("\n"),
        shellcheck: `#!/bin/sh\n${version}\n`,
      });
      const child = spawnChecks(dir, "0", { PATH: bin });
      const started = await poll(() => exists(`${g}/started`));
      killChild(child, "SIGTERM");
      const r = await child.output();
      await sleep(4500);
      const got = {
        started,
        code: r.code,
        stdout: dec.decode(r.stdout),
        stderr: dec.decode(r.stderr),
        survived: await exists(`${g}/survived`),
      };
      expect(
        "段より前",
        JSON.stringify(got) ===
          JSON.stringify({
            started: true,
            code: 143,
            stdout: "",
            stderr: "",
            survived: false,
          }),
        JSON.stringify(got),
      );
    }),
    // deno test の段。TERM を無視する孫が TMPDIR に書き続けても、TMPDIR は残らない
    withRepo({}, async (dir) => {
      // 孫のループと test の待ちは、run-checks.ts が猶予の後に止めるより長く、lifetimeMs より短い
      await writeFiles(dir, {
        "wait_test.ts": [
          'Deno.test("w", async () => {',
          '  const tmp = Deno.env.get("TMPDIR");',
          '  new Deno.Command("sh", {',
          `    args: ["-c", \`trap "" TERM; i=0; while [ $i -lt 100 ]; do echo > "\${tmp}/f.$$"; sleep 0.05; i=$((i + 1)); done\`],`,
          "  }).spawn();",
          '  await Deno.writeTextFile(`${tmp}/started`, "");',
          "  await new Promise((r) => setTimeout(r, 5000));",
          "});",
          "",
        ].join("\n"),
      });
      const child = spawnChecks(dir, "0");
      let testTmp: string | undefined;
      const started = await poll(async () => {
        for await (const e of Deno.readDir(fixtureTmp(dir))) {
          const path = `${fixtureTmp(dir)}/${e.name}`;
          if (await exists(`${path}/started`)) {
            testTmp = path;
            return true;
          }
        }
        return false;
      });
      killChild(child, "SIGTERM");
      const r = await child.output();
      await sleep(500);
      expect(
        "deno test の段の TMPDIR",
        started && r.code === 143 && dec.decode(r.stdout) === "" &&
          testTmp !== undefined && !await exists(testTmp),
        JSON.stringify({ started, code: r.code, testTmp }),
      );
    }),
  ]);
  deepStrictEqual(failures, []);
});

Deno.test("段が普通に終わると、残った孫を止め、deno test の段の TMPDIR を消す", async () => {
  await withRepo({
    "a.sh": "#!/bin/sh\n",
    "ok_test.ts":
      'Deno.test("ok", () => console.log(`TESTTMP=${Deno.env.get("TMPDIR")}`));\n',
  }, async (dir) => {
    const g = `${dir}/.git`;
    const bin = await fakePath(dir, {
      shellcheck: [
        "#!/bin/sh",
        version,
        `(sleep 1; ${mark(g, "survived")}) >/dev/null 2>&1 &`,
        "exit 0",
      ].join("\n"),
    });
    const r = await runChecks(dir, "0", { PATH: `${bin}:${baseEnv.PATH}` });
    const testTmp = r.stdout.match(/TESTTMP=(.*)/)?.[1];
    await sleep(1500);
    deepStrictEqual(
      {
        code: r.code,
        testTmp: testTmp?.startsWith(`${fixtureTmp(dir)}/run-checks-`),
        left: testTmp !== undefined && await exists(testTmp),
        survived: await exists(`${g}/survived`),
      },
      { code: 0, testTmp: true, left: false, survived: false },
      r.stderr,
    );
  });
});

Deno.test("段の子孫がグループを抜けて出力の pipe を持ったまま残っても、段は上限の内に落ちる", async () => {
  await withRepo({ "a.sh": "#!/bin/sh\n" }, async (dir) => {
    // グループは deno の detached (子で setsid する) で抜ける。Linux と macOS の両方にある (setsid のコマンドは util-linux のもの。canon: facts/macos/no-setsid-command)。抜けたものは lifetimeMs で終わる
    const escape = `new Deno.Command("sleep", { args: ["${
      lifetimeMs / 1000
    }"], detached: true, stdin: "null" }).spawn().unref();`;
    const bin = await fakePath(dir, {
      shellcheck: ["#!/bin/sh", version, `deno eval '${escape}'`, "exit 0"]
        .join("\n"),
    });
    const start = performance.now();
    const r = await runChecks(dir, "0", { PATH: `${bin}:${baseEnv.PATH}` });
    const secs = (performance.now() - start) / 1000;
    deepStrictEqual(
      {
        code: r.code,
        failed: r.stderr.includes(failedHead("shellcheck")),
        message:
          /shellcheck の出力の pipe が、グループを空にしてから \d+ ms の内に閉じない。/
            .test(r.stderr),
        bounded: secs < 15,
      },
      { code: 1, failed: true, message: true, bounded: true },
      `${secs}s\n${r.stderr}`,
    );
  });
});
