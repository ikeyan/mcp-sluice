/**
 * verify.sh を子として、一時ディレクトリの fixture のリポで回す。
 * - fixture は verify.sh・hooks/pre-push・deno.json・deno.lock の写しと、scripts/run-checks.ts の stub (git が指す git dir を出し、引数 (状態を揃える段の結果) で終わる)。検査の段は run-checks_test.ts が受け持つ。
 * - 行ごとに、common git dir の hooks/pre-push の状態と環境を作って verify.sh を回し、次を比べる。
 *   - 終了コード。
 *   - 回した後の pre-push のバイトと、実行可能か。
 *   - stub が起動されたか、起動されたなら fixture の git dir を見たか。
 *   - 別のリポ (GIT_DIR を向ける先) に pre-push を置かなかったか。
 * - 子の環境は、このプロセスの環境から git の場所を決める変数 (canon: facts/git/local-env-vars-and-hook-env)と VERIFY_READONLY を消し、利用者の git の設定を読まないもの。
 */
import { deepStrictEqual } from "node:assert/strict";

const root = Deno.realPathSync(`${import.meta.dirname}/..`);
const dec = new TextDecoder();

const localEnv = dec.decode(
  (await new Deno.Command("git", { args: ["rev-parse", "--local-env-vars"] })
    .output()).stdout,
).split("\n").filter(Boolean);
const baseEnv: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(Deno.env.toObject()).filter(([k]) =>
      !localEnv.includes(k) && k !== "VERIFY_READONLY"
    ),
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
const stub = [
  'const r = await new Deno.Command("git", { args: ["rev-parse", "--absolute-git-dir"] }).output();',
  "console.log(`git-dir=${new TextDecoder().decode(r.stdout).trim()}`);",
  "Deno.exit(Number(Deno.args[0]));",
  "",
].join("\n");
const hookBytes = await Deno.readFile(`${root}/hooks/pre-push`);
const other = new TextEncoder().encode("#!/bin/sh\nexit 0\n");

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

async function git(dir: string, ...args: string[]) {
  const r = await spawn("git", {
    args: ["-C", dir, ...args],
    env: baseEnv,
    clearEnv: true,
  }).output();
  if (!r.success) throw new Error(dec.decode(r.stderr));
}

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
  | "違う";

async function setHook(dir: string, state: HookState) {
  const hooks = `${dir}/.git/hooks`;
  if (state === "無い") return;
  await Deno.mkdir(hooks);
  const hook = `${hooks}/pre-push`;
  if (state === "壊れた symlink") {
    await Deno.symlink(`${dir}/nowhere`, hook);
  } else {
    await Deno.writeFile(hook, state === "違う" ? other : hookBytes, {
      mode: state === "同じで実行可能でない" ? 0o644 : 0o755,
    });
  }
}

/** pre-push の中身と実行可能か。無いか壊れた symlink なら null。 */
async function readHook(dir: string) {
  const hook = `${dir}/.git/hooks/pre-push`;
  try {
    const info = await Deno.stat(hook);
    return {
      bytes: Array.from(await Deno.readFile(hook)),
      executable: ((info.mode ?? 0) & 0o111) !== 0,
    };
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
    return null;
  }
}

async function verify(dir: string, env: Record<string, string>) {
  const r = await spawn("bash", {
    args: [`${dir}/verify.sh`],
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

type Hook = { bytes: number[]; executable: boolean };
const copiedHook: Hook = { bytes: Array.from(hookBytes), executable: true };

interface Case {
  name: string;
  prepare: (dir: string) => Promise<void>;
  /** elsewhere は別の空のリポ。どの行でもそこに pre-push を置かないこと。 */
  env: (elsewhere: string) => Record<string, string>;
  code: number;
  hook: Hook | null;
  /** stub の run-checks.ts を起動するか */
  checks: boolean;
  stderr?: string;
}

const cases: Case[] = [];
const states: [HookState, number, Hook | null][] = [
  ["無い", 0, copiedHook],
  ["壊れた symlink", 0, copiedHook],
  ["同じ", 0, copiedHook],
  ["同じで実行可能でない", 1, { ...copiedHook, executable: false }],
  ["違う", 1, { bytes: Array.from(other), executable: true }],
];
for (const [state, code, hook] of states) {
  for (const readonly of [undefined, "1"]) {
    cases.push({
      name: `${state}・VERIFY_READONLY=${readonly ?? "(無し)"}`,
      prepare: (dir) => setHook(dir, state),
      env: (): Record<string, string> =>
        readonly === undefined ? {} : { VERIFY_READONLY: readonly },
      code,
      hook,
      checks: true,
    });
  }
}
cases.push(
  {
    name: "core.hooksPath",
    prepare: (dir) => git(dir, "config", "core.hooksPath", "elsewhere"),
    env: () => ({}),
    code: 1,
    hook: copiedHook,
    checks: true,
    stderr: "hook の置き場が",
  },
  {
    name: "VERIFY_READONLY=0",
    prepare: async () => {},
    env: () => ({ VERIFY_READONLY: "0" }),
    code: 1,
    hook: null,
    checks: false,
    stderr: "VERIFY_READONLY は未設定・空か 1 (0)",
  },
  {
    name: "GIT_DIR が別のリポを指す",
    prepare: async () => {},
    env: (elsewhere) => ({ GIT_DIR: `${elsewhere}/.git` }),
    code: 0,
    hook: copiedHook,
    checks: true,
  },
);

Deno.test("verify.sh の hook の状態と環境", async () => {
  const mismatches = (await Promise.all(
    cases.map((c) =>
      withTempDir((dir) =>
        withTempDir(async (elsewhere) => {
          await makeRepo(dir);
          await git(elsewhere, "init", "-q", "--template=");
          await c.prepare(dir);
          const r = await verify(dir, c.env(elsewhere));
          const hook = await readHook(dir);
          const strayHook = await readHook(elsewhere);
          const checked = r.stdout.includes("git-dir=");
          const sawRepo = r.stdout.includes(
            `git-dir=${await Deno.realPath(dir)}/.git\n`,
          );
          return r.code === c.code &&
              checked === c.checks && checked === sawRepo &&
              JSON.stringify(hook) === JSON.stringify(c.hook) &&
              strayHook === null &&
              (c.stderr === undefined || r.stderr.includes(c.stderr))
            ? []
            : [
              `${c.name}: exit ${r.code} (期待 ${c.code})、pre-push の実行可能 ${
                JSON.stringify(hook?.executable)
              } (期待 ${JSON.stringify(c.hook?.executable)})、中身が期待と${
                JSON.stringify(hook?.bytes) === JSON.stringify(c.hook?.bytes)
                  ? "同じ"
                  : "違う"
              }、別のリポの pre-push ${
                strayHook === null ? "無し" : "有り"
              }\n${r.stdout}${r.stderr}`,
            ];
        })
      )
    ),
  )).flat();
  deepStrictEqual(mismatches, []);
});
