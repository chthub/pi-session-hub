// Optional real-browser regression, no browser automation dependency.
// Requires Chrome/Chromium on PATH, or CHROME_BIN=/path/to/browser.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createJiti } from "jiti";
import { forwardLoopback } from "./fixtures/loopback-forward.mjs";
const jiti = createJiti(import.meta.url);
const { renderMarkdown } = await jiti.import("../src/web/markdown.ts");
const { startWebViewer } = await jiti.import("../src/web/server.ts");
const { buildWebHome } = await jiti.import("./fixtures/web-home.mjs");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "session-hub-browser-"));
let viewer, forward, chrome, socket;
let checks = 0;
function check(name, value) { assert.ok(value, name); console.log(`PASS ${name}`); checks++; }
try {
  const home = path.join(temp, "home");
  await buildWebHome(home);
  const piFile = path.join(home, ".pi", "agent", "sessions", "--srv-work-acme-api--", "2026-01-01T00-00-00-000Z_11111111-2222-3333-4444-555555555555.jsonl");
  const extra = [{ type: "session_info", name: "计数模型与训练权重的诊断" }];
  const prompts = ["请解释计数损失与训练权重分别在控制什么。", "现在检查模型的稳健性，并比较不同权重设置。", "最后总结结论和下一步。<img src=x onerror=alert(1)>" ];
  for (const [index, text] of prompts.entries()) {
    extra.push({ type: "message", id: `user-${index}`, message: { role: "user", content: text } });
    if (index === 0) {
      extra.push({ type: "message", id: "ui-call", message: { role: "assistant", content: [{ type: "toolCall", id: "ui-bash", name: "bash", arguments: { command: "printf 'hello\\n'\nprintf 'world\\n'", timeout: 17, env: { API_KEY: "UI_SECRET_VALUE" } } }] } });
      extra.push({ type: "message", id: "tool-1", message: { role: "toolResult", toolName: "bash", toolCallId: "ui-bash", content: "literal $x$ tool output" } });
      extra.push({ type: "message", id: "tool-2", message: { role: "tool_result", content: "second $$y$$ output <script>window.groupExecuted = true</script>" } });
      extra.push({ type: "message", id: "tool-3", message: { role: "function", content: "third output after function call" } });
    }
    extra.push({ type: "message", id: `reply-${index}`, message: { role: "assistant", content: Array.from({ length: 10 }, (_, i) => `第 ${i + 1} 步：先核对数据与模型假设，再比较诊断结果，保持每一步的证据都可回溯。`).join("\n\n") } });
    if (index === 0) extra.push({ type: "message", id: "single-tool", message: { role: "toolResult", content: "single output separated by assistant reply" } });
  }
  fs.appendFileSync(piFile, extra.map(row => JSON.stringify(row)).join("\n") + "\n");
  const jcodeFile = path.join(home, ".jcode", "sessions", "session_fake_1.json");
  const jcode = JSON.parse(fs.readFileSync(jcodeFile, "utf8"));
  for (const message of jcode.messages) if (message.role === "user") message.role = "assistant";
  fs.writeFileSync(jcodeFile, JSON.stringify(jcode));
  viewer = await startWebViewer({ home, port: 0 });
  forward = await forwardLoopback(viewer.url);
  check("external browser tunnel remaps the local port", new URL(forward.url).port !== new URL(viewer.url).port);
  chrome = spawn(process.env.CHROME_BIN ?? "google-chrome", [
    "--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--disable-background-networking", "--no-first-run", "--no-default-browser-check",
    "--remote-debugging-port=0", `--user-data-dir=${path.join(temp, "chrome")}`, "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let log = "";
  const debuggerURL = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Chrome startup timed out: ${log}`)), 15000);
    chrome.once("error", error => { clearTimeout(timer); reject(error); });
    chrome.once("exit", code => { clearTimeout(timer); reject(new Error(`Chrome exited ${code}: ${log}`)); });
    chrome.stderr.on("data", chunk => {
      log += chunk;
      const match = log.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  const debugOrigin = new URL(debuggerURL).origin.replace("ws:", "http:");
  const targets = await (await fetch(debugOrigin + "/json/list")).json();
  const target = targets.find(item => item.type === "page");
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await once(socket, "open");
  let sequence = 0;
  const pending = new Map();
  const requests = [], exceptions = [], failures = [];
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiter?.reject(new Error(message.error.message));
      else waiter?.resolve(message.result);
    }
    if (message.method === "Network.requestWillBeSent") requests.push(message.params.request.url);
    if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails);
    if (message.method === "Network.loadingFailed") failures.push(message.params);
  });
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const wait = async expression => {
    const until = Date.now() + 15000;
    while (Date.now() < until) {
      if (await evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Browser wait timed out: ${expression}`);
  };
  await cdp("Runtime.enable");
  await cdp("Network.enable");
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp("Page.navigate", { url: forward.url });
  await wait('document.querySelectorAll(".session").length === 6');
  check("browser loads six sessions", true);
  check("connection status is inside compact header", await evaluate('document.querySelector("#notice").closest(".app-header") !== null && document.querySelector(".app-header").getBoundingClientRect().height <= 52'));
  check("workspace starts immediately below header", await evaluate('Math.abs(document.querySelector(".workspace").getBoundingClientRect().top - document.querySelector(".app-header").getBoundingClientRect().bottom) < 1'));
  check("long status remains readable via full tooltip without enlarging header", await evaluate('(() => { const original = document.querySelector("#notice").textContent; notice("部分来源读取失败：" + "很长的诊断信息".repeat(100), true); const status = document.querySelector("#notice"); const ok = status.title === status.textContent && document.querySelector(".app-header").getBoundingClientRect().height <= 52 && document.documentElement.scrollWidth <= innerWidth; notice(original); return ok; })()'));
  check("token removed from browser address", await evaluate('location.hash === ""'));
  await evaluate('Array.from(document.querySelectorAll(".session")).find(b => b.querySelector(".harness-badge").textContent === "Pi").click()');
  await wait('document.querySelectorAll(".katex-display").length > 0');
  await evaluate("document.fonts.ready.then(() => true)");
  check("browser renders inline and multiline math", await evaluate('document.querySelectorAll(".katex").length >= 2 && document.querySelector(".katex-display").getBoundingClientRect().height > 20'));
  check("opening a session does not auto-focus or outline the reading pane", await evaluate('document.activeElement !== document.querySelector("#viewer") && getComputedStyle(document.querySelector("#viewer")).outlineStyle === "none"'));
  check("code remains literal", await evaluate('document.querySelector("code.language-tex").textContent.includes("$x$ and $$y$$")'));
  check("transcript scripts and images never execute", await evaluate('!window.transcriptExecuted && document.querySelectorAll("#viewer img, #viewer script").length === 0'));
  check("secrets not displayed", await evaluate('!document.querySelector("#viewer").textContent.includes("supersecret")'));
  check("no horizontal page overflow", await evaluate('document.documentElement.scrollWidth <= innerWidth'));
  check("prose fills its message card", await evaluate('(() => { const body = document.querySelector(".message-body"); const card = body.parentElement; const css = getComputedStyle(card); return Math.abs(body.getBoundingClientRect().width - (card.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight))) < 2; })()'));
  check("all desktop agent activity is indented beneath full-width user messages", await evaluate('(() => { const user = document.querySelector(".message-user").getBoundingClientRect(); return Array.from(document.querySelectorAll(".message-assistant, .message-tool")).every(node => Math.abs(node.getBoundingClientRect().left - user.left - 32) < 1) && Array.from(document.querySelectorAll(".message-user")).every(node => Math.abs(node.getBoundingClientRect().left - user.left) < 1 && Math.abs(node.getBoundingClientRect().width - user.width) < 1); })()'));
  check("tool collapse boxes are narrower and compact", await evaluate('(() => { const user = document.querySelector(".message-user").getBoundingClientRect(); const assistant = document.querySelector(".message-assistant").getBoundingClientRect(); const tool = document.querySelector(".message-tool"); const bounds = tool.getBoundingClientRect(); return !tool.open && Math.abs(bounds.width - (user.width - 44)) < 1 && bounds.width < assistant.width && bounds.height <= 44; })()'));
  check("consecutive tool outputs form one collapsed group", await evaluate('(() => { const groups = Array.from(document.querySelectorAll(".message-tool")); return groups.length === 2 && groups.every(g => !g.open) && groups[0].querySelectorAll(".tool-output").length === 3 && groups[1].querySelectorAll(".tool-output").length === 1 && groups[0].querySelector("summary").textContent.includes("3 条") && groups[0].querySelector("summary .message-index").textContent === "#4–#7"; })()'));
  check("tool runs stop at assistant and user boundaries", await evaluate('(() => { const groups = document.querySelectorAll(".message-tool"); return groups[0].previousElementSibling.classList.contains("message-user") && groups[0].nextElementSibling.classList.contains("message-assistant") && groups[1].previousElementSibling.classList.contains("message-assistant") && groups[1].nextElementSibling.classList.contains("message-user") && !document.querySelector(".message-tool + .message-tool"); })()'));
  check("grouped outputs retain message anchors and order", await evaluate('(() => { const outputs = Array.from(document.querySelector(".message-tool").querySelectorAll(".tool-output")); const ids = Array.from(document.querySelectorAll("#viewer [id]")).map(n => n.id); return outputs.map(n => n.id).join(",") === "message-5,message-6,message-7" && outputs[0].textContent.includes("literal $x$") && outputs[1].textContent.includes("second $$y$$") && outputs[2].textContent.includes("third output") && ids.length === new Set(ids).size; })()'));
  check("collapsed tool has a disclosure indicator", await evaluate('getComputedStyle(document.querySelector(".message-tool summary"), "::before").content.includes("▸")'));
  await evaluate('document.querySelector(".message-tool").open = true');
  check("expanded tool has an open disclosure indicator", await evaluate('getComputedStyle(document.querySelector(".message-tool summary"), "::before").content.includes("▾")'));
  check("expanded tool output retains inset width and literal text", await evaluate('(() => { const tool = document.querySelector(".message-tool"); const user = document.querySelector(".message-user").getBoundingClientRect(); return Math.abs(tool.getBoundingClientRect().width - (user.width - 44)) < 1 && tool.querySelector(".tool-output pre").textContent.includes("$x$") && !tool.querySelector(".katex") && document.documentElement.scrollWidth <= innerWidth; })()'));
  check("tool group shows calls, commands and source IDs before results", await evaluate('(() => { const group = document.querySelector(".message-tool"); const entries = Array.from(group.querySelectorAll(".tool-entry")); return group.querySelector("summary").textContent.includes("1 次调用 · 3 条输出") && entries[0].classList.contains("tool-call") && entries[0].textContent.includes("调用 · bash") && entries[0].textContent.includes("命令（command）") && entries[0].textContent.includes("timeout") && entries[0].textContent.includes("ui-bash") && entries[1].classList.contains("tool-output") && entries[1].textContent.includes("ui-bash"); })()'));
  check("tool call arguments are escaped and redact JSON secrets", await evaluate('!document.querySelector("#viewer").textContent.includes("UI_SECRET_VALUE") && !document.querySelector(".tool-call .katex")'));
  check("output-only groups remain labelled as tool output", await evaluate('document.querySelectorAll(".message-tool")[1].querySelector(".role-label").textContent === "工具输出"'));
  check("grouped tool text cannot execute HTML", await evaluate('!window.groupExecuted && !document.querySelector(".tool-output script")'));
  await evaluate('document.querySelector(".message-tool").scrollIntoView({ block: "start" }); Array.from(document.querySelectorAll("#viewer button")).find(b => b.textContent === "查看原文").click()');
  check("raw view preserves expanded tool groups and all outputs", await evaluate('document.querySelector(".message-tool").open && document.querySelector(".message-tool").querySelectorAll(".tool-output .raw").length === 3 && document.querySelector(".tool-call .raw").textContent.includes("调用参数") && document.querySelectorAll(".message-tool[open]").length === 1 && document.querySelector(".message-tool").textContent.includes("second $$y$$")'));
  await evaluate('Array.from(document.querySelectorAll("#viewer button")).find(b => b.textContent === "查看渲染正文").click()');
  check("rendered view keeps the same grouped tool run open", await evaluate('document.querySelector(".message-tool").open && document.querySelectorAll(".tool-output").length === 4'));
  await evaluate('document.querySelector(".message-tool").open = false; document.querySelector("#viewer").scrollTop = 0');
  await wait('document.querySelector(".outline-item").getAttribute("aria-current") === "location"');
  check("reported Chinese formula renders in browser", await evaluate('document.querySelector(".katex-display").parentElement.textContent.includes("计数") && !document.querySelector(".math-error")'));
  check("outline only lists user messages", await evaluate('document.querySelectorAll(".outline-item").length === 4 && Array.from(document.querySelectorAll(".outline-item")).every(b => document.getElementById(b.dataset.target).classList.contains("message-user"))'));
  check("selected session is visible in list", await evaluate('(() => { const r = document.querySelector(".session[aria-current=true]").getBoundingClientRect(); const pane = document.querySelector(".session-scroll").getBoundingClientRect(); return r.top >= pane.top && r.bottom <= pane.bottom; })()'));
  check("outline previews never interpret HTML", await evaluate('document.querySelectorAll("#outline img, #outline script").length === 0'));
  const outlineTop = await evaluate('document.querySelector("#outline").getBoundingClientRect().top');
  await evaluate('document.querySelectorAll(".outline-item")[2].click()');
  await wait('document.querySelectorAll(".outline-item")[2].getAttribute("aria-current") === "location"');
  check("outline click scrolls and focuses the user message", await evaluate('(() => { const button = document.querySelectorAll(".outline-item")[2]; const target = document.getElementById(button.dataset.target); const bounds = document.querySelector("#viewer").getBoundingClientRect(); return document.activeElement === target && target.getBoundingClientRect().top >= bounds.top && target.getBoundingClientRect().top < bounds.top + 130; })()'));
  check("outline stays visible while transcript scrolls", await evaluate(`document.querySelector("#outline").getBoundingClientRect().top === ${outlineTop}`));
  check("reading toolbar stays in view", await evaluate('(() => { const bar = document.querySelector(".transcript-toolbar").getBoundingClientRect(); const pane = document.querySelector("#viewer").getBoundingClientRect(); return bar.top >= pane.top - 1 && bar.bottom <= pane.bottom; })()'));
  await evaluate('document.querySelector("#previous-user").click()');
  await wait('document.querySelectorAll(".outline-item")[1].getAttribute("aria-current") === "location"');
  check("previous user navigation works", true);
  await evaluate('document.querySelector("#next-user").click()');
  await wait('document.querySelectorAll(".outline-item")[2].getAttribute("aria-current") === "location"');
  check("next user navigation works", true);
  await evaluate('document.querySelector("#viewer").scrollTop = 0');
  await wait('document.querySelector(".outline-item").getAttribute("aria-current") === "location"');
  check("scroll tracking updates current outline entry", true);
  await evaluate('Array.from(document.querySelectorAll("#viewer button")).find(b => b.textContent === "跳到末尾").click()');
  await wait('document.querySelectorAll(".outline-item")[3].getAttribute("aria-current") === "location"');
  check("jump to end locates the last user question", await evaluate('document.querySelector("#next-user").disabled'));
  await evaluate('Array.from(document.querySelectorAll("#viewer button")).find(b => b.textContent === "回到开头").click()');
  await wait('document.querySelector(".outline-item").getAttribute("aria-current") === "location"');
  await evaluate('document.querySelector("#outline-filter").value = "稳健性"; document.querySelector("#outline-filter").dispatchEvent(new Event("input"))');
  check("outline search matches full user text", await evaluate('document.querySelectorAll(".outline-item").length === 1 && document.querySelector(".outline-text").textContent.includes("稳健性")'));
  await evaluate('document.querySelector("#outline-filter").value = "no-match"; document.querySelector("#outline-filter").dispatchEvent(new Event("input"))');
  check("outline search has empty state", await evaluate('!document.querySelector(".outline-item") && document.querySelector(".outline-empty").textContent.includes("没有匹配")'));
  await evaluate('document.querySelector("#outline-filter").value = ""; document.querySelector("#outline-filter").dispatchEvent(new Event("input"))');
  if (process.env.WEB_SCREENSHOT_AGENT) {
    await evaluate('document.querySelectorAll(".outline-item")[1].click()');
    await wait('document.querySelectorAll(".outline-item")[1].getAttribute("aria-current") === "location"');
    const shot = await cdp("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(process.env.WEB_SCREENSHOT_AGENT, Buffer.from(shot.data, "base64"));
    await evaluate('document.querySelector("#viewer").scrollTop = 0');
    await wait('document.querySelector(".outline-item").getAttribute("aria-current") === "location"');
  }
  if (process.env.WEB_SCREENSHOT) {
    const shot = await cdp("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(process.env.WEB_SCREENSHOT, Buffer.from(shot.data, "base64"));
    console.log(`Screenshot: ${process.env.WEB_SCREENSHOT}`);
  }
  await evaluate('document.querySelectorAll(".outline-item")[2].click()');
  await evaluate('Array.from(document.querySelectorAll("#viewer button")).find(b => b.textContent === "查看原文").click()');
  check("raw toggle works", await evaluate('document.querySelector(".raw").textContent.includes("$$") && !document.querySelector(".katex")'));
  check("raw agent messages remain indented", await evaluate('document.querySelector(".message-assistant").getBoundingClientRect().left - document.querySelector(".message-user").getBoundingClientRect().left === 32'));
  await wait('document.querySelectorAll(".outline-item")[2].getAttribute("aria-current") === "location"');
  check("raw toggle preserves reading position and outline", await evaluate('document.querySelectorAll(".outline-item").length === 4'));
  await evaluate('Array.from(document.querySelectorAll("#viewer button")).find(b => b.textContent === "查看渲染正文").click()');
  await evaluate('document.querySelector("#search").value = "billing"; document.querySelector("#search").dispatchEvent(new Event("input"))');
  await wait('document.querySelectorAll(".session").length === 1');
  check("browser search works", true);
  await evaluate('document.querySelector("#search").value = ""; document.querySelector("#search").dispatchEvent(new Event("input"))');
  await wait('document.querySelectorAll(".session").length === 6');
  await evaluate('Array.from(document.querySelectorAll(".session")).find(b => b.querySelector(".harness-badge").textContent === "Claude Code").click()');
  await wait('document.querySelectorAll(".outline-item").length === 1');
  check("switching sessions replaces the outline", await evaluate('document.querySelector("#outline-count").textContent === "1" && document.querySelector("#previous-user").disabled && document.querySelector("#next-user").disabled'));
  await evaluate('Array.from(document.querySelectorAll(".session")).find(b => b.querySelector(".harness-badge").textContent === "JCode").click()');
  await wait('document.querySelector("#outline-count").textContent === "0" && document.querySelector(".outline-empty")');
  check("session with no user messages has a clear empty outline", await evaluate('document.querySelector("#outline-filter").disabled && !document.querySelector(".outline-item")'));
  await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await evaluate('document.querySelector("#sidebar-toggle").click()');
  check("mobile session drawer opens", await evaluate('getComputedStyle(document.querySelector("#session-sidebar")).display === "grid" && document.querySelector("#sidebar-toggle").getAttribute("aria-expanded") === "true"'));
  await evaluate('Array.from(document.querySelectorAll(".session")).find(b => b.querySelector(".harness-badge").textContent === "Pi").click()');
  await wait('document.querySelectorAll(".outline-item").length === 4');
  check("mobile session drawer closes after selection", await evaluate('getComputedStyle(document.querySelector("#session-sidebar")).display === "none"'));
  check("mobile has no horizontal page overflow", await evaluate('document.documentElement.scrollWidth <= innerWidth'));
  check("mobile preserves grouped tool output", await evaluate('document.querySelectorAll(".message-tool").length === 2 && document.querySelector(".message-tool").querySelectorAll(".tool-output").length === 3 && !document.querySelector(".message-tool").open'));
  check("mobile agent indent stays compact", await evaluate('(() => { const user = document.querySelector(".message-user").getBoundingClientRect(); return Array.from(document.querySelectorAll(".message-assistant, .message-tool")).every(node => Math.abs(node.getBoundingClientRect().left - user.left - 16) < 1) && Math.abs(document.querySelector(".message-tool").getBoundingClientRect().width - (user.width - 24)) < 1; })()'));
  check("mobile status stays in compact header", await evaluate('(() => { const header = document.querySelector(".app-header").getBoundingClientRect(); const status = document.querySelector("#notice").getBoundingClientRect(); return header.height <= 64 && status.top >= header.top && status.bottom <= header.bottom; })()'));
  check("mobile outline is always visible", await evaluate('(() => { const r = document.querySelector("#outline").getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight + 1 && r.height > 100; })()'));
  await evaluate('document.querySelectorAll(".outline-item")[2].click()');
  await wait('document.querySelectorAll(".outline-item")[2].getAttribute("aria-current") === "location"');
  check("mobile directory jump stays within reading pane", await evaluate('(() => { const target = document.getElementById(document.querySelectorAll(".outline-item")[2].dataset.target); const r = target.getBoundingClientRect(); const pane = document.querySelector("#viewer").getBoundingClientRect(); return r.top >= pane.top && r.top < pane.bottom && document.documentElement.scrollTop === 0; })()'));
  if (process.env.WEB_SCREENSHOT_MOBILE) {
    const shot = await cdp("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(process.env.WEB_SCREENSHOT_MOBILE, Buffer.from(shot.data, "base64"));
  }
  await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  check("dark theme has explicit background", await evaluate('getComputedStyle(document.body).backgroundColor === "rgb(20, 24, 32)"'));
  await evaluate('document.querySelector("#theme-toggle").click()');
  check("theme control switches back to light", await evaluate('document.documentElement.dataset.theme === "light" && getComputedStyle(document.body).backgroundColor === "rgb(244, 247, 249)"'));
  // Exercise the shared toolbar with the same action metadata as VS Code.
  await evaluate('transport.sessionActions = [{ label: "在终端中继续", icon: "▶", className: "primary-button resume-button", run: () => { window.resumeTestClicks = (window.resumeTestClicks || 0) + 1; } }]; renderDetail()');
  check("resume button has green background and decorative play icon in light mode", await evaluate('(() => { const button = document.querySelector(".resume-button"); const css = getComputedStyle(button); return button.classList.contains("primary-button") && css.backgroundColor === "rgb(40, 123, 118)" && css.color === "rgb(255, 255, 255)" && button.querySelector(".button-icon").textContent === "▶" && button.querySelector(".button-icon").getAttribute("aria-hidden") === "true" && button.textContent.includes("在终端中继续"); })()'));
  await evaluate('document.querySelector(".resume-button").click()');
  check("styled resume action remains functional", await evaluate('window.resumeTestClicks === 1'));
  await evaluate('document.documentElement.dataset.theme = "dark"');
  await wait('getComputedStyle(document.querySelector(".resume-button")).backgroundColor === "rgb(128, 212, 199)"');
  check("resume button keeps contrasting green background in dark mode", await evaluate('(() => { const css = getComputedStyle(document.querySelector(".resume-button")); return css.backgroundColor === "rgb(128, 212, 199)" && css.color === "rgb(20, 41, 37)"; })()'));
  await evaluate('document.documentElement.dataset.theme = "light"');
  // The same shared body renderer used in VS Code must intercept local links,
  // keep normal URLs untouched, and preserve raw mode and error feedback.
  const localMessage = { role: "assistant", text: "[阅读页](docs/reading.html) [网站](https://example.com)" };
  localMessage.html = renderMarkdown(localMessage.text, { localLink: () => "a".repeat(32) });
  check("browser intercepts local links with bound UID + opaque ID, leaving normal URLs intact",
    await evaluate(`(async () => {
      const calls = [];
      transport.openLink = async (uid, id) => { calls.push({ uid, id }); };
      const body = renderMessageBody(${JSON.stringify(localMessage)});
      const link = body.querySelector("[data-session-link]");
      const followed = link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await Promise.resolve();
      return !followed && calls.length === 1 && calls[0].uid === selected &&
        calls[0].id === "a".repeat(32) && body.querySelector('a[href="https://example.com"]').target === "_blank";
    })()`));
  check("raw transcript mode keeps local links literal", await evaluate(`(() => {
    raw = true; const body = renderMessageBody(${JSON.stringify(localMessage)}); raw = false;
    return body.tagName === "PRE" && !body.querySelector("a") && body.textContent.includes("docs/reading.html");
  })()`));
  check("local link failures give visible feedback without navigating", await evaluate(`(async () => {
    transport.openLink = async () => { throw new Error("文件已不存在"); };
    const body = renderMessageBody(${JSON.stringify(localMessage)});
    body.querySelector("[data-session-link]").click();
    await Promise.resolve(); await Promise.resolve();
    return document.querySelector("#notice").textContent.includes("打开链接失败：文件已不存在");
  })()`));
  check("viewer makes no remote requests", requests.every(url => url.startsWith(new URL(forward.url).origin)));
  check("no browser JS exceptions", exceptions.length === 0);
  check("no failed resource requests", failures.length === 0);
  console.log(`\n${checks} real-browser checks passed.`);
} finally {
  socket?.close();
  if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
    const exited = once(chrome, "exit"); chrome.kill("SIGTERM"); await exited;
  }
  if (forward) await forward.close();
  if (viewer) await viewer.close();
  fs.rmSync(temp, { recursive: true, force: true });
}
