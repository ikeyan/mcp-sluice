/**
 * check-json-md.ts — git が知るファイルのうち、JSON の構文と、Markdown のリポ内リンク・anchor を検査する。run-checks.ts が起動する。
 *
 * 使い方: リポのルートを cwd にして `deno run --allow-read=. <このファイル> <path>...`。
 * - <path> は git が知るファイルの全部。それぞれリポのルートからの相対パス。
 *   - `.json` で終わるもの: 構文を検査する。BOM で始まるものは JSON として読めない違反になる (deno も BOM 付きの deno.json を読めない。canon: facts/deno/config-file-bom-rejected)。
 *   - `.md` で終わるもの: リンクと anchor を検査する。
 *   - 全部: リンク先が在るかの判定に使う。
 *   - 拡張子の判定は大文字小文字を区別する。
 * - `.json`・`.md` は UTF-8 として読む。BOM は落とさない (canon: facts/git/path-output-quoting の TextDecoder)。
 * - 次のときは何も検査せず exit 2:
 *   - 引数が無い。
 *   - どれかが正規の相対パスでない (先頭の `/`、空・`.`・`..` の segment)。
 *   - どれかの拡張子が `.json`・`.md` と大文字小文字だけ違う (`.JSON`・`.Md` など。run-checks.ts が段の前で落とすので、渡されない)。
 * - 違反があれば stderr に出して exit 1。同じ違反の行は 1 回だけ出す。無ければ件数を stdout に出して exit 0。
 *
 * リンク:
 * - 根拠: GitHub が追跡されたファイルを描画するときの解決に合わせる。ただし未確認の前提で、canon に事実が無く、下の規則は GitHub で確かめていない。
 * - 対象: 文書を markdown-it で HTML に描画し、parse5 の parse で文書の木にした、全部の要素の属性 (canon: facts/markdown-it/render-html、facts/parse5/parse-tree-attributes)。
 *   - parse5 を使うのは、HTML の仕様の木構築で読むため。正規表現や tokenizer 単独では、textarea・script・svg などの文脈の規則を写し続けることになる。
 *   - 生の HTML はそのまま描画される。Markdown のリンク・画像 (参照スタイルを含む) は a の href・img の src になり、値は markdown-it が正規化した href・src と同じ。
 *   - 木に属性が残らないものは見ない。木構築のとおりで、次を含む:
 *     - 中身を要素にしない要素 (title・textarea・style・xmp・iframe・noembed・noframes・noscript・script・plaintext) の中。svg・math の直下の style・title の中は要素になるので見る。
 *     - コメント (閉じないものは文書の終わりまで) の中。
 *     - 木構築が捨てる開きタグ (body の中の head・frame、select の中の a など)。
 *   - template の中身も見る。
 *   - 木構築は閉じない a などを後の要素に複製するので、同じ違反が重なる (上の「同じ違反の行は 1 回だけ」)。
 *   - 属性の名前は小文字。外来の要素の xlink:href などは prefix つきの名前で見る。値は引用符を外して文字参照を戻したもの。U+0000 と `&#0;` は U+FFFD になり、値の一部として残る。
 *   - 値は、WHATWG URL の parser の前処理に合わせ、前後の C0 制御文字と空白を落とし、中の tab と改行を消してから扱う (canon: facts/url/parser-strips-c0-space-and-tab-newline)。
 *   - 属性の類 (attributeClasses。canon: facts/html/url-valued-attributes の一覧と「値の形」) と値の類ごとの扱い:
 *
 *     | 属性の類 | 外部のスキーム (`http:`・`mailto:` など) | `//` で始まる | 空 | fragment だけ (`#x`) | リポ内に在る | リポ内に無い |
 *     | --- | --- | --- | --- | --- | --- | --- |
 *     | 単一の URL (`url`。`href`・`src` など) | 見ない | 見ない | ファイル自身 (違反でない) | ファイル自身の anchor | 通る (anchor は下の規則) | 違反 |
 *     | URL の列 (`urlList`。`srcset` など) と、値の形を canon で確かめていないもの (`unconfirmed`。`archive` など) | 違反 (検査できない) | 違反 | 見ない | 違反 | 違反 | 違反 |
 *     | 見ない (`ignored`。`usemap`。値は `<map name>` を指す `#名前` で、リポのファイルを指せない) と、attributeClasses に無いもの | 見ない | 見ない | 見ない | 見ない | 見ない | 見ない |
 *
 *   - `unconfirmed` の類を外せる条件: canon の facts/html/url-valued-attributes の「確かめていないもの」の値の形が確かめられたとき。各属性を `url` か `urlList` へ移し、この類を消す。
 *
 * - 下の規則は、単一の URL の属性 (Markdown のリンク・画像を含む) の値に当てる。スキームか `//` で始まるものは外部として見ない。
 * - 最初の `#` の後が anchor。その前の最初の `?` の後は query で、見ない。
 * - パス:
 *   - `/` で割ってから、segment ごとに %-decode する。`%2F` は区切りにならない。
 *   - 起点は、`/` で始まればリポのルート、他はファイルのディレクトリ。パスが空ならファイル自身。
 *   - `.` と空の segment は飛ばし、`..` で 1 つ戻る。
 *   - 違反: decode できない segment があれば「不正な %-エンコード」。ルートより上へ戻れば「リポの外を指す」。
 * - 辿った先が、引数のどれかと segment ごとに綴り (大文字小文字を含む) まで一致するか、どれかの親ディレクトリ (ルートを含む) でなければ「リンク先が無い」違反。
 * - anchor (空なら見ない。%-decode できなければ「不正な %-エンコード」違反):
 *   - 辿った先が `.md` の引数: その見出しの id のどれかと一致すること。id は github-slugger の規則で作る (canon: facts/github/heading-anchor-ids)。
 *   - 他 (ディレクトリを含む): GitHub の行の anchor (`L10`・`L10-L20`) だけを受ける。他は検査できないので違反。
 * - ファイルを読めない (無い、を含む) か UTF-8 として不正なら、そのファイル自身の違反にする。そういう .md への anchor は見ない。
 * - 違反の行は `<file>: <何が>。<どう直すか> — <リンクか原因の文言>`。
 */
