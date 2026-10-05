import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { createJiti } from "jiti";
import { forwardLoopback } from "./fixtures/loopback-forward.mjs";

const jiti = createJiti(import.meta.url);
const { renderMarkdown, renderPlainText } = await jiti.import("../src/web/markdown.ts");
const { startWebViewer } = await jiti.import("../src/web/server.ts");
const { AdapterRegistry } = await jiti.import("../src/adapters/registry.ts");
const { cleanTranscriptText } = await jiti.import("../src/security.ts");
const { buildToolHome, TOOL_COMMAND, TOOL_SECRET } = await jiti.import("./fixtures/tool-home.mjs");
const { pushToolCall, pushToolResult, pushTranscriptBlocks } = await jiti.import("../src/adapters/util.ts");
let checks = 0;
function check(name, predicate) {
  assert.ok(predicate, name);
  console.log(`PASS ${name}`);
  checks++;
}

check("inline math preserves TeX", renderMarkdown(String.raw`中文 $x_1^2 + \alpha$。`).includes('class="katex"'));
const chineseLoss = String.raw`\mathcal L=\mathcal L_{\mathrm{计数}}+\lambda\sum_{j\in\mathrm{训练集}}\omega_j(\mu_j-\hat r_j)^2`;
check("reported Chinese-label formula renders inline", renderMarkdown(`$${chineseLoss}$`).includes('class="katex"') && !renderMarkdown(`$${chineseLoss}$`).includes("math-error"));
check("reported Chinese-label formula renders in display mode", renderMarkdown(`$$\n${chineseLoss}\n$$`).includes('class="katex-display"') && !renderMarkdown(`$$\n${chineseLoss}\n$$`).includes("math-error"));
check("plain Chinese math labels use fallback fonts", !renderMarkdown("$均值=x_1$").includes("math-error"));
check("multiline display math", renderMarkdown("前文\n\n$$\n\\frac{1}{2}\n$$\n\n后文").includes('class="katex-display"'));
check("single-line display math", renderMarkdown("$$x^2$$").includes('class="katex-display"'));
check("display math after paragraph", renderMarkdown("前文\n$$\nx^2\n$$").includes('class="katex-display"'));
check("inline display math", renderMarkdown("前文 $$x^2$$ 后文").includes('class="katex-display"'));
check("display math in list", renderMarkdown("- 公式\n\n  $$\n  x^2\n  $$").includes('class="katex-display"'));
check("inline code stays literal", !renderMarkdown("`$x$` and `$$y$$`").includes('class="katex'));
check("fenced code stays literal", !renderMarkdown("```tex\n$x$\n$$y$$\n```").includes('class="katex'));
check("indented code stays literal", !renderMarkdown("    $$x$$").includes('class="katex'));
check("escaped dollars stay literal", !renderMarkdown(String.raw`\$x\$`).includes('class="katex'));
check("currency stays literal", !renderMarkdown("Costs $5 and $10.").includes('class="katex'));
check("unclosed delimiters stay literal", renderMarkdown("before $x and $$y").includes("$x"));
check("invalid math has visible fallback", renderMarkdown(String.raw`$\notACommand{<script>}$`).includes("公式无法渲染"));
check("math errors escape HTML", !renderMarkdown(String.raw`$\notACommand{<script>}$`).includes("<script>"));
check("raw HTML disabled", !renderMarkdown('<script>alert(1)</script><img src=x onerror="alert(1)">').includes("<script>"));
check("javascript links disabled", !renderMarkdown("[x](javascript:alert(1))").includes('href="javascript:'));
check("relative links disabled", !renderMarkdown("[x](/api/refresh)").includes('href="/api/'));
check("safe links isolated", renderMarkdown("[x](https://example.com)").includes('rel="noopener noreferrer"'));
check("remote images disabled", !renderMarkdown("![image](http://example.com/tracker)").includes("<img"));
check("KaTeX untrusted commands cannot create links", !renderMarkdown(String.raw`$\href{javascript:alert(1)}{x}$`).includes("href="));
check("tool text is escaped and never math", renderPlainText("<script>$x$</script>") === "<pre>&lt;script&gt;$x$&lt;/script&gt;</pre>");
check("secrets redacted", !renderMarkdown("password=supersecret sk-abcdefghijklmnop").includes("supersecret"));
check("oversized math has fallback", renderMarkdown("$" + "x".repeat(20001) + "$").includes("公式无法渲染"));
check("transcript cleaning preserves indentation", cleanTranscriptText("    $x$\n") === "    $x$\n");

