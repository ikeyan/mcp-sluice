/**
 * check-json-md.ts を子として、TMPDIR の下の一時ディレクトリの fixture に回す。
 * - 表の各行: fixture のファイルと引数に対し、終了コードと stderr の違反の行 (順を問わない集合) が一致すること。
 * - 性質: 生成した相対パスへのリンクと、a/c.txt への行の anchor (固定の列と生成した列) について、生成した a/c.txt の中身 (バイト列) で、報告がモデルと一致すること。モデルは:
 *   1. 最初の # と、その前の最初の ? で割る。
 *   2. パスを segment ごとに decode して辿る。
 *   3. anchor を decode する。
 *   4. a/c.txt への行の anchor を、形で判定する。形を受けるなら、中身の類を次の順に見て最初に当たるもので判定し、どれにも当たらなければ行数で判定する:
 *      - 空。
 *      - UTF-8 として不正。
 *      - NUL を含む。
 *      - CR を含む。
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

/** 検査できない形の anchor の違反の、先の名詞の後から — の前まで。 */
const uncheckableSuffix = "への anchor は検査できない。anchor を外す";
/** 違反の行の、ファイルの後から — の前まで。 */
const labels = {
  malformed:
    "不正な %-エンコード。% の後に 16 進 2 桁を置くか、%XX の列を UTF-8 の 1 文字に完成させる (% そのものは %25)",
  outside: "リポの外を指す。リポ内を指すか、URL で書く",
  missing: "リンク先が無い。git が知るファイルかディレクトリを指す",
  anchor: "anchor が見出しに無い。リンク先の見出しの id に合わせる",
  notMd:
    ".md でないファイルへの anchor は、L<行番号> の形 (先頭に 0 を置かない) だけ検査できる。L<行番号> にするか、anchor を外す",
  emptyAnchor: `空のファイル${uncheckableSuffix}`,
  nonUtf8Anchor: `UTF-8 として不正なファイル${uncheckableSuffix}`,
  nulAnchor: `NUL を含むファイル${uncheckableSuffix}`,
  crAnchor: `CR を含むファイル${uncheckableSuffix}`,
  dirAnchor: `ディレクトリ${uncheckableSuffix}`,
  noLine:
    "行の anchor の行がファイルに無い。1 から行数までの番号にするか、anchor を外す",
};
/** file の、link のリンク先が無い違反の行。 */
const missingLine = (link: string, file = "a.md") =>
  `${file}: ${labels.missing} — ${link}`;
