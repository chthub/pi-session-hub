import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Module, createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { createJiti } from "jiti";
import { buildToolHome } from "./fixtures/tool-home.mjs";
const root = fileURLToPath(new URL("../vscode-extension/", import.meta.url));
const jiti = createJiti(import.meta.url);
const { parseViewerRequest } = await jiti.import("../vscode-extension/src/protocol.ts");
const { sessionTabTitle } = await jiti.import("../vscode-extension/src/sessionTitle.ts");
assert.equal(sessionTabTitle("short", "id"), "Session: short");
assert.equal(sessionTabTitle("a".repeat(20), "id"), "Session: " + "a".repeat(20));
assert.equal(sessionTabTitle("中".repeat(21), "id"), "Session: " + "中".repeat(19) + "…");
assert.equal(sessionTabTitle("👩‍💻".repeat(21), "id"), "Session: " + "👩‍💻".repeat(19) + "…");
assert.equal(sessionTabTitle("line\n  break", "id"), "Session: line break");
assert.equal(sessionTabTitle(null, "native-id"), "Session: native-id");
assert.ok(!sessionTabTitle("password=supersecret", "id").includes("supersecret"));
console.log("PASS tab labels truncate long titles without splitting Unicode or exposing secrets");
let checks = 0;
function check(name, value) { assert.ok(value, name); console.log(`PASS ${name}`); checks++; }
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
check("manifest prefers the remote workspace host", manifest.extensionKind.join() === "workspace");
check("manifest contributes Activity Bar, tree and commands", manifest.contributes.viewsContainers.activitybar[0].id === "sessionHub" && manifest.contributes.views.sessionHub[0].id === "sessionHub.sessions" && manifest.contributes.commands.length === 4);
check("untrusted/virtual workspaces cannot launch runtimes", manifest.capabilities.untrustedWorkspaces.supported === false && manifest.capabilities.virtualWorkspaces === false);
check("compiled entry and shared media are packaged locally", fs.existsSync(path.join(root, manifest.main)) && ["index.html", "style.css", "app.js", "transport.js", "katex/katex.min.css"].every(file => fs.existsSync(path.join(root, "dist/media", file))));
for (const request of [
  { type: "sessionHub.request", id: 1, operation: "getSession", path: "/etc/passwd" },
  { type: "sessionHub.request", id: 1, operation: "getSession", uid: "pi:elsewhere" },
  { type: "sessionHub.request", id: 1, operation: "resume", uid: "pi:allowed", args: ["evil"] },
  { type: "sessionHub.request", id: 1, operation: "delete", uid: "pi:allowed" },
  { type: "sessionHub.request", id: 1, operation: "status", uid: "pi:allowed" },
  { type: "sessionHub.request", id: "1", operation: "status" },
]) assert.throws(() => parseViewerRequest(request, "pi:allowed"));
check("typed protocol rejects paths, argv, destructive actions and other UIDs", true);

