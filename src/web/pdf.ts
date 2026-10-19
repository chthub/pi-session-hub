import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { SessionDetail } from "../types.ts";
import { redact } from "../security.ts";
import { viewerDetail } from "./presentation.ts";

const BROWSER_TIMEOUT_MS = 80_000;
const STDERR_LIMIT = 16 * 1024;
let rendering = false;

function escapeHtml(value: unknown): string {
  return redact(String(value)).replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]!);
}

async function executableFile(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).isFile() && await fs.access(file, fs.constants.X_OK).then(() => true);
  } catch { return false; }
}

async function resolveExecutable(candidate: string): Promise<string | undefined> {
  if (path.isAbsolute(candidate)) return await executableFile(candidate) ? candidate : undefined;
  // Never search the current directory, accept shell fragments, or invoke a shell.
  if (candidate.includes("/") || candidate.includes("\\")) return undefined;
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    const file = path.join(dir, candidate);
    if (await executableFile(file)) return file;
  }
  return undefined;
}

async function findBrowser(executable?: string): Promise<string> {
  const override = executable ?? process.env.CHROME_BIN;
  if (override !== undefined) {
    const found = await resolveExecutable(override);
    if (found) return found;
    throw new Error("PDF browser is not executable. Set CHROME_BIN or options.executable to the absolute path of an installed Chromium, Chrome, or Edge executable.");
  }
  const common = process.platform === "darwin" ? [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    path.join(os.homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
  ] : process.platform === "win32" ? [
    ...[process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA]
      .filter((root): root is string => !!root)
      .flatMap(root => [path.join(root, "Google/Chrome/Application/chrome.exe"),
        path.join(root, "Microsoft/Edge/Application/msedge.exe"), path.join(root, "Chromium/Application/chrome.exe")]),
  ] : [
    "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser",
    "/opt/google/chrome/chrome", "/opt/microsoft/msedge/msedge", "/snap/bin/chromium",
  ];
  const names = process.platform === "win32" ? ["chrome.exe", "msedge.exe", "chromium.exe"]
    : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "microsoft-edge-stable"];
  for (const candidate of [...common, ...names]) {
    const found = await resolveExecutable(candidate);
    if (found) return found;
  }
  throw new Error("PDF export requires a local Chromium, Chrome, or Edge installation. Install one and set CHROME_BIN or options.executable to its absolute executable path.");
}

async function inlineKatex(katexDir: string): Promise<string> {
  try {
    let css = await fs.readFile(path.join(katexDir, "katex.min.css"), "utf8");
    const references = [...css.matchAll(/url\(([^)]+)\)/g)];
    const fonts = new Map<string, string>();
    for (const match of references) {
      const name = match[1].replace(/^["']|["']$/g, "");
      // Only packaged font names, never URLs or paths supplied by a transcript.
      if (!/^fonts\/[a-zA-Z0-9_-]+\.(woff2?|ttf)$/.test(name)) throw new Error("Unexpected font reference");
      if (fonts.has(name)) continue;
      const bytes = await fs.readFile(path.join(katexDir, name));
      const mime = name.endsWith(".woff2") ? "font/woff2" : name.endsWith(".woff") ? "font/woff" : "font/ttf";
      fonts.set(name, `data:${mime};base64,${bytes.toString("base64")}`);
    }
    css = css.replace(/url\(([^)]+)\)/g, (_match, name: string) => `url("${fonts.get(name.replace(/^["']|["']$/g, ""))}")`);
    if (/@import/i.test(css) || !references.length) throw new Error("Unexpected KaTeX stylesheet");
    return css.replace(/</g, "\\3c ");
  } catch {
    throw new Error("Unable to embed KaTeX resources. Set katexDir to the trusted packaged KaTeX dist directory containing katex.min.css and fonts/.");
  }
}

