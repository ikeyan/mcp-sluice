/**
 * check-json-md.ts を子として、一時ディレクトリの fixture に回す。
 * - 表の各行: fixture のファイルと引数に対し、終了コードと stderr の違反の行 (順を問わない集合) が一致すること。
 * - 性質: 生成した相対パス (`.`・`..`・空・名前の segment、先頭の `/`) へのリンクが「リポの外を指す」と報告されるのは、`..` で辿ってルートより上へ戻るときだけ。
 */
import fc from "fast-check";
import { deepStrictEqual } from "node:assert/strict";

const root = Deno.realPathSync(`${import.meta.dirname}/..`);
const dec = new TextDecoder();

const withTempDir = async <T>(fn: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await Deno.makeTempDir();
  try {
    return await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
};

/** files を置いた一時ディレクトリを cwd にして check-json-md.ts を回す。値が null のパスはディレクトリにする。 */
const check = (
  files: Record<string, string | null>,
  args = Object.keys(files).filter((f) => /\.(?:json|md)$/.test(f)),
): Promise<{ code: number; stderr: string }> =>
  withTempDir(async (dir) => {
    for (const [path, content] of Object.entries(files)) {
      const full = `${dir}/${path}`;
      if (content === null) {
        await Deno.mkdir(full, { recursive: true });
        continue;
      }
      await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), {
        recursive: true,
      });
      await Deno.writeTextFile(full, content);
    }
    const r = await new Deno.Command("deno", {
      args: [
        "run",
        "--frozen-lockfile",
        `--config=${root}/deno.json`,
        "--allow-read=.",
        `${root}/scripts/check-json-md.ts`,
        ...args,
      ],
      cwd: dir,
      stdin: "null",
    }).output();
    return { code: r.code, stderr: dec.decode(r.stderr) };
  });

const lines = (s: string) => s.split("\n").filter(Boolean).sort();

const heading = "# x\n\n## a\n\n## a\n";
const cases: {
  name: string;
  files: Record<string, string | null>;
  args?: string[];
  code: number;
  stderr: string[];
  /** stderr の行の先頭だけを比べる (OS の文言を含む行) */
  prefix?: boolean;
}[] = [
  {
    name: "ルートからのパス",
    files: {
      LICENSE: "",
      "docs/a.md": "[l](/LICENSE) [m](/nope) [n](/docs/a.md)\n",
    },
    code: 1,
    stderr: ["docs/a.md: リンク先が無い — /nope"],
  },
  {
    name: "ルートより上へ戻る ..",
    files: {
      LICENSE: "",
      "docs/a.md":
        "[ok](../LICENSE) [up](../../LICENSE) [root](/../LICENSE) [back](../docs/../../x)\n",
    },
    code: 1,
    stderr: [
      "docs/a.md: リポの外を指す — ../../LICENSE",
      "docs/a.md: リポの外を指す — /../LICENSE",
      "docs/a.md: リポの外を指す — ../docs/../../x",
    ],
  },
  {
    name: "2 つ目の # は anchor の一部",
    files: { "b.md": heading, "a.md": "[l](b.md#x#y) [m](b.md#x)\n" },
    code: 1,
    stderr: ["a.md: anchor が見出しに無い — b.md#x#y"],
  },
  {
    name: "query は見ない",
    files: { "b.md": heading, "a.md": "[l](b.md?plain=1#x) [m](c.md?x=1)\n" },
    code: 1,
    stderr: ["a.md: リンク先が無い — c.md?x=1"],
  },
  {
    name: "生の HTML の href・src",
    files: {
      "b.md": heading,
      "img/ok.png": "",
      "a.md": [
        '<p align="center"><img src="img/ok.png"><img src=\'img/no.png\'></p>',
        "",
        '<!-- <a href="commented.md"> -->',
        "",
        'text <a href="b.md#x">x</a> <a href=missing.md>m</a> <a href="b.md?a=1&amp;b=2#nope">n</a> <img src="https://example.com/x.png">',
        "",
      ].join("\n"),
    },
    code: 1,
    stderr: [
      "a.md: リンク先が無い — img/no.png",
      "a.md: リンク先が無い — missing.md",
      "a.md: anchor が見出しに無い — b.md?a=1&b=2#nope",
    ],
  },
  {
    name: ".md でないファイルの anchor",
    files: {
      LICENSE: "",
      "a.md": "[a](LICENSE#L10) [b](LICENSE#L10-L20) [c](LICENSE#intro)\n",
    },
    code: 1,
    stderr: [
      "a.md: .md でないファイルの anchor は検査できない — LICENSE#intro",
    ],
  },
  {
    name: "重複する見出しと自分への anchor",
    files: {
      "b.md": heading + "\n[s](#a-1) [t](#a-2)\n",
      "a.md": "[l](b.md#a) [m](b.md#a-1) [n](b.md#a-2)\n",
    },
    code: 1,
    stderr: [
      "a.md: anchor が見出しに無い — b.md#a-2",
      "b.md: anchor が見出しに無い — #a-2",
    ],
  },
  {
    name: "YAML として不正な frontmatter",
    files: {
      "b.md": "---\ntitle: x: y\n---\n# Real\n",
      "a.md": "[l](b.md#real) [m](b.md#title-x-y)\n",
    },
    code: 1,
    stderr: ["a.md: anchor が見出しに無い — b.md#title-x-y"],
  },
  {
    name: "壊れた %-escape",
    files: {
      "b.md": heading,
      "100%zz.md": "",
      "a.md": '<a href="100%zz.md">a</a> <a href="b.md#%E3">b</a>\n',
    },
    code: 1,
    stderr: ["a.md: anchor が見出しに無い — b.md#%E3"],
  },
  {
    name: "無いファイルと、他の理由で読めないもの",
    files: {
      LICENSE: "",
      "dir.md": null,
      "a.md": "[l](LICENSE/x)\n",
    },
    args: ["a.md", "dir.md", "gone.md", "gone.json"],
    code: 1,
    prefix: true,
    stderr: [
      "a.md: リンク先を読めない — LICENSE/x (Not a directory",
      "dir.md: 読めない — Is a directory",
      "gone.json: git の一覧にあるがファイルが無い",
      "gone.md: git の一覧にあるがファイルが無い",
    ],
  },
  {
    name: "JSON の構文",
    files: { "ok.json": "{}", "bad.json": "{" },
    code: 1,
    prefix: true,
    stderr: ["bad.json: JSON として読めない — "],
  },
  {
    name: ".json・.md でない引数",
    files: { "a.md": "" },
    args: ["a.md", "a.txt"],
    code: 2,
    stderr: ["check-json-md.ts: 引数は .json か .md のファイルだけ (a.txt)"],
  },
];

