/**
 * verify.sh を子として、TMPDIR の下の一時ディレクトリの fixture のリポで回す。
 * - fixture は verify.sh・hooks/pre-push・deno.json・deno.lock の写しと、scripts/run-checks.ts の stub。stub は次を JSON で出し、引数 (hook を揃えた結果) で終わる。検査の段は run-checks_test.ts が受け持つ。
 *   - git が指す git dir。
 *   - 環境に残っている GIT_ の変数の名前 (比べるのは --local-env-vars の一覧に載るものだけ)。
 *   - TMPDIR と、自分の許可 (Deno.permissions.querySync)。
 * - 行ごとに、hook の状態と環境を作って verify.sh を回し、次を比べる。
 *   - 終了コード。
 *   - 回した後の common git dir の hooks の中身 (名前ごとのバイトと、実行可能か。一時ファイルが残れば名前が増える)。
 *   - stub の報告 (git dir・GIT_ の変数・TMPDIR・許可)。
 *   - 別のリポ (環境変数を向ける先) に hook を置かなかったか。
 *   - deno.lock を書き換えなかったか。
 * - linked worktree の test: worktree で回すと、hook は common git dir の hooks にだけ写る。
 * - symlink は ln -s で作る。deno test の段の --allow-write は TMPDIR に絞ってあり、Deno.symlink は絞らない read・write を要る (canon: facts/deno/symlink-requires-unscoped-permissions)。
 * - 子の環境は、このプロセスの環境から git の場所を決める変数 (canon: facts/git/local-env-vars-and-hook-env) を消し、利用者の git の設定を読まないもの。
 */
import { deepStrictEqual } from "node:assert/strict";

const root = Deno.realPathSync(`${import.meta.dirname}/..`);
const dec = new TextDecoder();
const tmpdir = Deno.env.get("TMPDIR");
if (!tmpdir) throw new Error("TMPDIR が空。./verify.sh から回す");

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

const copied = [
  "verify.sh",
  "hooks/pre-push",
  "deno.json",
  "deno.lock",
];
const stub = `
const run = async (cmd: string, args: string[]) =>
  new TextDecoder().decode((await new Deno.Command(cmd, { args }).output()).stdout);
const tmpdir = Deno.env.get("TMPDIR") ?? "";
const granted = (d: Deno.PermissionDescriptor) => Deno.permissions.querySync(d).state === "granted";
console.log(JSON.stringify({
  gitDir: (await run("git", ["rev-parse", "--absolute-git-dir"])).trim(),
  gitVars: (await run("env", [])).split("\\n").filter((l) => l.startsWith("GIT_")).map((l) => l.split("=")[0]),
  tmpdir,
  permissions: {
    run: granted({ name: "run" }),
    envTmpdir: granted({ name: "env", variable: "TMPDIR" }),
    envOther: granted({ name: "env", variable: "HOME" }),
    writeTmpdir: granted({ name: "write", path: tmpdir }),
    readDenoJson: granted({ name: "read", path: "deno.json" }),
    readCwd: granted({ name: "read", path: "." }),
    net: granted({ name: "net" }),
  },
}));
Deno.exit(Number(Deno.args[0]));
`;
const hookBytes = await Deno.readFile(`${root}/hooks/pre-push`);
const other = new TextEncoder().encode("#!/bin/sh\nexit 0\n");

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

async function git(dir: string, ...args: string[]) {
  const r = await spawn("git", {
    args: ["-C", dir, ...args],
    env: baseEnv,
    clearEnv: true,
  }).output();
  if (!r.success) throw new Error(dec.decode(r.stderr));
}

const ln = async (target: string, path: string) => {
  const r = await spawn("ln", { args: ["-s", target, path] }).output();
  if (!r.success) throw new Error(dec.decode(r.stderr));
};

/** fixture のリポを作る。hooks の置き場は作らない (git init --template=)。 */
async function makeRepo(dir: string) {
  await git(dir, "init", "-q", "--template=");
  for (const path of copied) {
    await Deno.mkdir(`${dir}/${path.slice(0, path.lastIndexOf("/") + 1)}`, {
      recursive: true,
    });
    await Deno.copyFile(`${root}/${path}`, `${dir}/${path}`);
  }
  await Deno.mkdir(`${dir}/scripts`);
  await Deno.writeTextFile(`${dir}/scripts/run-checks.ts`, stub);
}