const PRINT_CSS = `
@page { size: A4; margin: 16mm 14mm 18mm;
  @bottom-right { content: "Page " counter(page) " of " counter(pages); font: 8pt sans-serif; color: #666; }
}
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; background: #fff; color: #202124; font: 10.5pt/1.55 Arial, system-ui, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif; }
body, p, li, dd, dt, th, td, h1, h2, h3, h4, h5, h6, pre { overflow-wrap: anywhere; }
h1 { font-size: 20pt; margin: 0 0 10pt; }
h2 { font-size: 14pt; margin: 16pt 0 8pt; }
h3 { font-size: 12pt; }
h1, h2, h3, h4, h5, h6, .message-heading { break-after: avoid; }
p { margin: 6pt 0; orphans: 3; widows: 3; }
dl { margin: 0 0 14pt; }
dt { font-weight: bold; margin-top: 4pt; }
dd { margin: 0; white-space: pre-wrap; }
.message { border-top: 1px solid #d5d9df; padding-top: 9pt; margin-top: 14pt; }
.message-heading { font-size: 11pt; margin: 0 0 6pt; color: #394454; }
.tool-summary { background: #f4f5f7; padding: 8pt; break-inside: avoid; }
.tool-summary .message-heading { margin: 0; }
.export-note { color: #4b5563; font-size: 9pt; }
pre, code { font-family: "SFMono-Regular", Consolas, "Liberation Mono", "DejaVu Sans Mono", "PingFang SC", "Microsoft YaHei", "Noto Sans Mono CJK SC", "Noto Sans CJK SC", monospace; font-size: 9pt; }
pre { white-space: pre-wrap; word-break: break-word; background: #f4f5f7; border: 1px solid #e0e3e8; padding: 8pt; }
code { white-space: break-spaces; }
blockquote { margin: 8pt 0; padding-left: 10pt; border-left: 2pt solid #b7c0ce; color: #4b5563; }
table { width: 100%; table-layout: fixed; border-collapse: collapse; margin: 8pt 0; }
thead { display: table-header-group; }
th, td { border: 1px solid #d5d9df; padding: 5pt; vertical-align: top; }
tr { break-inside: avoid; }
.link { color: #24588c; text-decoration: underline; }
.katex-display { margin: 10pt 0; }
.katex { font-size: 1.08em; }
.math-error, .image-placeholder { color: #5e4930; }
`;

type PdfEntry = { kind: "message"; index: number; messageIndex: number }
  | { kind: "tool"; start: number; end: number; calls: number };

