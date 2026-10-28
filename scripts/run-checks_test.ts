/**
 * run-checks.ts を子として、TMPDIR の下の一時ディレクトリの fixture のリポで回す。
 * - fixture は git のリポ。run-checks.ts が読む deno.json を必ず置く。
 * - run-checks.ts に渡す deno の引数は、verify.sh が exec する引数 (verifyFlags) を使う。PATH の先に置いた fake の deno に、verify.sh の exec の引数を書かせて得る。
 * - fake (shellcheck・git) は git・deno・sleep の symlink と同じ dir に置き、PATH の先頭にする。PATH から本物の shellcheck を外す test (段より前の確かめ) は、PATH をその dir だけにする。
 * - symlink は ln -s で作る。deno test の段の --allow-write は TMPDIR に絞ってあり、Deno.symlink は絞らない read・write を要る (canon: facts/deno/symlink-requires-unscoped-permissions)。
 * - 子の環境は、このプロセスの環境から git の場所を決める変数 (canon: facts/git/local-env-vars-and-hook-env) を消し、利用者の git の設定を読まないもの。
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

const which = (name: string): string => {
  for (const dir of (baseEnv.PATH ?? "").split(":")) {
    try {
      Deno.statSync(`${dir}/${name}`);
      return `${dir}/${name}`;
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
  }
  throw new Error(`${name} が PATH に無い`);
};

const withTempDir = async <T>(fn: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await Deno.makeTempDir({ dir: tmpdir });
  try {
    return await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
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
    await Deno.writeTextFile(`${dir}/${path}`, content, { mode: 0o755 });
  }
}

/** dir に fixture のリポを作る。 */
async function makeRepo(dir: string, files: Record<string, string>) {
  await run("git", ["init", "-q", "--template=", dir]);
  await writeFiles(dir, { "deno.json": "{}", ...files });
}

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

const spawnChecks = (dir: string, state: string, change: EnvChange = {}) => {
  const env = { ...baseEnv, ...change };
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete env[name];
  }
  return spawn("deno", {
    args: ["run", ...verifyFlags, `${root}/scripts/run-checks.ts`, state],
    cwd: dir,
    env: env as Record<string, string>,
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

/** git・deno・sleep と、fakes (名前 → 中身) だけを置いた PATH の dir を作る。 */
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
  const disable = "disable=SC2086\n";
  const rows: [string, (outer: string) => Promise<EnvChange>][] = [
    [
      "SHELLCHECK_OPTS",
      () => Promise.resolve({ SHELLCHECK_OPTS: "--exclude=SC2086" }),
    ],
    ["リポの親の .shellcheckrc", async (outer) => {
      await Deno.writeTextFile(`${outer}/.shellcheckrc`, disable);
      return {};
    }],
    ["リポの親の shellcheckrc", async (outer) => {
      await Deno.writeTextFile(`${outer}/shellcheckrc`, disable);
      return {};
    }],
    ["HOME の .shellcheckrc", async (outer) => {
      await Deno.writeTextFile(`${outer}/.shellcheckrc`, disable);
      return { HOME: outer, DENO_DIR: denoDir };
    }],
    ["XDG_CONFIG_HOME の shellcheckrc", async (outer) => {
      await Deno.writeTextFile(`${outer}/shellcheckrc`, disable);
      return { XDG_CONFIG_HOME: outer };
    }],
    [
      "XDG_CONFIG_HOME が未設定で HOME/.config の shellcheckrc",
      async (outer) => {
        await writeFiles(outer, { ".config/shellcheckrc": disable });
        return { HOME: outer, DENO_DIR: denoDir, XDG_CONFIG_HOME: undefined };
      },
    ],
  ];
  await Promise.all(rows.map(([name, prepare]) =>
    withTempDir(async (outer) => {
      const dir = `${outer}/repo`;
      await makeRepo(dir, { "bad.sh": bad });
      const r = await runChecks(dir, "0", await prepare(outer));
      expect(
        name,
        r.code === 1 && r.stderr.includes("== shellcheck: 落ちた") &&
          r.stderr.includes("SC2086"),
        r.stderr,
      );
    })
  ));
  deepStrictEqual(failures, []);
});