type HookState =
  | "無い"
  | "壊れた symlink"
  | "同じ"
  | "同じで実行可能でない"
  | "違う"
  | "ディレクトリ";

async function setHook(dir: string, state: HookState) {
  const hooks = `${dir}/.git/hooks`;
  if (state === "無い") return;
  await Deno.mkdir(hooks);
  const hook = `${hooks}/pre-push`;
  if (state === "壊れた symlink") {
    await ln(`${dir}/nowhere`, hook);
  } else if (state === "ディレクトリ") {
    await Deno.mkdir(hook);
  } else {
    await Deno.writeFile(hook, state === "違う" ? other : hookBytes, {
      mode: state === "同じで実行可能でない" ? 0o644 : 0o755,
    });
  }
}

/** hooks の中身 (名前ごとの、ファイルのバイトと実行可能か。ディレクトリは "dir")。hooks が無ければ null。 */
async function readHooks(gitDir: string) {
  const hooks = `${gitDir}/hooks`;
  const out: Record<string, Hook | "dir" | "dangling"> = {};
  try {
    for await (const e of Deno.readDir(hooks)) {
      const path = `${hooks}/${e.name}`;
      try {
        const info = await Deno.stat(path);
        out[e.name] = info.isDirectory ? "dir" : {
          bytes: Array.from(await Deno.readFile(path)),
          executable: ((info.mode ?? 0) & 0o111) !== 0,
        };
      } catch (err) {
        if (!(err instanceof Deno.errors.NotFound)) throw err;
        out[e.name] = "dangling";
      }
    }
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    if (e instanceof Deno.errors.NotADirectory) return "file";
    throw e;
  }
  return out;
}

async function verify(
  dir: string,
  env: Record<string, string>,
  args: string[] = [],
) {
  const r = await spawn("bash", {
    args: [`${dir}/verify.sh`, ...args],
    cwd: dir,
    env: { ...baseEnv, ...env },
    clearEnv: true,
  }).output();
  return {
    code: r.code,
    stdout: dec.decode(r.stdout),
    stderr: dec.decode(r.stderr),
  };
}

interface Report {
  gitDir: string;
  gitVars: string[];
  tmpdir: string;
  permissions: Record<string, boolean>;
}
const reportOf = (stdout: string): Report | undefined => {
  const line = stdout.split("\n").find((l) => l.startsWith("{"));
  return line === undefined ? undefined : JSON.parse(line);
};

type Hook = { bytes: number[]; executable: boolean };
const copiedHook: Hook = { bytes: Array.from(hookBytes), executable: true };
const realTmpdir = await Deno.realPath(tmpdir);
const permissions = {
  run: true,
  envTmpdir: true,
  envOther: true,
  writeTmpdir: true,
  readDenoJson: true,
  readCwd: false,
  net: false,
};

interface Case {
  name: string;
  prepare?: (dir: string, elsewhere: string) => Promise<void>;
  /** elsewhere は別の空のリポ。どの行でもそこに hook を置かないこと。 */
  env?: (elsewhere: string, dir: string) => Record<string, string>;
  args?: string[];
  code: number;
  /** 回した後の hooks の中身。 */
  hooks: Awaited<ReturnType<typeof readHooks>>;
  /** stub が起動されないなら undefined。 */
  tmpdir?: string;
  stderr?: string;
}

