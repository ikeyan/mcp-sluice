/**
 * verify.sh を子として、TMPDIR の下の一時ディレクトリの fixture のリポで回す。
 * - fixture は verify.sh・hooks/pre-push・deno.json・deno.lock の写しと、scripts/run-checks.ts の stub。stub は次を JSON で出し、引数 (hook を揃えた結果) で終わる。
 *   - git が指す git dir。
 *   - 環境に残っている GIT_ の変数の名前 (比べるのは --local-env-vars の一覧に載るものだけ)。
 *   - TMPDIR と、自分の許可 (Deno.permissions.querySync)。
 * - 行ごとに、hook の状態と環境を作って verify.sh を回し、次を比べる。
 *   - 終了コード。
 *   - 回した後の common git dir の hooks の中身 (名前ごとのバイトと、実行可能か。一時ファイルが残れば名前が増える)。
 *   - stub の報告 (git dir・GIT_ の変数・TMPDIR・許可)。
 *   - 別のリポ (環境変数を向ける先) に hook を置かず、その場所を stdout に出さなかったか。
 *   - deno.lock を書き換えなかったか。
 * - 落ちる行は、示したコマンド (Execute: の後) を実行してから同じ環境で回し直し、exit 0 で hook が写ることも比べる。
 * - 道具の失敗 (install・cmp・chmod) は、PATH の先に置いた fake で作る。
 * - linked worktree の test: worktree で回すと、hook は common git dir の hooks にだけ写る。
 * - 中断の test: 写している最中に SIGTERM を受けると、一時ファイルを残さない。
 * - 子の環境は run-checks_test.ts の先頭と同じ形。
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

// symlink を ln -s で作る理由は run-checks_test.ts の ln
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

/**
 * hooks と pre-push の状態 (verify.sh の先頭の表の行)。
 * 「読めない」は mode 000 にし、PATH の先の fake の cmp が mode 000 を比べられないとする。root は mode 000 も読める (canon: facts/capabilities/root-reads-mode-000-files)。
 */
type HookState =
  | "hooks が無い"
  | "hooks が通常ファイル"
  | "hooks が壊れた symlink"
  | "hooks がディレクトリへの symlink"
  | "無い"
  | "壊れた symlink"
  | "同じ中身への symlink"
  | "違う中身への symlink"
  | "同じ"
  | "同じで実行可能でない"
  | "違う"
  | "読めない"
  | "ディレクトリ"
  | "FIFO";

async function setHook(dir: string, state: HookState) {
  const hooks = `${dir}/.git/hooks`;
  const hook = `${hooks}/pre-push`;
  switch (state) {
    case "hooks が無い":
      return;
    case "hooks が通常ファイル":
      return await Deno.writeTextFile(hooks, "");
    case "hooks が壊れた symlink":
      return await ln(`${dir}/nowhere`, hooks);
    case "hooks がディレクトリへの symlink":
      await Deno.mkdir(`${dir}/.git/real-hooks`);
      return await ln(`${dir}/.git/real-hooks`, hooks);
  }
  await Deno.mkdir(hooks);
  switch (state) {
    case "無い":
      return;
    case "壊れた symlink":
      return await ln(`${dir}/nowhere`, hook);
    case "同じ中身への symlink":
    case "違う中身への symlink":
      await Deno.writeFile(
        `${dir}/.git/target`,
        state === "違う中身への symlink" ? other : hookBytes,
        { mode: 0o755 },
      );
      return await ln(`${dir}/.git/target`, hook);
    case "ディレクトリ":
      return await Deno.mkdir(hook);
    case "FIFO": {
      const r = await spawn("mkfifo", { args: [hook] }).output();
      if (!r.success) throw new Error(dec.decode(r.stderr));
      return;
    }
  }
  await Deno.writeFile(hook, state === "違う" ? other : hookBytes, {
    mode: state === "同じで実行可能でない"
      ? 0o644
      : state === "読めない"
      ? 0
      : 0o755,
  });
}

/**
 * gitDir の hooks の状態。
 * - hooks が無い: null。
 * - 通常ファイル: "file"。
 * - 壊れた symlink: "dangling"。
 * - ディレクトリ: 名前ごとの中身。
 *   - 通常ファイル: バイトと、実行可能か。mode が 000 なら中身を読まず "mode 000" (root は読めてしまい、uid で結果が分かれるので)。
 *   - ディレクトリ: "dir"。
 *   - 壊れた symlink: "dangling"。
 *   - 他: "other"。
 */
