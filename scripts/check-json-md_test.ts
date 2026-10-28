/**
 * check-json-md.ts を子として、TMPDIR の下の一時ディレクトリの fixture に回す。
 * - 表の各行: fixture のファイルと引数に対し、終了コードと stderr の違反の行 (順を問わない集合) が一致すること。
 * - 性質: 生成した相対パスへのリンクについて、報告が、最初の # と、その前の最初の ? で割り、パスを segment ごとに decode して辿るモデルと一致すること。
 */
import fc from "fast-check";
import { deepStrictEqual } from "node:assert/strict";

const root = Deno.realPathSync(`${import.meta.dirname}/..`);
const dec = new TextDecoder();
const tmpdir = Deno.env.get("TMPDIR");
if (!tmpdir) throw new Error("TMPDIR が空。./verify.sh から回す");

const withTempDir = async <T>(fn: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await Deno.makeTempDir({ dir: tmpdir });
  try {
    return await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
};

/** files を置いた一時ディレクトリを cwd にして check-json-md.ts を回す。値が null のパスはディレクトリにする。引数の既定は null でないパスの全部。 */
const check = (
  files: Record<string, string | null>,
  args = Object.keys(files).filter((f) => files[f] !== null),
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

/** 期待行のそれぞれに、まだ割り当てていない実際の行を 1 つずつ割り当てられるか (prefix なら先頭の一致)。 */
const assignable = (got: string[], want: string[], prefix: boolean) => {
  if (got.length !== want.length) return false;
  const free = [...got];
  return [...want].sort((a, b) => b.length - a.length).every((w) => {
    const i = free.findIndex((g) => prefix ? g.startsWith(w) : g === w);
    if (i < 0) return false;
    free.splice(i, 1);
    return true;
  });
};

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
      "docs/a.md":
        "[l](/LICENSE) [m](/nope) [n](/docs/a.md) [o](/) [p](/docs/)\n",
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
    name: "綴りは大文字小文字まで git の一覧と比べる",
    files: {
      LICENSE: "",
      "docs/a.md": "",
      "b.md": "[l](license) [m](Docs/a.md) [n](docs/a.md)\n",
    },
    code: 1,
    stderr: [
      "b.md: リンク先が無い — license",
      "b.md: リンク先が無い — Docs/a.md",
    ],
  },
  {
    name: "git の一覧に無いファイルは、作業ツリーに在っても無い",
    files: { "untracked.md": "", "a.md": "[l](untracked.md)\n" },
    args: ["a.md"],
    code: 1,
    stderr: ["a.md: リンク先が無い — untracked.md"],
  },
  {
    name: "%-エンコードは segment ごとに戻す",
    files: {
      LICENSE: "",
      "a b.md": "",
      "docs/a.md":
        "[l](%2e%2e/LICENSE) [m](..%2FLICENSE) [n](../a%20b.md) [o](%2E%2E/%2e%2e/LICENSE)\n",
    },
    code: 1,
    stderr: [
      "docs/a.md: リンク先が無い — ..%2FLICENSE",
      "docs/a.md: リポの外を指す — %2E%2E/%2e%2e/LICENSE",
    ],
  },
  {
    name: "不正な %-エンコード",
    files: {
      "b.md": heading,
      "100%zz.md": "",
      "a.md": '<a href="100%zz.md">a</a> <a href="b.md#%E3">b</a>\n',
    },
    code: 1,
    stderr: [
      "a.md: 不正な %-エンコード — 100%zz.md",
      "a.md: anchor が見出しに無い — b.md#%E3",
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
    name: "参照スタイルのリンク・画像と、外部のもの",
    files: {
      "b.md": heading,
      "a.md": [
        "[l][ok] ![i][img] [m][gone] [h](//example.com/x.md) [e](mailto:a@b) [s](https://example.com/y.md)",
        "",
        "[ok]: b.md#a-1",
        "[img]: b.md",
        "[gone]: gone.md",
        "",
      ].join("\n"),
    },
    code: 1,
    stderr: ["a.md: リンク先が無い — gone.md"],
  },
  {
    name: "生の HTML の href・src・srcset",
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
        '<picture><source srcset="img/ok.png 2x"><img src="img/ok.png"></picture>',
        "",
      ].join("\n"),
    },
    code: 1,
    stderr: [
      "a.md: リンク先が無い — img/no.png",
      "a.md: リンク先が無い — missing.md",
      "a.md: anchor が見出しに無い — b.md?a=1&b=2#nope",
      "a.md: srcset のリンク先は検査できない。リポ内のファイルを指すなら src にする — srcset=img/ok.png 2x",
    ],
  },
  {
    name: ".md でないファイルとディレクトリの anchor",
    files: {
      LICENSE: "",
      "docs/b.md": "",
      "a.md":
        "[a](LICENSE#L10) [b](LICENSE#L10-L20) [c](LICENSE#intro) [d](docs#x)\n",
    },
    code: 1,
    stderr: [
      "a.md: .md でないファイルの anchor は検査できない — LICENSE#intro",
      "a.md: .md でないファイルの anchor は検査できない — docs#x",
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
    // canon: facts/github/heading-anchor-ids の表の行
    name: "見出しの id: 画像の alt・HTML の alt・_・日本語",
    files: {
      "logo.png": "",
      "b.md": [
        "## ![Logo](logo.png) Project Name",
        "### Text ![alt word](logo.png) tail",
        '#### <img src="logo.png" alt="html alt"> Html Img',
        "## `subscribe_pr_activity` only",
        "## 日本語の見出し",
        "",
      ].join("\n"),
      "a.md": [
        "[a](b.md#-project-name) [b](b.md#logo-project-name)",
        "[c](b.md#text--tail) [d](b.md#text-alt-word-tail)",
        "[e](b.md#-html-img) [f](b.md#html-alt-html-img)",
        "[g](b.md#subscribe_pr_activity-only)",
        "[h](b.md#日本語の見出し) [i](b.md#%E6%97%A5%E6%9C%AC%E8%AA%9E%E3%81%AE%E8%A6%8B%E5%87%BA%E3%81%97)",
        '<a href="b.md#日本語の見出し">j</a>',
        "",
      ].join("\n"),
    },
    code: 1,
    stderr: [
      "a.md: anchor が見出しに無い — b.md#logo-project-name",
      "a.md: anchor が見出しに無い — b.md#text-alt-word-tail",
      "a.md: anchor が見出しに無い — b.md#html-alt-html-img",
    ],
  },
  {
    name: "frontmatter: YAML として不正なものと空のもの",
    files: {
      "b.md": "---\ntitle: x: y\n---\n# Real\n",
      "c.md": "---\n---\nEmpty\n",
      "d.md": "---\n---\n# Heading\n",
      "a.md":
        "[l](b.md#real) [m](b.md#title-x-y) [n](c.md#empty) [o](d.md#heading)\n",
    },
    code: 1,
    stderr: [
      "a.md: anchor が見出しに無い — b.md#title-x-y",
      "a.md: anchor が見出しに無い — c.md#empty",
    ],
  },
  {
    name: "frontmatter: CRLF",
    files: {
      "b.md": "---\r\ntitle: x\r\n---\r\n# Real\r\n",
      "a.md": "[l](b.md#real) [m](b.md#title-x)\n",
    },
    code: 1,
    stderr: ["a.md: anchor が見出しに無い — b.md#title-x"],
  },
  {
    // markdown-it は \_ を text_special の _ にする (canon: facts/github/heading-anchor-ids の子トークンの選び方)
    name: "見出しの id: backslash escape",
    files: {
      "b.md": "## a\\_b\n",
      "a.md": "[l](b.md#a_b) [m](b.md#ab)\n",
    },
    code: 1,
    stderr: ["a.md: anchor が見出しに無い — b.md#ab"],
  },
  {
    name: "読めないファイルは原因の文言のまま",
    files: { "dir.md": null, "a.md": "[l](gone.md#x)\n" },
    args: ["a.md", "dir.md", "gone.md", "gone.json"],
    code: 1,
    prefix: true,
    stderr: [
      "dir.md: 読めない — Is a directory",
      "gone.md: 読めない — No such file or directory",
      "gone.json: 読めない — No such file or directory",
    ],
  },
  {
    name: "JSON の構文",
    files: { "ok.json": "{}", "bad.json": "{" },
    code: 1,
    prefix: true,
    stderr: ["bad.json: JSON として読めない — "],
  },
  ...[[], ["/a.md"], ["a//b.md"], ["./a.md"], ["a/../b.md"], [""], ["a/"]].map((
    args,
  ) => ({
    name: `引数 ${JSON.stringify(args)}`,
    files: { "a.md": "" },
    args,
    code: 2,
    prefix: true,
    stderr: ["check-json-md.ts: 引数は git が知るファイルの"],
  })),
];

