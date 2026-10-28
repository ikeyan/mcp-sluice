/**
 * check-json-md.ts — リポ内の JSON の構文と、Markdown のリポ内リンク・anchor を検査する。run-checks.ts から呼ぶ。
 *
 * 事前条件: リポのルートを cwd にして、検査対象のパスを引数に渡すこと (run-checks.ts は `./` を前置して渡す)。.json と .md 以外は無視する。
 * 副作用: 検査結果を stdout / stderr に出し、違反が 1 件でもあれば exit 1。
 */
import GithubSlugger from "github-slugger";
import MarkdownIt from "markdown-it";

const violations: string[] = [];
const report = (file: string, message: string) =>
  violations.push(`${file}: ${message}`);

/** 壊れた %-エンコードで例外を出さない (URIError で検査全体が止まるのを防ぐ)。 */
const decode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

const exists = (path: string) =>
  Deno.stat(path).then(() => true).catch(() => false);

const targets = Deno.args.map((f) => f.replace(/^\.\//, ""));
const jsonFiles = targets.filter((f) => f.endsWith(".json"));
const markdownFiles = targets.filter((f) => f.endsWith(".md"));

for (const file of jsonFiles) {
  try {
    JSON.parse(await Deno.readTextFile(file));
  } catch (e) {
    report(file, `読めない — ${e instanceof Error ? e.message : e}`);
  }
}

// Markdown は CommonMark のパーサで読む。コードブロック・インラインコードの中はリンクでも見出しでもない。
const md = new MarkdownIt({ html: true });
type Token = ReturnType<typeof md.parse>[number];

/**
 * 先頭の --- で囲まれたブロックを落としてからパースする。GitHub はこのブロックを YAML として読めなくても
 * frontmatter として扱い、本文として描画しない (見出しにもリンクにもならない)。残すと --- が見出しの下線になる。
 */
const parse = (markdown: string): Token[] =>
  md.parse(markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, ""), {});

/** 見出しの anchor。github-slugger は GitHub が描画時に付ける id と同じ規則 (重複は -1, -2 …)。 */
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

/** リンクと画像の参照先 (参照スタイルのリンクも解決済みで出てくる)。 */
const targetsOf = (markdown: string): string[] => {
  const out: string[] = [];
  const walk = (tokens: Token[]) => {
    for (const token of tokens) {
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

const anchorCache = new Map<string, Set<string>>();
const anchorsFor = async (path: string): Promise<Set<string>> => {
  let anchors = anchorCache.get(path);
  if (!anchors) {
    anchorCache.set(path, anchors = anchorsOf(await Deno.readTextFile(path)));
  }
  return anchors;
};

for (const file of markdownFiles) {
  const text = await Deno.readTextFile(file).catch(() => null);
  if (text === null) {
    report(file, "git の一覧にあるがファイルが無い");
    continue;
  }
  const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ".";
  for (const target of targetsOf(text)) {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) continue; // http:, mailto:, //host (プロトコル相対) 等の外部
    const [path, anchor] = target.split("#");
    const resolved = path === "" ? file : `${dir}/${path}`.replace(/^\.\//, "");
    const normalized = decode(new URL(resolved, "file:///").pathname.slice(1));
    if (!(await exists(normalized))) {
      report(file, `リンク先が無い — ${target}`);
      continue;
    }
    if (!anchor || !normalized.endsWith(".md")) continue;
    if (!(await anchorsFor(normalized)).has(decode(anchor))) {
      report(file, `anchor が見出しに無い — ${target}`);
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
