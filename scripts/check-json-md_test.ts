/**
 * check-json-md.ts を子として、TMPDIR の下の一時ディレクトリの fixture に回す。
 * - 表の各行: fixture のファイルと引数に対し、終了コードと stderr の違反の行 (順を問わない集合) が一致すること。
 * - 性質: 生成した相対パスへのリンクについて、報告が、最初の # と、その前の最初の ? で割り、パスを segment ごとに decode して辿り、anchor を decode するモデルと一致すること。
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

/** files を置いた一時ディレクトリを cwd にして check-json-md.ts を回す。値が null のパスはディレクトリにし、Uint8Array はそのバイトで書く。引数の既定は null でないパスの全部。 */
const check = (
  files: Record<string, string | Uint8Array | null>,
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
      await (typeof content === "string"
        ? Deno.writeTextFile(full, content)
        : Deno.writeFile(full, content));
    }
    const r = await new Deno.Command("deno", {
      args: [
        "run",
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
/** 検査できない属性の違反の、属性の名前の後から値の前まで。 */
const uncheckable =
  "の参照先は検査できない。リポ内のファイルを指すなら Markdown のリンク・画像で書き、この属性を外す";

/** 属性の類 (check-json-md.ts の先頭の「属性の類」と attributeClasses。canon: facts/html/url-valued-attributes の一覧と「値の形」)。大文字の綴りを各類に 1 つ。other (attributeClasses に無いもの) は代表の 1 つ。 */
const attributeClasses: [
  string[],
  "url" | "urlList" | "unconfirmed" | "ignored" | "other",
][] = [
  [
    [
      "href",
      "src",
      "action",
      "background",
      "cite",
      "codebase",
      "data",
      "formaction",
      "itemid",
      "longdesc",
      "lowsrc",
      "manifest",
      "poster",
      "CITE",
    ],
    "url",
  ],
  [["imagesrcset", "itemtype", "ping", "srcset", "SRCSET"], "urlList"],
  [
    ["archive", "classid", "profile", "xlink:href", "XLINK:HREF"],
    "unconfirmed",
  ],
  [["usemap", "UseMap"], "ignored"],
  [["title"], "other"],
];
/** 値の類。a.md は見出し a を持ち、b.md は在って見出しを持たず、gone.md は無い。 */
const attributeValues = [
  "https://example.com/x.md",
  "//example.com/x.md",
  "",
  "#a",
  "#nope",
  "b.md",
  "b.md#nope",
  "gone.md",
];
/** 属性ごとの行: 値の類の全部を属性の値に置き、類ごとの違反の行と比べる。 */
const attributeCases = attributeClasses.flatMap(([names, kind]) =>
  names.map((name) => ({
    name: `属性 ${name} (${kind}) と値の類`,
    files: {
      "b.md": "",
      "a.md": [
        "# a",
        "",
        ...attributeValues.map((v) => `<span ${name}="${v}">x</span>`),
        "",
      ].join("\n"),
    },
    code: kind === "ignored" || kind === "other" ? 0 : 1,
    stderr: kind === "url"
      ? [
        "a.md: anchor が見出しに無い。リンク先の見出しの id に合わせる — #nope",
        "a.md: anchor が見出しに無い。リンク先の見出しの id に合わせる — b.md#nope",
        "a.md: リンク先が無い。git が知るファイルかディレクトリを指す — gone.md",
      ]
      : kind === "urlList" || kind === "unconfirmed"
      ? attributeValues.filter((v) => v !== "").map((v) =>
        `a.md: ${name.toLowerCase()} ${uncheckable} — ${name.toLowerCase()}=${v}`
      )
      : [],
  }))
);
const cases: {
  name: string;
  files: Record<string, string | Uint8Array | null>;
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
    stderr: [
      "docs/a.md: リンク先が無い。git が知るファイルかディレクトリを指す — /nope",
    ],
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
      "docs/a.md: リポの外を指す。リポ内を指すか、URL で書く — ../../LICENSE",
      "docs/a.md: リポの外を指す。リポ内を指すか、URL で書く — /../LICENSE",
      "docs/a.md: リポの外を指す。リポ内を指すか、URL で書く — ../docs/../../x",
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
      "b.md: リンク先が無い。git が知るファイルかディレクトリを指す — license",
      "b.md: リンク先が無い。git が知るファイルかディレクトリを指す — Docs/a.md",
    ],
  },
  {
    name: "git の一覧に無いファイルは、作業ツリーに在っても無い",
    files: { "untracked.md": "", "a.md": "[l](untracked.md)\n" },
    args: ["a.md"],
    code: 1,
    stderr: [
      "a.md: リンク先が無い。git が知るファイルかディレクトリを指す — untracked.md",
    ],
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
      "docs/a.md: リンク先が無い。git が知るファイルかディレクトリを指す — ..%2FLICENSE",
      "docs/a.md: リポの外を指す。リポ内を指すか、URL で書く — %2E%2E/%2e%2e/LICENSE",
    ],
  },
  {
    name: "%2F を decode した segment は、/ を含む 1 つの名前",
    files: {
      "a/b.md": "",
      "x.md": "[l](/a%2Fb.md) [m](a%2Fb.md) [n](a/b.md)\n",
    },
    code: 1,
    stderr: [
      "x.md: リンク先が無い。git が知るファイルかディレクトリを指す — /a%2Fb.md",
      "x.md: リンク先が無い。git が知るファイルかディレクトリを指す — a%2Fb.md",
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
      "a.md: 不正な %-エンコード。正しい %XX の列にする (% そのものは %25) — 100%zz.md",
      "a.md: 不正な %-エンコード。正しい %XX の列にする (% そのものは %25) — b.md#%E3",
    ],
  },
  {
    name: "2 つ目の # は anchor の一部",
    files: { "b.md": heading, "a.md": "[l](b.md#x#y) [m](b.md#x)\n" },
    code: 1,
    stderr: [
      "a.md: anchor が見出しに無い。リンク先の見出しの id に合わせる — b.md#x#y",
    ],
  },
  {
    name: "query は見ない",
    files: { "b.md": heading, "a.md": "[l](b.md?plain=1#x) [m](c.md?x=1)\n" },
    code: 1,
    stderr: [
      "a.md: リンク先が無い。git が知るファイルかディレクトリを指す — c.md?x=1",
    ],
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
    stderr: [
      "a.md: リンク先が無い。git が知るファイルかディレクトリを指す — gone.md",
    ],
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
        'text <a href="b.md#x">x</a> <a href=missing.md>m</a> <a href="b.md?a=1&amp;b=2#nope">n</a> <img src="https://example.com/x.png"> <a HREF="upper.md">u</a>',
        "",
        '<picture><source srcset="img/ok.png 2x"><img src="img/ok.png"></picture>',
        "",
      ].join("\n"),
    },
    code: 1,
    stderr: [
      "a.md: リンク先が無い。git が知るファイルかディレクトリを指す — img/no.png",
      "a.md: リンク先が無い。git が知るファイルかディレクトリを指す — missing.md",
      "a.md: リンク先が無い。git が知るファイルかディレクトリを指す — upper.md",
      "a.md: anchor が見出しに無い。リンク先の見出しの id に合わせる — b.md?a=1&b=2#nope",
      `a.md: srcset ${uncheckable} — srcset=img/ok.png 2x`,
    ],
  },
  {
    // canon: facts/url/parser-strips-c0-space-and-tab-newline
    name: "生の HTML の属性の値: 前後の C0 制御文字と空白、中の tab と改行",
    files: {
      "b.md": "",
      "a.md": [
        "<p>",
        '<a href=" b.md ">s</a> <a href="\t\n b.md\r\n">t</a> <a href="b\t.m\nd">u</a>',
        '<a href="&#x1;b.md&#x1f;">v</a> <a href="&#9;b.md&#10;">w</a>',
        '<a href=" gone.md ">x</a> <a href="&nbsp;b.md">y</a> <a href="  ">z</a>',
        "</p>",
        "",
      ].join("\n"),
    },
    code: 1,
    stderr: [
      "a.md: リンク先が無い。git が知るファイルかディレクトリを指す — gone.md",
      "a.md: リンク先が無い。git が知るファイルかディレクトリを指す — \u00a0b.md",
    ],
  },
  {
    name: "生の HTML: 閉じないコメントの後と、中身をタグとして読まない要素の中",
    files: {
      "a.md": [
        '<textarea><a href="in-textarea.md"></textarea>',
        "",
        "<script>document.write('<a href=\"in-script.md\">')</script>",
        "",
        '<a href="after.md">a</a>',
        "",
        "<!-- memo",
        "",
        '<a href="gone.md">g</a>',
        "",
      ].join("\n"),
    },
    code: 1,
    stderr: [
      "a.md: リンク先が無い。git が知るファイルかディレクトリを指す — after.md",
    ],
  },
  {
    name: "大文字小文字だけ違う拡張子の名前は検査せず、リンク先としてだけ使う",
    files: {
      "A.JSON": "{",
      "B.MD": "[x](gone.md)\n",
      "c.md": "[y](B.MD) [z](A.JSON)\n",
    },
    code: 0,
    stderr: [],
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
      "a.md: .md でないもの (ディレクトリを含む) の anchor は検査できない。行の anchor (L10・L10-L20) にするか、anchor を外す — LICENSE#intro",
      "a.md: .md でないもの (ディレクトリを含む) の anchor は検査できない。行の anchor (L10・L10-L20) にするか、anchor を外す — docs#x",
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
      "a.md: anchor が見出しに無い。リンク先の見出しの id に合わせる — b.md#a-2",
      "b.md: anchor が見出しに無い。リンク先の見出しの id に合わせる — #a-2",
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
      "a.md: anchor が見出しに無い。リンク先の見出しの id に合わせる — b.md#logo-project-name",
      "a.md: anchor が見出しに無い。リンク先の見出しの id に合わせる — b.md#text-alt-word-tail",
      "a.md: anchor が見出しに無い。リンク先の見出しの id に合わせる — b.md#html-alt-html-img",
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
      "a.md: anchor が見出しに無い。リンク先の見出しの id に合わせる — b.md#title-x-y",
      "a.md: anchor が見出しに無い。リンク先の見出しの id に合わせる — c.md#empty",
    ],
  },
  {
    name: "frontmatter: 閉じの --- でファイルが終わる",
    files: {
      "b.md": "---\ntitle: x\n---",
      "a.md": "[l](b.md#title-x)\n",
    },
    code: 1,
    stderr: [
      "a.md: anchor が見出しに無い。リンク先の見出しの id に合わせる — b.md#title-x",
    ],
  },
  {
    name: "frontmatter: CRLF",
    files: {
      "b.md": "---\r\ntitle: x\r\n---\r\n# Real\r\n",
      "a.md": "[l](b.md#real) [m](b.md#title-x)\n",
    },
    code: 1,
    stderr: [
      "a.md: anchor が見出しに無い。リンク先の見出しの id に合わせる — b.md#title-x",
    ],
  },
  {
    name: "見出しの id: backslash escape",
    files: {
      "b.md": "## a\\_b\n",
      "a.md": "[l](b.md#a_b) [m](b.md#ab)\n",
    },
    code: 1,
    stderr: [
      "a.md: anchor が見出しに無い。リンク先の見出しの id に合わせる — b.md#ab",
    ],
  },
  {
    name: "読めないファイルは原因の文言のまま",
    files: { "dir.md": null, "a.md": "[l](gone.md#x)\n" },
    args: ["a.md", "dir.md", "gone.md", "gone.json"],
    code: 1,
    prefix: true,
    stderr: [
      "dir.md: 読めない。読める通常ファイルにする — Is a directory",
      "gone.md: 読めない。読める通常ファイルにする — No such file or directory",
      "gone.json: 読めない。読める通常ファイルにする — No such file or directory",
    ],
  },
  {
    name: "UTF-8 として不正な .json と .md",
    files: {
      "bad.json": new Uint8Array([0x7b, 0xff, 0x7d]),
      "bad.md": new Uint8Array([0x23, 0x20, 0xff, 0x0a]),
      "a.md": "[l](bad.md#x)\n",
    },
    code: 1,
    prefix: true,
    stderr: [
      "bad.json: UTF-8 として不正。UTF-8 で保存し直す — ",
      "bad.md: UTF-8 として不正。UTF-8 で保存し直す — ",
    ],
  },
  {
    name: "JSON の構文と BOM",
    files: { "ok.json": "{}", "bad.json": "{", "bom.json": "\uFEFF{}" },
    code: 1,
    prefix: true,
    stderr: [
      "bad.json: JSON として読めない。構文を直す — ",
      "bom.json: JSON として読めない。構文を直す — ",
    ],
  },
  ...attributeCases,
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
const known = ["a/b/x.md", "a/n.md", "a b/n.md", "a/c.json"];