function documentHtml(detail: SessionDetail, katexCss: string): string {
  const entries: PdfEntry[] = [];
  const conversation: SessionDetail["messages"] = [];
  // Match the viewer's role classification and consecutive-run grouping. Never
  // read tool bodies or identifiers, even to render hidden/off-page HTML.
  for (let index = 0; index < detail.messages.length;) {
    const message = detail.messages[index];
    if (/tool|function/i.test(message.role)) {
      const start = index;
      let calls = 0;
      while (index < detail.messages.length && /tool|function/i.test(detail.messages[index].role)) {
        if (/^(toolCall|tool_call|tool_use|function_call|custom_tool_call)$/i.test(detail.messages[index].role)) calls++;
        index++;
      }
      entries.push({ kind: "tool", start, end: index, calls });
    } else {
      entries.push({ kind: "message", index, messageIndex: conversation.length });
      conversation.push({ role: message.role, text: message.text });
      index++;
    }
  }
  // Filter before shared Markdown/redaction machinery, and discard recorded
  // commands/tools so neither can reintroduce omitted details in an appendix.
  // Preexisting message.html properties are deliberately not copied.
  const safe = viewerDetail({ ...detail, messages: conversation, commands: [], tools: [] }, { locale: "en" });
  const toolGroups = entries.filter(entry => entry.kind === "tool").length;
  const metadata: [string, unknown][] = [
    ["Harness", safe.harness], ["Session ID", safe.uid], ["Native ID", safe.nativeId],
    ["Source", safe.path], ["Repository", safe.repo], ["Working directory", safe.cwd],
    ["Model", safe.model], ["Created", safe.createdAt], ["Updated", safe.updatedAt],
    ["Recovered records", detail.messages.length], ["Conversation messages", safe.messages.length],
    ["Collapsed tool groups", toolGroups], ["Recorded messages", safe.messageCount], ["Recorded tool activity", safe.toolCount],
  ];
  const fields = metadata.filter(([, value]) => value !== null && value !== undefined)
    .map(([label, value]) => `<dt>${label}</dt><dd>${escapeHtml(value)}</dd>`).join("");
  const messages = entries.map(entry => {
    if (entry.kind === "tool") {
      const outputs = entry.end - entry.start - entry.calls;
      const range = entry.end - entry.start === 1 ? `#${entry.start + 1}` : `#${entry.start + 1}–#${entry.end}`;
      const count = entry.calls ? `${entry.calls} calls${outputs ? ` · ${outputs} outputs` : ""}` : `${outputs} outputs`;
      return `<section class="message tool-summary"><h2 class="message-heading">▸ ${entry.calls ? "Tool activity" : "Tool output"} · ${count} · ${range}</h2></section>`;
    }
    const message = safe.messages[entry.messageIndex];
    // Export is a static document: links are readable but never navigable.
    const html = message.html.replace(/<a\b[^>]*>/g, '<span class="link">').replace(/<\/a>/g, "</span>");
    return `<section class="message"><h2 class="message-heading">Message ${entry.index + 1} · ${escapeHtml(message.role)}</h2>${html}</section>`;
  }).join("\n");
  const exportNote = '<p class="export-note">Tool activity is shown as collapsed summaries. Tool details and the recorded-command appendix are omitted; summaries cannot be expanded in this PDF.</p>';
  const notes = safe.fidelity.notes.length ? `<h2>Source notes</h2><ul>${safe.fidelity.notes.map(note => `<li>${escapeHtml(note)}</li>`).join("")}</ul>` : "";
  const css = katexCss + PRINT_CSS;
  const styleHash = createHash("sha256").update(css).digest("base64");
  const csp = `default-src 'none'; script-src 'none'; style-src 'sha256-${styleHash}'; style-src-attr 'unsafe-inline'; font-src data:; img-src 'none'; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; media-src 'none'; base-uri 'none'; form-action 'none'`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>${escapeHtml(safe.title ?? "Conversation export")}</title><style>${css}</style></head><body><header><h1>${escapeHtml(safe.title ?? "Conversation export")}</h1><dl>${fields}</dl>${exportNote}</header><main>${messages || "<p>No messages available.</p>"}</main>${notes}</body></html>`;
}

async function runBrowser(executable: string, directory: string): Promise<void> {
  // Keep Chromium's sandbox enabled; do not silently downgrade to --no-sandbox.
  // The CSP and DNS/background-network restrictions also protect static exports.
  const args = [
    "--headless", "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check",
    "--disable-extensions", "--disable-background-networking", "--disable-component-update", "--disable-sync",
    "--metrics-recording-only", "--safebrowsing-disable-auto-update", "--no-proxy-server", "--host-resolver-rules=MAP * ~NOTFOUND",
    `--user-data-dir=${path.join(directory, "profile")}`, "--no-pdf-header-footer", "--print-to-pdf-no-header",
    `--print-to-pdf=${path.join(directory, "session.pdf")}`, pathToFileURL(path.join(directory, "session.html")).href,
  ];
  await new Promise<void>((resolve, reject) => {
    // On POSIX, own a process group so timeout/failure also reaps Chrome helpers.
    const child = spawn(executable, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
    let stderr = Buffer.alloc(0);
    let timedOut = false;
    const kill = () => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { /* Process already exited. */ }
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, BROWSER_TIMEOUT_MS);
    child.stderr.on("data", (chunk: Buffer) => {
      // Drain the pipe, but retain only a bounded diagnostic tail.
      stderr = Buffer.concat([stderr, chunk.subarray(-STDERR_LIMIT)]).subarray(-STDERR_LIMIT);
    });
    child.once("error", () => {
      clearTimeout(timer);
      kill();
      reject(new Error("Unable to start the PDF browser. Check CHROME_BIN/options.executable and executable permissions."));
    });
    child.once("close", code => {
      clearTimeout(timer);
      kill();
      if (timedOut) reject(new Error("PDF browser timed out after 80 seconds. Try a smaller session or check the local browser installation."));
      else if (code !== 0) {
        const diagnostic = redact(stderr.toString("utf8")).replace(/[\x00-\x1f\x7f]/g, " ").trim();
        reject(new Error(`PDF browser failed (exit ${code ?? "unknown"}). Check the local browser installation and sandbox support.${diagnostic ? ` Browser diagnostic: ${diagnostic}` : ""}`));
      } else resolve();
    });
  });
}

async function render(detail: SessionDetail, options: { katexDir: string; executable?: string }): Promise<Buffer> {
  const executable = await findBrowser(options.executable);
  const css = await inlineKatex(options.katexDir);
  const html = documentHtml(detail, css);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "session-hub-pdf-"));
  try {
    await fs.chmod(directory, 0o700);
    await fs.writeFile(path.join(directory, "session.html"), html, { mode: 0o600 });
    await runBrowser(executable, directory);
    let pdf: Buffer;
    try { pdf = await fs.readFile(path.join(directory, "session.pdf")); }
    catch { throw new Error("PDF browser did not create a PDF. Check that the installed browser supports headless --print-to-pdf."); }
    if (pdf.length < 16 || pdf.subarray(0, 5).toString("ascii") !== "%PDF-" || !pdf.subarray(-1024).includes(Buffer.from("%%EOF"))) {
      throw new Error("PDF browser produced an empty or invalid PDF. Check the local browser installation.");
    }
    return pdf;
  } finally {
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

/** Static, redacted, offline A4 export. Options must come from the host, not a client.
 * One active render, with no waiting queue (safe for transport response deadlines).
 */
export async function renderSessionPdf(detail: SessionDetail, options: { katexDir: string; executable?: string }): Promise<Buffer> {
  if (rendering) throw new Error("PDF export is busy. Wait for the current export to finish and try again.");
  rendering = true;
  try { return await render(detail, options); }
  finally { rendering = false; }
}
