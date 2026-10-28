/**
 * check-json-md.ts — git が知るファイルのうち、JSON の構文と、Markdown のリポ内リンク・anchor を検査する。run-checks.ts が起動する。
 *
 * 使い方: リポのルートを cwd にして `deno run --allow-read=. <このファイル> <path>...`。
 * - <path> は git が知るファイルの全部。それぞれリポのルートからの相対パス。
 *   - `.json` で終わるもの: 構文を検査する。BOM で始まるものは JSON として読めない違反になる (deno も BOM 付きの deno.json を読めない。canon: facts/deno/config-file-bom-rejected)。
 *   - `.md` で終わるもの: リンクと anchor を検査する。
 *   - 全部: リンク先が在るかの判定に使う。`.md` でないファイルは、行の anchor の先になったときに行数を数えるのに読む (下の「リンク」)。
 *   - 拡張子の判定は大文字小文字を区別する。
 * - `.json`・`.md` は UTF-8 として読む。BOM は落とさない (canon: facts/git/path-output-quoting の TextDecoder)。
 * - 次のときは何も検査せず exit 2:
 *   - 引数が無い。
 *   - どれかが正規の相対パスでない (先頭の `/`、空・`.`・`..` の segment)。
 *   - どれかの拡張子が `.json`・`.md` と大文字小文字だけ違う (`.JSON`・`.Md` など。run-checks.ts が段の前で落とすので、渡されない)。
 * - 違反があれば stderr に出して exit 1。同じ違反の行は 1 回だけ出す。無ければ件数を stdout に出して exit 0。
 *
 * リンク:
 * - 根拠:
 *   - 見出しの id: canon の実測 (facts/github/heading-anchor-ids)。
 *   - リンクのパスの解決 (segment の decode・`..`・起点): 未確認の前提で、GitHub では測っていない。
 * - 属性の読み方:
 *   1. 文書を markdown-it で parse する。
 *   2. 生の HTML の token に、GFM の tagfilter (下の「tagfilter」) を当てる。
 *   3. HTML に描画する。生の HTML は tagfilter の後のまま出る。Markdown のリンク・画像 (参照スタイルを含む) は a の href・img の src になり、値は markdown-it が正規化した href・src と同じ (canon: facts/markdown-it/render-html)。
 *   4. parse5 の parse で文書の木にし、全部の要素 (template の中身を含む) の属性を見る (canon: facts/parse5/parse-tree-attributes)。
 * - tagfilter: GFM の仕様と cmark-gfm の規則に依り、GitHub の描画では測っていない (canon: facts/github/gfm-tagfilter)。
 *   - 場所: 生の HTML のうち、html_block の中の全部の `<` と、html_inline の先頭の `<`。
 *   - タグ: title・textarea・style・xmp・iframe・noembed・noframes・script・plaintext の開き・閉じのタグ。名前は大文字小文字を問わない。
 *   - 名前の後: tab・LF・CR・空白・`>`・`/>` のどれか。
 *   - 当たれば `<` を `&lt;` にする。当たったタグは文字になり、中と後ろは木構築で読む。閉じない形も同じ (canon: facts/github/gfm-tagfilter)。
 *   - 外せる条件: GitHub の描画が規則と違うと分かったとき。確かめ方は同じ canon の「確かめ方」(使い捨てのブランチに置いて描画する)。違えば規則を合わせる。
 * - 木に属性が残らないものは見ない。木構築のとおりで、次を含む (canon: facts/parse5/parse-tree-attributes):
 *   - noscript の中。parse5 の scripting の既定で中身が文字になる。
 *     - GitHub が noscript を同じに扱うかは未確認 (canon: facts/github/gfm-tagfilter の「一覧に無いもの」)。確かめ方は同じ canon の「確かめ方」。GitHub が中の a を要素にすると分かれば、noscript の中も見る。
 *   - tagfilter に当たらない形のタグ (名前の後が FF など) で始まる、上の 9 要素の中 (canon: facts/github/gfm-tagfilter)。
 *   - コメント (閉じないものは文書の終わりまで) の中。
 *   - 木構築が捨てる開きタグ (body の中の head・frame、select の中の a など)。
 * - 木構築は閉じない a などを後の要素に複製するので、同じ違反が重なる (上の「同じ違反の行は 1 回だけ」。canon: facts/parse5/parse-tree-attributes)。
 * - 属性の名前は小文字。外来の要素の xlink:href などは prefix つきの名前で見る。値は引用符を外して文字参照を戻したもの。U+0000 と `&#0;` は U+FFFD になり、値の一部として残る (canon: facts/markdown-it/render-html、facts/parse5/parse-tree-attributes)。
 * - 値は、WHATWG URL の parser の前処理に合わせて、次の順に直してから扱う (canon: facts/url/parser-strips-c0-space-and-tab-newline):
 *   1. 前後の C0 制御文字と空白を落とす。
 *   2. 中の tab と改行を消す。
 * - 属性の類 (attributeClasses。canon: facts/html/url-valued-attributes の一覧と「値の形」) と値の類ごとの扱い:
 *
 *   | 属性の類 | 外部のスキーム (`http:`・`mailto:` など) | `//` で始まる | 空 | fragment だけ (`#x`) | リポ内に在る | リポ内に無い |
 *   | --- | --- | --- | --- | --- | --- | --- |
 *   | 単一の URL (`url`。`href`・`src` など) | 見ない | 見ない | ファイル自身 (違反でない) | ファイル自身の anchor | 通る (anchor は下の規則) | 違反 |
 *   | URL の列 (`urlList`。`srcset` など) と、値の形を canon で確かめていないもの (`unconfirmed`。`archive` など) | 違反 (検査できない) | 違反 | 見ない | 違反 | 違反 | 違反 |
 *   | 見ない (`ignored`。`usemap`。値は `<map name>` を指す `#名前` で、リポのファイルを指せない) と、attributeClasses に無いもの | 見ない | 見ない | 見ない | 見ない | 見ない | 見ない |
 *
 * - `unconfirmed` の類を外せる条件: canon の facts/html/url-valued-attributes の「確かめていないもの」の値の形が確かめられたとき。各属性を `url` か `urlList` へ移し、この類を消す。
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
 *   - 辿った先が `.md` でないファイル: 行の anchor `L<行番号>` の形だけを受ける。他の形 (範囲の `L10-L20` を含む) は検査できないので違反 (canon: facts/github/blob-line-anchors)。
 *     - 行番号が 1 から行数までに無ければ、その行が無いので違反。
 *     - 行数は、ファイルのバイトの LF の数。最後のバイトが LF でなければ 1 を足す。空のファイルは 0 行。
 *       - GitHub の行番号の振り方 (末尾の LF の後、空のファイル) は測っていない (同じ canon の「docs に無いもの」)。同じ canon の「確かめ方」で違うと分かれば、数え方を合わせる。
 *     - 行数を数えるファイルを読めなければ、リンクを置いた .md の違反。
 *   - 辿った先がディレクトリ: どの形も検査できないので違反 (同じ canon の「docs に無いもの」)。直し方は anchor を外すこと。
 * - 検査できない形の違反 (範囲とディレクトリ) は、canon の facts/github/blob-line-anchors の「確かめ方」で GitHub の描画を確かめたときに外せる。外し方は、効く形を受ける形に足すこと。
 * - ファイルを読めない (無い、を含む) か UTF-8 として不正なら、そのファイル自身の違反にする。そういう .md への anchor は見ない。
 * - 違反の行は `<file>: <何が>。<どう直すか> — <リンクか原因の文言>`。
 */