Deno.test("引数・TMPDIR・出力の経路と順", async () => {
  const { failures, expect } = collector();
  await Promise.all([
    withRepo({}, async (dir) => {
      const r = await runChecks(dir, "2");
      expect(
        "引数が 0 か 1 でない",
        r.code === 1 && r.stderr.includes("引数は hook を揃えた結果"),
        r.stderr,
      );
    }),
    withRepo({}, async (dir) => {
      const r = await runChecks(dir, "0", { TMPDIR: "" });
      expect(
        "TMPDIR が空",
        r.code === 1 && r.stderr.includes("TMPDIR が空"),
        r.stderr,
      );
    }),
    withRepo(
      { "bad.sh": bad, "fmt.ts": "export const a=1;\n" },
      async (dir) => {
        const r = await runChecks(dir, "0");
        const shellcheck = r.stderr.indexOf("== shellcheck: 落ちた");
        const fmt = r.stderr.indexOf("== deno fmt: 落ちた");
        expect(
          "通った段は stdout、落ちた段は stderr に steps の順",
          r.code === 1 && shellcheck >= 0 && fmt > shellcheck &&
            r.stdout.includes("== deno lint: 通った") &&
            r.stdout.includes("== deno check: 通った") &&
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
        code === 1 && stderr.includes("== shellcheck: 落ちた") &&
          stderr.includes("./bad.sh") && !stderr.includes("書けない"),
        stderr,
      );
    }),
    ...([{}, { "bad.sh": bad }] as Record<string, string>[]).map((files) =>
      withRepo(files, async (dir) => {
        const r = await spawn("sh", {
          args: [
            "-c",
            'exec "$@" >/dev/full',
            "sh",
            "deno",
            "run",
            ...verifyFlags,
            `${root}/scripts/run-checks.ts`,
            "0",
          ],
          cwd: dir,
          env: baseEnv,
          clearEnv: true,
        }).output();
        const stderr = dec.decode(r.stderr);
        expect(
          `stdout に書けない (${Object.keys(files).join(" ")})`,
          r.code === 1 && stderr.includes("run-checks.ts: stdout に書けない") &&
            ("bad.sh" in files) === stderr.includes("== shellcheck: 落ちた"),
          stderr,
        );
      })
    ),
  ]);
  deepStrictEqual(failures, []);
});