Deno.test("check-json-md.ts の表", async () => {
  const failures = (await Promise.all(cases.map(async (c) => {
    const r = await check(c.files, c.args);
    const got = lines(r.stderr);
    const want = [...c.stderr].sort();
    const matches = got.length === want.length &&
      got.every((l, i) => c.prefix ? l.startsWith(want[i]) : l === want[i]);
    return r.code === c.code && matches
      ? []
      : [`${c.name}: exit ${r.code} (期待 ${c.code})\n${r.stderr}`];
  }))).flat();
  deepStrictEqual(failures, []);
});

/** dir (リポのルートからの segment の数) から path を辿り、ルートより上へ戻るか。 */
const escapes = (depth: number, path: string): boolean => {
  if (path === "" || path.startsWith("//")) return false;
  let d = path.startsWith("/") ? 0 : depth;
  for (const s of path.split("/")) {
    if (s === "..") d--;
    else if (s !== "" && s !== ".") d++;
    if (d < 0) return true;
  }
  return false;
};

Deno.test("リポの外を指すと報告するのは、.. でルートより上へ戻るときだけ", async () => {
  const path = fc.array(fc.constantFrom(".", "..", "", "a", "n.md"), {
    minLength: 1,
    maxLength: 6,
  }).map((s) => s.join("/"));
  await fc.assert(
    fc.asyncProperty(
      fc.uniqueArray(path, { minLength: 1, maxLength: 20 }),
      async (paths) => {
        const r = await check({
          "a/b/x.md": paths.map((p) => `- [l](<${p}>)\n`).join(""),
        });
        const prefix = "a/b/x.md: リポの外を指す — ";
        deepStrictEqual(
          lines(r.stderr).filter((l) => l.startsWith(prefix)).map((l) =>
            l.slice(prefix.length)
          ),
          paths.filter((p) => escapes(2, p)).sort(),
        );
      },
    ),
    { numRuns: 30, includeErrorInReport: true },
  );
});