const callExample = [];
pushToolCall(callExample, "exec_command", { cmd: ["bash", "-lc", TOOL_COMMAND], env: { API_KEY: TOOL_SECRET } }, "test-call");
check("tool call preserves argv and command without inventing shell quoting", callExample[0].text.includes('"bash"') && callExample[0].text.includes("调用参数") && callExample[0].toolCallId === "test-call");
check("tool argument secrets are redacted", !callExample[0].text.includes(TOOL_SECRET));
const missingArgs = [];
pushToolCall(missingArgs, "read", undefined, "missing-call");
check("missing call parameters are reported honestly", missingArgs[0].text.includes("调用参数：\n未记录") && !missingArgs[0].text.includes("命令（"));
const nullArgs = [];
pushTranscriptBlocks(nullArgs, "assistant", [{ type: "toolCall", name: "custom", arguments: null }, { type: "tool_result", content: null }]);
check("explicit null arguments and results are not reported as missing", nullArgs[0].text.includes("调用参数：\nnull") && nullArgs[1].text === "null");
const structuredOutput = [];
pushToolResult(structuredOutput, { stdout: "hello", password: TOOL_SECRET }, "bash", "test-call");
check("structured results preserve content and redact keys", structuredOutput[0].text.includes("hello") && !structuredOutput[0].text.includes(TOOL_SECRET));
const orderedBlocks = [];
pushTranscriptBlocks(orderedBlocks, "assistant", [{ type: "text", text: "before" }, { type: "toolCall", id: "order", name: "bash", arguments: { command: TOOL_COMMAND } }, { type: "text", text: "after" }], { preserveFormatting: true });
check("mixed text and tool calls keep source block order", orderedBlocks.map(m => m.role).join(",") === "assistant,toolCall,assistant" && orderedBlocks[1].text.includes(TOOL_COMMAND));
check("quoted JSON secrets are redacted in command text", !renderPlainText('{"api_key":"secret_value_123"}').includes("secret_value_123"));

