/**
 * check-json-md.ts — git が知るファイルのうち、JSON の構文と、Markdown のリポ内リンク・anchor を検査する。run-checks.ts が起動する。
 *
 * 使い方: リポのルートを cwd にして `deno run --frozen-lockfile --allow-read=. <このファイル> <path>...`。
 * - <path> は git が知るファイルの全部。それぞれリポのルートからの相対パス。
 *   - `.json` で終わるもの: 構文を検査する。
 *   - `.md` で終わるもの: リンクと anchor を検査する。
 *   - 全部: リンク先が在るかの判定に使う。
 * - 次のときは何も検査せず exit 2:
 *   - 引数が無い。
 *   - どれかが正規の相対パスでない (先頭の `/`、空・`.`・`..` の segment)。
 * - 違反があれば stderr に出して exit 1。無ければ件数を stdout に出して exit 0。
 *
 * リンク (GitHub が追跡されたファイルを描画するときの解決に合わせる。ただし未確認の前提で、canon に事実が無く、下の規則は GitHub で確かめていない):
 * - 対象:
 *   - Markdown のリンク・画像 (参照スタイルを含む)。
 *   - 生の HTML のタグの `href`・`src`。
 *   - 生の HTML のタグの `srcset`: 検査できないので違反。
 * - スキーム (`http:`・`mailto:` など) か `//` で始まるものは外部として見ない。
 * - 最初の `#` の後が anchor。その前の最初の `?` の後は query で、見ない。
 * - パス:
 *   - `/` で割ってから segment ごとに %-decode する (`%2F` は区切りにならない)。decode できない segment があれば「不正な %-エンコード」の違反。
 *   - `/` で始まればリポのルートから、他はファイルのディレクトリから辿る。`.` と空の segment は飛ばし、`..` で 1 つ戻る。ルートより上へ戻るものは「リポの外を指す」違反。
 *   - パスが空ならファイル自身。
 * - 辿った先が、引数のどれかと segment ごとに綴り (大文字小文字を含む) まで一致するか、どれかの親ディレクトリ (ルートを含む) でなければ「リンク先が無い」違反。
 * - anchor (空なら見ない。%-decode できなければそのままの綴りで比べる):
 *   - 辿った先が `.md` のファイル: その見出しの id のどれかと一致すること。id は github-slugger の規則で作る (canon: facts/github/heading-anchor-ids)。
 *   - 他: GitHub の行の anchor (`L10`・`L10-L20`) だけを受ける。他は検査できないので違反。
 * - ファイルを読めなければ (無い、を含む)、そのファイル自身の違反 (`<file>: 読めない — <原因の文言>`) にする。読めないリンク先への anchor は見ない (リンク先は引数にあるので、リンク先自身の違反として出る)。
 */
import GithubSlugger from "github-slugger";
import MarkdownIt from "markdown-it";

const self = "check-json-md.ts";
const nonCanonical = Deno.args.filter((f) =>
  f.split("/").some((s) => s === "" || s === "." || s === "..")
);
if (Deno.args.length === 0 || nonCanonical.length > 0) {
  console.error(
    `${self}: 引数は git が知るファイルの、リポのルートからの相対パス (1 つ以上)。./verify.sh から起動する (${
      nonCanonical.map((f) => JSON.stringify(f)).join(" ")
    })`,
  );
  Deno.exit(2);
}
const jsonFiles = Deno.args.filter((f) => f.endsWith(".json"));
const markdownFiles = Deno.args.filter((f) => f.endsWith(".md"));

/** segment の列の鍵は JSON にする (segment は decode した `/` や NUL を含みうるので)。 */
const key = (segments: string[]) => JSON.stringify(segments);
const knownFiles = new Set(Deno.args.map((f) => key(f.split("/"))));
const knownDirs = new Set(
  Deno.args.flatMap((f) => {
    const segments = f.split("/");
    return segments.map((_, i) => key(segments.slice(0, i)));
  }),
);

const violations: string[] = [];
const report = (file: string, message: string) =>
  violations.push(`${file}: ${message}`);
const messageOf = (e: unknown) => e instanceof Error ? e.message : String(e);

const readOrReport = async (file: string): Promise<string | undefined> => {
  try {
    return await Deno.readTextFile(file);
  } catch (e) {
    report(file, `読めない — ${messageOf(e)}`);
  }
};

