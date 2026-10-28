/**
 * check-json-md.ts を子として、TMPDIR の下の一時ディレクトリの fixture に回す。
 * - 表の各行: fixture のファイルと引数に対し、終了コードと stderr の違反の行 (順を問わない集合) が一致すること。
 * - 性質: 生成した相対パスへのリンクと、生成した a/c.json の中身について、報告が、最初の # と、その前の最初の ? で割り、パスを segment ごとに decode して辿り、anchor を decode するモデルと一致すること。
 * - 属性の値の前処理: 前・中・後と U+0000〜U+0020 の全部の組 (そのままの文字と文字参照) で、報告が URL の前処理のモデルと一致すること。
 */
import fc from "fast-check";
import { deepStrictEqual } from "node:assert/strict";

const root = Deno.realPathSync(`${import.meta.dirname}/..`);
const dec = new TextDecoder();
const tmpdir = Deno.env.get("TMPDIR");
if (!tmpdir) throw new Error("TMPDIR が空。./verify.sh から回す");

/** dir を作って fn に渡し、終われば消す。fn が投げたら、その例外を投げる。そのときに消せなければ、そのことを stderr に出す。 */
const withTempDir = async <T>(fn: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await Deno.makeTempDir({ dir: tmpdir });
  let result: T;
  try {
    result = await fn(dir);
  } catch (e) {
    await Deno.remove(dir, { recursive: true }).catch((left) =>
      console.error(`${dir} を消せない — ${left}`)
    );
    throw e;
  }
  await Deno.remove(dir, { recursive: true });
  return result;
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

/** 違反の行の、ファイルの後から — の前まで。 */
const labels = {
  malformed: "不正な %-エンコード。正しい %XX の列にする (% そのものは %25)",
  outside: "リポの外を指す。リポ内を指すか、URL で書く",
  missing: "リンク先が無い。git が知るファイルかディレクトリを指す",
  anchor: "anchor が見出しに無い。リンク先の見出しの id に合わせる",
  notMd:
    ".md でないファイルの行の anchor (L10 の形) の他は、検査できない。L<行番号> にするか、anchor を外す",
  dirAnchor: "ディレクトリへのリンクの anchor は検査できない。anchor を外す",
  noLine:
    "行の anchor の行がファイルに無い。1 から行数までの番号にするか、anchor を外す",
};
/** file の、link のリンク先が無い違反の行。 */
const missingLine = (link: string, file = "a.md") =>
  `${file}: ${labels.missing} — ${link}`;

const heading = "# x\n\n## a\n\n## a\n";
/** 不正な引数の違反の、引数の後から。 */
const badArg = {
  path:
    "が、正規の相対パスでない (先頭の /、空・.・.. の segment のどれかを持つ)。",
  ext:
    "の拡張子が .json・.md と大文字小文字だけ違う。ファイルの拡張子を小文字にする",
};
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
        `a.md: ${labels.anchor} — #nope`,
        `a.md: ${labels.anchor} — b.md#nope`,
        missingLine("gone.md"),
      ]
      : kind === "urlList" || kind === "unconfirmed"
      ? attributeValues.filter((v) => v !== "").map((v) =>
        `a.md: ${name.toLowerCase()} ${uncheckable} — ${name.toLowerCase()}=${v}`
      )
      : [],
  }))
);
/**
 * 中身を要素にしない要素 (canon: facts/parse5/parse-tree-attributes) の開き・閉じのタグ。
 * - filtered: GFM の tagfilter が文字にするか (canon: facts/github/gfm-tagfilter)。
 * - restoredByClose: 文字にしないとき、閉じのタグで中身の扱いが元に戻るか。
 */
