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
const { SessionLinks } = await jiti.import("../vscode-extension/src/sessionLinks.ts");
const { renderMarkdown } = await jiti.import("../src/web/markdown.ts");
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
check("manifest contributes Activity Bar, two-line webview sidebar and commands", manifest.contributes.viewsContainers.activitybar[0].id === "sessionHub" && manifest.contributes.views.sessionHub[0].id === "sessionHub.sessions" && manifest.contributes.views.sessionHub[0].type === "webview" && manifest.contributes.commands.length === 8);
const starColor = manifest.contributes.colors.find(color => color.id === "sessionHub.starredForeground");
check("star color supplies dark/light/high-contrast defaults without changing user settings",
  ["dark", "light", "highContrast", "highContrastLight"].every(theme => /^#[a-f0-9]{6}$/i.test(starColor.defaults[theme])));
check("untrusted/virtual workspaces cannot launch runtimes", manifest.capabilities.untrustedWorkspaces.supported === false && manifest.capabilities.virtualWorkspaces === false);
check("compiled entry and shared media are packaged locally", fs.existsSync(path.join(root, manifest.main)) && ["index.html", "style.css", "app.js", "transport.js", "katex/katex.min.css"].every(file => fs.existsSync(path.join(root, "dist/media", file))));
for (const request of [
  { type: "sessionHub.request", id: 1, operation: "getSession", path: "/etc/passwd" },
  { type: "sessionHub.request", id: 1, operation: "getSession", uid: "pi:elsewhere" },
  { type: "sessionHub.request", id: 1, operation: "resume", uid: "pi:allowed", args: ["evil"] },
  { type: "sessionHub.request", id: 1, operation: "delete", uid: "pi:allowed" },
  { type: "sessionHub.request", id: 1, operation: "status", uid: "pi:allowed" },
  { type: "sessionHub.request", id: "1", operation: "status" },
  { type: "sessionHub.request", id: 1, operation: "openLink", uid: "pi:allowed", linkId: "/etc/passwd" },
  { type: "sessionHub.request", id: 1, operation: "openLink", uid: "pi:elsewhere", linkId: "a".repeat(32) },
  { type: "sessionHub.request", id: 1, operation: "status", linkId: "a".repeat(32) },
  { type: "sessionHub.request", id: 1, operation: "exportPdf", uid: "pi:elsewhere" },
  { type: "sessionHub.request", id: 1, operation: "exportPdf", uid: "pi:allowed", path: "/etc/passwd" },
  { type: "sessionHub.request", id: 1, operation: "exportPdf", uid: "pi:allowed", html: "<script>bad()</script>" },
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
// Synthetic report path and prose: never embed real project/session content.
const readingHref = "docs/reports/example/reading.html";
const readingFile = path.join(project, readingHref);
fs.mkdirSync(path.dirname(readingFile), { recursive: true });
fs.writeFileSync(readingFile, "<html><body>阅读页</body></html>");
const linkedText = "以下为虚构的诊断示例。\n\n[阅读页：诊断结果与解释说明](" + readingHref + ")\n\n[网站](https://example.com/report)";
fs.appendFileSync(piSource, [
  { type: "message", message: { role: "assistant", content: linkedText } },
  { type: "message", message: { role: "user", content: "scopeuserneedle 检索用户提问" } },
  { type: "message", message: { role: "assistant", content: [
    { type: "text", text: "scopeassistantneedle 检索助手回复" },
    { type: "toolCall", id: "scope-call", name: "bash", arguments: { command: "echo scopetoolneedle" } },
  ] } },
  { type: "message", message: { role: "toolResult", toolCallId: "scope-call", toolName: "bash", content: [{ type: "text", text: "scopeoutputneedle" }] } },
].map(row => JSON.stringify(row)).join("\n") + "\n");
const localLinks = new SessionLinks(project);
check("session-relative links and fragments resolve from source cwd, including spaces",
  localLinks.resolve(localLinks.register(readingHref + "#结果")).path === fs.realpathSync(readingFile) &&
  localLinks.resolve(localLinks.register(readingHref + "#结果")).fragment === "结果");
for (const href of ["../outside.html", "%2e%2e/outside.html", "/etc/passwd", "//evil.example/page",
  "command:workbench.action.terminal.new", "file:///etc/passwd", "https://example.com", ".env", "auth.json", "docs/%00bad", "docs/%2fbad"]) {
  assert.equal(localLinks.register(href), undefined, href);
}
check("local link registry rejects traversal, arbitrary schemes and credential paths", true);
check("cwd is required; workspace and history directory are never guessed",
  new SessionLinks(null).register(readingHref) === undefined && new SessionLinks("relative").register(readingHref) === undefined);
const outsideFile = path.join(temp, "outside.html");
fs.writeFileSync(outsideFile, "outside");
const symlink = path.join(project, "linked.html");
fs.symlinkSync(readingFile, symlink);
const symlinkId = localLinks.register("linked.html");
assert.equal(localLinks.resolve(symlinkId).path, fs.realpathSync(readingFile));
fs.unlinkSync(symlink); fs.symlinkSync(outsideFile, symlink);
assert.throws(() => localLinks.resolve(symlinkId), /outside the session project/);
const credential = path.join(project, "auth.json");
fs.writeFileSync(credential, "{}");
fs.unlinkSync(symlink); fs.symlinkSync(credential, symlink);
assert.throws(() => localLinks.resolve(symlinkId), /protected file/);
assert.throws(() => localLinks.resolve("a".repeat(32)), /does not belong/);
assert.throws(() => localLinks.resolve(localLinks.register("missing.html")), /no longer exists/);
check("click revalidates missing files, forged IDs and changed/credential symlinks", true);
const renderOptions = { localLink: href => localLinks.register(href) };
check("host opt-in preserves local link label and issues an opaque ID",
  renderMarkdown(linkedText, renderOptions).includes("data-session-link=") && renderMarkdown(linkedText, renderOptions).includes("阅读页：诊断结果"));
check("per-render host options never leak local links to HTTP rendering",
  !renderMarkdown(linkedText).includes("data-session-link=") && !renderMarkdown(linkedText).includes('href="docs/'));
check("command and network-path links remain disabled even when host opts in",
  !renderMarkdown("[x](command:evil) [y](//evil.example)", renderOptions).includes("data-session-link="));
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
  constructor(fsPath) { this.fsPath = fsPath; this.path = fsPath; this.scheme = "file"; this.authority = ""; }
  static from(parts) { return Object.assign(new Uri(parts.path), parts); }
  static joinPath(uri, ...parts) { return new Uri(path.join(uri.fsPath, ...parts)); }
  static file(fsPath) { return new Uri(fsPath); }
  with(changes) { return Object.assign(new Uri(this.fsPath), changes); }
  toString() { return `${this.scheme}://${this.authority}${this.path}`; }
}
class TreeItem { constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; } }
const commands = new Map(), panels = [], terminals = [], errors = [], settingUpdates = [], environmentPicks = [], confirmations = [];
const openedFiles = [], pdfBrowserLaunches = [], progressMessages = [], pdfFolderPrompts = [];
let pickedPdfFolder, pickedPdfDirectory;
const decorationProviders = new Set();
let sidebarDensity = "comfortable", configurationChanged, clipboard, tree, view, workspaceChanged, confirmation = "Resume in terminal", pickedProfile = "default", pickedTarget, pickedCwd, extension;
const newSessionPicks = [];
const vscode = {
  Disposable, EventEmitter, Uri, TreeItem, ThemeIcon: class { constructor(id) { this.id = id; } },
  ThemeColor: class { constructor(id) { this.id = id; } },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 }, ViewColumn: { Active: -1 }, ProgressLocation: { Notification: 15 },
  workspace: { workspaceFolders: [{ uri: new Uri(project) }], onDidChangeWorkspaceFolders(callback) { workspaceChanged = callback; return new Disposable(); },
    getConfiguration(section) {
      if (section === "sessionHub.sidebar") return { get: key => key === "density" ? sidebarDensity : undefined };
      assert.equal(section, "workbench.editor"); return { async update(key, value, target) { settingUpdates.push({ key, value, target }); } };
    },
    onDidChangeConfiguration(callback) { configurationChanged = callback; return new Disposable(); } },
  commands: { async executeCommand(name, uri) { assert.equal(name, "vscode.open"); openedFiles.push(uri); }, registerCommand(name, callback) { commands.set(name, callback); return new Disposable(() => commands.delete(name)); } },
  env: { clipboard: { async writeText(value) { clipboard = value; } } },
  window: {
    registerFileDecorationProvider(provider) { tree = provider; decorationProviders.add(provider); return new Disposable(() => decorationProviders.delete(provider)); },
    registerWebviewViewProvider(id, provider) { assert.equal(id, "sessionHub.sessions"); view = provider; return new Disposable(() => { view = undefined; }); },
    createTreeView() { throw new Error("the two-line sidebar must not create a single-line native tree"); },
    async withProgress(options, callback) { progressMessages.push(options); return callback(); },
    async showWarningMessage(message) { confirmations.push(message); return confirmation; },
    async showQuickPick(items, options) {
      if (items[0]?.target) { newSessionPicks.push({ items, options }); return items.find(item => item.target.id === pickedTarget); }
      if (items[0]?.cwd) { newSessionPicks.push({ items, options }); return items.find(item => item.cwd === pickedCwd); }
      environmentPicks.push({ items, options }); return items.find(item => item.profile.id === pickedProfile);
    },
    async showErrorMessage(message) { errors.push(message); },
    async showWorkspaceFolderPick(options) { pdfFolderPrompts.push(options); return pickedPdfFolder; },
    async showOpenDialog(options) { pdfFolderPrompts.push(options); return pickedPdfDirectory ? [pickedPdfDirectory] : undefined; },
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
function mountSidebar() {
  const callbacks = new Set(), disposeCallbacks = new Set();
  const sidebar = {
    webview: { cspSource: "https://local-resource.vscode-cdn.net", responses: [],
      asWebviewUri(uri) { return { toString: () => `https://local-resource.vscode-cdn.net${encodeURI(uri.fsPath)}` }; },
      onDidReceiveMessage(callback) { callbacks.add(callback); return new Disposable(() => callbacks.delete(callback)); },
      async postMessage(response) { this.responses.push(response); return true; },
      async send(message) { await Promise.all([...callbacks].map(callback => callback(message))); return this.responses.findLast(response => response.type === "sessionHub.sidebar.result" && response.id === message.id); },
    },
    show(preserveFocus) { this.shown = true; this.preserveFocus = preserveFocus; },
    onDidDispose(callback) { disposeCallbacks.add(callback); return new Disposable(() => disposeCallbacks.delete(callback)); },
    dispose() { [...disposeCallbacks].forEach(callback => callback()); },
    callbacks,
  };
  view.resolveWebviewView(sidebar);
  return sidebar;
}
// Persist outside the tool home, just as VS Code owns its own extension storage.
const stateFile = path.join(temp, "vscode-global-state.json");
fs.writeFileSync(stateFile, JSON.stringify({ unrelatedPreference: "preserve me" }));
let stateWrites = 0, failStateWrite = false;
const globalState = () => ({
  get(key) { return JSON.parse(fs.readFileSync(stateFile, "utf8"))[key]; },
  async update(key, value) {
    stateWrites++;
    if (failStateWrite) throw new Error("storage full");
    const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    saved[key] = value;
    fs.writeFileSync(stateFile, JSON.stringify(saved));
  },
});
const makeContext = () => ({ extensionUri: new Uri(root), subscriptions: [], globalState: globalState(),
  get workspaceState() { throw new Error("stars must not use workspace state"); } });
let context = makeContext();
const disposeExtension = () => {
  for (const disposable of context.subscriptions.splice(0).reverse()) disposable.dispose();
  extension?.deactivate();
  assert.equal(decorationProviders.size, 0, "decoration provider must be disposed with the extension");
};
try {
  const entry = path.join(root, manifest.main);
  const nativeRequire = createRequire(entry);
  const module = new Module(entry);
  module.filename = entry;
  module.paths = Module._nodeModulePaths(path.dirname(entry));
  module.require = name => {
    if (name === "vscode") return vscode;
    if (name === "node:os") return { ...os, homedir: () => home };
    if (name === "node:http") throw new Error("VS Code host must not import an HTTP server");
    if (name === "node:child_process") return { spawn(command, args, options) {
      assert.ok(args.some(arg => arg.startsWith("--headless")));
      assert.ok(!options?.shell); // A managed process group may be used to kill browser descendants on timeout.
      pdfBrowserLaunches.push({ command, args, options });
      return nativeRequire(name).spawn(command, args, options);
    } };
    return nativeRequire(name);
  };
  module._compile(fs.readFileSync(entry, "utf8"), entry);
  extension = module.exports;
  await extension.activate(context);
  check("compiled activation uses core without HTTP server or detached launcher", errors.length === 0 && tree && commands.size === 8);
  let sidebar = mountSidebar(), sidebarId = 0;
  const sidebarRequest = (action, fields = {}) => sidebar.webview.send({ type: "sessionHub.sidebar", id: ++sidebarId, action, ...fields });
  const sidebarState = () => sidebar.webview.responses.findLast(response => response.type === "sessionHub.sidebar.state");
  await sidebarRequest("ready");
  check("sidebar loads local assets under strict CSP, without HTTP or transcript content",
    sidebar.webview.options.localResourceRoots[0].fsPath === path.join(root, "media") &&
    sidebar.webview.html.includes("connect-src 'none'") && sidebar.webview.html.includes("script-src 'nonce-") &&
    sidebar.webview.html.includes("sidebar.js") && !sidebar.webview.html.includes("{{") &&
    sidebarState().groups.length === 3 && !JSON.stringify(sidebarState()).includes(home));
  check("search starts collapsed and the magnifier sits left of New Session",
    sidebarState().searchOpen === false && sidebar.webview.html.includes('id="search-panel"') &&
    manifest.contributes.menus["view/title"].map(item => item.command).join() === "sessionHub.search,sessionHub.newSession,sessionHub.refresh" &&
    manifest.contributes.commands.find(item => item.command === "sessionHub.search").icon === "$(search)");
  check("sidebar density defaults to comfortable and the setting is declared",
    sidebarState().density === "comfortable" && manifest.contributes.configuration.properties["sessionHub.sidebar.density"].default === "comfortable");
  sidebarDensity = "compact"; configurationChanged({ affectsConfiguration: key => key === "sessionHub.sidebar.density" });
  check("changing the density setting republishes the sidebar immediately", sidebarState().density === "compact");
  sidebarDensity = "comfortable"; configurationChanged({ affectsConfiguration: key => key === "sessionHub.sidebar.density" });
  await commands.get("sessionHub.search")();
  check("native search command opens the panel without opening an editor", sidebarState().searchOpen === true && sidebar.shown && panels.length === 0);
  await sidebarRequest("search", { text: "scopeuserneedle", searchScope: "user" });
  await commands.get("sessionHub.search")();
  check("native search command closes the panel and clears the filter", sidebarState().searchOpen === false && sidebarState().search.text === "");
  await commands.get("sessionHub.search")();
  await sidebarRequest("closeSearch");
  assert.equal(sidebarState().searchOpen, false);
  await commands.get("sessionHub.search")();
  check("sidebar headings and manifest UI are English", sidebarState().groups.map(group => group.label).join() === "Current Project,Unassigned,Other Projects" && !/\p{Script=Han}/u.test(JSON.stringify(manifest.contributes)));
  const groups = tree.getChildren();
  const current = groups.find(group => group.scope === "current");
  const currentItems = tree.getChildren(current);
  check("tree scopes current project and labels sessions with harness + recency", currentItems.length >= 4 && currentItems.every(item => item.description.includes(" · ")));
  check("unscoped sessions remain visible", tree.getChildren(groups.find(group => group.scope === "unscoped")).some(item => item.session.harness === "crush"));
  const allItems = groups.flatMap(group => tree.getChildren(group));
  check("all six harnesses have their own light/dark SVG tree icons",
    new Set(allItems.map(item => item.session.harness)).size === 6 &&
    allItems.every(item => ["light", "dark"].every(theme =>
      item.iconPath[theme].fsPath === path.join(root, "media/harness", theme, item.session.harness + ".svg") &&
      fs.readFileSync(item.iconPath[theme].fsPath, "utf8").includes("<svg"))));
  const pi = currentItems.find(item => item.session.harness === "pi" && item.session.nativeId === "11111111-2222-3333-4444-555555555555");
  const claude = currentItems.find(item => item.session.harness === "claude-code");
  await commands.get("sessionHub.open")(pi);
  const panel = panels[0];
  await commands.get("sessionHub.open")(pi.session.uid);
  check("open creates/reuses an editor WebviewPanel", panels.length === 1 && panel.reveals === 1);
  check("viewer retains its page context while hidden by another editor tab", panel.options.retainContextWhenHidden === true);
  check("viewer paints the host editor background before external styles load",
    panel.webview.html.includes("background: var(--vscode-editor-background") &&
    panel.webview.html.indexOf('id="session-hub-initial-style"') < panel.webview.html.indexOf('rel="stylesheet"'));
  check("only the Session tab title is truncated; tree retains full prompt", panel.title === sessionTabTitle(longPrompt, pi.session.nativeId) && panel.title.endsWith("…") && pi.label === longPrompt);
  check("webview resources are restricted to packaged media", panel.options.localResourceRoots.length === 1 && panel.options.localResourceRoots[0].fsPath === path.join(root, "dist/media"));
  check("webview HTML has strict CSP, two-column mode and no localhost endpoint", panel.webview.html.includes("connect-src &#39;none&#39;") && panel.webview.html.includes('data-host="vscode"') && panel.webview.html.includes('nonce="') && !panel.webview.html.includes("http://127.0.0.1") && !panel.webview.html.includes('src="/app.js"'));
  const request = async (operation, extras = {}) => panel.webview.send({ type: "sessionHub.request", id: panel.webview.responses.length + 1, operation, ...extras });
  const response = await request("getSession", { uid: pi.session.uid });
  const detail = response.result;
  check("transcript metadata keeps the full title after tab truncation", detail.title === longPrompt);
  check("VS Code requests English generated tool labels without changing Chinese prose", detail.messages.some(message => message.role === "toolCall" && message.text.startsWith("Tool:")) && detail.messages.some(message => message.text.includes("以下为虚构的诊断示例")));
  check("postMessage detail keeps Markdown/math/tool activity and redaction", !response.error && detail.messages.some(m => m.html.includes('class="katex"')) && detail.messages.some(m => m.role === "toolCall") && !JSON.stringify(detail).includes("TOOL_SECRET_VALUE"));
  const linkedMessage = detail.messages.find(message => message.text.includes("阅读页：诊断结果"));
  const linkId = linkedMessage.html.match(/data-session-link="([a-f0-9]{32})"/)?.[1];
  check("compiled webview keeps the reported reading-page link and external URLs",
    linkId && linkedMessage.html.includes('href="https://example.com/report"'));
  const linkResponse = await request("openLink", { uid: pi.session.uid, linkId });
  check("local link click opens the source-cwd file through VS Code (no browser/server)",
    !linkResponse.error && openedFiles.at(-1).fsPath === fs.realpathSync(readingFile));
  check("client cannot forge paths or link IDs",
    Boolean((await request("openLink", { uid: pi.session.uid, linkId: "a".repeat(32) })).error) &&
    Boolean((await request("openLink", { uid: pi.session.uid, linkId, path: outsideFile })).error));
  await request("getSession", { uid: pi.session.uid });
  check("reload invalidates stale panel link IDs", Boolean((await request("openLink", { uid: pi.session.uid, linkId })).error));
  check("webview cannot supply a filesystem path", Boolean((await request("getSession", { uid: pi.session.uid, path: "/etc/passwd" })).error));
  check("webview cannot read a different session", Boolean((await request("getSession", { uid: claude.session.uid })).error));
  await request("copyId", { uid: pi.session.uid });
  check("viewer copies its indexed session ID", clipboard === pi.session.uid);
  const sourceBeforePdf = fs.readFileSync(piSource);
  const exported = await request("exportPdf", { uid: pi.session.uid });
  assert.ok(!exported.error, exported.error);
  check("Export PDF writes a real document to the current workspace root without modifying source history",
    path.dirname(exported.result.path) === project && exported.result.fileName.endsWith(".pdf") &&
    fs.readFileSync(exported.result.path).subarray(0, 5).toString() === "%PDF-" && fs.readFileSync(piSource).equals(sourceBeforePdf) &&
    pdfBrowserLaunches.length >= 1 && progressMessages.some(options => options.title === "Exporting conversation as PDF…"));
  check("PDF destination and HTML cannot be supplied by the webview",
    Boolean((await request("exportPdf", { uid: pi.session.uid, path: "/etc/passwd" })).error) &&
    Boolean((await request("exportPdf", { uid: claude.session.uid })).error));
  const launchesAfterFirstPdf = pdfBrowserLaunches.length;
  const secondPdfWorkspace = path.join(temp, "second workspace");
  fs.mkdirSync(secondPdfWorkspace);
  const initialFolders = vscode.workspace.workspaceFolders;
  try {
    vscode.workspace.workspaceFolders = [...initialFolders, { name: "Second workspace", uri: new Uri(secondPdfWorkspace) }];
    const cancelled = await request("exportPdf", { uid: pi.session.uid });
    assert.equal(cancelled.result.cancelled, true);
    assert.equal(pdfBrowserLaunches.length, launchesAfterFirstPdf);
    pickedPdfFolder = vscode.workspace.workspaceFolders[1];
    const multiple = await request("exportPdf", { uid: pi.session.uid });
    assert.ok(!multiple.error, multiple.error);
    assert.equal(path.dirname(multiple.result.path), secondPdfWorkspace);
    vscode.workspace.workspaceFolders = [];
    pickedPdfDirectory = undefined;
    assert.equal((await request("exportPdf", { uid: pi.session.uid })).result.cancelled, true);
    pickedPdfDirectory = new Uri(secondPdfWorkspace);
    const noWorkspace = await request("exportPdf", { uid: pi.session.uid });
    assert.ok(!noWorkspace.error, noWorkspace.error);
    assert.equal(path.dirname(noWorkspace.result.path), secondPdfWorkspace);
    assert.ok(pdfFolderPrompts.every(prompt => !/\p{Script=Han}/u.test(JSON.stringify(prompt))));
    check("PDF export asks for multi-root or no-workspace destinations and cancels without writing", true);
  } finally { vscode.workspace.workspaceFolders = initialFolders; }
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
  confirmation = "Resume in terminal";
  pickedProfile = undefined;
  const terminalCount = terminals.length;
  await commands.get("sessionHub.resume")("pi:unknown-env");
  check("unknown environment asks for configuration identity; picker cancellation launches nothing", environmentPicks.length === 1 && terminals.length === terminalCount && environmentPicks[0].items.some(item => item.label === "Pi Team"));
  pickedProfile = "team";
  await commands.get("sessionHub.resume")("pi:unknown-env");
  check("manual profile choice uses configured dir, not a shell alias or inherited default", terminals.at(-1).options.env.PI_CODING_AGENT_DIR === profiles[2].agentDir && terminals.at(-1).options.shellPath === "pi" && terminals.at(-1).options.shellArgs[1] === unknownSource);
  pickedProfile = "default";
  await commands.get("sessionHub.resume")("pi:conflicting-env");
  check("conflicting Context cannot silently choose one account", environmentPicks.at(-1).options.placeHolder.includes("multiple Pi environments") && terminals.at(-1).options.env.PI_CODING_AGENT_DIR === profiles[0].agentDir);
  const missingDirectory = fs.readFileSync(piSource);
  fs.rmdirSync(profiles[1].agentDir);
  const countBeforeMissing = terminals.length;
  const picksBeforeMissing = environmentPicks.length;
  await commands.get("sessionHub.resume")(pi.session.uid);
  check("missing detected config directory errors instead of switching to default", terminals.length === countBeforeMissing && environmentPicks.length === picksBeforeMissing && errors.at(-1).includes("source Pi configuration directory is unavailable"));
  check("environment detection/picking never rewrites a source transcript", fs.readFileSync(piSource).equals(missingDirectory));

  // New blank sessions: only executables found on PATH, Pi once per configured
  // environment, no argv, workspace folder as cwd.
  const bin = path.join(temp, "bin with spaces");
  fs.mkdirSync(bin);
  for (const name of ["pi", "claude"]) fs.writeFileSync(path.join(bin, name), "#!/bin/sh\n", { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "codex"), "not executable", { mode: 0o644 });
  const savedPath = process.env.PATH;
  process.env.PATH = [bin, "relative-bin"].join(path.delimiter);
  const otherProject = path.join(temp, "second project");
  fs.mkdirSync(otherProject);
  vscode.workspace.workspaceFolders = [{ uri: new Uri(project) }];
  try {
    check("+ sits beside refresh in the sidebar title bar",
      manifest.contributes.menus["view/title"].map(entry => entry.command).join() === "sessionHub.search,sessionHub.newSession,sessionHub.refresh" &&
      manifest.contributes.commands.find(entry => entry.command === "sessionHub.newSession").icon === "$(add)");
    let terminalCount = terminals.length;
    pickedTarget = undefined;
    await commands.get("sessionHub.newSession")();
    const offered = newSessionPicks.at(-1).items.map(item => item.target.id);
    check("new session offers PATH executables only, Pi once per environment",
      offered.join() === "pi:default,pi:research,pi:team,claude-code" && terminals.length === terminalCount);
    pickedTarget = "claude-code";
    await commands.get("sessionHub.newSession")();
    check("new Claude session starts a blank CLI in the workspace folder without resume argv or confirmation",
      terminals.length === terminalCount + 1 && terminals.at(-1).shown && terminals.at(-1).options.shellPath === path.join(bin, "claude") &&
      terminals.at(-1).options.shellArgs.length === 0 && terminals.at(-1).options.cwd === project &&
      terminals.at(-1).options.env === undefined && terminals.at(-1).options.name.includes("New session"));
    pickedTarget = "pi:team";
    await commands.get("sessionHub.newSession")();
    check("new Pi session passes the chosen environment explicitly",
      terminals.at(-1).options.shellPath === path.join(bin, "pi") && terminals.at(-1).options.shellArgs.length === 0 &&
      terminals.at(-1).options.env.PI_CODING_AGENT_DIR === profiles[2].agentDir);
    terminalCount = terminals.length;
    pickedTarget = "pi:research";
    await commands.get("sessionHub.newSession")();
    check("missing Pi environment directory errors instead of falling back to default",
      terminals.length === terminalCount && errors.at(-1).includes("Pi configuration directory is unavailable"));
    vscode.workspace.workspaceFolders = [{ uri: new Uri(project) }, { uri: new Uri(otherProject) }];
    pickedTarget = "claude-code"; pickedCwd = undefined;
    await commands.get("sessionHub.newSession")();
    check("multi-root picker cancellation launches nothing", terminals.length === terminalCount &&
      newSessionPicks.at(-1).items.map(item => item.cwd).join() === [project, otherProject].join());
    pickedCwd = otherProject;
    await commands.get("sessionHub.newSession")();
    check("multi-root new session starts in the chosen folder", terminals.length === terminalCount + 1 && terminals.at(-1).options.cwd === otherProject);
    process.env.PATH = "";
    const errorCount = errors.length;
    await commands.get("sessionHub.newSession")();
    check("no harness on PATH reports an error instead of guessing", errors.length === errorCount + 1 && errors.at(-1).includes("PATH"));
  } finally {
    process.env.PATH = savedPath;
    vscode.workspace.workspaceFolders = [{ uri: new Uri(path.join(temp, "different")) }];
  }
  panel.dispose();
  await commands.get("sessionHub.open")(pi.session.uid);
  check("closed panels can be reopened", panels.length === 2);
  check("activation and session opens never change editor tab preferences", settingUpdates.length === 0);

  const items = () => tree.getChildren().flatMap(group => tree.getChildren(group));
  const item = uid => items().find(row => row.id === uid);
  const snapshot = () => new Map(files(home).sort().map(file => [file, fs.readFileSync(file)]));
  const unchanged = saved => {
    assert.deepEqual(files(home).sort(), [...saved.keys()]);
    for (const [file, bytes] of saved) assert.ok(fs.readFileSync(file).equals(bytes), file);
  };
  const menu = manifest.contributes.menus["webview/context"];
  const menuVisible = (command, row) => {
    const when = menu.find(entry => entry.command === command).when;
    assert.ok(when.startsWith("webviewId == sessionHub.sessions && webviewSection == session"));
    if (!row.session) return false;
    return when.endsWith("&& !sessionStarred") ? row.contextValue === "session"
      : when.endsWith("&& sessionStarred") ? row.contextValue === "sessionStarred" : true;
  };
  const beforeSearchActions = snapshot();
  for (const [action, fields] of [
    ["open", { uid: "/etc/passwd" }], ["star", { uid: "pi:missing", starred: true }],
    ["star", { uid: pi.session.uid, starred: "yes" }], ["open", { uid: pi.session.uid, path: pi.session.path }],
    ["resume", { uid: pi.session.uid, args: ["bad"] }], ["more", { scope: "unknown" }],
    ["ready", { uid: pi.session.uid }], ["execute", { command: "bad" }], ["closeSearch", { uid: pi.session.uid }],
    ["search", { text: "query", searchScope: "system" }],
    ["search", { text: "query" }], ["search", { text: 42, searchScope: "user" }],
    ["search", { text: "x".repeat(2001), searchScope: "user" }],
    ["search", { text: "query", searchScope: "all", path: "/etc/passwd" }],
    ...["unknown", ["pi"], null, 42].map(harness => ["search", { text: "", searchScope: "user", harness }]),
  ]) assert.ok((await sidebarRequest(action, fields)).error);
  check("sidebar rejects unknown UIDs, paths, argv, extra fields and forged actions", true);
  const sidebarRows = () => sidebarState().groups.flatMap(group => group.sessions);
  check("sidebar starts with prompt-only search and exposes all three scope options",
    sidebarState().search.searchScope === "user" && sidebar.webview.html.includes('value="conversation"') && sidebar.webview.html.includes('value="all"'));
  for (const [text, searchScope, expected] of [
    ["scopeuserneedle", "user", true], ["scopeassistantneedle", "user", false],
    ["scopeassistantneedle", "conversation", true], ["scopetoolneedle", "conversation", false],
    ["scopetoolneedle", "all", true], ["scopeoutputneedle", "all", true],
    [longPrompt, "user", false],
  ]) {
    assert.ok(!(await sidebarRequest("search", { text, searchScope })).error);
    assert.equal(sidebarRows().some(row => row.uid === pi.session.uid), expected, `${searchScope}: ${text}`);
    assert.deepEqual(sidebarState().search, { text, searchScope, harness: "" });
  }
  check("harness icons sit above the search field and use packaged light/dark assets",
    sidebar.webview.html.indexOf('id="search-harness"') < sidebar.webview.html.indexOf('id="search"') &&
    !sidebar.webview.html.includes('src="harness/') &&
    ["pi", "claude-code", "codex", "opencode", "crush", "jcode"].every(harness =>
      sidebar.webview.html.includes(`data-harness="${harness}"`) &&
      ["light", "dark"].every(theme => sidebar.webview.html.includes(`/harness/${theme}/${harness}.svg`))));
  for (const harness of ["pi", "claude-code", "codex", "opencode", "crush", "jcode"]) {
    assert.ok(!(await sidebarRequest("search", { text: "", searchScope: "user", harness })).error);
    const expected = tree.sessions.filter(session => session.harness === harness);
    assert.ok(expected.length > 0);
    assert.equal(sidebarState().groups.reduce((sum, group) => sum + group.total, 0), expected.length);
    assert.ok(sidebarRows().every(row => row.harness === harness));
  }
  check("selecting any harness immediately filters the list without a search keyword", true);
  for (const [harness, expected] of [["pi", [pi.session.uid]], ["claude-code", []], ["", [pi.session.uid]]]) {
    await sidebarRequest("search", { text: "scopeuserneedle", searchScope: "user", harness });
    assert.deepEqual(sidebarRows().map(row => row.uid), expected);
  }
  check("keyword searches are restricted to the selected harness; All restores cross-harness search", true);
  await sidebarRequest("search", { text: "", searchScope: "user", harness: "pi" });
  await sidebarRequest("closeSearch");
  check("closing search clears the harness filter as well as the keyword",
    sidebarState().search.harness === "" && sidebarRows().some(row => row.harness === "claude-code"));
  await sidebarRequest("search", { text: "scopeuserneedle", searchScope: "user", harness: "pi" });
  check("a delayed search after Close cannot restore a hidden harness filter",
    sidebarState().search.text === "" && sidebarState().search.harness === "" && sidebarRows().some(row => row.harness === "claude-code"));
  await commands.get("sessionHub.search")();
  unchanged(beforeSearchActions);
  await sidebarRequest("search", { text: "scopeuserneedle", searchScope: "user", harness: "pi" });
  await commands.get("sessionHub.refresh")();
  check("active search and harness filter survive an index refresh",
    sidebarState().search.text === "scopeuserneedle" && sidebarState().search.harness === "pi" && sidebarRows().length === 1);
  await sidebarRequest("search", { text: "  ", searchScope: "user" });
  assert.ok(sidebarRows().length > 1);
  const beforeSidebarActions = snapshot();
  const listSessions = tree.service.listSessions;
  try {
    let finishSlow;
    tree.service.listSessions = query => query.text === "slow"
      ? new Promise(resolve => { finishSlow = resolve; }) : Promise.resolve([pi.session]);
    const slow = tree.setSearch("slow", "all", "claude-code");
    await tree.setSearch("latest", "user", "pi");
    finishSlow([claude.session]); await slow;
    assert.equal(tree.sidebarSearch.text, "latest");
    assert.equal(tree.sidebarSearch.harness, "pi");
    assert.deepEqual(sidebarRows().map(row => row.uid), [pi.session.uid]);
    check("late search completion cannot overwrite a newer query, scope or harness", true);
    const slowAgain = tree.setSearch("slow", "all", "claude-code");
    await tree.setSearch("", "user", "pi");
    finishSlow([claude.session]); await slowAgain;
    assert.equal(tree.sidebarSearch.text, "");
    assert.equal(tree.sidebarSearch.harness, "pi");
    assert.ok(sidebarRows().length > 0 && sidebarRows().every(row => row.harness === "pi"));
    check("filter-only changes also cancel an older in-flight keyword search", true);
  } finally { tree.service.listSessions = listSessions; await tree.setSearch("", "user"); }
  unchanged(beforeSidebarActions);
  await sidebarRequest("star", { uid: pi.session.uid, starred: true });
  check("second-row star action publishes confirmed highlighted state without changing source/index bytes", sidebarRows().find(row => row.uid === pi.session.uid).starred === true);
  failStateWrite = true;
  assert.ok((await sidebarRequest("star", { uid: pi.session.uid, starred: false })).error);
  check("sidebar star failure keeps saved highlight unchanged", sidebarRows().find(row => row.uid === pi.session.uid).starred === true);
  failStateWrite = false;
  await sidebarRequest("star", { uid: pi.session.uid, starred: false });
  assert.equal(sidebarRows().find(row => row.uid === pi.session.uid).starred, false);
  const panelCount = panels.length;
  await sidebarRequest("open", { uid: pi.session.uid });
  assert.equal(panels.length, panelCount);
  await sidebarRequest("copyId", { uid: pi.session.uid });
  assert.equal(clipboard, pi.session.uid);
  await commands.get("sessionHub.copyId")({ sessionUid: claude.session.uid, webviewSection: "session" });
  assert.equal(clipboard, claude.session.uid);
  unchanged(beforeSidebarActions);
  check("sidebar opens existing editors and context menus resolve UIDs without source writes", true);

  const originalSessions = tree.sessions;
  const originalFolders = vscode.workspace.workspaceFolders;
  try {
    vscode.workspace.workspaceFolders = [{ uri: new Uri(project) }];
    // Pagination-only fixture: no source parsing or index modifications needed.
    tree.sessions = Array.from({ length: 205 }, (_, i) => ({ ...pi.session, uid: `pi:page-${i}`, repo: project, cwd: project,
      updatedAt: new Date(Date.UTC(2026, 0, 1) - i * 60000).toISOString() }));
    tree.sessions.push(
      { ...pi.session, uid: "pi:other-new", repo: path.join(temp, "other"), cwd: path.join(temp, "other") },
      { ...pi.session, uid: "pi:other-old", repo: path.join(temp, "other"), cwd: path.join(temp, "other") },
      { ...pi.session, uid: "pi:unscoped-new", repo: null, cwd: null },
      { ...pi.session, uid: "pi:unscoped-old", repo: null, cwd: null });
    tree.rescope();
    let group = sidebarState().groups.find(g => g.scope === "current");
    const currentRows = () => sidebarState().groups.find(g => g.scope === "current").sessions.map(row => row.uid);
    const originalOrder = tree.sessions.map(session => session.uid);
    assert.equal(group.total, 205); assert.equal(group.sessions.length, 100);
    await sidebarRequest("star", { uid: "pi:page-204", starred: true });
    assert.deepEqual(currentRows(), ["pi:page-204", ...originalOrder.slice(0, 99)]);
    assert.equal(tree.getChildren(tree.getChildren().find(g => g.scope === "current"))[0].id, "pi:page-204");
    check("old starred sessions move to the first page before pagination", true);
    await sidebarRequest("star", { uid: "pi:page-203", starred: true });
    assert.deepEqual(currentRows().slice(0, 3), ["pi:page-203", "pi:page-204", "pi:page-0"]);
    assert.deepEqual(tree.sessions.map(session => session.uid), originalOrder);
    check("multiple stars preserve newest-first order without mutating the source-order cache", true);
    const pinnedOrder = currentRows();
    failStateWrite = true;
    assert.ok((await sidebarRequest("star", { uid: "pi:page-202", starred: true })).error);
    assert.ok((await sidebarRequest("star", { uid: "pi:page-203", starred: false })).error);
    assert.deepEqual(currentRows(), pinnedOrder);
    failStateWrite = false;
    check("failed star/unstar writes do not reorder visible cards", true);
    await sidebarRequest("star", { uid: "pi:other-old", starred: true });
    await sidebarRequest("star", { uid: "pi:unscoped-old", starred: true });
    assert.deepEqual(currentRows(), pinnedOrder);
    assert.deepEqual(sidebarState().groups.find(g => g.scope === "other").sessions.map(row => row.uid), ["pi:other-old", "pi:other-new"]);
    assert.deepEqual(sidebarState().groups.find(g => g.scope === "unscoped").sessions.map(row => row.uid), ["pi:unscoped-old", "pi:unscoped-new"]);
    check("stars pin within their own project groups without moving unrelated sessions", true);
    for (const uid of ["pi:page-203", "pi:page-204", "pi:other-old", "pi:unscoped-old"]) await sidebarRequest("star", { uid, starred: false });
    assert.deepEqual(currentRows(), originalOrder.slice(0, 100));
    unchanged(beforeSidebarActions);
    check("unstar restores chronological placement and all pinning leaves source/index bytes unchanged", true);
    await sidebarRequest("more", { scope: "current" });
    assert.equal(sidebarState().groups.find(g => g.scope === "current").sessions.length, 200);
    await sidebarRequest("more", { scope: "current" });
    group = sidebarState().groups.find(g => g.scope === "current");
    assert.equal(group.sessions.length, 205);
    assert.equal(new Set(group.sessions.map(row => row.uid)).size, 205);
    check("sidebar pages large groups without dropping or duplicating old sessions", true);
    const listSessions = tree.service.listSessions;
    try {
      tree.sessions = Array.from({ length: 705 }, (_, i) => ({ ...pi.session, uid: `pi:match-${i}`, repo: project, cwd: project }));
      tree.sessions.unshift(...Array.from({ length: 600 }, (_, i) => ({ ...claude.session, uid: `claude-code:excluded-${i}`, repo: project, cwd: project })));
      const offsets = [];
      tree.service.listSessions = async query => {
        assert.equal(query.searchScope, "conversation"); assert.equal(query.harness, "pi"); offsets.push(query.offset);
        return tree.sessions.filter(session => session.harness === query.harness).slice(query.offset, query.offset + query.limit);
      };
      await sidebarRequest("search", { text: "pagedneedle", searchScope: "conversation", harness: "pi" });
      group = sidebarState().groups.find(g => g.scope === "current");
      assert.deepEqual(offsets, [0, 500]);
      assert.equal(group.total, 705); assert.equal(group.sessions.length, 100);
      await sidebarRequest("star", { uid: "pi:match-704", starred: true });
      assert.equal(currentRows()[0], "pi:match-704");
      await sidebarRequest("star", { uid: "pi:match-704", starred: false });
      await sidebarRequest("more", { scope: "current" });
      assert.equal(currentRows().length, 200);
      assert.ok(sidebarRows().every(row => row.harness === "pi"));
      check("harness-restricted search covers every index page before grouping, star pinning and pagination", true);
    } finally { tree.service.listSessions = listSessions; await tree.setSearch("", "user"); }
  } finally { tree.sessions = originalSessions; vscode.workspace.workspaceFolders = originalFolders; tree.rescope(); }
  await sidebarRequest("search", { text: "", searchScope: "user", harness: "pi" });
  const oldSidebar = sidebar;
  sidebar = mountSidebar();
  await sidebarRequest("ready");
  check("recreated sidebar restores the harness filter and detaches old message listeners",
    oldSidebar.callbacks.size === 0 && sidebarState().search.harness === "pi" && sidebarRows().length > 0 && sidebarRows().every(row => row.harness === "pi"));
  await sidebarRequest("search", { text: "", searchScope: "user", harness: "" });

  let starChanges = 0;
  tree.onDidChangeTreeData(() => { starChanges++; });
  const decorationChanges = [];
  tree.onDidChangeFileDecorations(uri => { decorationChanges.push(uri?.toString()); });
  const unmarked = item(pi.session.uid);
  check("tree registers an isolated decoration provider; unstarred rows and groups have no color",
    decorationProviders.size === 1 && decorationProviders.has(tree) &&
    tree.provideFileDecoration(unmarked.resourceUri) === undefined && tree.getChildren().every(group => !group.resourceUri));
  check("session decoration identities are opaque and do not expose source paths or native IDs",
    unmarked.resourceUri.scheme === "session-hub" && unmarked.resourceUri.authority === "sessions" &&
    /^\/[a-f0-9]{64}$/.test(unmarked.resourceUri.path) && new Set(items().map(row => row.resourceUri.toString())).size === items().length);
  check("only unstarred session rows offer Star; groups offer neither star action",
    menuVisible("sessionHub.star", unmarked) && !menuVisible("sessionHub.unstar", unmarked) &&
    tree.getChildren().every(group => !menuVisible("sessionHub.star", group) && !menuVisible("sessionHub.unstar", group)));
  const beforeStars = snapshot();
  await commands.get("sessionHub.star")(unmarked);
  const marked = item(pi.session.uid);
  const decoration = tree.provideFileDecoration(marked.resourceUri);
  check("star applies the theme color immediately without an extra badge or parent propagation",
    decoration.color.id === "sessionHub.starredForeground" && decoration.propagate === false && !decoration.badge &&
    decorationChanges.length === 1 && decorationChanges[0] === marked.resourceUri.toString() &&
    marked.resourceUri.toString() === unmarked.resourceUri.toString());
  check("decorations never color real source files, unrelated resources or other sessions",
    tree.provideFileDecoration(Uri.file(pi.session.path)) === undefined &&
    tree.provideFileDecoration(marked.resourceUri.with({ scheme: "other" })) === undefined &&
    tree.provideFileDecoration(Uri.from({ scheme: "session-hub", authority: "sessions", path: "/unknown" })) === undefined &&
    tree.provideFileDecoration(claude.resourceUri) === undefined);
  check("star visibly marks the full tree title while preserving UID, icon, description and open action",
    marked.label === `★ ${longPrompt}` && marked.id === unmarked.id && marked.tooltip.includes("Starred") &&
    marked.contextValue === "sessionStarred" && marked.description === unmarked.description &&
    marked.iconPath.light.fsPath === unmarked.iconPath.light.fsPath && marked.command.arguments[0] === unmarked.id && starChanges === 1);
  check("starred rows offer Unstar and retain Open, Resume and Copy ID menus",
    !menuVisible("sessionHub.star", marked) && menuVisible("sessionHub.unstar", marked) &&
    ["sessionHub.open", "sessionHub.resume", "sessionHub.copyId"].every(command => menuVisible(command, marked)));
  const savedStars = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.deepEqual(savedStars, { unrelatedPreference: "preserve me", "sessionHub.starredSessionUids.v1": [pi.session.uid] });
  await commands.get("sessionHub.copyId")(marked);
  assert.equal(clipboard, pi.session.uid);
  await commands.get("sessionHub.open")(marked);
  check("star does not mark viewer titles or transcript metadata", !panels.at(-1).title.startsWith("★"));
  failStateWrite = true;
  const changesBeforeFailure = starChanges;
  const decorationsBeforeFailure = decorationChanges.length;
  await commands.get("sessionHub.unstar")(marked);
  check("failed unstar reports an error without changing visible or durable state",
    errors.at(-1).includes("Could not save session stars") && item(pi.session.uid).contextValue === "sessionStarred" &&
    starChanges === changesBeforeFailure && JSON.stringify(JSON.parse(fs.readFileSync(stateFile, "utf8"))) === JSON.stringify(savedStars));
  await commands.get("sessionHub.star")(claude);
  check("failed star never displays an unsaved mark", item(claude.session.uid).contextValue === "session" && starChanges === changesBeforeFailure);
  check("failed star writes leave decoration colors and invalidation state unchanged",
    decorationChanges.length === decorationsBeforeFailure &&
    tree.provideFileDecoration(marked.resourceUri)?.color.id === "sessionHub.starredForeground" &&
    tree.provideFileDecoration(claude.resourceUri) === undefined);
  failStateWrite = false;
  const invalidWrites = stateWrites, invalidErrors = errors.length;
  for (const arg of [undefined, {}, current, "pi:missing", "x".repeat(2001)]) await commands.get("sessionHub.star")(arg);
  check("invalid, group and missing-session command arguments are safely rejected", stateWrites === invalidWrites && errors.length === invalidErrors + 5);
  await Promise.all([commands.get("sessionHub.star")(claude), commands.get("sessionHub.unstar")(pi), commands.get("sessionHub.star")(pi)]);
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, "utf8"))["sessionHub.starredSessionUids.v1"], [claude.session.uid, pi.session.uid].sort());
  unchanged(beforeStars);
  check("star/unstar including failures and rapid clicks leave ALL source and index files byte-for-byte unchanged", true);
  await commands.get("sessionHub.refresh")();
  check("stars survive refresh and reconstructed tree items", item(pi.session.uid).contextValue === "sessionStarred" && item(claude.session.uid).contextValue === "sessionStarred");
  const assertPinnedGroups = () => {
    const stars = new Set(JSON.parse(fs.readFileSync(stateFile, "utf8"))["sessionHub.starredSessionUids.v1"] ?? []);
    const originalRanks = new Map(tree.sessions.map((row, i) => [row.uid, i]));
    for (const group of sidebarState().groups) {
      let sawOrdinary = false, lastStar = -1, lastOrdinary = -1;
      for (const row of group.sessions) {
        const rank = originalRanks.get(row.uid);
        assert.equal(row.starred, stars.has(row.uid));
        if (row.starred) { assert.equal(sawOrdinary, false); assert.ok(rank > lastStar); lastStar = rank; }
        else { sawOrdinary = true; assert.ok(rank > lastOrdinary); lastOrdinary = rank; }
      }
    }
  };
  assertPinnedGroups();
  check("refresh preserves pinned stars and stable chronological order within each section", true);
  vscode.workspace.workspaceFolders = [{ uri: new Uri(project) }];
  workspaceChanged();
  check("stars survive workspace regrouping", tree.getChildren(tree.getChildren().find(group => group.scope === "current")).some(row => row.id === pi.session.uid && row.contextValue === "sessionStarred"));
  assertPinnedGroups();
  check("workspace changes preserve pinning in the new project groups", true);
  disposeExtension();
  vscode.workspace.workspaceFolders = [{ uri: new Uri(path.join(temp, "restarted-workspace")) }];
  context = makeContext();
  await extension.activate(context);
  check("globalState stars survive extension restart in a different workspace", item(pi.session.uid).contextValue === "sessionStarred" && item(claude.session.uid).contextValue === "sessionStarred");
  sidebar = mountSidebar(); await sidebarRequest("ready");
  assertPinnedGroups();
  check("existing saved stars are pinned on the first render after extension restart", true);
  check("saved stars regain their theme color after refresh/workspace changes/restart",
    tree.provideFileDecoration(item(pi.session.uid).resourceUri)?.color.id === "sessionHub.starredForeground" &&
    tree.provideFileDecoration(item(claude.session.uid).resourceUri)?.color.id === "sessionHub.starredForeground");
  const beforeUnstar = snapshot();
  const restoredResource = item(pi.session.uid).resourceUri;
  const unstarDecorations = [];
  tree.onDidChangeFileDecorations(uri => { unstarDecorations.push(uri?.toString()); });
  await commands.get("sessionHub.unstar")(item(pi.session.uid));
  check("unstar invalidates the same resource and restores default title color immediately",
    unstarDecorations[0] === restoredResource.toString() && tree.provideFileDecoration(restoredResource) === undefined);
  check("successful unstar removes marker and restores Star menu", item(pi.session.uid).label === longPrompt && menuVisible("sessionHub.star", item(pi.session.uid)));
  unchanged(beforeUnstar);
  disposeExtension();
  context = makeContext();
  await extension.activate(context);
  check("unstar also persists across restart without clearing other stars", item(pi.session.uid).contextValue === "session" && item(claude.session.uid).contextValue === "sessionStarred");
  disposeExtension();
  const corruptState = JSON.stringify({ "sessionHub.starredSessionUids.v1": { invalid: true } });
  fs.writeFileSync(stateFile, corruptState);
  const errorsBeforeCorrupt = errors.length;
  context = makeContext();
  await extension.activate(context);
  check("corrupt saved star state reports an error but does not prevent browsing", errors.length === errorsBeforeCorrupt + 1 && errors.at(-1).includes("Could not load starred sessions") && items().length > 0);
  await commands.get("sessionHub.star")(item(pi.session.uid));
  check("corrupt storage is never silently overwritten by a star command", fs.readFileSync(stateFile, "utf8") === corruptState && errors.at(-1).includes("existing data has not been overwritten"));

} finally {
  disposeExtension();
  extension?.deactivate();
  fs.rmSync(temp, { recursive: true, force: true });
}

