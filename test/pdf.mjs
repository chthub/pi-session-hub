import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createJiti } from "jiti";

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const { renderSessionPdf } = await createJiti(import.meta.url).import("../src/web/pdf.ts");
const katexDir = path.join(path.dirname(require.resolve("katex/package.json")), "dist");
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "session-hub-pdf-test-"));
const originalChrome = process.env.CHROME_BIN;
const browser = originalChrome || "/usr/bin/google-chrome";
let checks = 0;
function check(name, predicate = true) {
  assert.ok(predicate, name);
  console.log(`PASS ${name}`);
  checks++;
}
async function available(name) {
  try { await exec(name, ["-v"], { timeout: 5000 }); return true; }
  catch (error) { return error.code !== "ENOENT"; }
}
async function writeBrowser(name, body) {
  const file = path.join(scratch, name);
  await fs.writeFile(file, `#!${process.execPath}\n${body}`, { mode: 0o700 });
  return file;
}
function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
async function pdfTemps() {
  return (await fs.readdir(os.tmpdir())).filter(name => name.startsWith("session-hub-pdf-") && !name.startsWith("session-hub-pdf-test-")).sort();
}
async function gone(directory) {
  await assert.rejects(fs.stat(directory), { code: "ENOENT" });
}

try {
  const source = path.join(scratch, 'source "<&>.jsonl');
  await fs.writeFile(source, "source must not change\n");
  const sourceBefore = await fs.readFile(source);
  const title = '../../hostile "title" <script>metadataAttack()</script> & A4';
  const secret = "pdf_test_secret_123456789";
  const detail = freeze({
    uid: "pi:test<&>", harness: "pi", nativeId: "native\"<&>", path: source, title,
    createdAt: "2026-01-02T03:04:05Z", updatedAt: null,
    cwd: `<iframe src="https://example.invalid/cwd"> password=${secret}`, repo: 'repo & <b>name</b>',
    model: '<img src="https://example.invalid/model">', messageCount: 1, toolCount: 2,
    preview: "not a message", searchText: "must not be exported from index", mtimeMs: 0, size: 0,
    fidelity: { hasToolCalls: true, hasToolResults: true, hasReasoning: false, filesChanged: null, filesRead: null,
      notes: ['note <img src="https://example.invalid/notes">'] },
    tools: [{ name: 'TOOL_NAME_HIDDEN_summary "<&>', count: 1 }], commands: ['echo "COMMAND_APPENDIX_HIDDEN_marker"', `password=${secret}`],
    messages: [
      { role: "user", text: "Ordinary searchable conversation text.\n\n中文对话：你好世界，公式与代码。\n\n**Bold text** and `inline code`." },
      { role: "assistant", text: String.raw`Inline equation $x_1^2 + \alpha$.

$$
\frac{1}{2} + \sqrt{x} = y
$$

| Column | Value |
| --- | --- |
| Table text | 42 |

` + '```js\nconst codeMarker = "<tag>"; // 中文代码\n```' },
      { role: "toolCall", toolName: 'TOOL_NAME_HIDDEN_bash <img src="x">', toolCallId: 'CALL_ID_HIDDEN_1 "<&>', text: `Tool call marker\n{"command":"echo tool-content", "password":"${secret}"}\nliteral $x$ <script>toolAttack()</script>` },
      { role: "toolResult", toolName: "TOOL_NAME_HIDDEN_bash", toolCallId: "CALL_ID_HIDDEN_2", text: "Tool result marker\nline two 中文工具结果\n$x$ <iframe>not a frame</iframe>" },
      ...["TOOL_CALL", "tool_USE", "Function_Call", "CUSTOM_TOOL_CALL", "FUNCTION_RESULT"].map((role, index) => ({
        role, toolCallId: `CALL_ID_HIDDEN_alias_${index}`, text: `TOOL_ALIAS_BODY_${index} parameter=value\noutput=value`,
      })),
      { role: '<svg onload="roleAttack()">', text: '<script>injectedScript()</script>\n<img src="https://example.invalid/tracker" onerror="imageAttack()">\n![Tracking image](https://example.invalid/pixel)\n[External link](https://example.invalid/link)\n[Unsafe](javascript:alert(1))\n' + String.raw`$\href{https://example.invalid/math}{x}$`, html: '<script>preexistingHtmlAttack()</script>' },
      { role: "fUnCtIoN", text: "ISOLATED_OUTPUT_HIDDEN_body", toolCallId: "CALL_ID_HIDDEN_orphan" },
      { role: "user", text: "Between tool groups. 中文正文完整保留。 Equation $z^3$ remains." },
      { role: "tOoLcAlL", text: "SECOND_CALL_HIDDEN_parameters", toolCallId: "CALL_ID_HIDDEN_second" },
      { role: "tOoL", text: "SECOND_OUTPUT_HIDDEN_body" },
      { role: "Function", text: "THIRD_OUTPUT_HIDDEN_body" },
      { role: "assistant", text: "After separated tool groups. Keep this ordinary response intact." },
      ...Array.from({ length: 45 }, (_, i) => ({ role: "assistant", text: `Pagination marker ${i + 1}. ${"Long readable paragraph for pagination and selection. ".repeat(12)}` })),
      { role: "function_call", text: "LAST_CALL_HIDDEN_parameters", toolCallId: "CALL_ID_HIDDEN_last" },
      { role: "assistant", text: `Final message marker. password=${secret}` },
    ],
  });
  const before = JSON.stringify(detail);
  const capture = path.join(scratch, "capture.json");
  const htmlCopy = path.join(scratch, "captured.html");
  const wrapper = await writeBrowser("capture-browser.mjs", `
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const args = process.argv.slice(2);
const html = fileURLToPath(args.at(-1));
const directory = path.dirname(html);
fs.copyFileSync(html, ${JSON.stringify(htmlCopy)});
fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ args, directory, mode: fs.statSync(directory).mode & 0o777, htmlMode: fs.statSync(html).mode & 0o777, files: fs.readdirSync(directory) }));
const child = spawn(${JSON.stringify(browser)}, args, { stdio: ['ignore', 'ignore', 'inherit'] });
child.on('error', error => { console.error(error.message); process.exit(1); });
child.on('exit', code => process.exit(code ?? 1));
`);
  const pdf = await renderSessionPdf(detail, { katexDir, executable: wrapper });
  check("real Chromium returns nonempty PDF bytes", Buffer.isBuffer(pdf) && pdf.length > 10_000 && pdf.subarray(0, 5).toString() === "%PDF-");
  const captured = JSON.parse(await fs.readFile(capture, "utf8"));
  await gone(captured.directory);
  check("success removes the private HTML/profile/output directory", captured.mode === 0o700 && captured.htmlMode === 0o600);
  check("filenames are constant, never derived from metadata", captured.files.includes("session.html") && captured.args.some(arg => arg === `--print-to-pdf=${path.join(captured.directory, "session.pdf")}`));
  check("normal export preserves the Chromium sandbox", !captured.args.includes("--no-sandbox"));
  const html = await fs.readFile(htmlCopy, "utf8");
  check("strict CSP forbids active content and network resources", ["default-src 'none'", "script-src 'none'", "img-src 'none'", "connect-src 'none'", "frame-src 'none'", "object-src 'none'", "font-src data:", "style-src 'sha256-"].every(rule => html.includes(rule)));
  check("KaTeX CSS and fonts are embedded, with no local resource requests", html.includes("data:font/woff2;base64,") && !html.includes('url(fonts/') && html.includes('class="katex"'));
  check("metadata, title and ordinary message roles are escaped", html.includes('&lt;script&gt;metadataAttack()&lt;/script&gt;') && html.includes('&lt;svg onload=&quot;roleAttack()&quot;&gt;') && html.includes('repo &amp; &lt;b&gt;name&lt;/b&gt;'));
  check("only generated Markdown HTML is accepted; scripts/images/frames/links are inert", !/<(?:script|img|iframe|object|embed|a)\b/i.test(html) && !html.includes("preexistingHtmlAttack") && !html.includes('href="https:'));
  const summaries = ["Tool activity · 5 calls · 2 outputs · #3–#9", "Tool output · 1 outputs · #11", "Tool activity · 1 calls · 2 outputs · #13–#15", "Tool activity · 1 calls · #62"];
  check("consecutive tool aliases form collapsed summaries with viewer counts and original ranges", summaries.every(summary => html.includes(summary)) && (html.match(/class="message tool-summary"/g) ?? []).length === 4 && !html.includes("<details"));
  check("ordinary messages separate tool groups and keep original order and numbering", html.indexOf(summaries[0]) < html.indexOf("Message 10") && html.indexOf("Message 10") < html.indexOf(summaries[1]) && html.indexOf(summaries[1]) < html.indexOf("Between tool groups") && html.indexOf("Between tool groups") < html.indexOf(summaries[2]) && html.includes("Message 16 · assistant") && html.includes(`Message ${detail.messages.length}`));
  const omitted = ["Tool call marker", "Tool result marker", "中文工具结果", "tool-content", "TOOL_ALIAS_BODY_", "CALL_ID_HIDDEN_", "TOOL_NAME_HIDDEN_", "ISOLATED_OUTPUT_HIDDEN_", "SECOND_CALL_HIDDEN_", "SECOND_OUTPUT_HIDDEN_", "THIRD_OUTPUT_HIDDEN_", "LAST_CALL_HIDDEN_", "COMMAND_APPENDIX_HIDDEN_", "Recorded commands", "Call ID:"];
  check("tool bodies, parameters, IDs and command appendix are absent from generated HTML", omitted.every(marker => !html.includes(marker)));
  check("metadata truthfully distinguishes recovered records, conversation messages and collapsed groups", html.includes(`<dt>Recovered records</dt><dd>${detail.messages.length}</dd>`) && html.includes("<dt>Conversation messages</dt><dd>51</dd>") && html.includes("<dt>Collapsed tool groups</dt><dd>4</dd>") && html.includes("Tool details and the recorded-command appendix are omitted") && html.includes("summaries cannot be expanded in this PDF") && !html.includes("Exported messages"));
  check("redaction still protects retained metadata and conversation text", !html.includes(secret) && html.includes("[REDACTED]"));
  check("source index excerpts are not exported", !html.includes("must not be exported from index"));
  check("input objects and source files are unchanged", JSON.stringify(detail) === before && sourceBefore.equals(await fs.readFile(source)));

  const output = path.join(scratch, "actual.pdf");
  await fs.writeFile(output, pdf);
  if (await available("pdfinfo")) {
    const { stdout } = await exec("pdfinfo", [output], { timeout: 10_000 });
    const pageSize = /Page size:\s+([\d.]+) x ([\d.]+) pts/.exec(stdout);
    check("real output is paginated A4", Number(/Pages:\s+(\d+)/.exec(stdout)?.[1]) > 1 && pageSize && Math.abs(Number(pageSize[1]) - 595.28) < 2 && Math.abs(Number(pageSize[2]) - 841.89) < 2);
    check("PDF title preserves literal metadata without interpreting markup", stdout.includes('metadataAttack()') && stdout.includes('<script>'));
    check("PDF contains no JavaScript", /JavaScript:\s+no/.test(stdout));
  } else console.log("SKIP pdfinfo unavailable");
  if (await available("pdftotext")) {
    const { stdout } = await exec("pdftotext", ["-layout", output, "-"], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
    check("ordinary conversation text and code are selectable", stdout.includes("Ordinary searchable conversation text") && stdout.includes("codeMarker") && stdout.includes("inline code"));
    check("Chinese conversation text is selectable via system fallback", stdout.includes("你好世界") && stdout.includes("中文正文完整保留"));
    check("ordinary inline and display equations remain selectable", stdout.includes("α") && /x/.test(stdout) && /y/.test(stdout) && stdout.includes("Equation") && stdout.includes("remains"));
    const normalized = stdout.replace(/\s+/g, " ");
    check("real PDF contains collapsed multi-call, isolated-output and calls-only summaries", summaries.every(summary => normalized.includes(summary)));
    check("tool bodies, parameters, IDs and command appendix never enter the real PDF", omitted.every(marker => !stdout.includes(marker)));
    check("ordinary conversation order and final page remain complete", normalized.indexOf(summaries[1]) < normalized.indexOf("Between tool groups") && normalized.indexOf("Between tool groups") < normalized.indexOf(summaries[2]) && stdout.includes("After separated tool groups") && stdout.includes("Final message marker") && stdout.includes("Pagination marker 45"));
    check("no secrets leak into extracted PDF text", !stdout.includes(secret));
  } else console.log("SKIP pdftotext unavailable");

  const widthCheck = process.env.PROSE_WIDTH_CHECK || path.join(os.homedir(), ".agent-shared/skills/report-page/scripts/prose_width_check.py");
  const hasWidthCheck = await fs.access(widthCheck).then(() => true, error => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
  if (hasWidthCheck) {
    try {
      await exec("python3", [widthCheck, htmlCopy, "--body-font-size", "14"], { timeout: 10_000 });
      check("generated print HTML passes the prose width check");
    } catch (error) {
      if (error.code === "ENOENT") console.log("SKIP prose width check: python3 is not installed");
      else throw error;
    }
  } else console.log("SKIP prose width check: checker script is not installed; set PROSE_WIDTH_CHECK to its location");

  const guardedHtml = path.join(scratch, "guarded.html");
  const guardedBrowser = await writeBrowser("guarded-browser.mjs", `
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const html = fileURLToPath(process.argv.at(-1));
fs.copyFileSync(html, ${JSON.stringify(guardedHtml)});
fs.writeFileSync(path.join(path.dirname(html), 'session.pdf'), '%PDF-1.4\\nstatic filtering fixture\\n%%EOF\\n');
`);
  const guardedTool = {
    role: "TOOL_CALL",
    get text() { throw new Error("Tool text must not be read or rendered"); },
    get toolName() { throw new Error("Tool names must not be read"); },
    get toolCallId() { throw new Error("Call IDs must not be read"); },
    get html() { throw new Error("Tool HTML must not be copied"); },
  };
  await renderSessionPdf({ ...detail, messages: [guardedTool] }, { katexDir, executable: guardedBrowser });
  const toolOnlyHtml = await fs.readFile(guardedHtml, "utf8");
  check("tool bodies and identifiers are filtered before Markdown or redaction visits them", toolOnlyHtml.includes("Tool activity · 1 calls · #1") && toolOnlyHtml.includes("<dt>Conversation messages</dt><dd>0</dd>") && !toolOnlyHtml.includes("No messages available"));
  await renderSessionPdf({ ...detail, messages: [] }, { katexDir, executable: guardedBrowser });
  const emptyHtml = await fs.readFile(guardedHtml, "utf8");
  check("empty sessions have no invented tool groups", emptyHtml.includes("No messages available") && emptyHtml.includes("<dt>Collapsed tool groups</dt><dd>0</dd>"));

  const small = { ...detail, title: "Small export", messages: [{ role: "user", text: "small" }], commands: [] };
  const failureLog = path.join(scratch, "failure-directory");
  const failed = await writeBrowser("failed-browser.mjs", `
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const directory = path.dirname(fileURLToPath(process.argv.at(-1)));
fs.mkdirSync(path.join(directory, 'profile'));
fs.writeFileSync(${JSON.stringify(failureLog)}, directory);
process.stderr.write('x'.repeat(100000) + '\\npassword=${secret}');
process.exitCode = 7;
`);
  await assert.rejects(renderSessionPdf(small, { katexDir, executable: failed }), error => {
    assert.match(error.message, /PDF browser failed \(exit 7\)/);
    assert.ok(error.message.length < 17_000);
    assert.ok(!error.message.includes(secret));
    return true;
  });
  await gone(await fs.readFile(failureLog, "utf8"));
  check("browser failure has bounded/redacted English diagnostics and cleans private files");

  for (const [name, body, expected] of [
    ["missing-output", "", /did not create a PDF/],
    ["empty-output", "fs.writeFileSync(output, '');", /empty or invalid PDF/],
    ["invalid-output", "fs.writeFileSync(output, 'not a valid PDF file %%EOF');", /empty or invalid PDF/],
    ["truncated-output", "fs.writeFileSync(output, '%PDF-1.7 this output was truncated');", /empty or invalid PDF/],
  ]) {
    const fake = await writeBrowser(`${name}.mjs`, `
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const directory = path.dirname(fileURLToPath(process.argv.at(-1)));
fs.writeFileSync(${JSON.stringify(failureLog)}, directory);
const output = path.join(directory, 'session.pdf');
${body}
`);
    await assert.rejects(renderSessionPdf(small, { katexDir, executable: fake }), expected);
    await gone(await fs.readFile(failureLog, "utf8"));
    check(`${name} is rejected and cleaned`);
  }

  const broken = path.join(scratch, "broken-interpreter");
  await fs.writeFile(broken, "#!/no/such/pdf-test-interpreter\n", { mode: 0o700 });
  const beforeSpawnError = await pdfTemps();
  await assert.rejects(renderSessionPdf(small, { katexDir, executable: broken }), /Unable to start the PDF browser/);
  check("spawn errors clean temporary files", JSON.stringify(beforeSpawnError) === JSON.stringify(await pdfTemps()));

  const hanging = await writeBrowser("hanging-browser.mjs", `
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const directory = path.dirname(fileURLToPath(process.argv.at(-1)));
fs.writeFileSync(${JSON.stringify(failureLog)}, directory);
spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'ignore', 'inherit'] });
setInterval(() => {}, 1000);
`);
  const realSetTimeout = globalThis.setTimeout;
  try {
    // Exercise the production timeout branch without waiting the full 80 seconds.
    globalThis.setTimeout = (callback, delay, ...args) => realSetTimeout(callback, delay === 80_000 ? 500 : delay, ...args);
    const started = Date.now();
    await assert.rejects(renderSessionPdf(small, { katexDir, executable: hanging }), /timed out after 80 seconds/);
    await gone(await fs.readFile(failureLog, "utf8"));
    check("timeout kills the owned process group and cleans temporary files", Date.now() - started < 5000);
  } finally { globalThis.setTimeout = realSetTimeout; }

  const tempsBefore = await pdfTemps();
  await assert.rejects(renderSessionPdf(small, { katexDir, executable: path.join(scratch, "no-such-browser") }), /CHROME_BIN.*options.executable/);
  process.env.CHROME_BIN = path.join(scratch, "invalid-env-browser");
  await assert.rejects(renderSessionPdf(small, { katexDir }), /not executable/);
  if (originalChrome === undefined) delete process.env.CHROME_BIN; else process.env.CHROME_BIN = originalChrome;
  await assert.rejects(renderSessionPdf(small, { katexDir: scratch, executable: browser }), /trusted packaged KaTeX dist/);
  check("missing browser/invalid host override/resources fail clearly without temp leaks", JSON.stringify(tempsBefore) === JSON.stringify(await pdfTemps()));

  // A trusted fake executable exercises the no-wait lock without extra Chrome launches.
  const events = path.join(scratch, "events.jsonl");
  const serial = await writeBrowser("serial-browser.mjs", `
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const directory = path.dirname(fileURLToPath(process.argv.at(-1)));
const events = ${JSON.stringify(events)};
fs.appendFileSync(events, JSON.stringify({type: 'start', directory}) + '\\n');
setTimeout(() => {
 fs.writeFileSync(path.join(directory, 'session.pdf'), '%PDF-1.4\\nsynthetic queue fixture\\n%%EOF\\n');
 fs.appendFileSync(events, JSON.stringify({type: 'end', directory}) + '\\n');
}, 100);
`);
  const active = renderSessionPdf(small, { katexDir, executable: serial });
  const rejectedAt = Date.now();
  await assert.rejects(renderSessionPdf(small, { katexDir, executable: serial }), /busy.*try again/);
  check("concurrent export is rejected immediately instead of queued", Date.now() - rejectedAt < 1000);
  await active;
  await renderSessionPdf(small, { katexDir, executable: serial });
  const timeline = (await fs.readFile(events, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  check("only one browser is active and lock is released after completion", timeline.map(event => event.type).join(",") === "start,end,start,end");
  for (const event of timeline) await gone(event.directory);
  check("subsequent renders clean up and work after earlier browser failures");
  console.log(`\n${checks} PDF checks passed`);
} finally {
  if (originalChrome === undefined) delete process.env.CHROME_BIN; else process.env.CHROME_BIN = originalChrome;
  await fs.rm(scratch, { recursive: true, force: true });
}
