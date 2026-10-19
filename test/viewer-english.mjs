// Synthetic end-to-end reader regression: real browser/assets/panel protocol,
// mocked VS Code APIs, and no access to actual session stores.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createJiti } from "jiti";

const root = path.resolve(import.meta.dirname, "..");
const publicDir = path.join(root, "src/web/public");
const require = createRequire(import.meta.url);
const extensionRequire = createRequire(path.join(root, "vscode-extension/package.json"));
const { build } = extensionRequire("esbuild");
const jiti = createJiti(import.meta.url);
const { parseViewerRequest } = await jiti.import("../vscode-extension/src/protocol.ts");
const { SessionLinks } = await jiti.import("../vscode-extension/src/sessionLinks.ts");
const { SessionStars } = await jiti.import("../vscode-extension/src/sessionStars.ts");
const { PiEnvironmentDetector, selectPiEnvironment, assertPiEnvironmentAvailable, assertPiEnvironmentSelected } = await jiti.import("../src/core/pi-environment.ts");
const { assertNewSessionLaunchable } = await jiti.import("../src/core/new-session.ts");
const { renderMarkdown } = await jiti.import("../src/web/markdown.ts");
const han = /\p{Script=Han}/u;
let checks = 0;
function check(name, value) { assert.ok(value, name); checks++; console.log(`PASS ${name}`); }
function englishError(fn) { assert.throws(fn, error => error instanceof Error && !han.test(error.message)); }

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "hub-viewer-english-"));
let chrome, socket, server, cdp, panel, receiver;
let clipboardFails = false, missingSession = false, dropRequests = false;
let lastReadOptions;
const confirmations = [], terminals = [], responses = [], exceptions = [], requests = [];
class Uri {
  constructor(fsPath) { this.fsPath = fsPath; }
  static joinPath(uri, ...parts) { return new Uri(path.join(uri.fsPath, ...parts)); }
  static file(file) { return new Uri(file); }
  with(parts) { return Object.assign(new Uri(this.fsPath), parts); }
  toString() { return this.fsPath; }
}
let origin;
const vscode = {
  Uri, ViewColumn: { Active: 1 },
  window: {
    createWebviewPanel() {
      panel = {
        webview: {
          cspSource: origin,
          onDidReceiveMessage(callback) { receiver = callback; return { dispose() {} }; },
          asWebviewUri(uri) { return new Uri(origin + "/" + path.relative(publicDir, uri.fsPath)); },
          async postMessage(response) {
            responses.push(response);
            if (cdp) await cdp("Runtime.evaluate", { expression: `window.dispatchEvent(new MessageEvent("message", {data: ${JSON.stringify(response)}}))` });
          },
        },
        onDidDispose() {}, dispose() {}, reveal() {},
      };
      return panel;
    },
    async showWarningMessage(text, options, action) { confirmations.push({ text, options, action }); return action; },
    createTerminal(options) { terminals.push(options); return { show() {} }; },
  },
  commands: { async executeCommand() { throw new Error("Synthetic file open failure"); } },
  env: { clipboard: { async writeText() { if (clipboardFails) throw new Error("Synthetic clipboard failure"); } } },
};
const synthetic = {
  uid: "pi:synthetic", nativeId: "synthetic", harness: "pi", title: "Synthetic session",
  path: "/synthetic/session.jsonl", cwd: temp, repo: null, model: null,
  messageCount: 8, fidelity: { hasToolCalls: false, hasToolResults: false, hasReasoning: false, notes: ["Synthetic read limit note"] },
  messages: [
    { role: "user", text: "First question" },
    { role: "assistant", text: "$x^2$\n\n$\\invalidCommand{<script>}$\n\n![Sample image](https://invalid.example/tracker)\n\n[Project file](missing.md)" },
    { role: "toolCall", toolName: "bash", toolCallId: "call-1", text: "echo synthetic" },
    { role: "toolResult", toolName: "bash", toolCallId: "call-1", text: "Literal $x$ <script>bad()</script> password=supersecret" },
    { role: "assistant", text: "Reply" },
    { role: "toolResult", text: "Output without a matching call" },
    { role: "user", text: "" },
  ],
};
const service = {
  async getSessionMetadata() { return missingSession ? null : synthetic; },
  async getStatus() { return { total: 1, harnesses: ["pi"], scan: { total: 1, errors: [] } }; },
  async getSession(_uid, options) { lastReadOptions = options; return missingSession ? null : structuredClone(synthetic); },
};

