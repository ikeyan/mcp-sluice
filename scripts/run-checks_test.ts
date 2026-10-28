/**
 * run-checks.ts を子として、一時ディレクトリの fixture のリポで回す。
 * - fixture は git のリポ。deno.json は run-checks.ts が読むので置き、.git/info/exclude で git の一覧から外す (一覧に入ると、JSON と Markdown の段が fixture に無い scripts/check-json-md.ts を回して落ちる)。
 * - shellcheck を fake に替える test は、PATH を git・deno・sleep と fake だけを置いた dir にする。
 * - 子の環境は、このプロセスの環境から git の場所を決める変数 (canon: facts/git/local-env-vars-and-hook-env) を消し、利用者の git の設定を読まないもの。
 */
import { deepStrictEqual } from "node:assert/strict";

const root = Deno.realPathSync(`${import.meta.dirname}/..`);
const dec = new TextDecoder();
const enc = new TextEncoder();

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

/** git の blob の id (sha1)。git hash-object --no-filters と独立に求める。 */
const blobId = async (content: string): Promise<string> => {
  const body = enc.encode(content);
  const header = enc.encode(`blob ${body.length}\0`);
  const all = new Uint8Array(header.length + body.length);
  all.set(header);
  all.set(body, header.length);
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-1", all)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
};