const textElements: (
  & { open: string; close: string }
  & ({ filtered: true } | { filtered: false; restoredByClose: boolean })
)[] = [
  ...[
    "title",
    "textarea",
    "style",
    "xmp",
    "iframe",
    "noembed",
    "noframes",
    "script",
    "plaintext",
    "TEXTAREA",
  ].map((e) => ({ open: `<${e}>`, close: `</${e}>`, filtered: true as const })),
  { open: "<textarea/>", close: "</textarea>", filtered: true },
  { open: "<style\t>", close: "</style\n>", filtered: true },
  // CR は parse の前の normalize が LF にする (canon: facts/markdown-it/render-html)
  { open: "<title\r>", close: "</title\r>", filtered: true },
  // 名前の後の空白も tagfilter の区切り (canon: facts/github/gfm-tagfilter)
  { open: "<xmp >", close: "</xmp >", filtered: true },
  // 閉じのタグは tagfilter が文字にするので、文書の終わりまで textarea の中
  {
    open: "<textarea\f>",
    close: "</textarea>",
    filtered: false,
    restoredByClose: false,
  },
  {
    open: "<noscript>",
    close: "</noscript>",
    filtered: false,
    restoredByClose: true,
  },
];
/** タグごとに、閉じのタグを持つ形と持たない形を、html_block (開きタグの行で始まる) と段落の中の html_inline に置く。 */
const textElementCases = textElements.flatMap((element) =>
  [
    {
      form: "html_block",
      content:
        `${element.open}\n<a href="gone.md">x</a>\n${element.close}\n\n<a href="after.md">a</a>\n`,
      withClose: true,
    },
    {
      form: "閉じない html_block",
      content:
        `${element.open}\n<a href="gone.md">x</a>\n\n<a href="after.md">a</a>\n`,
      withClose: false,
    },
    {
      form: "html_inline",
      content:
        `x ${element.open}<a href="gone.md">x</a>${element.close} <a href="after.md">a</a>\n`,
      withClose: true,
    },
    {
      form: "閉じない html_inline",
      content:
        `x ${element.open}<a href="gone.md">x</a>\n\n<a href="after.md">a</a>\n`,
      withClose: false,
    },
  ].map(({ form, content, withClose }) => {
    const seen = element.filtered
      ? ["gone.md", "after.md"]
      : withClose && element.restoredByClose
      ? ["after.md"]
      : [];
    return {
      name: `生の HTML: ${JSON.stringify(element.open)} の中と後ろ (${form})`,
      files: { "a.md": content },
      code: seen.length ? 1 : 0,
      stderr: seen.map((l) => missingLine(l)),
    };
  })
);
/** 外来の要素 (svg・math) の中の a (canon: facts/parse5/parse-tree-attributes)。 */
const foreignCases = ([
  // tagfilter が style・title を文字にし (canon: facts/github/gfm-tagfilter)、a は外来の要素
  ["svg", "style", true],
  ["svg", "title", true],
  ["math", "style", true],
  ["math", "title", true],
  // tagfilter に無い noscript は、svg・math の直下では外来の要素で、中の a も要素
  ["svg", "noscript", true],
  ["math", "noscript", true],
  // 統合点 (svg の desc・math の mi) の中は HTML の規則に戻り、noscript の中身は文字 (canon: facts/parse5/parse-tree-attributes)
  ["svg", "desc><noscript", false],
  ["math", "mi><noscript", false],
  // 統合点の中の style は tagfilter が文字にするので、中の a は要素 (canon: facts/github/gfm-tagfilter)
  ["svg", "desc><style", true],
  ["math", "mi><style", true],
] as const).flatMap(([outer, inner, seen]) => {
  const body = `<${inner}><a href="gone.md">x</a>`;
  return [
    ["html_block", `<${outer}>\n${body}\n</${outer}>\n`],
    ["html_inline", `x <${outer}>${body}</${outer}>\n`],
  ].map(([form, content]) => ({
    name: `生の HTML: ${outer} の中の ${
      inner.replaceAll("><", " の中の ")
    } の中の a (${form})`,
    files: { "a.md": content },
    code: seen ? 1 : 0,
    stderr: seen ? [missingLine("gone.md")] : [],
  }));
});
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
      missingLine("/nope", "docs/a.md"),
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
      `docs/a.md: ${labels.outside} — ../../LICENSE`,
      `docs/a.md: ${labels.outside} — /../LICENSE`,
      `docs/a.md: ${labels.outside} — ../docs/../../x`,
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
      missingLine("license", "b.md"),
      missingLine("Docs/a.md", "b.md"),
    ],
  },
  {
    name: "git の一覧に無いファイルは、作業ツリーに在っても無い",
    files: { "untracked.md": "", "a.md": "[l](untracked.md)\n" },
    args: ["a.md"],
    code: 1,
    stderr: [
      missingLine("untracked.md"),
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
      missingLine("..%2FLICENSE", "docs/a.md"),
      `docs/a.md: ${labels.outside} — %2E%2E/%2e%2e/LICENSE`,
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
      missingLine("/a%2Fb.md", "x.md"),
      missingLine("a%2Fb.md", "x.md"),
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
      `a.md: ${labels.malformed} — 100%zz.md`,
      `a.md: ${labels.malformed} — b.md#%E3`,
    ],
  },
  {
    name: "2 つ目の # は anchor の一部",
    files: { "b.md": heading, "a.md": "[l](b.md#x#y) [m](b.md#x)\n" },
    code: 1,
    stderr: [
      `a.md: ${labels.anchor} — b.md#x#y`,
    ],
  },
  {
    name: "query は見ない",
    files: { "b.md": heading, "a.md": "[l](b.md?plain=1#x) [m](c.md?x=1)\n" },
    code: 1,
    stderr: [
      missingLine("c.md?x=1"),
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
      missingLine("gone.md"),
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
      missingLine("img/no.png"),
      missingLine("missing.md"),
      missingLine("upper.md"),
      `a.md: ${labels.anchor} — b.md?a=1&b=2#nope`,
      `a.md: srcset ${uncheckable} — srcset=img/ok.png 2x`,
    ],
  },
  {
    // URL の parser は前後の C0 制御文字と空白を落とし、中の tab と改行を消す (canon: facts/url/parser-strips-c0-space-and-tab-newline)
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
      missingLine("gone.md"),
      missingLine("\u00a0b.md"),
    ],
  },
  {
    name: "生の HTML: 閉じないコメントの後",
    files: {
      "a.md": [
        '<a href="after.md">a</a>',
        "",
        "<!-- memo",
        "",
        '<a href="gone.md">g</a>',
        "",
      ].join("\n"),
    },
    code: 1,
    stderr: [missingLine("after.md")],
  },
  {
    // canon: facts/parse5/parse-tree-attributes の「閉じない a は、次の p の中に同じ属性で複製される」
    name: "生の HTML: 木構築が複製する閉じない a の違反は 1 行",
    files: { "a.md": 'x <a href="gone.md">open\n\nnext\n' },
    code: 1,
    stderr: [missingLine("gone.md")],
  },
  {
    name:
      "生の HTML: 閉じない textarea (html_inline) の後の段落の Markdown のリンク",
    files: { "a.md": "x <textarea>\n\n[l](gone.md)\n" },
    code: 1,
    stderr: [missingLine("gone.md")],
  },
  {
    // 閉じのタグの無い script の html_block は文書の終わりまで続き、Markdown のリンクは描画されない
    name: "生の HTML: 閉じない script (html_block) の後の Markdown と生の HTML",
    files: {
      "a.md": 'y\n\n<script>\n\n[l](md.md)\n\n<a href="raw.md">r</a>\n',
    },
    code: 1,
    stderr: [missingLine("raw.md")],
  },
  {
    // canon: facts/parse5/parse-tree-attributes の「body の中の head・frame の開きタグと、select の中の a は捨てられ」
    name: "生の HTML: 木構築が捨てる開きタグの属性",
    files: {
      "a.md":
        'x <select><a href="gone.md">x</a></select> <frame src="gone.md"> <head profile="gone.md"> <a href="after.md">a</a>\n',
    },
    code: 1,
    stderr: [missingLine("after.md")],
  },
  {
    // canon: facts/parse5/parse-tree-attributes の「外来の要素の xlink:href は prefix "xlink"・name "href"」
    name: "生の HTML: svg の中の a の xlink:href は prefix つきの名前",
    files: { "a.md": 'x <svg><a xlink:href="gone.md">x</a></svg>\n' },
    code: 1,
    stderr: [`a.md: xlink:href ${uncheckable} — xlink:href=gone.md`],
  },
  {
    name: "生の HTML: template の中身",
    files: { "a.md": '<template><a href="gone.md">x</a></template>\n' },
    code: 1,
    stderr: [missingLine("gone.md")],
  },
  {
    // markdown-it の normalize と parse5 が U+FFFD に替える (canon: facts/markdown-it/render-html、facts/parse5/parse-tree-attributes)
    name: "生の HTML の属性の値: U+0000 と &#0; は U+FFFD として残る",
    files: {
      "b.md": "",
      "a.md": 'x <a href="\0b.md">y</a> <a href="&#0;b.md">z</a>\n',
    },
    code: 1,
    stderr: [missingLine("\ufffdb.md")],
  },
  {
    name: "大文字小文字だけ違う拡張子の引数は exit 2",
    files: { "A.JSON": "{}", "B.Md": "", "c.md": "" },
    code: 2,
    prefix: true,
    stderr: [
      `check-json-md.ts: 引数 "A.JSON" ${badArg.ext}`,
      `check-json-md.ts: 引数 "B.Md" ${badArg.ext}`,
    ],
  },
  {
    // GitHub の docs が示す行の anchor は、ファイルの L<行番号> だけ (canon: facts/github/blob-line-anchors)
    name: ".md でないファイルとディレクトリの anchor",
    files: {
      LICENSE: "x\n".repeat(10),
      "docs/b.md": "",
      "a.md":
        "[a](LICENSE#L10) [b](LICENSE#L10-L20) [c](LICENSE#intro) [d](docs#x) [e](docs#L10)\n",
    },
    code: 1,
    stderr: [
      `a.md: ${labels.notMd} — LICENSE#L10-L20`,
      `a.md: ${labels.notMd} — LICENSE#intro`,
      `a.md: ${labels.dirAnchor} — docs#x`,
      `a.md: ${labels.dirAnchor} — docs#L10`,
    ],
  },
  {
    name:
      "行の anchor の行数: 末尾の LF の有無と CRLF で行数ちょうどは通り、1 つ超えるか 0 は違反。CR だけの区切りは 1 行、空のファイルは 0 行",
    files: {
      "lf.txt": "a\nb\n",
      "crlf.txt": "a\r\nb\r\n",
      "nolf.txt": "a\nb",
      "onlylf.txt": "\n",
      "cr.txt": "a\rb\r",
      "empty.txt": "",
      "a.md": [
        "lf.txt#L2",
        "lf.txt#L3",
        "lf.txt#L0",
        "crlf.txt#L2",
        "crlf.txt#L3",
        "nolf.txt#L2",
        "nolf.txt#L3",
        "onlylf.txt#L1",
        "onlylf.txt#L2",
        "cr.txt#L1",
        "cr.txt#L2",
        "empty.txt#L1",
      ].map((l) => `[l](${l})\n`).join(""),
    },
    code: 1,
    stderr: [
      `a.md: ${labels.noLine} — lf.txt#L3`,
      `a.md: ${labels.noLine} — lf.txt#L0`,
      `a.md: ${labels.noLine} — crlf.txt#L3`,
      `a.md: ${labels.noLine} — nolf.txt#L3`,
      `a.md: ${labels.noLine} — onlylf.txt#L2`,
      `a.md: ${labels.noLine} — cr.txt#L2`,
      `a.md: ${labels.noLine} — empty.txt#L1`,
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
      `a.md: ${labels.anchor} — b.md#a-2`,
      `b.md: ${labels.anchor} — #a-2`,
    ],
  },
  {
    // GitHub が付けた見出しの id の実測 (canon: facts/github/heading-anchor-ids の表の行)
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
      `a.md: ${labels.anchor} — b.md#logo-project-name`,
      `a.md: ${labels.anchor} — b.md#text-alt-word-tail`,
      `a.md: ${labels.anchor} — b.md#html-alt-html-img`,
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
      `a.md: ${labels.anchor} — b.md#title-x-y`,
      `a.md: ${labels.anchor} — c.md#empty`,
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
      `a.md: ${labels.anchor} — b.md#title-x`,
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
      `a.md: ${labels.anchor} — b.md#title-x`,
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
      `a.md: ${labels.anchor} — b.md#ab`,
    ],
  },
  {
    name: "読めないファイルは原因の文言のまま",
    files: { "dir.md": null, "a.md": "[l](gone.md#x) [m](gone.txt#L1)\n" },
    args: ["a.md", "dir.md", "gone.md", "gone.json", "gone.txt"],
    code: 1,
    prefix: true,
    stderr: [
      "dir.md: 読めない。読める通常ファイルにする — Is a directory",
      "gone.md: 読めない。読める通常ファイルにする — No such file or directory",
      "gone.json: 読めない。読める通常ファイルにする — No such file or directory",
      "a.md: 行の anchor の先を読めない。読める通常ファイルにするか、anchor を外す — gone.txt#L1: No such file or directory",
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
  ...textElementCases,
  ...foreignCases,
  {
    name: "引数が無い",
    files: { "a.md": "" },
    args: [],
    code: 2,
    prefix: true,
    stderr: ["check-json-md.ts: 引数が無い。"],
  },
  ...["/a.md", "a//b.md", "./a.md", "a/../b.md", "", "a/"].map((arg) => ({
    name: `引数 ${JSON.stringify(arg)}`,
    files: { "a.md": "" },
    args: ["a.md", arg],
    code: 2,
    prefix: true,
    stderr: [`check-json-md.ts: 引数 ${JSON.stringify(arg)} ${badArg.path}`],
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

/**
 * a/c.json の中身の形 (canon: facts/github/blob-line-anchors の「行の anchor の入力の次元」。空のファイルは JSON でないので上の表で見る)。
 * - rows: 区切りで割った行の数。
 * - terminated: 最後の行の後にも区切りを置くか。
 * - eol: 区切り。CR だけは行を割らない。
 */
const jsonShape = fc.record({
  rows: fc.integer({ min: 1, max: 3 }),
  terminated: fc.boolean(),
  eol: fc.constantFrom("\n", "\r\n", "\r"),
});
type JsonShape = { rows: number; terminated: boolean; eol: string };
/** 行を eol で区切った JSON の配列。1 行なら `[]`、他は最初の行が `[`、最後の行が `]`、間の行は空。 */
const jsonText = ({ rows, terminated, eol }: JsonShape) =>
  (rows === 1 ? ["[]"] : ["[", ...Array(rows - 2).fill(""), "]"]).join(eol) +
  (terminated ? eol : "");

/** a/b/x.md の url のリンクの報告のモデル。known の .md はどれも見出しを持たない。a/c.json は shape の中身。報告が無ければ undefined。 */
const model = (
  url: string,
  shape: JsonShape,
): keyof typeof labels | undefined => {
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
  const file = known.find((f) =>
    f.split("/").length === out.length &&
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
  if (file === undefined) return "dirAnchor";
  if (!file.endsWith(".md")) {
    const line = /^L(\d+)$/.exec(anchor);
    if (line === null) return "notMd";
    const count = shape.eol === "\r" ? 1 : shape.rows;
    return Number(line[1]) >= 1 && Number(line[1]) <= count
      ? undefined
      : "noLine";
  }
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
      "c.json#L0",
      "c.json#L1",
      "c.json#L01",
      "c.json#L2",
      "c.json#L3",
      "c.json#L4",
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
  // 生成したパスが a/c.json に届くのは稀なので、行番号の境目は毎回見る
  const lineLinks = ["L0", "L1", "L01", "L2", "L3", "L4"].map((l) =>
    `../c.json#${l}`
  );
  await fc.assert(
    fc.asyncProperty(
      fc.uniqueArray(path, { minLength: 1, maxLength: 20 }),
      jsonShape,
      async (paths, shape) => {
        const links = [...new Set([...lineLinks, ...paths])];
        const r = await check({
          "a/n.md": "",
          "a b/n.md": "",
          "a/c.json": jsonText(shape),
          "a/b/x.md": links.map((p) => `- [l](<${p}>)\n`).join(""),
        });
        deepStrictEqual(
          lines(r.stderr),
          links.flatMap((p) => {
            const m = model(p, shape);
            return m === undefined ? [] : [`a/b/x.md: ${labels[m]} — ${p}`];
          }).sort(),
        );
      },
    ),
    { numRuns: 30, includeErrorInReport: true },
  );
});

Deno.test("属性の値の前処理: 前・中・後の U+0000〜U+0020 (tab・LF・CR・FF を含む)、そのままの文字と文字参照の全部の組", async () => {
  const codes = Array.from({ length: 0x21 }, (_, i) => i);
  /** 値 b.md の at の位置に x を置いたもの。 */
  const placeAt = (at: string, x: string) =>
    at === "前" ? `${x}b.md` : at === "中" ? `b${x}.md` : `b.md${x}`;
  const values = codes.flatMap((code) => {
    const c = String.fromCharCode(code);
    return ["前", "中", "後"].flatMap((at) => [
      { written: placeAt(at, c), at, c },
      { written: placeAt(at, `&#x${code.toString(16)};`), at, c },
    ]);
  });
  const r = await check({
    "b.md": "",
    "a.md": [
      "<p>",
      ...values.map(({ written }) => `<a href="${written}">x</a>`),
      "</p>",
      "",
    ].join("\n"),
  });
  const reported = new Set(
    values.flatMap(({ at, c }) => {
      // markdown-it の normalize と parse5 は U+0000 を U+FFFD にする (canon: facts/markdown-it/render-html、facts/parse5/parse-tree-attributes)
      const read = c === "\0" ? "\ufffd" : c;
      // canon: facts/url/parser-strips-c0-space-and-tab-newline。前後は U+0020 以下を落とし、中は tab・LF・CR だけを消す。markdown-it と parse5 は CR を LF にする (上と同じ canon)
      const kept = read > " " || (at === "中" && !"\t\n\r".includes(read));
      return kept ? [missingLine(placeAt(at, read))] : [];
    }),
  );
  deepStrictEqual(lines(r.stderr), [...reported].sort());
});