/** --local-env-vars のそれぞれを elsewhere へ向ける値。一覧に足された変数は、ここに無いので落ちる。 */
const pointElsewhere: Record<string, (e: string) => Record<string, string>> = {
  GIT_ALTERNATE_OBJECT_DIRECTORIES: (e) => ({
    GIT_ALTERNATE_OBJECT_DIRECTORIES: `${e}/.git/objects`,
  }),
  GIT_CONFIG: (e) => ({ GIT_CONFIG: `${e}/.git/config` }),
  GIT_CONFIG_PARAMETERS: (e) => ({
    GIT_CONFIG_PARAMETERS: `'core.hooksPath'='${e}/.git/hooks'`,
  }),
  GIT_CONFIG_COUNT: (e) => ({
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: `${e}/.git/hooks`,
  }),
  GIT_OBJECT_DIRECTORY: (e) => ({ GIT_OBJECT_DIRECTORY: `${e}/.git/objects` }),
  GIT_DIR: (e) => ({ GIT_DIR: `${e}/.git` }),
  GIT_WORK_TREE: (e) => ({ GIT_WORK_TREE: e }),
  GIT_IMPLICIT_WORK_TREE: () => ({ GIT_IMPLICIT_WORK_TREE: "0" }),
  GIT_GRAFT_FILE: (e) => ({ GIT_GRAFT_FILE: `${e}/.git/info/grafts` }),
  GIT_INDEX_FILE: (e) => ({ GIT_INDEX_FILE: `${e}/.git/index` }),
  GIT_NO_REPLACE_OBJECTS: () => ({ GIT_NO_REPLACE_OBJECTS: "1" }),
  GIT_REPLACE_REF_BASE: () => ({ GIT_REPLACE_REF_BASE: "refs/elsewhere/" }),
  GIT_PREFIX: () => ({ GIT_PREFIX: "sub/" }),
  GIT_SHALLOW_FILE: (e) => ({ GIT_SHALLOW_FILE: `${e}/.git/shallow` }),
  GIT_COMMON_DIR: (e) => ({ GIT_COMMON_DIR: `${e}/.git` }),
};

const cases: Case[] = [];
const states: [HookState, number, Case["hooks"], string?][] = [
  ["無い", 0, { "pre-push": copiedHook }],
  ["壊れた symlink", 0, { "pre-push": copiedHook }],
  ["同じ", 0, { "pre-push": copiedHook }],
  ["同じで実行可能でない", 0, { "pre-push": copiedHook }],
  [
    "違う",
    1,
    { "pre-push": { bytes: Array.from(other), executable: true } },
    "Execute: install -m 755 hooks/pre-push",
  ],
  [
    "ディレクトリ",
    1,
    { "pre-push": "dir" },
    "Execute: install -m 755 hooks/pre-push",
  ],
];
for (const [state, code, hooks, stderr] of states) {
  cases.push({
    name: state,
    prepare: (dir) => setHook(dir, state),
    code,
    hooks,
    tmpdir: realTmpdir,
    stderr,
  });
}
for (const name of localEnv) {
  cases.push({
    name: `${name} が別のリポを指す`,
    env: (e) => {
      const point = pointElsewhere[name];
      if (point === undefined) throw new Error(`${name} を向ける値が表に無い`);
      return point(e);
    },
    code: 0,
    hooks: { "pre-push": copiedHook },
    tmpdir: realTmpdir,
  });
}
cases.push(
  {
    name: "core.hooksPath",
    prepare: (dir) => git(dir, "config", "core.hooksPath", "elsewhere"),
    code: 1,
    hooks: { "pre-push": copiedHook },
    tmpdir: realTmpdir,
    stderr: "hook の置き場が",
  },
  {
    name: "hooks が通常ファイルで写せない",
    prepare: (dir) => Deno.writeTextFile(`${dir}/.git/hooks`, ""),
    code: 1,
    hooks: "file",
    tmpdir: realTmpdir,
    stderr:
      "hooks/pre-push を写せない。 Execute: install -m 755 hooks/pre-push",
  },
  {
    name: "引数を受けない",
    args: ["x"],
    code: 2,
    hooks: null,
    stderr: "verify.sh: 引数は受けない (x)",
  },
  {
    name: "TMPDIR が未設定なら /tmp を解決したもの",
    env: () => ({ TMPDIR: "" }),
    code: 0,
    hooks: { "pre-push": copiedHook },
    tmpdir: await Deno.realPath("/tmp"),
  },
  {
    name: "TMPDIR が symlink",
    prepare: (dir) => ln(realTmpdir, `${dir}/.git/tmp-link`),
    env: (_, dir) => ({ TMPDIR: `${dir}/.git/tmp-link` }),
    code: 0,
    hooks: { "pre-push": copiedHook },
    tmpdir: realTmpdir,
  },
  {
    name: "TMPDIR が無い",
    env: (e) => ({ TMPDIR: `${e}/nowhere` }),
    code: 1,
    hooks: { "pre-push": copiedHook },
    stderr: "がディレクトリでない",
  },
  {
    name: "TMPDIR が , を含む",
    prepare: (_, e) => Deno.mkdir(`${e}/a,b`),
    env: (e) => ({ TMPDIR: `${e}/a,b` }),
    code: 1,
    hooks: { "pre-push": copiedHook },
    stderr: "が , を含む",
  },
  {
    name: "deno.lock が deno.json と食い違えば書き換えず落ちる",
    prepare: async (dir) => {
      const json = JSON.parse(await Deno.readTextFile(`${dir}/deno.json`));
      json.imports["is-odd"] = "npm:is-odd@3.0.1";
      await Deno.writeTextFile(`${dir}/deno.json`, JSON.stringify(json));
    },
    code: 1,
    hooks: { "pre-push": copiedHook },
    stderr: "The lockfile is out of date",
  },
);