try {
  // Bundle only the owned host classes; no activation/index scan/user home.
  const bundle = await build({ stdin: { contents: 'export {SessionViewer} from "./vscode-extension/src/sessionViewer.ts"; export {TerminalLauncher} from "./vscode-extension/src/terminalLauncher.ts";', resolveDir: root },
    bundle: true, platform: "node", format: "cjs", target: "node22", write: false, external: ["vscode"],
    nodePaths: [path.join(root, "vscode-extension/node_modules")],
    alias: { katex: extensionRequire.resolve("katex"), "markdown-it": extensionRequire.resolve("markdown-it") } });
  const mod = { exports: {} };
  vm.runInThisContext(`(function(require,module,exports){${bundle.outputFiles[0].text}\n})`)(name => name === "vscode" ? vscode : require(name), mod, mod.exports);
  const { SessionViewer, TerminalLauncher } = mod.exports;
  const template = fs.readFileSync(path.join(publicDir, "index.html"), "utf8");
  // Serve the shared assets unchanged. The VS Code route uses actual panel HTML;
  // the standalone route keeps the template and its default HTTP transport.
  server = http.createServer((req, res) => {
    const route = new URL(req.url, "http://localhost").pathname;
    if (route === "/reader" || route === "/") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.end(route === "/reader" ? panel.webview.html : template);
    }
    if (route.startsWith("/api/")) {
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify(route === "/api/status" ? { scan: { total: 1, errors: [] } }
        : route === "/api/sessions" ? { sessions: [], hasMore: false } : {}));
    }
    const files = { "/app.js": "app.js", "/transport.js": "transport.js", "/style.css": "style.css" };
    if (files[route]) {
      res.setHeader("Content-Type", route.endsWith(".js") ? "text/javascript" : "text/css");
      return res.end(fs.readFileSync(path.join(publicDir, files[route])));
    }
    if (route.startsWith("/katex/") && !route.includes("..")) {
      const dir = path.join(path.dirname(extensionRequire.resolve("katex/package.json")), "dist");
      const file = path.join(dir, route.slice("/katex/".length));
      if (fs.existsSync(file) && fs.statSync(file).isFile()) return res.end(fs.readFileSync(file));
    }
    res.statusCode = 404; res.end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  origin = `http://127.0.0.1:${server.address().port}`;
  // The host URI API maps packaged media to our synthetic asset directory.
  vscode.Uri.joinPath = (uri, ...parts) => parts.join("/") === "dist/media" ? new Uri(publicDir)
    : new Uri(path.join(uri.fsPath, ...parts));
  const viewer = new SessionViewer(service, new Uri(root), async () => { throw new Error("Synthetic resume failure"); }, async () => { throw new Error("Synthetic refresh failure"); });
  await viewer.open(synthetic.uid);
  check("panel HTML keeps strict CSP and selects the English host", panel.webview.html.includes('data-host="vscode"') && panel.webview.html.includes('<html lang="en">') && panel.webview.html.includes("connect-src &#39;none&#39;") && !panel.webview.html.includes('<script src="/'));

  chrome = spawn(process.env.CHROME_BIN ?? "google-chrome", ["--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--disable-background-networking", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${path.join(temp, "chrome")}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  let log = "";
  const debuggerURL = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Chrome startup timeout: ${log}`)), 15000);
    chrome.once("error", error => { clearTimeout(timer); reject(error); });
    chrome.once("exit", code => { clearTimeout(timer); reject(new Error(`Chrome exited ${code}: ${log}`)); });
    chrome.stderr.on("data", chunk => { log += chunk; const match = log.match(/DevTools listening on (ws:\/\/\S+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
  });
  const debugOrigin = new URL(debuggerURL).origin.replace("ws:", "http:");
  const targets = await (await fetch(debugOrigin + "/json/list")).json();
  socket = new WebSocket(targets.find(target => target.type === "page").webSocketDebuggerUrl);
  await once(socket, "open");
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (message.id) { const entry = pending.get(message.id); pending.delete(message.id); if (message.error) entry?.reject(new Error(message.error.message)); else entry?.resolve(message.result); }
    if (message.method === "Runtime.bindingCalled" && !dropRequests) receiver(JSON.parse(message.params.payload)).catch(error => exceptions.push(String(error)));
    if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails);
    if (message.method === "Network.requestWillBeSent") requests.push(message.params.request.url);
  });
  cdp = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => {
    const result = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const wait = async expression => {
    const end = Date.now() + 15000;
    while (Date.now() < end) { if (await evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 40)); }
    throw new Error(`Browser wait timed out: ${expression}`);
  };
  const generatedChinese = async () => evaluate(`(() => {
    const found = [];
    const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) if (/\\p{Script=Han}/u.test(walker.currentNode.textContent)) found.push(walker.currentNode.textContent);
    for (const node of document.querySelectorAll("*")) for (const attr of ["aria-label", "title", "placeholder"]) if (/\\p{Script=Han}/u.test(node.getAttribute(attr) || "")) found.push(node.getAttribute(attr));
    return found;
  })()`);
  await cdp("Runtime.enable"); await cdp("Network.enable"); await cdp("Page.enable");
  await cdp("Runtime.addBinding", { name: "syntheticHost" });
  await cdp("Page.addScriptToEvaluateOnNewDocument", { source: 'window.acquireVsCodeApi = () => ({postMessage: message => window.syntheticHost(JSON.stringify(message))});' });
  await cdp("Page.navigate", { url: origin + "/reader" });
  await wait('document.querySelectorAll(".message").length === 6');
  check("VS Code asks adapters for English generated tool labels", lastReadOptions.locale === "en");
  check("all rendered framework text, hidden controls, aria labels, titles and placeholders are English", (await generatedChinese()).length === 0);
  check("English metadata, tool groups and outline are rendered", await evaluate('document.querySelector(".session-info").textContent.includes("Not provided by the source: tool calls, tool results, reasoning.") && document.querySelector(".message-tool summary").textContent.includes("1 calls · 1 outputs") && document.querySelector("#outline-status").textContent.includes("2 questions") && document.querySelector(".outline-text").textContent === "First question"'));
  check("math and image failures are English, escaped, and do not fetch images", await evaluate('document.querySelector(".math-error").textContent.startsWith("Unable to render math: ") && document.querySelector(".image-placeholder").textContent === "[Image: Sample image]" && document.querySelectorAll(".katex").length > 0 && !document.querySelector("#viewer script, #viewer img") && !document.querySelector("#viewer").textContent.includes("supersecret")'));
  await evaluate('document.querySelector(".message-tool").open = true; document.querySelector(".toolbar-actions button").click()');
  check("raw/rendered switching keeps tool state and English actions", await evaluate('document.querySelector(".message-tool").open && document.querySelector(".toolbar-actions button").textContent === "View rendered text" && document.querySelector(".raw")'));
  await evaluate('document.querySelector(".toolbar-actions button").click(); document.querySelector("#zoom-in").click(); document.querySelector("#next-user").click(); document.querySelector("#theme-toggle").click()');
  check("zoom, theme and outline navigation retain English accessible labels", await evaluate('document.querySelector("#zoom-level").textContent === "110%" && document.querySelector("#outline-position").textContent === "User message 2 / 2" && document.querySelector("#theme-toggle").getAttribute("aria-label").startsWith("Switch to ")'));
  await evaluate('document.querySelector("#outline-filter").value = "not present"; renderOutline()');
  check("outline no-match state is English", await evaluate('document.querySelector(".outline-empty").textContent.startsWith("No matching questions")'));
  await evaluate('document.querySelector("#outline-filter").value = ""; renderOutline(); document.querySelector("[data-session-link]").click()');
  await wait('document.querySelector("#notice").textContent.startsWith("Unable to open link: ")');
  check("missing file link errors are English", await evaluate('document.querySelector("#notice").textContent.includes("no longer exists")'));
  await evaluate('document.querySelector(".resume-button").click()');
  await wait('document.querySelector("#notice").textContent === "Synthetic resume failure"');
  clipboardFails = true;
  await evaluate('Array.from(document.querySelectorAll("button")).find(node => node.textContent === "Copy session ID").click()');
  await wait('document.querySelector("#notice").textContent === "Synthetic clipboard failure"');
  await evaluate('document.querySelector("#refresh").click()');
  await wait('document.querySelector("#notice").textContent === "Refresh failed: Synthetic refresh failure"');
  check("resume, clipboard and refresh failures are visible and English", (await generatedChinese()).length === 0);
  missingSession = true;
  await evaluate('openSession("pi:synthetic")');
  check("read failure and unavailable outline are English", await evaluate('document.querySelector("#viewer").textContent.startsWith("Read failed: The source session") && document.querySelector("#outline-status").textContent === "Read failed; outline unavailable"'));
  missingSession = false;
  await evaluate('openSession("pi:synthetic")');
  await evaluate('detail.messages = []; renderDetail()');
  check("empty transcript and empty outline remain English", (await generatedChinese()).length === 0 && await evaluate('document.querySelector("#viewer").textContent.includes("No recoverable text messages")'));
  await evaluate('openSession("pi:synthetic")');
  synthetic.title = "用户标题：工具输出";
  synthetic.messages = [{ role: "user", text: "用户原文：查看原文" }, { role: "assistant", text: "![用户图片说明](https://invalid.example/image)\n\n$\\invalidCommand{中文}$" }];
  await evaluate('openSession("pi:synthetic")');
  check("authored Chinese titles, transcript text, outline excerpts and image alt text are preserved", await evaluate('document.querySelector(".session-heading").textContent === "用户标题：工具输出" && document.querySelector(".message-body").textContent.includes("用户原文：查看原文") && document.querySelector(".outline-item").getAttribute("aria-label").includes("用户原文：查看原文") && document.querySelector(".image-placeholder").textContent === "[Image: 用户图片说明]" && document.querySelector(".math-error").textContent.includes("中文")'));
  dropRequests = true;
  check("closed-page transport errors are English", await evaluate('(async () => { const pending = transport.request("status").catch(error => error.message); window.dispatchEvent(new Event("pagehide")); return await pending === "The session page has been closed"; })()'));
  check("transport timeout errors are English", await evaluate('(async () => { const original = window.setTimeout; window.setTimeout = (fn, ms) => original(fn, ms === 120000 ? 0 : ms); try { await transport.request("status"); } catch (error) { return error.message === "The extension timed out. Reopen the session."; } finally { window.setTimeout = original; } })()'));
  dropRequests = false;
  check("VS Code reader never uses HTTP APIs or remote image URLs", requests.every(url => !url.includes("/api/") && !url.includes("invalid.example")));
  await cdp("Page.navigate", { url: origin + "/#token=synthetic" });
  await wait('document.querySelector("#notice")?.textContent.startsWith("已连接")');
  check("standalone reader retains Chinese default text and locale", await evaluate('document.documentElement.lang === "zh-CN" && document.title === "Session Hub · 对话记录" && document.querySelector("#refresh").textContent === "刷新索引" && document.querySelector("#outline-filter").placeholder === "在用户消息中查找…" && projectName(null) === "未记录项目" && dateLabel(null) === "时间未知" && !transport.initialUid'));
  check("standalone math/image placeholders stay Chinese after English renders", renderMarkdown('$\\invalidCommand{x}$ ![图片说明](https://invalid.example)').includes("公式无法渲染：") && renderMarkdown("![图片说明](x)").includes("[图片：图片说明]"));
  check("no browser JavaScript exceptions", exceptions.length === 0);

  for (const request of [null, { type: "bad" }, { type: "sessionHub.request", id: 1, operation: "getSession", uid: "pi:other" }, { type: "sessionHub.request", id: 1, operation: "openLink", uid: synthetic.uid, linkId: "bad" }]) englishError(() => parseViewerRequest(request, synthetic.uid));
  englishError(() => new SessionLinks(null).resolve("bad"));
  englishError(() => new SessionStars({ get: () => "corrupt" }).load());
  const stars = new SessionStars({ get: () => [], update: async () => { throw new Error("write failed"); } });
  await assert.rejects(stars.set("invalid", true), error => !han.test(error.message));
  await assert.rejects(stars.set(synthetic.uid, true), error => error.message.includes("Could not save session stars") && !han.test(error.message));
  check("protocol, link and star-store validation errors are English", true);
  const choices = [{ id: "profile", label: "用户配置名称", agentDir: temp }];
  const detector = new PiEnvironmentDetector(temp, choices);
  check("unknown and truncated Pi environment reasons are English", !han.test(detector.resolve().reason) && !han.test(detector.resolve(true).reason));
  const resolution = detector.resolve();
  const action = { command: "pi", args: ["--session", "synthetic"], cwd: temp, verified: true, description: "Resume synthetic session", piEnvironment: resolution };
  englishError(() => selectPiEnvironment(action, "invalid"));
  englishError(() => assertPiEnvironmentSelected(action));
  const selected = selectPiEnvironment(action, "profile");
  check("selected Pi environment reason is English without translating profile labels", !han.test(selected.piEnvironment.reason) && selected.piEnvironment.selected.label === "用户配置名称");
  englishError(() => assertPiEnvironmentAvailable({ ...selected, piEnvironment: { ...selected.piEnvironment, selected: { ...choices[0], agentDir: path.join(temp, "missing") } }, env: { PI_CODING_AGENT_DIR: path.join(temp, "missing") } }));
  englishError(() => assertNewSessionLaunchable({ piEnvironment: { agentDir: path.join(temp, "missing") } }, undefined));
  englishError(() => assertNewSessionLaunchable({}, path.join(temp, "missing")));
  const launcher = new TerminalLauncher();
  await launcher.launch(selected);
  check("terminal confirmation labels are English and preserve configured profile names", confirmations[0].action === "Resume in terminal" && confirmations[0].text.includes("Working directory: ") && confirmations[0].text.includes("Pi environment: 用户配置名称") && !han.test(confirmations[0].text.replaceAll("用户配置名称", "")));
  launcher.startNew({ label: "用户配置名称", executable: "pi" }, temp);
  check("new terminal framework title is English, configured label unchanged", terminals.at(-1).name === "Session Hub · New session · 用户配置名称");
  console.log(`\n${checks} English reader checks passed.`);
} finally {
  socket?.close();
  if (chrome && chrome.exitCode === null && chrome.signalCode === null) { const exited = once(chrome, "exit"); chrome.kill("SIGTERM"); await exited; }
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await fs.promises.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