// Exercise the actual compiled extension, with only the VS Code API mocked.
// Its core/adapters/SQLite/Markdown are real and operate on an isolated home.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "hub-vscode-"));
const home = path.join(temp, "home");
const project = path.join(temp, "project with spaces;not-a-command");
await buildToolHome(home);
fs.mkdirSync(project);
function files(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)]); }
for (const file of files(home).filter(file => /\.jsonl?$/.test(file))) {
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replaceAll("/srv/work/acme-api", project));
}
const longPrompt = "用户提出的长问题与任务背景".repeat(8);
const piSource = files(path.join(home, ".pi", "agent", "sessions")).find(file => file.endsWith(".jsonl"));
const profiles = [
  { id: "default", label: "Pi", agentDir: path.join(home, ".pi", "agent") },
  { id: "research", label: "Pi Research", agentDir: path.join(home, "profiles", "research with spaces") },
  { id: "team", label: "Pi Team", agentDir: path.join(home, ".pi", "agent-team") },
];
const configDir = path.join(home, ".pi", "agent", "pi-session-hub");
fs.mkdirSync(configDir, { recursive: true });
fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ piEnvironments: profiles }));
for (const profile of profiles) fs.mkdirSync(profile.agentDir, { recursive: true });
const systemContext = profile => ({ type: "message", message: { role: "system", content: "", sections: {
  project_context: `<project_context><project_instructions path="${path.join(profile.agentDir, "AGENTS.md")}">rules</project_instructions></project_context>`,
} } });
fs.appendFileSync(piSource, [systemContext(profiles[1]), { type: "session_info", name: longPrompt }].map(row => JSON.stringify(row)).join("\n") + "\n");
const extraSource = (id, contexts = []) => {
  const file = path.join(path.dirname(piSource), `${id}.jsonl`);
  fs.writeFileSync(file, [{ type: "session", id, cwd: project }, ...contexts, { type: "message", message: { role: "user", content: id } }].map(row => JSON.stringify(row)).join("\n") + "\n");
  return file;
};
const unknownSource = extraSource("unknown-env");
extraSource("conflicting-env", [systemContext(profiles[1]), systemContext(profiles[2])]);
const before = new Map(files(home).map(file => [file, fs.readFileSync(file)]));
class Disposable { constructor(fn = () => {}) { this.fn = fn; } dispose() { this.fn(); } }
class EventEmitter {
  callbacks = [];
  event = callback => { this.callbacks.push(callback); return new Disposable(() => { this.callbacks = this.callbacks.filter(fn => fn !== callback); }); };
  fire(value) { this.callbacks.forEach(callback => callback(value)); }
  dispose() { this.callbacks = []; }
}
class Uri {
  constructor(fsPath) { this.fsPath = fsPath; this.scheme = "file"; }
  static joinPath(uri, ...parts) { return new Uri(path.join(uri.fsPath, ...parts)); }
  toString() { return `file://${this.fsPath}`; }
}
class TreeItem { constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; } }
const commands = new Map(), panels = [], terminals = [], errors = [], settingUpdates = [], environmentPicks = [], confirmations = [];
let clipboard, tree, view, workspaceChanged, confirmation = "在终端中继续", pickedProfile = "default", extension;
const vscode = {
  Disposable, EventEmitter, Uri, TreeItem, ThemeIcon: class { constructor(id) { this.id = id; } },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 }, ViewColumn: { Active: -1 },
  workspace: { workspaceFolders: [{ uri: new Uri(project) }], onDidChangeWorkspaceFolders(callback) { workspaceChanged = callback; return new Disposable(); },
    getConfiguration(section) { assert.equal(section, "workbench.editor"); return { async update(key, value, target) { settingUpdates.push({ key, value, target }); } }; } },
  commands: { registerCommand(name, callback) { commands.set(name, callback); return new Disposable(() => commands.delete(name)); } },
  env: { clipboard: { async writeText(value) { clipboard = value; } } },
  window: {
    createTreeView(_id, options) { tree = options.treeDataProvider; view = new Disposable(); return view; },
    async withProgress(_options, callback) { return callback(); },
    async showWarningMessage(message) { confirmations.push(message); return confirmation; },
    async showQuickPick(items, options) { environmentPicks.push({ items, options }); return items.find(item => item.profile.id === pickedProfile); },
    async showErrorMessage(message) { errors.push(message); },
    createTerminal(options) { const terminal = { options, show() { this.shown = true; } }; terminals.push(terminal); return terminal; },
    createWebviewPanel(_type, title, _column, options) {
      const callbacks = [], disposeCallbacks = [];
      const panel = { title, options, reveals: 0, reveal() { this.reveals++; },
        webview: { cspSource: "https://local-resource.vscode-cdn.net", responses: [],
          asWebviewUri(uri) { return { toString: () => `https://local-resource.vscode-cdn.net${encodeURI(uri.fsPath)}` }; },
          onDidReceiveMessage(callback) { callbacks.push(callback); return new Disposable(); },
          async postMessage(response) { this.responses.push(response); return true; },
          async send(message) { await Promise.all(callbacks.map(callback => callback(message))); return this.responses.at(-1); },
        },
        onDidDispose(callback) { disposeCallbacks.push(callback); return new Disposable(); },
        dispose() { if (!this.disposed) { this.disposed = true; disposeCallbacks.forEach(callback => callback()); } },
      };
      panels.push(panel); return panel;
    },
  },
};
const context = { extensionUri: new Uri(root), subscriptions: [] };
try {
  const entry = path.join(root, manifest.main);
  const nativeRequire = createRequire(entry);
  const module = new Module(entry);
  module.filename = entry;
  module.paths = Module._nodeModulePaths(path.dirname(entry));
  module.require = name => {
    if (name === "vscode") return vscode;
    if (name === "node:os") return { ...os, homedir: () => home };
    if (name === "node:http" || name === "node:child_process") throw new Error("VS Code host must not import HTTP server or detached launcher");
    return nativeRequire(name);
  };
  module._compile(fs.readFileSync(entry, "utf8"), entry);
  extension = module.exports;
  await extension.activate(context);
  check("compiled activation uses core without HTTP server or detached launcher", errors.length === 0 && tree && commands.size === 4);
  const groups = tree.getChildren();
  const current = groups.find(group => group.scope === "current");
  const currentItems = tree.getChildren(current);
  check("tree scopes current project and labels sessions with harness + recency", currentItems.length >= 4 && currentItems.every(item => item.description.includes(" · ")));
  check("unscoped sessions remain visible", tree.getChildren(groups.find(group => group.scope === "unscoped")).some(item => item.session.harness === "crush"));
  const pi = currentItems.find(item => item.session.harness === "pi" && item.session.nativeId === "11111111-2222-3333-4444-555555555555");
  const claude = currentItems.find(item => item.session.harness === "claude-code");
  await commands.get("sessionHub.open")(pi);
  const panel = panels[0];
  await commands.get("sessionHub.open")(pi.session.uid);
  check("open creates/reuses an editor WebviewPanel", panels.length === 1 && panel.reveals === 1);
  check("only the Session tab title is truncated; tree retains full prompt", panel.title === sessionTabTitle(longPrompt, pi.session.nativeId) && panel.title.endsWith("…") && pi.label === longPrompt);
  check("webview resources are restricted to packaged media", panel.options.localResourceRoots.length === 1 && panel.options.localResourceRoots[0].fsPath === path.join(root, "dist/media"));
  check("webview HTML has strict CSP, two-column mode and no localhost endpoint", panel.webview.html.includes("connect-src &#39;none&#39;") && panel.webview.html.includes('data-host="vscode"') && panel.webview.html.includes('nonce="') && !panel.webview.html.includes("http://127.0.0.1") && !panel.webview.html.includes('src="/app.js"'));
  const request = async (operation, extras = {}) => panel.webview.send({ type: "sessionHub.request", id: panel.webview.responses.length + 1, operation, ...extras });
  const response = await request("getSession", { uid: pi.session.uid });
  const detail = response.result;
  check("transcript metadata keeps the full title after tab truncation", detail.title === longPrompt);
  check("postMessage detail keeps Markdown/math/tool activity and redaction", !response.error && detail.messages.some(m => m.html.includes('class="katex"')) && detail.messages.some(m => m.role === "toolCall") && !JSON.stringify(detail).includes("TOOL_SECRET_VALUE"));
  check("webview cannot supply a filesystem path", Boolean((await request("getSession", { uid: pi.session.uid, path: "/etc/passwd" })).error));
  check("webview cannot read a different session", Boolean((await request("getSession", { uid: claude.session.uid })).error));
  await request("copyId", { uid: pi.session.uid });
  check("viewer copies its indexed session ID", clipboard === pi.session.uid);
  await request("resume", { uid: pi.session.uid });
  check("detected Pi environment is passed explicitly without an account picker", environmentPicks.length === 0 && terminals[0].options.env.PI_CODING_AGENT_DIR === profiles[1].agentDir && terminals[0].options.name.includes("Pi Research") && confirmations[0].includes("Pi Research"));
  check("Pi resume uses native terminal with exact argv and source-backed cwd", terminals[0].shown && terminals[0].options.shellPath === "pi" && terminals[0].options.shellArgs[0] === "--session" && terminals[0].options.shellArgs[1] === pi.session.path && terminals[0].options.cwd === project);
  await commands.get("sessionHub.resume")(claude);
  check("non-Pi resumes do not override account environment", terminals[1].options.env === undefined);
  check("Claude resume uses its native CLI and source-backed cwd", terminals[1].shown && terminals[1].options.shellPath === "claude" && terminals[1].options.shellArgs.join() === ["--resume", claude.session.nativeId].join() && terminals[1].options.cwd === project);
  confirmation = undefined;
  await request("resume", { uid: pi.session.uid });
  check("resume cancellation creates no terminal", terminals.length === 2);
  await request("refresh");
  check("viewer refresh goes through shared service and reloads tree", !panel.webview.responses.at(-1).error);
  vscode.workspace.workspaceFolders = [{ uri: new Uri(path.join(temp, "different")) }];
  workspaceChanged();
  check("workspace changes re-scope without hiding other project history", tree.getChildren(current).length === 0 && tree.getChildren(groups.find(group => group.scope === "other")).length >= 4);
  check("foreign harness stores remain byte-for-byte unchanged", [...before].every(([file, content]) => fs.readFileSync(file).equals(content)));
  confirmation = "在终端中继续";
  pickedProfile = undefined;
  const terminalCount = terminals.length;
  await commands.get("sessionHub.resume")("pi:unknown-env");
  check("unknown environment asks for configuration identity; picker cancellation launches nothing", environmentPicks.length === 1 && terminals.length === terminalCount && environmentPicks[0].items.some(item => item.label === "Pi Team"));
  pickedProfile = "team";
  await commands.get("sessionHub.resume")("pi:unknown-env");
  check("manual profile choice uses configured dir, not a shell alias or inherited default", terminals.at(-1).options.env.PI_CODING_AGENT_DIR === profiles[2].agentDir && terminals.at(-1).options.shellPath === "pi" && terminals.at(-1).options.shellArgs[1] === unknownSource);
  pickedProfile = "default";
  await commands.get("sessionHub.resume")("pi:conflicting-env");
  check("conflicting Context cannot silently choose one account", environmentPicks.at(-1).options.placeHolder.includes("多个 Pi 环境") && terminals.at(-1).options.env.PI_CODING_AGENT_DIR === profiles[0].agentDir);
  const missingDirectory = fs.readFileSync(piSource);
  fs.rmdirSync(profiles[1].agentDir);
  const countBeforeMissing = terminals.length;
  const picksBeforeMissing = environmentPicks.length;
  await commands.get("sessionHub.resume")(pi.session.uid);
  check("missing detected config directory errors instead of switching to default", terminals.length === countBeforeMissing && environmentPicks.length === picksBeforeMissing && errors.at(-1).includes("源 Pi 配置目录不可用"));
  check("environment detection/picking never rewrites a source transcript", fs.readFileSync(piSource).equals(missingDirectory));
  panel.dispose();
  await commands.get("sessionHub.open")(pi.session.uid);
  check("closed panels can be reopened", panels.length === 2);
  check("activation and session opens never change editor tab preferences", settingUpdates.length === 0);

} finally {
  for (const disposable of context.subscriptions.reverse()) disposable.dispose();
  extension?.deactivate(); extension?.deactivate();
  fs.rmSync(temp, { recursive: true, force: true });
}