Deno.test("verify.sh の hook の状態と環境", async () => {
  const mismatches = (await Promise.all(
    cases.map((c) =>
      withTempDir((dir) =>
        withTempDir(async (elsewhere) => {
          await makeRepo(dir);
          await git(elsewhere, "init", "-q", "--template=");
          await c.prepare?.(dir, elsewhere);
          const env = c.env?.(elsewhere, dir) ?? {};
          const lock = await Deno.readTextFile(`${dir}/deno.lock`);
          const r = await verify(dir, env, c.args);
          const got = {
            code: r.code,
            hooks: await readHooks(`${dir}/.git`),
            strayHooks: await readHooks(`${elsewhere}/.git`),
            report: reportOf(r.stdout),
            lockUnchanged: await Deno.readTextFile(`${dir}/deno.lock`) === lock,
            stderr: c.stderr === undefined || r.stderr.includes(c.stderr),
          };
          const want = {
            code: c.code,
            hooks: c.hooks,
            strayHooks: null,
            report: c.tmpdir === undefined ? undefined : {
              gitDir: `${await Deno.realPath(dir)}/.git`,
              gitVars: [],
              tmpdir: c.tmpdir,
              permissions,
            },
            lockUnchanged: true,
            stderr: true,
          };
          if (got.report) {
            got.report.gitVars = got.report.gitVars.filter((v) =>
              localEnv.includes(v)
            );
          }
          try {
            deepStrictEqual(got, want);
            return [];
          } catch {
            return [
              `${c.name}\n${
                JSON.stringify({ ...got, hooks: undefined }, null, 1)
              }\nhooks の一致: ${
                JSON.stringify(got.hooks) === JSON.stringify(want.hooks)
              }\n${r.stdout}${r.stderr}`,
            ];
          }
        })
      )
    ),
  )).flat();
  deepStrictEqual(mismatches, []);
});

Deno.test("linked worktree で回すと、hook は common git dir の hooks にだけ写る", async () => {
  await withTempDir((dir) =>
    withTempDir(async (outside) => {
      await makeRepo(dir);
      await git(dir, "add", "-A");
      await git(
        dir,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.com",
        "commit",
        "-q",
        "-m",
        "x",
      );
      await git(dir, "worktree", "add", "-q", `${outside}/wt`);
      const r = await verify(`${outside}/wt`, {});
      const real = await Deno.realPath(dir);
      deepStrictEqual(
        {
          code: r.code,
          gitDir: reportOf(r.stdout)?.gitDir,
          common: await readHooks(`${dir}/.git`),
          linked: await readHooks(`${dir}/.git/worktrees/wt`),
        },
        {
          code: 0,
          gitDir: `${real}/.git/worktrees/wt`,
          common: { "pre-push": copiedHook },
          linked: null,
        },
        r.stderr,
      );
    })
  );
});
