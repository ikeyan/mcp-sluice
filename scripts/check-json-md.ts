/**
 * check-json-md.ts — リポ内の JSON の構文と、Markdown のリポ内リンク・anchor を検査する。run-checks.ts から呼ぶ。
 *
 * 使い方: リポのルートを cwd にして `deno run --allow-read=. scripts/check-json-md.ts <file>...`。
 * - <file> は git が出すリポのルートからの相対パスで、`.json` か `.md` で終わるもの。他の引数があれば何も検査せず exit 2。
 * - 違反があれば stderr に出して exit 1。無ければ件数を stdout に出して exit 0。
 *
 * リンク (GitHub がリポのファイルを描画するときの解決に合わせる):
 * - 対象は Markdown のリンク・画像 (参照スタイルを含む) と、生の HTML のタグの href・src。スキーム (`http:`・`mailto:` など) か `//` で始まるものは外部として見ない。
 * - 最初の `#` の後が anchor。その前の最初の `?` の後は query で、見ない。
 * - パスは %-decode する (壊れた escape はそのまま)。`/` で始まればリポのルートから、他はファイルのディレクトリから辿り、`.` と空の segment は飛ばし、`..` で 1 つ戻る。
 *   - ルートより上へ戻るものは「リポの外を指す」違反。
 *   - パスが空ならファイル自身。
 * - 辿った先が無ければ違反。Deno.errors.NotFound だけを「無い」とし、他のエラーは文言を付けて違反にする。
 * - anchor (空なら見ない):
 *   - `.md`: 見出しの id のどれかと一致すること。id は github-slugger の規則で作る (canon: facts/github/heading-anchor-ids)。
 *   - 他: GitHub の行の anchor (`L10`・`L10-L20`) だけを受ける。他は検査できないので違反。
 */
import GithubSlugger from "github-slugger";
import MarkdownIt from "markdown-it";

const self = "check-json-md.ts";
const unknownArgs = Deno.args.filter((f) => !/\.(?:json|md)$/.test(f));
if (unknownArgs.length > 0) {
  console.error(
    `${self}: 引数は .json か .md のファイルだけ (${unknownArgs.join(" ")})`,
  );
  Deno.exit(2);
}
const jsonFiles = Deno.args.filter((f) => f.endsWith(".json"));
const markdownFiles = Deno.args.filter((f) => f.endsWith(".md"));

const violations: string[] = [];
const report = (file: string, message: string) =>
  violations.push(`${file}: ${message}`);
const messageOf = (e: unknown) => e instanceof Error ? e.message : String(e);

/** 壊れた %-エンコードはそのまま返す (URIError で検査全体を止めない)。 */
const decode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

const readOrReport = async (file: string): Promise<string | undefined> => {
  try {
    return await Deno.readTextFile(file);
  } catch (e) {
    report(
      file,
      e instanceof Deno.errors.NotFound
        ? "git の一覧にあるがファイルが無い"
        : `読めない — ${messageOf(e)}`,
    );
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

/** 先頭の --- のブロックは YAML として読めなくても GitHub が本文から外す (canon: facts/github/heading-anchor-ids)。残すと --- が見出しの下線になる。 */
const parse = (markdown: string): Token[] =>
  md.parse(markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, ""), {});

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

// CommonMark 0.31.2 の Raw HTML の open tag と attribute の構文 (markdown-it が html_block・html_inline にするもの)
const openTag =
  /<[A-Za-z][A-Za-z0-9-]*((?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*)\s*\/?>/g;
const attribute =
  /\s+([A-Za-z_:][A-Za-z0-9_.:-]*)(?:\s*=\s*([^\s"'=<>`]+|'[^']*'|"[^"]*"))?/g;

/** 生の HTML の href・src の値 (引用符を外し、文字参照を戻したもの)。コメントの中は描画されないので見ない。 */
const htmlTargets = (html: string): string[] =>
  [...html.replace(/<!--[\s\S]*?-->/g, "").matchAll(openTag)].flatMap((
    [, attrs],
  ) =>
    [...attrs.matchAll(attribute)]
      .filter(([, name, value]) =>
        value !== undefined && /^(?:href|src)$/i.test(name)
      )
      .map(([, , value]) =>
        (/^["']/.test(value) ? value.slice(1, -1) : value).replace(
          /&[#A-Za-z0-9]+;/g,
          (ref) => md.utils.unescapeAll(ref),
        )
      )
  );

/** リンクと画像の参照先 (参照スタイルのリンクも解決済みで出てくる) と、生の HTML の href・src。 */
const targetsOf = (markdown: string): string[] => {
  const out: string[] = [];
  const walk = (tokens: Token[]) => {
    for (const token of tokens) {
      if (token.type === "html_block" || token.type === "html_inline") {
        out.push(...htmlTargets(token.content));
      }
      const target = token.type === "link_open"
        ? token.attrGet("href")
        : token.type === "image"
        ? token.attrGet("src")
        : null;
      if (typeof target === "string") out.push(target);
      if (token.children) walk(token.children);
    }
  };
  walk(parse(markdown));
  return out;
};

/** リンクのパスを辿った、リポのルートからの segment。ルートより上へ戻れば undefined。 */
const resolve = (dir: string[], path: string): string[] | undefined => {
  const decoded = decode(path);
  const out = decoded.startsWith("/") ? [] : [...dir];
  for (const segment of decoded.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment !== "..") out.push(segment);
    else if (out.pop() === undefined) return undefined;
  }
  return out;
};

const anchorCache = new Map<string, Set<string>>();
const anchorsFor = async (path: string): Promise<Set<string>> => {
  let anchors = anchorCache.get(path);
  if (!anchors) {
    anchorCache.set(path, anchors = anchorsOf(await Deno.readTextFile(path)));
  }
  return anchors;
};

for (const file of markdownFiles) {
  const text = await readOrReport(file);
  if (text === undefined) continue;
  const dir = file.split("/").slice(0, -1);
  for (const target of targetsOf(text)) {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) continue;
    const hash = target.indexOf("#");
    const beforeHash = hash < 0 ? target : target.slice(0, hash);
    const anchor = hash < 0 ? "" : decode(target.slice(hash + 1));
    const path = beforeHash.split("?")[0];
    const segments = path === "" ? file.split("/") : resolve(dir, path);
    if (segments === undefined) {
      report(file, `リポの外を指す — ${target}`);
      continue;
    }
    const resolved = segments.join("/") || ".";
    try {
      await Deno.stat(resolved);
      if (anchor === "") continue;
      if (!resolved.endsWith(".md")) {
        if (!/^L\d+(?:-L\d+)?$/.test(anchor)) {
          report(
            file,
            `.md でないファイルの anchor は検査できない — ${target}`,
          );
        }
        continue;
      }
      if (!(await anchorsFor(resolved)).has(anchor)) {
        report(file, `anchor が見出しに無い — ${target}`);
      }
    } catch (e) {
      report(
        file,
        e instanceof Deno.errors.NotFound
          ? `リンク先が無い — ${target}`
          : `リンク先を読めない — ${target} (${messageOf(e)})`,
      );
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