// Client transport itself, isolated from browser fetch/sessionStorage.
const sent = [], listeners = {}, timers = new Map();
let timerId = 0;
const sandbox = { window: { addEventListener: (name, callback) => { listeners[name] = callback; } },
  document: { body: { dataset: { host: "vscode", sessionUid: "pi:bound" } } },
  acquireVsCodeApi: () => ({ postMessage: message => sent.push(message) }),
  setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
  clearTimeout: id => timers.delete(id),
  fetch: () => { throw new Error("HTTP is forbidden in Webview mode"); },
};
vm.runInNewContext(fs.readFileSync(path.join(root, "dist/media/transport.js"), "utf8"), sandbox);
const transport = sandbox.window.sessionHubTransport;
check("resume action declares a primary green button and decorative play icon", transport.sessionActions[0].className === "primary-button resume-button" && transport.sessionActions[0].icon === "▶" && transport.sessionActions[0].label === "在终端中继续");
const pending = transport.getSession("pi:bound");
check("VscodeTransport uses UID-based postMessage, not fetch", sent[0].operation === "getSession" && sent[0].uid === "pi:bound" && !transport.hasSessionList);
listeners.message({ data: { type: "sessionHub.response", id: sent[0].id, result: { uid: "pi:bound" } } });
check("transport matches replies and clears request timers", (await pending).uid === "pi:bound" && timers.size === 0);
const error = transport.status();
listeners.message({ data: { type: "sessionHub.response", id: sent[1].id, error: "denied" } });
await assert.rejects(() => error, /denied/);
const timeout = transport.refresh();
[...timers.values()][0]();
await assert.rejects(() => timeout, /超时/);
const closing = transport.status(); listeners.pagehide();
await assert.rejects(() => closing, /关闭/);
check("transport errors, timeouts and disposal reject pending requests", true);
console.log(`${checks} VS Code manifest/compiled-host/protocol/transport checks passed.`);