import GithubSlugger from "github-slugger";
import MarkdownIt from "markdown-it";
import { type DefaultTreeAdapterTypes, parse as parseHtml } from "parse5";

const self = "check-json-md.ts";
const checkedExts = [".json", ".md"];
const badArgs = Deno.args.filter((f) =>
  f.split("/").some((s) => s === "" || s === "." || s === "..") ||
  checkedExts.some((e) => !f.endsWith(e) && f.toLowerCase().endsWith(e))
);
if (Deno.args.length === 0 || badArgs.length > 0) {
  console.error(
    `${self}: 引数は git が知るファイルの、リポのルートからの相対パス (1 つ以上) で、拡張子が ${
      checkedExts.join("・")
    } と大文字小文字だけ違うものを含まない。./verify.sh から起動する (${
      badArgs.map((f) => JSON.stringify(f)).join(" ")
    })`,
  );
  Deno.exit(2);
}
const jsonFiles = Deno.args.filter((f) => f.endsWith(".json"));
const markdownFiles = Deno.args.filter((f) => f.endsWith(".md"));

/** segment の列の鍵は JSON にする (segment は decode した `/` や NUL を含みうるので)。 */
const key = (segments: string[]) => JSON.stringify(segments);
/** リンク先として在るもの: 引数のファイルと、その親ディレクトリ (ルートを含む) の鍵。 */
const linkTargets = new Set(
  Deno.args.flatMap((f) => {
    const segments = f.split("/");
    return segments.map((_, i) => key(segments.slice(0, i + 1)))
      .concat(key([]));
  }),
);

const violations = new Set<string>();
const report = (file: string, message: string) =>
  violations.add(`${file}: ${message}`);
const messageOf = (e: unknown) => e instanceof Error ? e.message : String(e);

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
/** 読めて UTF-8 なら文字列。読めなければ違反を記録して undefined を返す。 */
const readOrReport = async (file: string): Promise<string | undefined> => {
  let bytes: Uint8Array;
  try {
    bytes = await Deno.readFile(file);
  } catch (e) {
    report(file, `読めない。読める通常ファイルにする — ${messageOf(e)}`);
    return;
  }
  try {
    return utf8.decode(bytes);
  } catch (e) {
    if (!(e instanceof TypeError)) throw e;
    report(file, `UTF-8 として不正。UTF-8 で保存し直す — ${messageOf(e)}`);
  }
};