// Client transport itself, isolated from browser fetch/sessionStorage.
const sent = [], listeners = {}, timers = new Map();
let timerId = 0;
const sandbox = { window: { addEventListener: (name, callback) => { listeners[name] = callback; } },
  document: { documentElement: {}, querySelectorAll: () => [], body: { dataset: { host: "vscode", sessionUid: "pi:bound" } } },
  acquireVsCodeApi: () => ({ postMessage: message => sent.push(message) }),
  setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
  clearTimeout: id => timers.delete(id),
  fetch: () => { throw new Error("HTTP is forbidden in Webview mode"); },
};
vm.runInNewContext(fs.readFileSync(path.join(root, "dist/media/transport.js"), "utf8"), sandbox);
const transport = sandbox.window.sessionHubTransport;
check("resume action declares a primary green button and decorative play icon", transport.sessionActions[0].className === "primary-button resume-button" && transport.sessionActions[0].icon === "▶" && transport.sessionActions[0].label === "Resume in terminal");
const pending = transport.getSession("pi:bound");
check("VscodeTransport uses UID-based postMessage, not fetch", sent[0].operation === "getSession" && sent[0].uid === "pi:bound" && !transport.hasSessionList);
listeners.message({ data: { type: "sessionHub.response", id: sent[0].id, result: { uid: "pi:bound" } } });
check("transport matches replies and clears request timers", (await pending).uid === "pi:bound" && timers.size === 0);
const error = transport.status();
listeners.message({ data: { type: "sessionHub.response", id: sent[1].id, error: "denied" } });
await assert.rejects(() => error, /denied/);
const linkPending = transport.openLink("pi:bound", "a".repeat(32));
check("local link transport sends only bound UID and opaque link ID",
  sent.at(-1).operation === "openLink" && sent.at(-1).linkId === "a".repeat(32) && sent.at(-1).path === undefined);
listeners.message({ data: { type: "sessionHub.response", id: sent.at(-1).id, result: { ok: true } } });
await linkPending;
const pdfPending = transport.exportPdf("pi:bound");
check("PDF transport sends only the bound UID and export operation", sent.at(-1).operation === "exportPdf" && sent.at(-1).uid === "pi:bound" && sent.at(-1).path === undefined);
listeners.message({ data: { type: "sessionHub.response", id: sent.at(-1).id, result: { path: "/synthetic/export.pdf" } } });
assert.equal((await pdfPending).path, "/synthetic/export.pdf");
const timeout = transport.refresh();
[...timers.values()][0]();
await assert.rejects(() => timeout, /timed out/);
const closing = transport.status(); listeners.pagehide();
await assert.rejects(() => closing, /closed/);
check("transport errors, timeouts and disposal reject pending requests", true);
console.log(`${checks} VS Code manifest/compiled-host/protocol/transport checks passed.`);