/** links のそれぞれを 1 行の Markdown のリンクにした文書。 */
const linkLines = (links: string[]) => links.map((l) => `[l](${l})\n`).join("");

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
    name: "行の anchor の行数: 行数ちょうどは通り、超える番号と 0 は違反",
    files: {
      "lf.txt": "a\nb\n",
      "nolf.txt": "a\nb",
      "onlylf.txt": "\n",
      "ja.txt": "日本語\n",
      "a.md": linkLines([
        "lf.txt#L2",
        "lf.txt#L3",
        "lf.txt#L0",
        "nolf.txt#L2",
        "nolf.txt#L3",
        "onlylf.txt#L1",
        "onlylf.txt#L2",
        "ja.txt#L1",
        "ja.txt#L2",
      ]),
    },
    code: 1,
    stderr: [
      `a.md: ${labels.noLine} — lf.txt#L3`,
      `a.md: ${labels.noLine} — lf.txt#L0`,
      `a.md: ${labels.noLine} — nolf.txt#L3`,
      `a.md: ${labels.noLine} — onlylf.txt#L2`,
      `a.md: ${labels.noLine} — ja.txt#L2`,
    ],
  },
  {
    name:
      "行の anchor: 空のファイル、UTF-8 として不正なファイル、NUL を含むファイル、CR を含むファイルは検査できない",
    files: {
      "empty.txt": "",
      // 次の 6 つは UTF-8 として不正。
      "ff.dat": new Uint8Array([0x61, 0xff, 0x0a]), // UTF-8 に現れないバイト
      "cont.dat": new Uint8Array([0x61, 0x80, 0x0a]), // 単独の継続バイト
      "cut.dat": new Uint8Array([0x61, 0x0a, 0xe3, 0x81]), // EOF で切れた列
      "overlong.dat": new Uint8Array([0xc0, 0xaf, 0x0a]), // 過長形
      "surrogate.dat": new Uint8Array([0xed, 0xa0, 0x80, 0x0a]), // サロゲート
      "beyond.dat": new Uint8Array([0xf4, 0x90, 0x80, 0x80, 0x0a]), // U+10FFFF を超えるもの
      "nul.txt": "a\0b\n",
      "crlf.txt": "a\r\nb\r\n",
      "cr.txt": "a\rb\r",
      "a.md": linkLines([
        "empty.txt#L1",
        "ff.dat#L1",
        "cont.dat#L1",
        "cut.dat#L1",
        "overlong.dat#L1",
        "surrogate.dat#L1",
        "beyond.dat#L1",
        "nul.txt#L1",
        "crlf.txt#L2",
        "crlf.txt#L3",
        "cr.txt#L1",
        "cr.txt#L2",
      ]),
    },
    code: 1,
    stderr: [
      `a.md: ${labels.emptyAnchor} — empty.txt#L1`,
      `a.md: ${labels.nonUtf8Anchor} — ff.dat#L1`,
      `a.md: ${labels.nonUtf8Anchor} — cont.dat#L1`,
      `a.md: ${labels.nonUtf8Anchor} — cut.dat#L1`,
      `a.md: ${labels.nonUtf8Anchor} — overlong.dat#L1`,
      `a.md: ${labels.nonUtf8Anchor} — surrogate.dat#L1`,
      `a.md: ${labels.nonUtf8Anchor} — beyond.dat#L1`,
      `a.md: ${labels.nulAnchor} — nul.txt#L1`,
      `a.md: ${labels.crAnchor} — crlf.txt#L2`,
      `a.md: ${labels.crAnchor} — crlf.txt#L3`,
      `a.md: ${labels.crAnchor} — cr.txt#L1`,
      `a.md: ${labels.crAnchor} — cr.txt#L2`,
    ],
  },
  {
    name:
      "行の anchor: 検査できない類の 2 つ以上に当たるファイルは、空・不正な UTF-8・NUL・CR の順で最初の類",
    files: {
      "nulcr.txt": "a\0b\r\n",
      "all.dat": new Uint8Array([0x61, 0xff, 0x00, 0x0d, 0x0a]),
      "a.md": linkLines(["nulcr.txt#L1", "all.dat#L1"]),
    },
    code: 1,
    stderr: [
      `a.md: ${labels.nulAnchor} — nulcr.txt#L1`,
      `a.md: ${labels.nonUtf8Anchor} — all.dat#L1`,
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

/**
 * a/c.txt の中身。canon: facts/github/blob-line-anchors の「行の anchor の入力の次元」の、区切り (LF・CRLF・CR)・LF の数・最後のバイト・空・テキストでない blob (不正な UTF-8・NUL) を、次の断片を並べて作る。
 * - `e3 81` は、後に 80〜BF の 1 バイトが来れば正しい UTF-8 の 1 文字 (3 バイトの 1 文字) になり、それ以外のバイトや終わりなら不正になる。
 */
const fileBytes = fc.array(
  fc.oneof(
    { arbitrary: fc.constant([0x61]), weight: 3 }, // a
    { arbitrary: fc.constant([0x0a]), weight: 3 }, // LF
    fc.constant([0xe3, 0x81, 0x82]), // あ
    fc.constant([0x0d]), // CR
    fc.constant([0x00]), // NUL
    fc.constant([0xff]), // UTF-8 に現れないバイト
    fc.constant([0xe3, 0x81]), // あ の途中まで (上の注)
    fc.constant([0x80]), // 継続バイト
  ),
  { maxLength: 8 },
).map((chunks) => new Uint8Array(chunks.flat()));

/** 性質のテストの fixture のファイル。キーは相対パス、値はその中身 (a/c.txt の中身とリンクの列から作る)。 */
const propertyFiles: Record<
  string,
  (bytes: Uint8Array, links: string[]) => string | Uint8Array
> = {
  "a/b/x.md": (_, links) => links.map((p) => `- [l](<${p}>)\n`).join(""),
  "a/n.md": () => "",
  "a b/n.md": () => "",
  "a/c.txt": (bytes) => bytes,
};
/** git の一覧に載せるファイル。 */
const known = Object.keys(propertyFiles);

/** %-decode したもの。できなければ undefined。 */
const percentDecodeModel = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch (e) {
    if (!(e instanceof URIError)) throw e;
    return undefined;
  }
};

const utf8 = new TextDecoder("utf-8", { fatal: true });
/** a/c.txt への L<行番号> の行の anchor の報告のモデル。検査できる中身なら、行数は LF で割った行の数 (最後の LF の後の空の行は数えない)。 */
const lineModel = (
  bytes: Uint8Array,
  line: number,
): keyof typeof labels | undefined => {
  // 検査できない類と、当たるものが複数のときの順は check-json-md.ts の「行の anchor」
  if (bytes.length === 0) return "emptyAnchor";
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch (e) {
    if (!(e instanceof TypeError)) throw e;
    return "nonUtf8Anchor";
  }
  if (text.includes("\0")) return "nulAnchor";
  if (text.includes("\r")) return "crAnchor";
  const rows = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  return line >= 1 && line <= rows ? undefined : "noLine";
};

/** a/b/x.md の url のリンクの報告のモデル。known の .md はどれも見出しを持たない。a/c.txt の中身は bytes。報告が無ければ undefined。 */
const model = (
  url: string,
  bytes: Uint8Array,
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
      const s = percentDecodeModel(segment);
      if (s === undefined) return "malformed";
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
  const anchor = percentDecodeModel(raw);
  if (anchor === undefined) return "malformed";
  if (file === undefined) return "dirAnchor";
  if (!file.endsWith(".md")) {
    const line = /^L(\d+)$/.exec(anchor);
    if (line === null || (line[1].length > 1 && line[1].startsWith("0"))) {
      return "notMd";
    }
    return lineModel(bytes, Number(line[1]));
  }
  return "anchor";
};

Deno.test("リンクと a/c.txt への行の anchor の報告は、ファイル先頭の性質のモデルと一致する", async () => {
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
      "c.txt",
      "c.txt#x",
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
  // 生成したパスが a/c.txt に届くのは稀なので、行の anchor は固定の列と生成した列を毎回置く
  const fixedLines = ["L0", "L1", "L01", "L2", "L3", "L4"];
  const lineLink = fc.tuple(fc.nat({ max: 4 }), fc.nat({ max: 2 })).map((
    [n, zeros],
  ) => `L${"0".repeat(zeros)}${n}`);
  await fc.assert(
    fc.asyncProperty(
      fc.uniqueArray(lineLink, { maxLength: 15 }),
      fc.uniqueArray(path, { minLength: 1, maxLength: 20 }),
      fileBytes,
      async (generated, paths, bytes) => {
        const links = [
          ...new Set([
            ...[...fixedLines, ...generated].map((l) => `../c.txt#${l}`),
            ...paths,
          ]),
        ];
        const r = await check(
          Object.fromEntries(
            Object.entries(propertyFiles).map((
              [f, make],
            ) => [f, make(bytes, links)]),
          ),
        );
        deepStrictEqual(
          lines(r.stderr),
          links.flatMap((p) => {
            const m = model(p, bytes);
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