const home = fs.mkdtempSync(path.join(os.tmpdir(), "session-hub-web-"));
let viewer;
let forward;
let child;
function fingerprint(directory, map = {}) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (file === path.join(home, ".pi", "agent", "pi-session-hub")) continue;
    if (entry.isDirectory()) fingerprint(file, map);
    else if (entry.isFile() && !file.endsWith("-shm")) map[file] = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  }
  return map;
}
try {
  await buildToolHome(home);
  const before = fingerprint(home);
  viewer = await startWebViewer({ home, port: 0 });
  const url = new URL(viewer.url);
  const token = new URLSearchParams(url.hash.slice(1)).get("token");
  const headers = { Authorization: `Bearer ${token}` };
  const request = (route, options = {}) => fetch(url.origin + route, { headers, ...options });
  const page = await request("/");
  check("page served on loopback", page.status === 200 && url.hostname === "127.0.0.1");
  check("CSP blocks remote resources and frames", page.headers.get("content-security-policy").includes("frame-ancestors 'none'"));
  check("no cache", page.headers.get("cache-control") === "no-store");
  check("UI loaded", (await page.text()).includes("对话记录"));
  check("local KaTeX stylesheet", (await request("/katex/katex.min.css")).status === 200);
  check("local KaTeX fonts", (await request("/katex/fonts/KaTeX_Main-Regular.woff2")).status === 200);
  check("unauthenticated metadata denied", (await request("/api/status", { headers: {} })).status === 401);
  check("wrong token denied", (await request("/api/sessions", { headers: { Authorization: "Bearer wrong" } })).status === 401);
  check("foreign origin denied", (await request("/api/status", { headers: { ...headers, Origin: "https://evil.example" } })).status === 403);
  const rebinding = await new Promise((resolve, reject) => {
    const req = http.get(url.origin + "/api/status", { headers: { ...headers, Host: `evil.example:${url.port}` } }, res => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject);
  });
  check("DNS rebinding denied", rebinding === 403);
  const hostStatus = (host, extra = {}) => new Promise((resolve, reject) => {
    const req = http.get(url.origin + "/api/status", { headers: { ...headers, Host: host, ...extra } }, res => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject);
  });
  for (const host of ["localhost:54321", "127.0.0.1:54321", "[::1]:54321"]) {
    check(`remapped loopback host accepted (${host})`, await hostStatus(host) === 200);
  }
  for (const host of ["localhost.evil:54321", "127.0.0.1.evil:54321", "127.0.0.2:54321", "localhost:65536", "localhost:0", "user@localhost:54321"]) {
    check(`non-loopback or invalid host rejected (${host})`, await hostStatus(host) === 403);
  }
  check("forwarded headers cannot bypass host check", await hostStatus("evil.example", { "X-Forwarded-Host": "localhost:54321" }) === 403);
  for (const origin of ["null", "http://localhost.evil:54321", "http://evil@localhost:54321", "http://localhost:54321/path"]) {
    check(`invalid origin rejected (${origin})`, (await request("/api/status", { headers: { ...headers, Origin: origin } })).status === 403);
  }
  forward = await forwardLoopback(viewer.url);
  const forwardedURL = new URL(forward.url);
  check("test tunnel uses a different local port", forwardedURL.port !== url.port);
  check("page accessible through remapped tunnel", (await fetch(forwardedURL.origin)).status === 200);
  check("API accessible through remapped tunnel", (await fetch(forwardedURL.origin + "/api/status", { headers })).status === 200);
  check("tunnel still requires token", (await fetch(forwardedURL.origin + "/api/status")).status === 401);
  check("POST Origin accepts forwarded port", (await fetch(forwardedURL.origin + "/api/refresh", { method: "POST", headers: { ...headers, Origin: forwardedURL.origin } })).status === 200);
  check("foreign origin still rejected through tunnel", (await fetch(forwardedURL.origin + "/api/refresh", { method: "POST", headers: { ...headers, Origin: "https://evil.example" } })).status === 403);
  await forward.close();
  forward = null;
  const status = await (await request("/api/status")).json();
  check("all six harnesses indexed", status.scan.total === 6 && status.scan.errors.length === 0);
  const first = await (await request("/api/sessions?limit=2")).json();
  const second = await (await request("/api/sessions?limit=2&offset=2")).json();
  check("stable pagination", first.sessions.length === 2 && first.hasMore && second.sessions.every(s => !first.sessions.some(t => t.uid === s.uid)));
  const filtered = await (await request("/api/sessions?harness=pi")).json();
  check("harness filter", filtered.sessions.length === 1 && filtered.sessions[0].harness === "pi");
  const search = await (await request("/api/sessions?q=billing")).json();
  check("FTS search", search.sessions.some(s => s.harness === "pi"));
  for (const query of ["harness=bad", "limit=0", "limit=9999", "offset=-1", "offset=abc", "q=" + "x".repeat(1001)]) {
    check(`bad query rejected (${query.slice(0, 30)})`, (await request(`/api/sessions?${query}`)).status === 400);
  }
  for (const session of (await (await request("/api/sessions")).json()).sessions) {
    const response = await request(`/api/session?${new URLSearchParams({ uid: session.uid })}`);
    const recovered = await response.json();
    check(`read ${session.harness}`, response.status === 200 && recovered.messages.length > 0 && recovered.uid === session.uid);
    check(`${session.harness}: API renders inline and display math`, recovered.messages.some(m => m.html.includes('class="katex"') && m.html.includes('class="katex-display"')));
    check(`${session.harness}: multiline Markdown preserved`, recovered.messages.some(m => m.text.includes("\n") && m.html.includes('<strong>格式测试</strong>') && m.html.includes('language-tex')));
    check(`${session.harness}: API redacts raw text and rendered text`, !JSON.stringify(recovered).includes("supersecret"));
    const callId = `call-${session.harness}`;
    const callIndex = recovered.messages.findIndex(m => m.role === "toolCall" && m.toolCallId === callId);
    const outputIndex = recovered.messages.findIndex(m => m.role === "toolResult" && m.toolCallId === callId);
    const beforeIndex = recovered.messages.findIndex(m => m.text.includes("tool test before call"));
    const afterIndex = recovered.messages.findIndex(m => m.text.includes("tool test after result"));
    check(`${session.harness}: source call and result are recovered in order`, beforeIndex >= 0 && beforeIndex < callIndex && callIndex < outputIndex && outputIndex < afterIndex);
    check(`${session.harness}: commands and all call parameters are visible`, callIndex >= 0 && recovered.messages[callIndex].text.includes(TOOL_COMMAND) && recovered.messages[callIndex].text.includes('"timeout": 17') && recovered.messages[callIndex].toolName);
    check(`${session.harness}: tool activity is literal and redacted`, outputIndex >= 0 && recovered.messages[outputIndex].text.includes("$x$") && recovered.messages[callIndex].html.startsWith("<pre>") && !recovered.messages[outputIndex].html.includes('class="katex') && !JSON.stringify(recovered).includes(TOOL_SECRET));
    const legacy = await new AdapterRegistry(home).get(session.harness).getSession(recovered.nativeId);
    check(`${session.harness}: default normalization unchanged`, legacy.messages.every(m => !m.text.includes("\n") && m.role !== "toolCall"));
    const formattedOnly = await new AdapterRegistry(home).get(session.harness).getSession(recovered.nativeId, { preserveFormatting: true });
    check(`${session.harness}: tool activity requires explicit opt-in`, JSON.stringify(formattedOnly.messages.map(m => m.role)) === JSON.stringify(legacy.messages.map(m => m.role)));
  }
  check("arbitrary path denied", (await request("/api/session?uid=/etc/passwd")).status === 404);
  check("unknown endpoint denied", (await request("/api/execute")).status === 404);
  check("traversal not served", (await request("/%2e%2e/package.json")).status === 404);
  check("unexpected method rejected", (await request("/api/sessions", { method: "POST" })).status === 405);
  check("refresh requires token", (await request("/api/refresh", { method: "POST", headers: {} })).status === 401);
  const refreshed = await request("/api/refresh", { method: "POST" });
  check("explicit refresh works", refreshed.status === 200 && (await refreshed.json()).total === 6);
  await assert.rejects(startWebViewer({ home, port: Number(url.port) }), /EADDRINUSE/);
  checks++; console.log("PASS occupied port fails clearly");
  check("foreign stores unchanged", JSON.stringify(before) === JSON.stringify(fingerprint(home)));
  await viewer.close();
  await viewer.close();
  viewer = null;
  check("shutdown is idempotent", true);

  child = spawn(process.execPath, ["bin/web.mjs", "--port", "0", "--no-open"], { cwd: path.resolve(import.meta.dirname, ".."), env: { ...process.env, HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let errors = "";
  child.stderr.on("data", data => { errors += data; });
  const exit = once(child, "exit");
  const cliURL = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CLI timeout: ${errors}`)), 15000);
    child.stdout.on("data", data => {
      output += data;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/#token=[a-f0-9]+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`CLI exited ${code}: ${errors}`)); });
  });
  check("standalone CLI starts", (await fetch(cliURL)).status === 200);
  child.kill("SIGTERM");
  const [code] = await exit;
  child = null;
  check("standalone CLI shuts down", code === 0);
  console.log(`\n${checks} Web Viewer checks passed.`);
} finally {
  if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
  if (forward) await forward.close();
  if (viewer) await viewer.close();
  fs.rmSync(home, { recursive: true, force: true });
}