async function readHooks(gitDir: string) {
  const hooks = `${gitDir}/hooks`;
  const out: Record<string, Hook | "mode 000" | "dir" | "dangling" | "other"> =
    {};
  try {
    for await (const e of Deno.readDir(hooks)) {
      const path = `${hooks}/${e.name}`;
      try {
        const info = await Deno.stat(path);
        out[e.name] = info.isDirectory
          ? "dir"
          : !info.isFile
          ? "other"
          : ((info.mode ?? 0) & 0o777) === 0
          ? "mode 000"
          : {
            bytes: Array.from(await Deno.readFile(path)),
            executable: ((info.mode ?? 0) & 0o111) !== 0,
          };
      } catch (err) {
        if (!(err instanceof Deno.errors.NotFound)) throw err;
        out[e.name] = "dangling";
      }
    }
  } catch (e) {
    if (e instanceof Deno.errors.NotADirectory) return "file";
    if (!(e instanceof Deno.errors.NotFound)) throw e;
    try {
      await Deno.lstat(hooks);
      return "dangling";
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return null;
      throw err;
    }
  }
  return out;
}

/** dir の verify.sh を回す。relative なら dir の親を cwd にし、$0 を相対パスにする。 */
async function verify(
  dir: string,
  env: Record<string, string>,
  { args = [], relative = false }: { args?: string[]; relative?: boolean } = {},
) {
  const slash = dir.lastIndexOf("/");
  const r = await spawn("bash", {
    args: [
      relative ? `${dir.slice(slash + 1)}/verify.sh` : `${dir}/verify.sh`,
      ...args,
    ],
    cwd: relative ? dir.slice(0, slash) : dir,
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
const which = async (name: string) =>
  dec.decode(
    (await new Deno.Command("sh", {
      args: ["-c", 'command -v "$1"', "sh", name],
    })
      .output()).stdout,
  ).trim();
const failing = (name: string) =>
  `#!/bin/sh\necho "${name}: fake の失敗" >&2\nexit 1\n`;
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
  /** elsewhere は別の空のリポ。どの行でもそこに hook を置かず、その場所を stdout に出さないこと。 */
  env?: (elsewhere: string, dir: string) => Record<string, string>;
  /** PATH の先 (dir の .git/fake-bin) に置く fake (名前 → 中身)。 */
  fakes?: Record<string, string>;
  args?: string[];
  /** dir の親を cwd にし、$0 を相対パスにする。 */
  relative?: true;
  code: number;
  /** 回した後の hooks の中身。 */
  hooks: Awaited<ReturnType<typeof readHooks>>;
  /** stub が起動されないなら undefined。 */
  tmpdir?: string;
  stderr?: string;
  /** stderr の Execute: の後のコマンドを実行してから回し直すと、exit 0 で hook が写っていること。 */
  fix?: true;
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
const refused = "。中身を確かめ、よければ Execute: ";
const states: [HookState, number, Case["hooks"], string?][] = [
  ["hooks が無い", 0, { "pre-push": copiedHook }],
  [
    "hooks が通常ファイル",
    1,
    "file",
    `/hooks: ディレクトリでない${refused}rm -f`,
  ],
  [
    "hooks が壊れた symlink",
    1,
    "dangling",
    `/hooks: ディレクトリでない${refused}rm -f`,
  ],
  ["hooks がディレクトリへの symlink", 0, { "pre-push": copiedHook }],
  ["無い", 0, { "pre-push": copiedHook }],
  ["壊れた symlink", 0, { "pre-push": copiedHook }],
  ["同じ中身への symlink", 0, { "pre-push": copiedHook }],
  [
    "違う中身への symlink",
    1,
    { "pre-push": { bytes: Array.from(other), executable: true } },
    `/pre-push: hooks/pre-push と中身が違う${refused}rm -f`,
  ],
  ["同じ", 0, { "pre-push": copiedHook }],
  ["同じで実行可能でない", 0, { "pre-push": copiedHook }],
  [
    "違う",
    1,
    { "pre-push": { bytes: Array.from(other), executable: true } },
    `/pre-push: hooks/pre-push と中身が違う${refused}rm -f`,
  ],
  [
    "読めない",
    1,
    { "pre-push": "mode 000" },
    `/pre-push: hooks/pre-push と比べられない (理由は上の cmp)${refused}rm -f`,
  ],
  [
    "ディレクトリ",
    1,
    { "pre-push": "dir" },
    `/pre-push: ディレクトリ${refused}rm -rf`,
  ],
  [
    "FIFO",
    1,
    { "pre-push": "other" },
    `/pre-push: 通常のファイルでない${refused}rm -f`,
  ],
];
const realCmp = await which("cmp");
for (const [state, code, hooks, stderr] of states) {
  cases.push({
    name: state,
    prepare: (dir) => setHook(dir, state),
    ...(state === "読めない"
      ? {
        fakes: {
          cmp:
            `#!/bin/sh\nif [ -n "$(find "$2" -prune -perm 0)" ]; then echo "cmp: $2: Permission denied" >&2; exit 2; fi\nexec '${realCmp}' "$@"\n`,
        },
      }
      : {}),
    code,
    hooks,
    tmpdir: realTmpdir,
    stderr,
    ...(code === 0 ? {} : { fix: true }),
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
// file でない出どころ (command line など) の core.hooksPath の行は無い: command line の変数は verify.sh が消し、他の出どころは --file・--blob を付けない読みでは出ない
const hooksPathFile = "[core]\n\thooksPath = elsewhere\n";
const realGit = await which("git");
cases.push(
  {
    name: "core.hooksPath",
    prepare: (dir) => git(dir, "config", "core.hooksPath", "elsewhere"),
    code: 1,
    hooks: { "pre-push": copiedHook },
    tmpdir: realTmpdir,
    stderr:
      "core.hooksPath が設定されている (local file:.git/config elsewhere)。hook は ",
    fix: true,
  },
  {
    name: "core.hooksPath を GIT_CONFIG_GLOBAL のファイルに書いた",
    prepare: (_, e) => Deno.writeTextFile(`${e}/gitconfig`, hooksPathFile),
    env: (e) => ({ GIT_CONFIG_GLOBAL: `${e}/gitconfig` }),
    code: 1,
    hooks: { "pre-push": copiedHook },
    tmpdir: realTmpdir,
    stderr: "core.hooksPath が設定されている (global file:",
    fix: true,
  },
  {
    // git config は -z 無しだと、このパスを C の quote で出す (canon: facts/git/config-sources-and-scopes)
    name:
      "core.hooksPath を、空白・タブ・非 ASCII を含むパスの include に書いた",
    prepare: async (dir, e) => {
      const include = `${e}/a b\tあ.cfg`;
      await Deno.writeTextFile(include, hooksPathFile);
      await git(dir, "config", "include.path", include);
    },
    code: 1,
    hooks: { "pre-push": copiedHook },
    tmpdir: realTmpdir,
    stderr: "core.hooksPath が設定されている (local file:",
    fix: true,
  },
  {
    name: "install が落ちる",
    prepare: (dir) => setHook(dir, "無い"),
    fakes: { install: failing("install") },
    code: 1,
    hooks: {},
    tmpdir: realTmpdir,
    stderr:
      "/pre-push: hooks/pre-push を写せない (理由は上)。 Execute: mkdir -p",
    fix: true,
  },
  {
    name: "chmod +x が落ちる",
    prepare: (dir) => setHook(dir, "同じで実行可能でない"),
    fakes: { chmod: failing("chmod") },
    code: 1,
    hooks: { "pre-push": { ...copiedHook, executable: false } },
    tmpdir: realTmpdir,
    stderr:
      "/pre-push: 実行可能にできない (理由は上の chmod)。 Execute: chmod +x",
    fix: true,
  },
  {
    name: "$0 が相対パスで、CDPATH が同じ相対パスの dir を持つ別の場所を指す",
    relative: true,
    prepare: (dir, e) =>
      Deno.mkdir(`${e}/${dir.slice(dir.lastIndexOf("/") + 1)}`),
    env: (e) => ({ CDPATH: e }),
    code: 0,
    hooks: { "pre-push": copiedHook },
    tmpdir: realTmpdir,
  },
  ...([["2.30.9", 1], ["2.31.0", 0]] as const).map(([version, code]) => ({
    name: `git の版が ${version}`,
    fakes: {
      git:
        `#!/bin/sh\n[ "$1" = --version ] && { echo 'git version ${version}'; exit 0; }\nexec '${realGit}' "$@"\n`,
    },
    code,
    hooks: code === 0 ? { "pre-push": copiedHook } : null,
    tmpdir: code === 0 ? realTmpdir : undefined,
    stderr: code === 0
      ? undefined
      : `git が 2.31 以降でない (git version ${version})`,
  })),
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
    stderr: "/nowhere) に cd できない (理由は上の cd)",
  },
  {
    name: "TMPDIR がディレクトリでない",
    prepare: (_, e) => Deno.writeTextFile(`${e}/file`, ""),
    env: (e) => ({ TMPDIR: `${e}/file` }),
    code: 1,
    hooks: { "pre-push": copiedHook },
    stderr: "/file) に cd できない (理由は上の cd)",
  },
  {
    name: "TMPDIR が相対パス",
    env: () => ({ TMPDIR: "." }),
    code: 1,
    hooks: { "pre-push": copiedHook },
    stderr: "verify.sh: TMPDIR (.) が相対パス",
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
    name: "deno.lock が deno.json と食い違えば落ちる",
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

/** stderr の Execute: の後のコマンドを bash で実行してから verify.sh を回し直した結果。 */
async function fixAndRerun(
  dir: string,
  env: Record<string, string>,
  stderr: string,
  relative: boolean,
) {
  const command = stderr.split("\n").find((l) => l.includes(" Execute: "))
    ?.split(" Execute: ")[1];
  if (command === undefined) return { command: null };
  const r = await spawn("bash", {
    args: ["-c", command],
    env: baseEnv,
    clearEnv: true,
  }).output();
  if (!r.success) return { command, stderr: dec.decode(r.stderr) };
  const again = await verify(dir, env, { relative });
  return { code: again.code, hooks: await readHooks(`${dir}/.git`) };
}

Deno.test("verify.sh の hook の状態と環境", async () => {
  const mismatches = (await Promise.all(
    cases.map((c) =>
      withTempDir((dir) =>
        withTempDir(async (elsewhere) => {
          await makeRepo(dir);
          await git(elsewhere, "init", "-q", "--template=");
          await c.prepare?.(dir, elsewhere);
          const env = c.env?.(elsewhere, dir) ?? {};
          if (c.fakes) {
            const bin = `${dir}/.git/fake-bin`;
            await Deno.mkdir(bin);
            for (const [name, content] of Object.entries(c.fakes)) {
              await Deno.writeTextFile(`${bin}/${name}`, content, {
                mode: 0o755,
              });
            }
            env.PATH = `${bin}:${baseEnv.PATH}`;
          }
          const lock = await Deno.readTextFile(`${dir}/deno.lock`);
          const relative = c.relative ?? false;
          const r = await verify(dir, env, { args: c.args, relative });
          const got = {
            code: r.code,
            hooks: await readHooks(`${dir}/.git`),
            strayHooks: await readHooks(`${elsewhere}/.git`),
            strayStdout: r.stdout.includes(elsewhere),
            report: reportOf(r.stdout),
            lockUnchanged: await Deno.readTextFile(`${dir}/deno.lock`) === lock,
            stderr: c.stderr === undefined || r.stderr.includes(c.stderr),
            fixed: c.fix && await fixAndRerun(dir, env, r.stderr, relative),
          };
          const want = {
            code: c.code,
            hooks: c.hooks,
            strayHooks: null,
            strayStdout: false,
            report: c.tmpdir === undefined ? undefined : {
              gitDir: `${await Deno.realPath(dir)}/.git`,
              gitVars: [],
              tmpdir: c.tmpdir,
              permissions,
            },
            lockUnchanged: true,
            stderr: true,
            fixed: c.fix && { code: 0, hooks: { "pre-push": copiedHook } },
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

const exists = (path: string) =>
  Deno.stat(path).then(() => true, (e) => {
    if (e instanceof Deno.errors.NotFound) return false;
    throw e;
  });

Deno.test("写している最中に SIGTERM を受けると、一時ファイルを残さずに 143 で終わる", async () => {
  await withTempDir(async (dir) => {
    await makeRepo(dir);
    await setHook(dir, "無い");
    const installed = `${dir}/.git/installed`;
    const bin = `${dir}/.git/fake-bin`;
    await Deno.mkdir(bin);
    // 一時ファイルを書いた後に止まる install。sleep は有限なので、verify.sh が止まらなくても自分で終わる
    await Deno.writeTextFile(
      `${bin}/install`,
      `#!/bin/sh\n'${await which(
        "install",
      )}' "$@" && echo > '${installed}' && sleep 3\n`,
      { mode: 0o755 },
    );
    const child = spawn("bash", {
      args: [`${dir}/verify.sh`],
      cwd: dir,
      env: { ...baseEnv, PATH: `${bin}:${baseEnv.PATH}` },
      clearEnv: true,
    });
    let started = false;
    for (let i = 0; i < 100 && !started; i++) {
      started = await exists(installed);
      if (!started) await new Promise((r) => setTimeout(r, 100));
    }
    child.kill("SIGTERM");
    const r = await child.output();
    deepStrictEqual(
      { started, code: r.code, hooks: await readHooks(`${dir}/.git`) },
      { started: true, code: 143, hooks: {} },
      dec.decode(r.stderr),
    );
  });
});
