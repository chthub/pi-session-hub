import MarkdownIt from "markdown-it";
import katex from "katex";
import { redact } from "../security.ts";

const md = new MarkdownIt({ html: false, linkify: false, breaks: true });

function escaped(source: string, position: number): boolean {
  let slashes = 0;
  while (position > 0 && source[--position] === "\\") slashes++;
  return slashes % 2 === 1;
}

// Tokenize before Markdown so TeX backslashes, underscores and asterisks survive.
// Markdown's code/fence rules take precedence: dollar signs in code stay literal.
md.inline.ruler.after("escape", "hub_math", (state, silent) => {
  const start = state.pos;
  if (state.src[start] !== "$") return false;
  const display = state.src[start + 1] === "$";
  const delimiter = display ? "$$" : "$";
  const contentStart = start + delimiter.length;
  if (!display && /\s/.test(state.src[contentStart] ?? " ")) return false;
  let end = contentStart;
  while ((end = state.src.indexOf(delimiter, end)) !== -1) {
    if (end >= state.posMax) return false;
    if (escaped(state.src, end) || (!display && (state.src[end + 1] === "$" || state.src[end - 1] === "$"))) {
      end += delimiter.length;
      continue;
    }
    // Avoid interpreting ordinary currency such as "$5 and $10" as math.
    if (!display && (/\s/.test(state.src[end - 1]) || /\d/.test(state.src[end + 1] ?? ""))) return false;
    const content = state.src.slice(contentStart, end);
    if (!content.trim() || (!display && content.includes("\n"))) return false;
    if (!silent) {
      const token = state.push("hub_math", "", 0);
      token.content = content;
      token.block = display;
    }
    state.pos = end + delimiter.length;
    return true;
  }
  return false;
});

md.block.ruler.before("fence", "hub_math_block", (state, start, end, silent) => {
  if (state.sCount[start] - state.blkIndent >= 4) return false;
  const first = state.src.slice(state.bMarks[start] + state.tShift[start], state.eMarks[start]);
  if (!first.startsWith("$$")) return false;
  const parts: string[] = [];
  for (let line = start; line < end; line++) {
    const text = line === start ? first.slice(2) : state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]);
    let close = text.indexOf("$$");
    while (close >= 0 && escaped(text, close)) close = text.indexOf("$$", close + 2);
    if (close >= 0) {
      if (text.slice(close + 2).trim()) return false;
      parts.push(text.slice(0, close));
      if (!parts.join("\n").trim()) return false;
      if (silent) return true;
      const token = state.push("hub_math", "", 0);
      token.content = parts.join("\n");
      token.block = true;
      token.map = [start, line + 1];
      state.line = line + 1;
      return true;
    }
    parts.push(text);
  }
  return false;
}, { alt: ["paragraph", "reference", "blockquote", "list"] });

md.renderer.rules.hub_math = (tokens, index) => {
  const token = tokens[index];
  try {
    if (token.content.length > 20000) throw new Error("公式超过长度上限");
    return katex.renderToString(token.content, {
      displayMode: token.block,
      throwOnError: true,
      trust: false,
      // Chinese labels in \mathrm and subscripts are common in transcripts.
      // KaTeX can render them via fallback fonts; don't turn that warning into
      // a parse failure. Keep other compatibility checks and trust restrictions.
      strict: (code: string) => code === "unicodeTextInMathMode" || code === "unknownSymbol" ? "ignore" : "error",
      maxExpand: 1000,
      maxSize: 20,
      output: "htmlAndMathml",
    });
  } catch {
    return `<span class="math-error">公式无法渲染：<code>${md.utils.escapeHtml(token.content)}</code></span>`;
  }
};

// Never fetch images from a transcript (tracking URLs and local network probes).
md.renderer.rules.image = (tokens, index) =>
  `<span class="image-placeholder">[图片：${md.utils.escapeHtml(tokens[index].content)}]</span>`;

md.renderer.rules.link_open = (tokens, index, options, _env, renderer) => {
  const token = tokens[index];
  const href = token.attrGet("href") ?? "";
  if (!/^(https?:|mailto:)/i.test(href)) {
    token.attrs = (token.attrs ?? []).filter(([name]) => name !== "href");
  }
  token.attrSet("target", "_blank");
  token.attrSet("rel", "noopener noreferrer");
  return renderer.renderToken(tokens, index, options);
};

export function renderMarkdown(text: string): string {
  return md.render(redact(text));
}

export function renderPlainText(text: string): string {
  return `<pre>${md.utils.escapeHtml(redact(text))}</pre>`;
}
