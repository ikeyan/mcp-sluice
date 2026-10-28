/**
 * verify.sh を子として、TMPDIR の下の一時ディレクトリの fixture のリポで回す。
 * - fixture は verify.sh・hooks/pre-push・deno.json・deno.lock の写しと、scripts/run-checks.ts の stub。stub は次を JSON で出し、引数 (hook を揃えた結果) で終わる。
 *   - git が指す git dir。
 *   - 環境に残っている GIT_ の変数の名前 (比べるのは --local-env-vars の一覧に載るものだけ)。
 *   - TMPDIR と、自分の許可 (Deno.permissions.querySync)。
 * - 行ごとに、hook の写す元と写す先の状態と環境を作って verify.sh を回し、次を比べる。
 *   - 終了コード。
 *   - 回した後の common git dir の hooks の中身 (名前ごとのバイトと、実行可能か。一時ファイルが残れば名前が増える)。
 *   - stub の報告 (git dir・GIT_ の変数・TMPDIR・許可)。
 *   - 別のリポ (環境変数を向ける先) に hook を置かず、その場所を stdout に出さなかったか。
 *   - deno.lock を書き換えなかったか。
 * - 落ちる行は、示したコマンド (Execute: の後) を実行してから同じ環境で回し直し、exit 0 で hook が写ることも比べる。
 * - 道具の失敗 (install・cmp・chmod・uname・git) は、PATH の先に置いた fake で作る。
 * - linked worktree の test: worktree で回すと、hook は common git dir の hooks にだけ写る。
 * - 中断の test: 写している最中に SIGTERM を受けると、一時ファイルを残さない。
 * - TMPDIR の値は、canon: facts/shell/string-input-categories の分類から生成して回す。
 * - git rev-parse --local-env-vars の各行の形は、fake の git が出す行を生成して回す。
 * - 子の環境と symlink の作り方、test が起動したものの寿命と fixture の消し方は、run-checks_test.ts の先頭と同じ。
 */
import fc from "fast-check";
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