for (const file of jsonFiles) {
  const text = await readOrReport(file);
  if (text === undefined) continue;
  try {
    JSON.parse(text);
  } catch (e) {
    report(file, `JSON として読めない。構文を直す — ${messageOf(e)}`);
  }
}

const md = new MarkdownIt({ html: true });
type Token = ReturnType<typeof md.parse>[number];

/** 先頭の --- のブロックは、YAML として読めなくても GitHub が本文から外す (canon: facts/github/heading-anchor-ids)。空のブロックと CRLF の行末も同じ扱いとする (GitHub で確かめていない。同じ canon の「測っていない次元」)。 */
const parse = (markdown: string): Token[] =>
  md.parse(
    // 残すと --- が見出しの下線になる
    markdown.replace(/^---\r?\n(?:[\s\S]*?\r?\n)?---(?:\r?\n|$)/, ""),
    {},
  );

/** 見出しの anchor。 */
const anchorsOf = (tokens: Token[]): Set<string> => {
  const slugger = new GithubSlugger();
  const anchors = new Set<string>();
  tokens.forEach((token, i) => {
    if (token.type !== "heading_open") return;
    const text = (tokens[i + 1].children ?? [])
      // テキストの子トークンの選び方は canon: facts/github/heading-anchor-ids。backslash escape と entity も parse() の後は text になる (canon: facts/markdown-it/parse-token-shapes の「backslash escape と entity の token」)
      .filter((c) => c.type === "text" || c.type === "code_inline")
      .map((c) => c.content)
      .join("");
    anchors.add(slugger.slug(text));
  });
  return anchors;
};

type AttributeClass = "url" | "urlList" | "unconfirmed" | "ignored";
/** 属性の名前 → 類。無い名前は見ない。 */
const attributeClasses = new Map<string, AttributeClass>([
  ["action", "url"],
  ["background", "url"],
  ["cite", "url"],
  ["codebase", "url"],
  ["data", "url"],
  ["formaction", "url"],
  ["href", "url"],
  ["itemid", "url"],
  ["longdesc", "url"],
  ["lowsrc", "url"],
  ["manifest", "url"],
  ["poster", "url"],
  ["src", "url"],
  ["imagesrcset", "urlList"],
  ["itemtype", "urlList"],
  ["ping", "urlList"],
  ["srcset", "urlList"],
  ["archive", "unconfirmed"],
  ["classid", "unconfirmed"],
  ["profile", "unconfirmed"],
  ["xlink:href", "unconfirmed"],
  ["usemap", "ignored"],
]);

/** 描画した HTML の木の、全部の要素 (template の中身を含む) の属性。名前は prefix つき。 */
const attributesOf = (html: string) => {
  const attrs: { name: string; value: string }[] = [];
  const pending: DefaultTreeAdapterTypes.Node[] = [parseHtml(html)];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (!("childNodes" in node)) continue;
    if ("attrs" in node) {
      for (const { prefix, name, value } of node.attrs) {
        attrs.push({ name: prefix ? `${prefix}:${name}` : name, value });
      }
    }
    for (const child of node.childNodes) pending.push(child);
    if ("content" in node) pending.push(node.content);
  }
  return attrs;
};

const urlPreprocess = (value: string) => {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] <= " ") start++;
  while (end > start && value[end - 1] <= " ") end--;
  return value.slice(start, end).replace(/[\t\n\r]/g, "");
};

type Target = { url: string } | {
  uncheckable: { name: string; value: string };
};

/** 文書の、単一の URL の属性の値と、URL の列か値の形を確かめていない属性の空でない値と名前。値は urlPreprocess の後のもの。 */
const targetsOf = (tokens: Token[]): Target[] =>
  attributesOf(md.renderer.render(tokens, md.options, {})).flatMap(
    ({ name, value: raw }): Target[] => {
      const value = urlPreprocess(raw);
      switch (attributeClasses.get(name)) {
        case "url":
          return [{ url: value }];
        case "urlList":
        case "unconfirmed":
          return value === "" ? [] : [{ uncheckable: { name, value } }];
        default:
          return [];
      }
    },
  );