Deno.test("deno の段: lint は no-unused-vars だけ、fmt と check は落とす", async () => {
  await withRepo({
    "unused.ts": "const unused = 1;\nexport {};\n",
    "empty.ts": "if (Math.random()) {\n}\nexport {};\n",
    "type.ts": 'const n: number = "s";\nexport { n };\n',
    "fmt.ts": "export const a=1;\n",
  }, async (dir) => {
    const r = await runChecks(dir, "0");
    const section = (name: string) => {
      const start = r.stderr.indexOf(`== ${name}: 落ちた`);
      if (start < 0) return "";
      const end = r.stderr.indexOf("\n== ", start + 1);
      return r.stderr.slice(start, end < 0 ? undefined : end);
    };
    deepStrictEqual({
      code: r.code,
      lintUnused: section("deno lint").includes("no-unused-vars"),
      lintEmpty: section("deno lint").includes("no-empty"),
      fmt: section("deno fmt").includes("fmt.ts"),
      check: section("deno check").includes("TS2322"),
    }, {
      code: 1,
      lintUnused: true,
      lintEmpty: false,
      fmt: true,
      check: true,
    }, r.stderr);
  });
});

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
        r.code === 1 && r.stderr.includes("== deno.json の imports: 落ちた") &&
          r.stderr.includes(
            'imports の "unused" がどの .ts からも使われていない',
          ) &&
          !r.stderr.includes('"a" がどの') &&
          !r.stderr.includes('"dir/" がどの') &&
          r.stdout.includes("== deno check: 通った"),
        `${r.stdout}\n${r.stderr}`,
      );
    }),
    withRepo({
      "deno.json": '{"imports": {"x": "./x.ts"}}',
      "broken.ts": "import x from 'x';\nconst = ;\n",
    }, async (dir) => {
      const r = await runChecks(dir, "0");
      expect(
        "deno info の error があれば未使用の判定をしない",
        r.code === 1 && r.stderr.includes("SyntaxError") &&
          r.stderr.includes("未使用の判定はしていない") &&
          !r.stderr.includes("使われていない"),
        r.stderr,
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
    "shellcheck --version が exit 3\nboom",
  ],
  [
    "version: の行が無い",
    { shellcheck: "#!/bin/sh\necho nothing\n" },
    "version: の行が無い",
  ],
  [
    "版が違う",
    { shellcheck: "#!/bin/sh\necho 'version: 0.9.0'\n" },
    "shellcheck の版が 0.9.0 で、0.11.0 でない",
  ],
];

Deno.test("段より前の確かめ: shellcheck の版と、作業ツリーに無い追跡ファイル", async () => {
  const { failures, expect } = collector();
  const unstaged = (r: Awaited<ReturnType<typeof runChecks>>) =>
    r.code === 1 && !r.stdout.includes("==") && !r.stderr.includes("==") &&
    r.stderr.includes("検査の段は回していない");
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

/** run-checks.ts と同じ escape (印字できる ASCII (空白と \ を除く) の他のバイトを \xHH)。 */
const escapeBytes = (b: Uint8Array) =>
  Array.from(
    b,
    (c) =>
      c > 0x20 && c < 0x7f && c !== 0x5c
        ? String.fromCharCode(c)
        : `\\x${c.toString(16).padStart(2, "0")}`,
  ).join("");

/** 名前の先頭の U+FEFF を落とさない (canon: facts/git/path-output-quoting)。 */
const keepBom = new TextDecoder("utf-8", { ignoreBOM: true });

Deno.test("名前: 処理できない名前があれば段を回さずに名前を出し、他は ./ を前置して検査する", async () => {
  // 次元: canon: facts/git/path-output-quoting (UTF-8 として不正・改行・BOM) と facts/deno/check-file-args-glob (* ?・先頭の - ! npm:)
  const nameArb = fc.record({
    prefix: fc.constantFrom("", "﻿", "-", "!", "npm:"),
    bad: fc.oneof(
      { arbitrary: fc.constant(""), weight: 4 },
      { arbitrary: fc.constantFrom("\n", "*", "?", "invalid"), weight: 1 },
    ),
    ext: fc.constantFrom(".sh", ".ts"),
  }).map(({ prefix, bad, ext }) => {
    const head = enc.encode(`${prefix}n${bad === "invalid" ? "" : bad}`);
    const bytes = new Uint8Array([
      ...head,
      ...(bad === "invalid" ? [0xff] : []),
      ...enc.encode(ext),
    ]);
    return { bytes, bad: bad !== "", ext };
  });
  await fc.assert(
    fc.asyncProperty(
      fc.uniqueArray(nameArb, {
        minLength: 1,
        maxLength: 3,
        selector: (n) => escapeBytes(n.bytes),
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
            r.stderr.includes(escapeBytes(n.bytes));
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
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};
const exists = (path: string) =>
  Deno.stat(path).then(() => true, (e) => {
    if (e instanceof Deno.errors.NotFound) return false;
    throw e;
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const version =
  "case \" $* \" in *' --version '*) echo 'version: 0.11.0'; exit 0 ;; esac";

/** fake の shellcheck を段で回し、started が出たら signals を送って、結果と、後で survived が書かれたかを返す。 */
async function interrupt(
  shellcheck: (dir: string) => string,
  signals: Deno.Signal[],
  afterMs: number,
) {
  return await withRepo({ "a.sh": "#!/bin/sh\n" }, async (dir) => {
    const bin = await fakePath(dir, {
      shellcheck: shellcheck(`${dir}/.git`),
    });
    const child = spawnChecks(dir, "0", { PATH: `${bin}:${baseEnv.PATH}` });
    const started = await poll(() => exists(`${dir}/.git/started`));
    const sent = performance.now();
    for (const [i, signal] of signals.entries()) {
      if (i > 0) await sleep(200);
      child.kill(signal);
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
      terminated: await exists(`${dir}/.git/terminated`),
      survived: await exists(`${dir}/.git/survived`),
    };
  });
}

Deno.test("中断: 段のグループを空にし、128 + シグナルの番号で終わる", async () => {
  const { failures, expect } = collector();
  const quiet = (r: { stdout: string; stderr: string }) =>
    r.stdout === "" && !r.stderr.includes("==");
  await Promise.all([
    // 段の最中。先頭は TERM で終わり、孫は TERM で止まる
    ...([["SIGHUP", 129], ["SIGINT", 130], ["SIGTERM", 143]] as const).map((
      [signal, code],
    ) =>
      interrupt(
        (g) =>
          [
            "#!/bin/sh",
            version,
            `trap 'echo > "${g}/terminated"; exit 143' TERM`,
            `(sleep 3; echo > "${g}/survived") &`,
            `echo > "${g}/started"`,
            "wait",
          ].join("\n"),
        [signal],
        3500,
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
          `(trap '' TERM; sleep 5; echo > "${g}/survived") &`,
          `echo > "${g}/started"`,
          "wait",
        ].join("\n"),
      ["SIGTERM"],
      3500,
    ).then((r) =>
      expect(
        "孫が残る",
        r.started && r.code === 143 && quiet(r) && !r.survived && r.secs >= 1.5,
        JSON.stringify(r),
      )
    ),
    // 先頭が TERM を無視する。2 回目のシグナル (SIGINT) は何もしない
    ...[["SIGTERM"], ["SIGTERM", "SIGINT"]].map((signals) =>
      interrupt(
        (g) =>
          [
            "#!/bin/sh",
            version,
            "trap '' TERM",
            `echo > "${g}/started"`,
            "sleep 5",
            `echo > "${g}/survived"`,
          ].join("\n"),
        signals as Deno.Signal[],
        3500,
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
          `if [ "$1 $2 $3" = "ls-files -z --cached" ]; then echo > "${g}/started"; sleep 4; echo > "${g}/survived"; exit 0; fi`,
          `exec "${which("git")}" "$@"`,
        ].join("\n"),
        shellcheck: `#!/bin/sh\n${version}\n`,
      });
      const child = spawnChecks(dir, "0", { PATH: bin });
      const started = await poll(() => exists(`${g}/started`));
      child.kill("SIGTERM");
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
      const token = crypto.randomUUID();
      await writeFiles(dir, {
        "wait_test.ts": [
          'Deno.test("w", async () => {',
          '  const tmp = Deno.env.get("TMPDIR");',
          '  new Deno.Command("sh", {',
          `    args: ["-c", \`trap "" TERM; while :; do echo > "\${tmp}/f.$$"; sleep 0.05; done\`],`,
          "  }).spawn();",
          `  await Deno.writeTextFile(\`\${tmp}/${token}\`, "");`,
          "  await new Promise((r) => setTimeout(r, 30000));",
          "});",
          "",
        ].join("\n"),
      });
      const child = spawnChecks(dir, "0");
      let testTmp: string | undefined;
      try {
        const started = await poll(async () => {
          for await (const e of Deno.readDir(tmpdir)) {
            const path = `${tmpdir}/${e.name}`;
            if (
              e.name.startsWith("run-checks-") &&
              await exists(`${path}/${token}`)
            ) {
              testTmp = path;
              return true;
            }
          }
          return false;
        });
        child.kill("SIGTERM");
        const r = await child.output();
        await sleep(500);
        expect(
          "deno test の段の TMPDIR",
          started && r.code === 143 && dec.decode(r.stdout) === "" &&
            testTmp !== undefined && !await exists(testTmp),
          JSON.stringify({ started, code: r.code, testTmp }),
        );
      } finally {
        if (testTmp !== undefined && await exists(testTmp)) {
          await Deno.remove(testTmp, { recursive: true });
        }
      }
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
        `(sleep 1; echo > "${g}/survived") >/dev/null 2>&1 &`,
        "exit 0",
      ].join("\n"),
    });
    const r = await runChecks(dir, "0", { PATH: `${bin}:${baseEnv.PATH}` });
    const testTmp = r.stdout.match(/TESTTMP=(.*)/)?.[1];
    await sleep(1500);
    deepStrictEqual(
      {
        code: r.code,
        testTmp: testTmp?.startsWith(`${tmpdir}/run-checks-`),
        left: testTmp !== undefined && await exists(testTmp),
        survived: await exists(`${g}/survived`),
      },
      { code: 0, testTmp: true, left: false, survived: false },
      r.stderr,
    );
  });
});