const fixtureFiles = [
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

/** dir を作って fn に渡し、終われば消す。fn が投げたら、消せなくても fn の例外を投げる (消せないことは stderr に出す)。 */
const withTempDir = async <T>(fn: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await Deno.makeTempDir({ dir: tmpdir });
  let result: T;
  try {
    result = await fn(dir);
  } catch (e) {
    await removeEventually(dir).catch((left) =>
      console.error(`${dir} を消せない — ${left}`)
    );
    throw e;
  }
  await removeEventually(dir);
  return result;
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

/** fixture のファイルを dir に置く。 */
async function placeFixture(dir: string) {
  for (const path of fixtureFiles) {
    await Deno.mkdir(`${dir}/${path.slice(0, path.lastIndexOf("/") + 1)}`, {
      recursive: true,
    });
    await Deno.copyFile(`${root}/${path}`, `${dir}/${path}`);
  }
  await Deno.mkdir(`${dir}/scripts`);
  await Deno.writeTextFile(`${dir}/scripts/run-checks.ts`, stub);
}

/** fixture のリポを作る。hooks の置き場は作らない (git init --template=)。 */
async function makeRepo(dir: string) {
  await git(dir, "init", "-q", "--template=");
  await placeFixture(dir);
}

/**
 * 写す先の hooks と pre-push の状態 (verify.sh の先頭の写す先の表の行)。
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

/** 写す元 (作業ツリーの hooks/pre-push) の状態 (verify.sh の先頭の写す元の表の、写す先へ進まない行)。git が追跡してから変える。 */
type SourceState = "無い" | "壊れた symlink" | "ディレクトリ";

async function setSource(dir: string, state: SourceState) {
  const src = `${dir}/hooks/pre-push`;
  await git(dir, "add", "hooks/pre-push");
  await Deno.remove(src);
  switch (state) {
    case "無い":
      return;
    case "壊れた symlink":
      return await ln(`${dir}/nowhere`, src);
    case "ディレクトリ":
      await Deno.mkdir(src);
      return await Deno.writeTextFile(`${src}/inside`, "");
  }
}

/**
 * gitDir の hooks の状態。
 * - hooks が無い: null。
 * - 通常ファイル: "file"。
 * - 壊れた symlink: "dangling"。
 * - ディレクトリ: 名前ごとの中身。
 *   - 通常ファイル: バイトと、実行可能か。mode が 000 なら中身を読まず "mode 000" (上の「読めない」)。
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

/** verify.sh の起動のしかた。cwd と $0。 */
interface Invocation {
  cwd: string;
  arg0: string;
}
const direct = (dir: string): Invocation => ({
  cwd: dir,
  arg0: `${dir}/verify.sh`,
});

/** baseEnv からの差分。undefined の変数は消す。 */
type EnvChange = Record<string, string | undefined>;

/** verify.sh を回す。 */
async function verify(
  { cwd, arg0 }: Invocation,
  change: EnvChange,
  args: string[] = [],
) {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries({ ...baseEnv, ...change })) {
    if (value !== undefined) env[name] = value;
  }
  const r = await spawn("bash", {
    // -- が無いと、- で始まる $0 を bash が option と読む
    args: ["--", arg0, ...args],
    cwd,
    env,
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
const realTmp = await Deno.realPath("/tmp");
/** 子の PATH で name を引く (command -v)。 */
const which = async (name: string) => {
  const r = await spawn("sh", {
    args: ["-c", 'command -v "$1"', "sh", name],
    env: baseEnv,
    clearEnv: true,
  }).output();
  if (!r.success) throw new Error(`${name} が PATH に無い`);
  return dec.decode(r.stdout).trim();
};
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
  env?: (elsewhere: string, dir: string) => EnvChange;
  /** PATH の先 (dir の .git/fake-bin) に置く fake (名前 → 中身)。 */
  fakes?: Record<string, string>;
  args?: string[];
  /** 既定は dir を cwd にし、$0 を絶対パスにする。 */
  invoke?: (dir: string, elsewhere: string) => Promise<Invocation>;
  code: number;
  /** 回した後の hooks の中身。 */
  hooks: Awaited<ReturnType<typeof readHooks>>;
  /** stub が起動されないなら undefined。関数なら、dir を解決したパスから決める。 */
  tmpdir?: string | ((realDir: string) => string);
  stderr?: string;
  /** stderr が含まないこと。 */
  stderrLacks?: string;
  /** stderr の Execute: の後のコマンドを実行してから回し直すと、exit 0 で hook が写っていること。 */
  fix?: true;
}

/** --local-env-vars のそれぞれを elsewhere へ向ける値。一覧に変数が増えたら、ここに足す。 */
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
/** 消しうるコマンドで直すと示した stderr の、理由の末尾からコマンドの先頭まで。 */
const refusedBy = (reason: string, command: string) =>
  `${reason}。消すものの中身を確かめ、よければ Execute: ${command}`;
const copiedHooks = { "pre-push": copiedHook };
const otherHooks = {
  "pre-push": { bytes: Array.from(other), executable: true },
};
/** 写した後に TMPDIR まで進んだ行の、stub の TMPDIR とその他の期待値。 */
const copied = { code: 0, hooks: copiedHooks, tmpdir: realTmpdir };
const states: [HookState, number, Case["hooks"], string?][] = [
  ["hooks が無い", 0, copiedHooks],
  [
    "hooks が通常ファイル",
    1,
    "file",
    refusedBy("/hooks: ディレクトリでない", "rm -f"),
  ],
  [
    "hooks が壊れた symlink",
    1,
    "dangling",
    refusedBy("/hooks: ディレクトリでない", "rm -f"),
  ],
  ["hooks がディレクトリへの symlink", 0, copiedHooks],
  ["無い", 0, copiedHooks],
  [
    "壊れた symlink",
    1,
    { "pre-push": "dangling" },
    refusedBy("/pre-push: 壊れた symlink", "rm -f"),
  ],
  ["同じ中身への symlink", 0, copiedHooks],
  [
    "違う中身への symlink",
    1,
    otherHooks,
    refusedBy("/pre-push: hooks/pre-push と中身が違う", "rm -f"),
  ],
  ["同じ", 0, copiedHooks],
  ["同じで実行可能でない", 0, copiedHooks],
  [
    "違う",
    1,
    otherHooks,
    refusedBy("/pre-push: hooks/pre-push と中身が違う", "rm -f"),
  ],
  [
    "読めない",
    1,
    { "pre-push": "mode 000" },
    refusedBy(
      "/pre-push: hooks/pre-push と比べられない (理由は上の cmp)",
      "rm -f",
    ),
  ],
  [
    "ディレクトリ",
    1,
    { "pre-push": "dir" },
    refusedBy("/pre-push: ディレクトリ", "rm -rf"),
  ],
  [
    "FIFO",
    1,
    { "pre-push": "other" },
    refusedBy("/pre-push: 通常のファイルでない", "rm -f"),
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
      // 実行可能なら chmod を呼ばない
      : state === "同じ"
      ? { fakes: { chmod: failing("chmod") } }
      : {}),
    code,
    hooks,
    tmpdir: realTmpdir,
    stderr,
    ...(code === 0 ? {} : { fix: true }),
  });
}
const sourceStates: [SourceState, string][] = [
  ["無い", "/hooks/pre-push: 無い。写す先には触れていない。Execute: git -C "],
  [
    "壊れた symlink",
    refusedBy(
      "/hooks/pre-push: 通常のファイルでない。写す先には触れていない",
      "git -C ",
    ),
  ],
  [
    "ディレクトリ",
    refusedBy(
      "/hooks/pre-push: 通常のファイルでない。写す先には触れていない",
      "git -C ",
    ),
  ],
];
for (const [source, stderr] of sourceStates) {
  for (const [state, hooks] of [["無い", {}], ["同じ", copiedHooks]] as const) {
    cases.push({
      name: `写す元が${source}で、写す先が${state}`,
      prepare: async (dir) => {
        await setSource(dir, source);
        await setHook(dir, state);
      },
      code: 1,
      hooks,
      tmpdir: realTmpdir,
      stderr,
      stderrLacks: "rm ",
      fix: true,
    });
  }
}
for (const name of localEnv) {
  cases.push({
    name: `${name} が別のリポを指す`,
    env: (e) => {
      const point = pointElsewhere[name];
      if (point === undefined) throw new Error(`${name} を向ける値が表に無い`);
      return point(e);
    },
    ...copied,
  });
}
const hooksPathFile = "[core]\n\thooksPath = elsewhere\n";
const realGit = await which("git");
const realInstall = await which("install");
/** core.hooksPath が設定されていても hook は写し、落ちて unset のコマンドを示す行。 */
const hooksPathSet = { ...copied, code: 1, fix: true as const };
cases.push(
  {
    name: "core.hooksPath",
    prepare: (dir) => git(dir, "config", "core.hooksPath", "elsewhere"),
    ...hooksPathSet,
    stderr:
      "core.hooksPath が設定されている (local file:.git/config elsewhere)。消す。",
  },
  {
    name: "core.hooksPath を worktree の scope に書いた",
    prepare: async (dir) => {
      await git(dir, "config", "extensions.worktreeConfig", "true");
      await git(dir, "config", "--worktree", "core.hooksPath", "elsewhere");
    },
    ...hooksPathSet,
    stderr:
      "core.hooksPath が設定されている (worktree file:.git/config.worktree elsewhere)。",
  },
  {
    name: "core.hooksPath を GIT_CONFIG_SYSTEM のファイルに書いた",
    prepare: (_, e) => Deno.writeTextFile(`${e}/sysconfig`, hooksPathFile),
    env: (e) => ({
      GIT_CONFIG_NOSYSTEM: "0",
      GIT_CONFIG_SYSTEM: `${e}/sysconfig`,
    }),
    ...hooksPathSet,
    stderr: "core.hooksPath が設定されている (system file:/",
  },
  {
    name: "core.hooksPath を GIT_CONFIG_GLOBAL のファイルに書いた",
    prepare: (_, e) => Deno.writeTextFile(`${e}/gitconfig`, hooksPathFile),
    env: (e) => ({ GIT_CONFIG_GLOBAL: `${e}/gitconfig` }),
    ...hooksPathSet,
    stderr: "core.hooksPath が設定されている (global file:",
  },
  {
    name: "core.hooksPath を global と local の 2 つに書いた",
    prepare: async (dir, e) => {
      await Deno.writeTextFile(`${e}/gitconfig`, hooksPathFile);
      await git(dir, "config", "core.hooksPath", "elsewhere");
    },
    env: (e) => ({ GIT_CONFIG_GLOBAL: `${e}/gitconfig` }),
    ...hooksPathSet,
    stderr: "/gitconfig elsewhere; local file:.git/config elsewhere)。",
  },
  {
    name:
      "core.hooksPath を、空白・タブ・非 ASCII を含むパスの include に書いた",
    prepare: async (dir, e) => {
      const include = `${e}/a b\tあ.cfg`;
      await Deno.writeTextFile(include, hooksPathFile);
      await git(dir, "config", "include.path", include);
    },
    ...hooksPathSet,
    stderr: "core.hooksPath が設定されている (local file:",
  },
  {
    name: "core.hooksPath を同じファイルに 2 回書いた",
    prepare: async (dir) => {
      await git(dir, "config", "--add", "core.hooksPath", "a");
      await git(dir, "config", "--add", "core.hooksPath", "b");
    },
    ...hooksPathSet,
    stderr: "(local file:.git/config a; local file:.git/config b)。消す。",
    // ファイルごとに 1 つの --unset-all で、両方の値が消える
    stderrLacks: " && git config",
  },
  {
    name: "git config が 0・1 以外で終わる",
    fakes: {
      git:
        `#!/bin/sh\n[ "$1" = config ] && { echo 'git: fake の失敗' >&2; exit 3; }\nexec '${realGit}' "$@"\n`,
    },
    code: 1,
    hooks: copiedHooks,
    tmpdir: realTmpdir,
    stderr:
      "core.hooksPath が設定されているかを読めない (git config が exit 3。理由は上の git)",
  },
  {
    name: "git の作業ツリーでない",
    prepare: (dir) => Deno.remove(`${dir}/.git`, { recursive: true }),
    // 上の dir を git が探さないように止める
    env: (_, dir) => ({
      GIT_CEILING_DIRECTORIES: dir.slice(0, dir.lastIndexOf("/")),
    }),
    code: 1,
    hooks: null,
    stderr: "を git の作業ツリーとして読めない (理由は上の git)",
  },
  {
    name: "親のリポの subdirectory に写しを置いた",
    invoke: async (_, e) => {
      await placeFixture(`${e}/sub`);
      return direct(`${e}/sub`);
    },
    code: 1,
    hooks: null,
    stderr: "は作業ツリーのルートでなく、親のリポの sub/ にある",
  },
  {
    name: "git dir の中に写しを置いた",
    invoke: async (_, e) => {
      await placeFixture(`${e}/.git/sub`);
      return direct(`${e}/.git/sub`);
    },
    code: 1,
    hooks: null,
    stderr: "は git の作業ツリーでない (git dir の中か bare のリポ)",
  },
  {
    name: "install が落ちる",
    prepare: (dir) => setHook(dir, "無い"),
    fakes: { install: failing("install") },
    code: 1,
    hooks: {},
    tmpdir: realTmpdir,
    stderr:
      "/pre-push: hooks/pre-push を写せない (理由は上)。Execute: mkdir -p",
    fix: true,
  },
  {
    // 一時ファイルを書いた後、置く前に、写す先へ別の中身が置かれる
    name: "置く前に別の中身が置かれる",
    prepare: (dir) => setHook(dir, "無い"),
    fakes: {
      install: `#!/bin/sh\n'${realInstall}' "$@" && printf '${
        dec.decode(other).replaceAll("\n", "\\n")
      }' > "\${4%.verify-*}"\n`,
    },
    code: 1,
    hooks: { "pre-push": { bytes: Array.from(other), executable: false } },
    tmpdir: realTmpdir,
    stderr: refusedBy("/pre-push: hooks/pre-push と中身が違う", "rm -f"),
    fix: true,
  },
  {
    name: "cmp が PATH に無い",
    prepare: (dir) => setHook(dir, "同じ"),
    // bash は PATH に無いコマンドを 127 にする。fake はその終わり方だけを写す
    fakes: { cmp: "#!/bin/sh\nexit 127\n" },
    code: 1,
    hooks: copiedHooks,
    tmpdir: realTmpdir,
    stderr:
      "/pre-push: cmp が PATH に無く、hooks/pre-push と比べられない。cmp を入れてから回し直す",
  },
  {
    name: "chmod +x が落ちる",
    prepare: (dir) => setHook(dir, "同じで実行可能でない"),
    fakes: { chmod: failing("chmod") },
    code: 1,
    hooks: { "pre-push": { ...copiedHook, executable: false } },
    tmpdir: realTmpdir,
    stderr:
      "/pre-push: 実行可能にできない (理由は上の chmod)。Execute: chmod +x",
    fix: true,
  },
  {
    name: "$0 が相対パスで、CDPATH が同じ相対パスの dir を持つ別の場所を指す",
    invoke: async (dir, e) => {
      const base = dir.slice(dir.lastIndexOf("/") + 1);
      await Deno.mkdir(`${e}/${base}`);
      return {
        cwd: dir.slice(0, dir.lastIndexOf("/")),
        arg0: `${base}/verify.sh`,
      };
    },
    env: (e) => ({ CDPATH: e }),
    ...copied,
  },
  {
    name: "$0 が -/verify.sh",
    invoke: async (dir, e) => {
      await ln(dir, `${e}/-`);
      return { cwd: e, arg0: "-/verify.sh" };
    },
    ...copied,
  },
  {
    name: "$0 が symlink",
    invoke: async (dir, e) => {
      await ln(`${dir}/verify.sh`, `${e}/v.sh`);
      return { cwd: e, arg0: "v.sh" };
    },
    code: 2,
    hooks: null,
    stderr: "verify.sh: v.sh は symlink で、その dir はリポでない",
  },
  {
    name: "OS が Linux でも macOS でもない",
    fakes: { uname: "#!/bin/sh\necho FreeBSD\n" },
    code: 1,
    hooks: null,
    stderr: "verify.sh: OS が Linux でも macOS でもない (FreeBSD)",
  },
  ...([["2.31.9", 1], ["2.32.0", 0]] as const).map(([version, code]) => ({
    name: `git の版が ${version}`,
    fakes: {
      git:
        `#!/bin/sh\n[ "$1" = --version ] && { echo 'git version ${version}'; exit 0; }\nexec '${realGit}' "$@"\n`,
    },
    ...(code === 0 ? copied : {
      code,
      hooks: null,
      stderr: `git が 2.32 以降でない (git version ${version})`,
    }),
  })),
  {
    name: "git rev-parse --local-env-vars が変数の名前でない行を出す",
    // --local-env-vars を知らない git が、リポの中で option の名前をそのまま出す形 (canon: facts/git/local-env-vars-and-hook-env の「知らない option」)
    fakes: {
      git:
        `#!/bin/sh\n[ "$*" = "rev-parse --local-env-vars" ] && { echo --local-env-vars; exit 0; }\nexec '${realGit}' "$@"\n`,
    },
    code: 1,
    hooks: null,
    stderr:
      "verify.sh: git rev-parse --local-env-vars の出力に、変数の名前でない行がある (--local-env-vars)",
  },
  {
    name: "git --version の形が読めない",
    fakes: {
      git:
        `#!/bin/sh\n[ "$1" = --version ] && { echo 'unknown'; exit 0; }\nexec '${realGit}' "$@"\n`,
    },
    code: 1,
    hooks: null,
    stderr: "git が 2.32 以降でない (unknown)",
  },
  {
    name: "引数を受けない",
    args: ["x"],
    code: 2,
    hooks: null,
    stderr: "verify.sh: 引数は受けない (x)",
  },
  ...[["空", ""], ["未設定", undefined]].map(([name, value]) => ({
    name: `TMPDIR が${name}なら /tmp を解決したもの`,
    env: () => ({ TMPDIR: value }),
    ...copied,
    tmpdir: realTmp,
  })),
  {
    name: "TMPDIR が symlink",
    prepare: (dir) => ln(realTmpdir, `${dir}/.git/tmp-link`),
    env: (_, dir) => ({ TMPDIR: `${dir}/.git/tmp-link` }),
    ...copied,
  },
  {
    name: "TMPDIR が無い",
    env: (e) => ({ TMPDIR: `${e}/nowhere` }),
    code: 1,
    hooks: copiedHooks,
    stderr:
      "/nowhere: No such file or directory\nverify.sh: TMPDIR に cd できない (値と理由は上の cd)",
  },
  {
    name: "TMPDIR がディレクトリでない",
    prepare: (_, e) => Deno.writeTextFile(`${e}/file`, ""),
    env: (e) => ({ TMPDIR: `${e}/file` }),
    code: 1,
    hooks: copiedHooks,
    stderr:
      "/file: Not a directory\nverify.sh: TMPDIR に cd できない (値と理由は上の cd)",
  },
  {
    name: "TMPDIR が相対パス",
    env: () => ({ TMPDIR: "." }),
    code: 1,
    hooks: copiedHooks,
    stderr: "verify.sh: TMPDIR (.) が相対パス",
  },
  {
    name: "TMPDIR が , を含む",
    prepare: (_, e) => Deno.mkdir(`${e}/a,b`),
    env: (e) => ({ TMPDIR: `${e}/a,b` }),
    code: 1,
    hooks: copiedHooks,
    stderr: "が , を含む",
  },
  {
    // hook は deno の exec より前に揃える
    name: "deno が PATH に無い",
    prepare: async (dir) => {
      const bin = `${dir}/.git/no-deno-bin`;
      await Deno.mkdir(bin);
      for (
        const name of [
          "bash",
          "uname",
          "dirname",
          "git",
          "cmp",
          "install",
          "mkdir",
          "ln",
          "rm",
        ]
      ) {
        await ln(await which(name), `${bin}/${name}`);
      }
    },
    env: (_, dir) => ({ PATH: `${dir}/.git/no-deno-bin` }),
    code: 127,
    hooks: copiedHooks,
    stderr: "deno: not found",
  },
  {
    name: "deno.lock が deno.json と食い違えば落ちる",
    prepare: async (dir) => {
      const json = JSON.parse(await Deno.readTextFile(`${dir}/deno.json`));
      json.imports["is-odd"] = "npm:is-odd@3.0.1";
      await Deno.writeTextFile(`${dir}/deno.json`, JSON.stringify(json));
    },
    code: 1,
    hooks: copiedHooks,
    stderr: "The lockfile is out of date",
  },
);

/** stderr の Execute: の後のコマンドを bash で実行してから verify.sh を回し直した結果。 */
async function fixAndRerun(
  invocation: Invocation,
  gitDir: string,
  env: EnvChange,
  stderr: string,
) {
  const command = stderr.split("\n").find((l) => l.includes("Execute: "))
    ?.split("Execute: ")[1];
  if (command === undefined) return { command: null };
  const r = await spawn("bash", {
    args: ["-c", command],
    env: baseEnv,
    clearEnv: true,
  }).output();
  if (!r.success) return { command, stderr: dec.decode(r.stderr) };
  const again = await verify(invocation, env);
  return { code: again.code, hooks: await readHooks(gitDir) };
}

/** c を回し、期待と違えば違いの説明を返す。 */
const runCase = (c: Case): Promise<string[]> =>
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
      const invocation = await c.invoke?.(dir, elsewhere) ?? direct(dir);
      const r = await verify(invocation, env, c.args);
      const got = {
        code: r.code,
        hooks: await readHooks(`${dir}/.git`),
        strayHooks: await readHooks(`${elsewhere}/.git`),
        strayStdout: r.stdout.includes(elsewhere),
        report: reportOf(r.stdout),
        lockUnchanged: await Deno.readTextFile(`${dir}/deno.lock`) === lock,
        stderr: c.stderr === undefined || r.stderr.includes(c.stderr),
        stderrLacks: c.stderrLacks === undefined ||
          !r.stderr.includes(c.stderrLacks),
        fixed: c.fix &&
          await fixAndRerun(invocation, `${dir}/.git`, env, r.stderr),
      };
      const want = {
        code: c.code,
        hooks: c.hooks,
        strayHooks: null,
        strayStdout: false,
        report: c.tmpdir === undefined ? undefined : {
          gitDir: `${await Deno.realPath(dir)}/.git`,
          gitVars: [],
          tmpdir: typeof c.tmpdir === "string"
            ? c.tmpdir
            : c.tmpdir(await Deno.realPath(dir)),
          permissions,
        },
        lockUnchanged: true,
        stderr: true,
        stderrLacks: true,
        fixed: c.fix && { code: 0, hooks: copiedHooks },
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
  );

Deno.test("verify.sh の hook の状態と環境", async () => {
  deepStrictEqual((await Promise.all(cases.map(runCase))).flat(), []);
});

Deno.test("git rev-parse --local-env-vars の各行が ^GIT_[A-Z_]+$ に合うときだけ受ける", async () => {
  // 次元: 大文字・小文字・数字・-・空白・\r・ASCII の外 (canon: facts/shell/string-input-categories)、空の行、GIT_ だけの行
  const fake =
    `#!/bin/sh\n[ "$*" = "rev-parse --local-env-vars" ] && { cat "\${FAKE_LINES?FAKE_LINES が無い}"; exit 0; }\nexec '${realGit}' "$@"\n`;
  /** fake の git が lines を出したときの、期待との違い。 */
  const runLines = (lines: string[]) => {
    // verify.sh は $(...) で受け (末尾の改行を落とす)、<<< で行に割る (空の出力は 1 つの空の行)
    const read = lines.join("\n").replace(/\n+$/, "").split("\n");
    return runCase({
      name: `--local-env-vars が ${JSON.stringify(lines)}`,
      // 改行を含む値を環境変数で渡すと、stub が読む env の出力の行が増える
      prepare: (dir) =>
        Deno.writeTextFile(`${dir}/.git/lines`, lines.join("\n")),
      fakes: { git: fake },
      env: (_, dir) => ({ FAKE_LINES: `${dir}/.git/lines` }),
      ...(read.every((l) => /^GIT_[A-Z_]+$/.test(l)) ? copied : {
        code: 1,
        hooks: null,
        stderr:
          "verify.sh: git rev-parse --local-env-vars の出力に、変数の名前でない行がある (",
      }),
    });
  };
  const rows = [
    ["GIT_DIR", "GIT_WORK_TREE"],
    ["GIT__"],
    [""],
    ["GIT_"],
    ["GIT_DIR", "", "GIT_PREFIX"],
    ["GIT_DIR", ""],
    ["GIT_DIR\r"],
    ["git_dir"],
    ["GIT_dir"],
    ["GIT_1"],
    ["GIT_A-B"],
    ["GIT_A B"],
    [" GIT_DIR"],
    ["GIT_é"],
    ["GIT_ｚ"],
  ];
  deepStrictEqual((await Promise.all(rows.map(runLines))).flat(), []);
  const line = fc.oneof(
    fc.constantFrom("", "GIT_", "GIT_DIR", "git_dir", "--local-env-vars"),
    fc.array(
      fc.constantFrom(
        "A",
        "Z",
        "_",
        "a",
        "z",
        "0",
        "9",
        "-",
        " ",
        "\r",
        "é",
        "ｚ",
      ),
      { minLength: 1, maxLength: 4 },
    ).map((cs) => `GIT_${cs.join("")}`),
  );
  await fc.assert(
    fc.asyncProperty(
      fc.array(line, { minLength: 1, maxLength: 3 }),
      async (lines) => deepStrictEqual(await runLines(lines), []),
    ),
    { numRuns: 10, includeErrorInReport: true },
  );
});

Deno.test("TMPDIR の値の文字", async () => {
  // 次元: canon: facts/shell/string-input-categories の全分類と、glob の ? [、改行。`,` は cases の行で検査する
  const chars = [
    "\t",
    "\x01",
    " ",
    "$",
    "*",
    '"',
    "'",
    "\\",
    "é",
    "あ",
    "ｚ",
    "?",
    "[",
    "\n",
  ];
  /** TMPDIR を .git の下の name のディレクトリにして回した、期待との違い。 */
  const runName = (name: string) =>
    runCase({
      name: `TMPDIR が ${JSON.stringify(name)}`,
      prepare: (dir) => Deno.mkdir(`${dir}/.git/${name}`),
      env: (_, dir) => ({ TMPDIR: `${dir}/.git/${name}` }),
      ...copied,
      tmpdir: (realDir) => `${realDir}/.git/${name}`,
    });
  // 各文字を 1 つずつ
  deepStrictEqual(
    (await Promise.all(chars.map((c) => runName(`a${c}b`)))).flat(),
    [],
  );
  // 組み合わせ: 先頭の - と、2 文字以上の並び
  const nameArb = fc.record({
    head: fc.constantFrom("", "-x", "--help"),
    body: fc.array(fc.constantFrom(...chars), { minLength: 2, maxLength: 4 }),
  }).map(({ head, body }) => `${head}a${body.join("")}b`);
  await fc.assert(
    fc.asyncProperty(
      fc.uniqueArray(nameArb, { minLength: 1, maxLength: 4 }),
      async (names) =>
        deepStrictEqual(
          (await Promise.all(names.map(runName))).flat(),
          [],
        ),
    ),
    { numRuns: 5, includeErrorInReport: true },
  );
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
      const r = await verify(direct(`${outside}/wt`), {});
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
      if (!started) await sleep(100);
    }
    try {
      child.kill("SIGTERM");
    } catch (e) {
      // 先に終わった子への kill は TypeError (canon: facts/deno/command-spawn)。終わり方は下で比べる
      if (!(e instanceof TypeError)) throw e;
    }
    const r = await child.output();
    deepStrictEqual(
      { started, code: r.code, hooks: await readHooks(`${dir}/.git`) },
      { started: true, code: 143, hooks: {} },
      dec.decode(r.stderr),
    );
  });
});