const withTempDir = async <T>(fn: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await Deno.makeTempDir();
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

/** fixture のリポを作って fn に渡し、終われば消す。 */
const withRepo = <T>(
  files: Record<string, string>,
  fn: (dir: string) => Promise<T>,
): Promise<T> =>
  withTempDir(async (dir) => {
    const init = await spawn("git", {
      args: ["init", "-q", "--template=", "--object-format=sha1", dir],
      env: baseEnv,
      clearEnv: true,
    }).output();
    if (!init.success) throw new Error(dec.decode(init.stderr));
    await Deno.mkdir(`${dir}/.git/info`, { recursive: true });
    await Deno.writeTextFile(`${dir}/.git/info/exclude`, "deno.json\n");
    for (
      const [path, content] of Object.entries({ "deno.json": "{}", ...files })
    ) {
      await Deno.mkdir(`${dir}/${path.slice(0, path.lastIndexOf("/") + 1)}`, {
        recursive: true,
      });
      await Deno.writeTextFile(`${dir}/${path}`, content, { mode: 0o755 });
    }
    return await fn(dir);
  });

const spawnChecks = (dir: string, state: string, path?: string) =>
  spawn("deno", {
    args: [
      "run",
      "--allow-run",
      "--allow-env=TMPDIR",
      `--allow-write=${baseEnv.TMPDIR || "/tmp"}`,
      "--allow-read=deno.json,.agent-sync/generated",
      `${root}/scripts/run-checks.ts`,
      state,
    ],
    cwd: dir,
    env: path === undefined ? baseEnv : { ...baseEnv, PATH: path },
    clearEnv: true,
  });

async function runChecks(dir: string, state: string, path?: string) {
  const r = await spawnChecks(dir, state, path).output();
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
    await Deno.symlink(which(name), `${bin}/${name}`);
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

Deno.test("shellcheck から除くのは、記録した id と今の中身が同じ .sh だけ", async () => {
  const { failures, expect } = collector();
  await Promise.all([
    withRepo({
      "bad.sh": bad,
      ".agent-sync/generated": `bad.sh\t${await blobId(bad)}\n`,
    }, async (dir) => {
      const r0 = await runChecks(dir, "0");
      expect("同じ中身・引数 0", r0.code === 0, r0.stderr);
      const r1 = await runChecks(dir, "1");
      expect(
        "同じ中身・引数 1 (段は全部通る)",
        r1.code === 1 && !r1.stderr.includes("落ちた"),
        r1.stderr,
      );
    }),
    withRepo({
      "bad.sh": bad,
      ".agent-sync/generated": `bad.sh\t${await blobId(
        '#!/bin/sh\necho "$1"\n',
      )}\n`,
    }, async (dir) => {
      const r = await runChecks(dir, "0");
      expect(
        "手を入れた写し",
        r.code === 1 && r.stderr.includes("== shellcheck: 落ちた") &&
          r.stderr.includes("./bad.sh"),
        r.stderr,
      );
    }),
    withRepo({ "bad.sh": bad, ".agent-sync/generated": "" }, async (dir) => {
      const r = await runChecks(dir, "0");
      expect(
        "記録に無い .sh",
        r.code === 1 && r.stderr.includes("./bad.sh"),
        r.stderr,
      );
    }),
  ]);
  deepStrictEqual(failures, []);
});

Deno.test("引数と出力と importKeys", async () => {
  const { failures, expect } = collector();
  await Promise.all([
    withRepo({ ".agent-sync/generated": "" }, async (dir) => {
      const r = await runChecks(dir, "2");
      expect(
        "引数が 0 か 1 でない",
        r.code === 1 && r.stderr.includes("引数は状態を揃える段の結果"),
        r.stderr,
      );
    }),
    // stdout が先に閉じても、落ちた段を stderr に出す
    withRepo({ "bad.sh": bad, ".agent-sync/generated": "" }, async (dir) => {
      const child = spawnChecks(dir, "0");
      await child.stdout.cancel();
      const [{ code }, stderr] = await Promise.all([
        child.status,
        new Response(child.stderr).text(),
      ]);
      expect(
        "stdout が閉じている",
        code === 1 && stderr.includes("== shellcheck: 落ちた") &&
          stderr.includes("./bad.sh"),
        stderr,
      );
    }),
    withRepo({
      ".agent-sync/generated": "",
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

Deno.test("shellcheck の版を確かめる", async () => {
  const { failures, expect } = collector();
  await Promise.all(
    probes.map(([name, fakes, message]) =>
      withRepo({ ".agent-sync/generated": "" }, async (dir) => {
        const r = await runChecks(dir, "0", await fakePath(dir, fakes));
        expect(
          name,
          r.code === 1 && r.stderr.includes(message) &&
            r.stderr.includes(install),
          r.stderr,
        );
      })
    ),
  );
  deepStrictEqual(failures, []);
});

const poll = async (path: string) => {
  for (let i = 0; i < 100; i++) {
    try {
      await Deno.stat(path);
      return true;
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return false;
};
const exists = (path: string) =>
  Deno.stat(path).then(() => true, (e) => {
    if (e instanceof Deno.errors.NotFound) return false;
    throw e;
  });

Deno.test("SIGTERM で段のプロセスグループに SIGTERM を送り、143 で終わる", async () => {
  await withRepo(
    { "a.sh": "#!/bin/sh\n", ".agent-sync/generated": "" },
    async (dir) => {
      const bin = await fakePath(dir, {
        shellcheck: [
          "#!/bin/sh",
          "[ \"$1\" = --version ] && { echo 'version: 0.11.0'; exit 0; }",
          `trap 'echo > "${dir}/.git/terminated"; exit 143' TERM`,
          `(sleep 1; echo > "${dir}/.git/survived") &`,
          `echo > "${dir}/.git/started"`,
          "wait",
          "",
        ].join("\n"),
      });
      const child = spawnChecks(dir, "0", bin);
      const started = await poll(`${dir}/.git/started`);
      child.kill("SIGTERM");
      const { code } = await child.output();
      const terminated = await poll(`${dir}/.git/terminated`);
      await new Promise((r) => setTimeout(r, 1500));
      deepStrictEqual(
        {
          started,
          code,
          terminated,
          survived: await exists(`${dir}/.git/survived`),
        },
        { started: true, code: 143, terminated: true, survived: false },
      );
    },
  );
});

Deno.test("中断で deno test の段の TMPDIR を消す", async () => {
  await withRepo(
    {
      ".agent-sync/generated": "",
      "wait_test.ts": [
        'Deno.test("w", async () => {',
        "  const d = await Deno.makeTempDir();",
        '  await Deno.writeTextFile(".git/test-tmp", d);',
        "  await new Promise((r) => setTimeout(r, 30000));",
        "});",
        "",
      ].join("\n"),
    },
    async (dir) => {
      const child = spawnChecks(dir, "0");
      const started = await poll(`${dir}/.git/test-tmp`);
      child.kill("SIGTERM");
      const { code } = await child.output();
      const testTmp = started
        ? await Deno.readTextFile(`${dir}/.git/test-tmp`)
        : "";
      const root = testTmp.slice(0, testTmp.lastIndexOf("/"));
      deepStrictEqual(
        {
          started,
          code,
          root: root.slice(root.lastIndexOf("/") + 1).startsWith("run-checks-"),
          left: started && await exists(root),
        },
        { started: true, code: 143, root: true, left: false },
      );
    },
  );
});