Deno.test("check-json-md.ts の表", async () => {
  const failures = (await Promise.all(cases.map(async (c) => {
    const r = await check(c.files, c.args);
    return r.code === c.code &&
        assignable(lines(r.stderr), c.stderr, c.prefix ?? false)
      ? []
      : [`${c.name}: exit ${r.code} (期待 ${c.code})\n${r.stderr}`];
  }))).flat();
  deepStrictEqual(failures, []);
});

/** リンクを置くファイル (a/b/x.md) の他に、git の一覧に載せるファイル。 */
const known = ["a/b/x.md", "a/n.md", "a b/n.md"];

const labels = {
  outside: "リポの外を指す",
  missing: "リンク先が無い",
  anchor: "anchor が見出しに無い",
  notMd: ".md でないファイルの anchor は検査できない",
};

/** a/b/x.md の url のリンクの報告のモデル。known の .md はどれも見出しを持たない。報告が無ければ undefined。 */
const model = (url: string): keyof typeof labels | undefined => {
  if (url.startsWith("//")) return undefined;
  const hash = url.indexOf("#");
  const raw = hash < 0 ? "" : url.slice(hash + 1);
  const anchor = (() => {
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  })();
  const path = (hash < 0 ? url : url.slice(0, hash)).split("?")[0];
  const out = path === ""
    ? ["a", "b", "x.md"]
    : path.startsWith("/")
    ? []
    : ["a", "b"];
  if (path !== "") {
    for (const segment of path.split("/")) {
      const s = decodeURIComponent(segment);
      if (s === "" || s === ".") continue;
      if (s !== "..") out.push(s);
      else if (out.pop() === undefined) return "outside";
    }
  }
  const isFile = known.includes(out.join("/"));
  const exists = known.some((f) => {
    const segments = f.split("/");
    return segments.length >= out.length &&
      out.every((s, i) => s === segments[i]);
  });
  if (!exists) return "missing";
  if (anchor === "") return undefined;
  if (!isFile) return /^L\d+(?:-L\d+)?$/.test(anchor) ? undefined : "notMd";
  return "anchor";
};

Deno.test("リンクの報告は、# と ? で割って segment ごとに decode して辿るモデルと一致する", async () => {
  const path = fc.array(
    fc.constantFrom(
      ".",
      "..",
      "",
      "a",
      "A",
      "b",
      "n.md",
      "N.md",
      "x.md",
      "%2e%2e",
      "%2E",
      "%2F",
      "a%20b",
      "#",
      "#L1",
      "n.md#x",
      "?q",
      "x.md?q#y",
      "%23",
    ),
    { minLength: 1, maxLength: 6 },
  ).map((s) => s.join("/"));
  await fc.assert(
    fc.asyncProperty(
      fc.uniqueArray(path, { minLength: 1, maxLength: 20 }),
      async (paths) => {
        const r = await check({
          "a/n.md": "",
          "a b/n.md": "",
          "a/b/x.md": paths.map((p) => `- [l](<${p}>)\n`).join(""),
        });
        deepStrictEqual(
          lines(r.stderr),
          paths.flatMap((p) => {
            const m = model(p);
            return m === undefined ? [] : [`a/b/x.md: ${labels[m]} — ${p}`];
          }).sort(),
        );
      },
    ),
    { numRuns: 30, includeErrorInReport: true },
  );
});