import GithubSlugger from "github-slugger";
import MarkdownIt from "markdown-it";
import { type DefaultTreeAdapterTypes, parse as parseHtml } from "parse5";

const self = "check-json-md.ts";
const checkedExts = [".json", ".md"];
const passPaths =
  "git が知るファイルの、リポのルートからの相対パスを渡す (./verify.sh から起動する)";
if (Deno.args.length === 0) {
  console.error(`${self}: 引数が無い。${passPaths}`);
  Deno.exit(2);
}
const argHead = (f: string) => `${self}: 引数 ${JSON.stringify(f)}`;
const badArgs = Deno.args.flatMap((f) =>
  f.split("/").some((s) => s === "" || s === "." || s === "..")
    ? [
      `${
        argHead(f)
      } が、正規の相対パスでない (先頭の /、空・.・.. の segment のどれかを持つ)。${passPaths}`,
    ]
    : checkedExts.some((e) => !f.endsWith(e) && f.toLowerCase().endsWith(e))
    ? [
      `${argHead(f)} の拡張子が ${
        checkedExts.join("・")
      } と大文字小文字だけ違う。ファイルの拡張子を小文字にする`,
    ]
    : []
);
if (badArgs.length > 0) {
  console.error(badArgs.join("\n"));
  Deno.exit(2);
}
const jsonFiles = Deno.args.filter((f) => f.endsWith(".json"));
const markdownFiles = Deno.args.filter((f) => f.endsWith(".md"));

/** segment の列の鍵は JSON にする (segment は decode した `/` や NUL を含みうるので)。 */
const key = (segments: string[]) => JSON.stringify(segments);
/** リポのルートからの相対パスの鍵。 */
const pathKey = (path: string) => key(path.split("/"));

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

/** GFM の tagfilter が `<` を `&lt;` にするタグ。名前の後に続く文字は cmark-gfm の is_tag のとおり (canon: facts/github/gfm-tagfilter)。 */
const filteredTag = String
  .raw`\/?(?:title|textarea|style|xmp|iframe|noembed|noframes|script|plaintext)(?:[\t\n\r >]|\/>)`;