const labels = {
  malformed: "不正な %-エンコード。正しい %XX の列にする (% そのものは %25)",
  outside: "リポの外を指す。リポ内を指すか、URL で書く",
  missing: "リンク先が無い。git が知るファイルかディレクトリを指す",
  anchor: "anchor が見出しに無い。リンク先の見出しの id に合わせる",
  notMd:
    ".md でないもの (ディレクトリを含む) の anchor は検査できない。行の anchor (L10・L10-L20) にするか、anchor を外す",
};

/** a/b/x.md の url のリンクの報告のモデル。known の .md はどれも見出しを持たない。報告が無ければ undefined。 */
const model = (url: string): keyof typeof labels | undefined => {
  if (url.startsWith("//")) return undefined;
  const hash = url.indexOf("#");
  const raw = hash < 0 ? "" : url.slice(hash + 1);
  const path = (hash < 0 ? url : url.slice(0, hash)).split("?")[0];
  const out = path === ""
    ? ["a", "b", "x.md"]
    : path.startsWith("/")
    ? []
    : ["a", "b"];
  if (path !== "") {
    for (const segment of path.split("/")) {
      let s: string;
      try {
        s = decodeURIComponent(segment);
      } catch {
        return "malformed";
      }
      if (s === "" || s === ".") continue;
      if (s !== "..") out.push(s);
      else if (out.pop() === undefined) return "outside";
    }
  }
  const isMd = known.some((f) =>
    f.endsWith(".md") && f.split("/").length === out.length &&
    f.split("/").every((s, i) => s === out[i])
  );
  const exists = known.some((f) => {
    const segments = f.split("/");
    return segments.length >= out.length &&
      out.every((s, i) => s === segments[i]);
  });
  if (!exists) return "missing";
  if (raw === "") return undefined;
  let anchor: string;
  try {
    anchor = decodeURIComponent(raw);
  } catch {
    return "malformed";
  }
  if (!isMd) return /^L\d+(?:-L\d+)?$/.test(anchor) ? undefined : "notMd";
  return "anchor";
};

Deno.test("リンクの報告は、# と ? で割り、segment ごとに decode して辿り、anchor を decode するモデルと一致する", async () => {
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
      "a%2Fn.md",
      "%00",
      "%25",
      "a%20b",
      "c.json",
      "c.json#L1",
      "c.json#x",
      "#",
      "#L1",
      "n.md#x",
      "?q",
      "x.md?q#y",
      "%23",
      "%E3",
      "#%E3",
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
          "a/c.json": "{}",
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