for (const file of jsonFiles) {
  const text = await readOrReport(file);
  if (text === undefined) continue;
  try {
    JSON.parse(text);
  } catch (e) {
    report(file, `JSON として読めない — ${messageOf(e)}`);
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

/** 見出しの anchor。テキストの子トークンの選び方は canon: facts/github/heading-anchor-ids。 */
const anchorsOf = (markdown: string): Set<string> => {
  const tokens = parse(markdown);
  const slugger = new GithubSlugger();
  const anchors = new Set<string>();
  tokens.forEach((token, i) => {
    if (token.type !== "heading_open") return;
    const text = (tokens[i + 1].children ?? [])
      .filter((c) =>
        c.type === "text" || c.type === "text_special" ||
        c.type === "code_inline"
      )
      .map((c) => c.content)
      .join("");
    anchors.add(slugger.slug(text));
  });
  return anchors;
};

// CommonMark 0.31.2 の Raw HTML の open tag と attribute の構文 (markdown-it が html_block・html_inline にするもの。canon: facts/markdown-it/parse-token-shapes)
const openTag =
  /<[A-Za-z][A-Za-z0-9-]*((?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*)\s*\/?>/g;
const attribute =
  /\s+([A-Za-z_:][A-Za-z0-9_.:-]*)(?:\s*=\s*([^\s"'=<>`]+|'[^']*'|"[^"]*"))?/g;

type Target = { url: string } | { uncheckable: string };

/** 生の HTML の href・src の値 (引用符を外し、文字参照を戻したもの) と、srcset の値。コメントの中は描画されないので見ない。 */
const htmlTargets = (html: string): Target[] =>
  [...html.replace(/<!--[\s\S]*?-->/g, "").matchAll(openTag)].flatMap((
    [, attrs],
  ) =>
    [...attrs.matchAll(attribute)].flatMap(([, name, raw]): Target[] => {
      if (raw === undefined) return [];
      const value = (/^["']/.test(raw) ? raw.slice(1, -1) : raw).replace(
        /&[#A-Za-z0-9]+;/g,
        (ref) => md.utils.unescapeAll(ref),
      );
      if (/^(?:href|src)$/i.test(name)) return [{ url: value }];
      if (/^srcset$/i.test(name)) return [{ uncheckable: `${name}=${value}` }];
      return [];
    })
  );

/** リンクと画像の参照先 (参照スタイルのリンクも解決済みで出てくる) と、生の HTML の参照先。 */
const targetsOf = (markdown: string): Target[] => {
  const out: Target[] = [];
  const walk = (tokens: Token[]) => {
    for (const token of tokens) {
      if (token.type === "html_block" || token.type === "html_inline") {
        out.push(...htmlTargets(token.content));
      }
      const url = token.type === "link_open"
        ? token.attrGet("href")
        : token.type === "image"
        ? token.attrGet("src")
        : null;
      if (typeof url === "string") out.push({ url });
      if (token.children) walk(token.children);
    }
  };
  walk(parse(markdown));
  return out;
};

type Resolved = { segments: string[] } | { problem: string };

/** リンクのパスを辿った、リポのルートからの segment。 */
const resolve = (dir: string[], path: string): Resolved => {
  const out = path.startsWith("/") ? [] : [...dir];
  for (const raw of path.split("/")) {
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return { problem: "不正な %-エンコード" };
    }
    if (segment === "" || segment === ".") continue;
    if (segment !== "..") out.push(segment);
    else if (out.pop() === undefined) return { problem: "リポの外を指す" };
  }
  return { segments: out };
};

const decodeAnchor = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** path の見出しの anchor。読めなければ undefined (読めないことは path 自身の違反として出る)。 */
const anchorCache = new Map<string, Set<string> | undefined>();
const anchorsFor = async (path: string): Promise<Set<string> | undefined> => {
  if (!anchorCache.has(path)) {
    anchorCache.set(
      path,
      await Deno.readTextFile(path).then(anchorsOf, () => undefined),
    );
  }
  return anchorCache.get(path);
};

for (const file of markdownFiles) {
  const text = await readOrReport(file);
  if (text === undefined) continue;
  const dir = file.split("/").slice(0, -1);
  for (const target of targetsOf(text)) {
    if ("uncheckable" in target) {
      report(
        file,
        `srcset のリンク先は検査できない。リポ内のファイルを指すなら src にする — ${target.uncheckable}`,
      );
      continue;
    }
    const { url } = target;
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url)) continue;
    const hash = url.indexOf("#");
    const anchor = hash < 0 ? "" : decodeAnchor(url.slice(hash + 1));
    const path = (hash < 0 ? url : url.slice(0, hash)).split("?")[0];
    const resolved: Resolved = path === ""
      ? { segments: file.split("/") }
      : resolve(dir, path);
    if ("problem" in resolved) {
      report(file, `${resolved.problem} — ${url}`);
      continue;
    }
    const isFile = knownFiles.has(key(resolved.segments));
    if (!isFile && !knownDirs.has(key(resolved.segments))) {
      report(file, `リンク先が無い — ${url}`);
      continue;
    }
    if (anchor === "") continue;
    const joined = resolved.segments.join("/");
    if (!isFile || !joined.endsWith(".md")) {
      if (!/^L\d+(?:-L\d+)?$/.test(anchor)) {
        report(file, `.md でないファイルの anchor は検査できない — ${url}`);
      }
      continue;
    }
    const anchors = await anchorsFor(joined);
    if (anchors !== undefined && !anchors.has(anchor)) {
      report(file, `anchor が見出しに無い — ${url}`);
    }
  }
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  Deno.exit(1);
}
console.log(
  `ok: JSON ${jsonFiles.length} 件、Markdown ${markdownFiles.length} 件`,
);