const filteredInBlock = new RegExp(`<(?=${filteredTag})`, "gi");
const filteredAtStart = new RegExp(`^<(?=${filteredTag})`, "i");
/**
 * 生の HTML の token に tagfilter (上の「tagfilter」) を当てる (tokens を書き換える)。
 * - GFM の仕様と cmark-gfm の規則に依り、GitHub の描画では測っていない (canon: facts/github/gfm-tagfilter)。
 */
const tagfilter = (tokens: Token[]) => {
  for (const token of tokens) {
    if (token.type === "html_block") {
      token.content = token.content.replace(filteredInBlock, "&lt;");
    } else if (token.type === "html_inline") {
      token.content = token.content.replace(filteredAtStart, "&lt;");
    }
    if (token.children) tagfilter(token.children);
  }
};

/**
 * 文書を parse し、tagfilter を当てたトークン。
 * - 先頭の --- のブロックは、YAML として読めなくても GitHub が本文から外す (canon: facts/github/heading-anchor-ids)。
 * - 空のブロックと CRLF の行末も同じ扱いとする。GitHub で確かめていない (同じ canon の「測っていない次元」)。確かめ方は同じ canon の、使い捨てのブランチに置いて描画する手順。違えば規則を合わせる。
 */
const parse = (markdown: string): Token[] => {
  const tokens = md.parse(
    // 残すと --- が見出しの下線になる
    markdown.replace(/^---\r?\n(?:[\s\S]*?\r?\n)?---(?:\r?\n|$)/, ""),
    {},
  );
  tagfilter(tokens);
  return tokens;
};

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

/** parse したトークンと見出しの anchor。 */
type Parsed = { tokens: Token[]; anchors: Set<string> };
/** 辿った先の種類 (上の「リンク」)。.md は Parsed (読めなければ undefined) を持つ。 */
type Destination =
  | { kind: "dir" }
  | { kind: "file"; path: string }
  | { kind: "md"; parsed?: Parsed };
/** リンク先として在るもの (引数のファイルと、その親ディレクトリ (ルートを含む)) の鍵 → 種類。 */
const destinations = new Map<string, Destination>();
for (const f of Deno.args) {
  const segments = f.split("/");
  for (let i = 0; i < segments.length; i++) {
    destinations.set(key(segments.slice(0, i)), { kind: "dir" });
  }
}
for (const f of Deno.args.filter((f) => !f.endsWith(".md"))) {
  destinations.set(pathKey(f), { kind: "file", path: f });
}
const markdownParsed: [string, Parsed | undefined][] = [];
for (const file of markdownFiles) {
  const text = await readOrReport(file);
  const tokens = text === undefined ? undefined : parse(text);
  const parsed = tokens && { tokens, anchors: anchorsOf(tokens) };
  destinations.set(pathKey(file), { kind: "md", parsed });
  markdownParsed.push([file, parsed]);
}

/** path のファイルの行数 (上の「行数」)。読めなければ原因の文言。 */
const linesOf = async (
  path: string,
): Promise<{ lines: number } | { unreadable: string }> => {
  let bytes: Uint8Array;
  try {
    bytes = await Deno.readFile(path);
  } catch (e) {
    return { unreadable: messageOf(e) };
  }
  const lfs = bytes.filter((b) => b === 0x0a).length;
  return { lines: bytes.length > 0 && bytes.at(-1) !== 0x0a ? lfs + 1 : lfs };
};

for (const [file, parsed] of markdownParsed) {
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
    const destination = destinations.get(key(resolved.segments));
    if (destination === undefined) {
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
    switch (destination.kind) {
      case "dir":
        report(
          file,
          `ディレクトリへのリンクの anchor は検査できない。anchor を外す — ${url}`,
        );
        break;
      // GitHub の docs が示す行の anchor は L<行番号> だけ (canon: facts/github/blob-line-anchors)
      case "file": {
        const line = /^L(\d+)$/.exec(anchor);
        if (line === null) {
          report(
            file,
            `.md でないファイルの行の anchor (L10 の形) の他は、検査できない。L<行番号> にするか、anchor を外す — ${url}`,
          );
          break;
        }
        const count = await linesOf(destination.path);
        if ("unreadable" in count) {
          report(
            file,
            `行の anchor の先を読めない。読める通常ファイルにするか、anchor を外す — ${url}: ${count.unreadable}`,
          );
        } else if (Number(line[1]) < 1 || Number(line[1]) > count.lines) {
          report(
            file,
            `行の anchor の行がファイルに無い。1 から行数までの番号にするか、anchor を外す — ${url}`,
          );
        }
        break;
      }
      case "md":
        if (destination.parsed && !destination.parsed.anchors.has(anchor)) {
          report(
            file,
            `anchor が見出しに無い。リンク先の見出しの id に合わせる — ${url}`,
          );
        }
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