type Resolved = { segments: string[] } | { problem: string };
const malformed =
  "不正な %-エンコード。正しい %XX の列にする (% そのものは %25)";

/** %-decode できなければ undefined。 */
const percentDecode = (s: string): string | undefined => {
  try {
    return decodeURIComponent(s);
  } catch {
    return undefined;
  }
};

/**
 * リンクのパスを辿った、リポのルートからの segment。リンクのパスは segment ごとに畳んで解決する。
 * - new URL() は、ルートより上へ出る `..` を黙って捨てる (`../../x` は `/x`。canon: facts/url/dot-dot-above-root-dropped) ので、リポの外への脱出を検出できない。
 * - node:path の posix.normalize は、decode した segment の `/` (%2F) を区切りとして畳む (canon: facts/nodejs/path-posix-normalize-splits-decoded-slash)。
 */
const resolve = (dir: string[], path: string): Resolved => {
  const out = path.startsWith("/") ? [] : [...dir];
  for (const raw of path.split("/")) {
    const segment = percentDecode(raw);
    if (segment === undefined) return { problem: malformed };
    if (segment === "" || segment === ".") continue;
    if (segment !== "..") out.push(segment);
    else if (out.pop() === undefined) {
      return { problem: "リポの外を指す。リポ内を指すか、URL で書く" };
    }
  }
  return { segments: out };
};

/** .md の引数ごとの、名前と、parse したトークンと見出しの anchor (読めなければ undefined)。鍵は key。 */
const markdown = new Map<
  string,
  { file: string; parsed?: { tokens: Token[]; anchors: Set<string> } }
>();
for (const file of markdownFiles) {
  const text = await readOrReport(file);
  const tokens = text === undefined ? undefined : parse(text);
  markdown.set(key(file.split("/")), {
    file,
    parsed: tokens && { tokens, anchors: anchorsOf(tokens) },
  });
}

for (const { file, parsed } of markdown.values()) {
  if (parsed === undefined) continue;
  const dir = file.split("/").slice(0, -1);
  for (const target of targetsOf(parsed.tokens)) {
    if ("uncheckable" in target) {
      const { name, value } = target.uncheckable;
      report(
        file,
        `${name} の参照先は検査できない。リポ内のファイルを指すなら Markdown のリンク・画像で書き、この属性を外す — ${name}=${value}`,
      );
      continue;
    }
    const { url } = target;
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url)) continue;
    const hash = url.indexOf("#");
    const rawAnchor = hash < 0 ? "" : url.slice(hash + 1);
    const path = (hash < 0 ? url : url.slice(0, hash)).split("?")[0];
    const resolved: Resolved = path === ""
      ? { segments: file.split("/") }
      : resolve(dir, path);
    if ("problem" in resolved) {
      report(file, `${resolved.problem} — ${url}`);
      continue;
    }
    const at = key(resolved.segments);
    if (!linkTargets.has(at)) {
      report(
        file,
        `リンク先が無い。git が知るファイルかディレクトリを指す — ${url}`,
      );
      continue;
    }
    if (rawAnchor === "") continue;
    const anchor = percentDecode(rawAnchor);
    if (anchor === undefined) {
      report(file, `${malformed} — ${url}`);
      continue;
    }
    const linked = markdown.get(at);
    if (linked === undefined) {
      if (!/^L\d+(?:-L\d+)?$/.test(anchor)) {
        report(
          file,
          `.md でないもの (ディレクトリを含む) の anchor は検査できない。行の anchor (L10・L10-L20) にするか、anchor を外す — ${url}`,
        );
      }
      continue;
    }
    if (linked.parsed && !linked.parsed.anchors.has(anchor)) {
      report(
        file,
        `anchor が見出しに無い。リンク先の見出しの id に合わせる — ${url}`,
      );
    }
  }
}

if (violations.size > 0) {
  console.error([...violations].join("\n"));
  Deno.exit(1);
}
console.log(
  `ok: JSON ${jsonFiles.length} 件、Markdown ${markdownFiles.length} 件`,
);
