#!/usr/bin/env node
// Reproducible, synthetic README artwork. Run: node bin/render-vscode-preview.mjs
// No extension activation, session scanning, user configuration, or existing browser
// profile is used. Only the VS Code chrome is simulated; the sidebar and reader use the
// shipped HTML/CSS/JS, real harness SVGs, and the real Markdown/wire renderer.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { once } from "node:events";

const root = path.resolve(import.meta.dirname, "..");
const output = path.join(root, "assets/vscode-session-hub-preview.png");
const media = path.join(root, "vscode-extension/media");
const publicDir = path.join(root, "src/web/public");
const require = createRequire(import.meta.url);
const extensionRequire = createRequire(path.join(root, "vscode-extension/package.json"));
const { build } = extensionRequire("esbuild");
const width = 1440, height = 900, dpr = 1;
const nonce = "synthetic-preview-only";
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "session-hub-preview-"));
const harnesses = ["pi", "claude-code", "codex", "opencode", "crush", "jcode"];
const labels = ["Pi", "Claude Code", "Codex", "OpenCode", "Crush", "JCode"];
const titles = [
  "Design project-scoped search", "Review the keyboard navigation", "Add tests for the session outline",
  "Polish the empty states", "Simplify the command palette", "Check the Markdown renderer",
  "Explore a small CLI prototype", "Plan the docs playground", "Refactor the example API", "Write a release checklist",
];
const rows = titles.map((title, index) => ({
  uid: `${harnesses[index % 6]}:synthetic-${index}`, title,
  harness: harnesses[index % 6], harnessLabel: labels[index % 6],
  recency: ["3 minutes ago", "18 minutes ago", "1 hour ago", "2 hours ago", "3 hours ago", "5 hours ago", "1 day ago", "2 days ago", "3 days ago", "2026-01-12"][index],
  starred: [0, 1, 7].includes(index),
  icons: Object.fromEntries(["light", "dark"].map(theme => [theme, `/media/harness/${theme}/${harnesses[index % 6]}.svg`])),
}));
const synthetic = {
  uid: rows[0].uid, nativeId: "synthetic-0", harness: "pi", title: titles[0],
  path: "/synthetic/history/pi/demo-session.jsonl", cwd: "/synthetic/workspaces/lumen-demo",
  repo: "/synthetic/workspaces/lumen-demo", model: "synthetic-model", messageCount: 10,
  fidelity: { hasToolCalls: true, hasToolResults: true, hasReasoning: false, notes: ["Synthetic conversation created for this preview."] },
  messages: [
    { role: "user", text: "How should project-scoped session search work? Keep the first version small and easy to navigate." },
    { role: "assistant", text: "Use one local index, then keep the reading workflow simple:\n\n- **Group by project.** Put the current workspace first.\n- **Keep history read-only.** Store stars separately from source logs.\n- **Search with context.** Start with user prompts; include tools only when requested.\n\n```ts\nconst searchScope = \"user\";\nconst project = \"/synthetic/workspaces/lumen-demo\";\n```" },
    { role: "toolCall", toolName: "bash", toolCallId: "synthetic-check", text: "node --test test/search.test.mjs" },
    { role: "toolResult", toolName: "bash", toolCallId: "synthetic-check", text: "Synthetic example output: 8 tests passed, 0 failed." },
    { role: "user", text: "Can we keep stars separate from the source logs?" },
    { role: "assistant", text: "Yes. Keep starred session IDs in extension storage. Browsing and starring should never rewrite the original conversation files." },
    { role: "user", text: "Show the questions as a navigable outline." },
    { role: "assistant", text: "List recovered user messages on the right. Selecting a question moves the reader to that point in the conversation; Previous and Next follow the same order." },
    { role: "user", text: "What should we verify before shipping the demo?" },
    { role: "assistant", text: "Check keyboard navigation, empty states, long titles, and read-only source handling. Use synthetic fixtures for screenshots and browser checks." },
  ],
};

let server, chrome, socket;
try {
  // In-memory bundle, exactly as the browser regression does. No build outputs.
  const bundle = await build({
    stdin: { contents: 'export {viewerHtml} from "./vscode-extension/src/sessionViewer.ts"; export {viewerDetail} from "./src/web/presentation.ts";', resolveDir: root },
    bundle: true, platform: "node", format: "cjs", target: "node22", write: false,
    external: ["vscode"], nodePaths: [path.join(root, "vscode-extension/node_modules")],
    alias: { katex: extensionRequire.resolve("katex"), "markdown-it": extensionRequire.resolve("markdown-it") },
  });
  const mod = { exports: {} };
  vm.runInThisContext(`(function(require,module,exports){${bundle.outputFiles[0].text}\n})`)(name => name === "vscode" ? {} : require(name), mod, mod.exports);
  const detail = mod.exports.viewerDetail(synthetic, { locale: "en" });
  const groups = [
    { scope: "current", label: "Current Project", total: 6, sessions: rows.slice(0, 6) },
    { scope: "unscoped", label: "Unassigned", total: 1, sessions: rows.slice(6, 7) },
    { scope: "other", label: "Other Projects", total: 3, sessions: rows.slice(7) },
  ];
  const sidebarState = { type: "sessionHub.sidebar.state", density: "comfortable", status: "", searchOpen: false, search: { text: "", searchScope: "user" }, groups };
  const themeCss = `:root { color-scheme: dark; --vscode-font-family: "Arial", system-ui, sans-serif;
    --vscode-font-size: 14px; --vscode-sideBar-background: #252526;
    --vscode-sideBar-foreground: #cccccc; --vscode-descriptionForeground: #969696;
    --vscode-sideBarSectionHeader-foreground: #cccccc; --vscode-badge-background: #3c3c3c;
    --vscode-badge-foreground: #cccccc; --vscode-list-hoverBackground: #2a2d2e;
    --vscode-sessionHub-starredForeground: #e2b647; --vscode-focusBorder: #007fd4; }
    body { background: #252526; }`;
  let readerHtml;
  const sidebarHtml = fs.readFileSync(path.join(media, "sidebar.html"), "utf8")
    .replaceAll("{{nonce}}", nonce).replaceAll("{{cspSource}}", "'self'")
    .replace("{{style}}", "/media/sidebar.css").replace("{{script}}", "/media/sidebar.js")
    .replace("</head>", '<link rel="stylesheet" href="/host-theme.css"></head>')
    .replace("<body ", '<body class="vscode-dark" ');
  // settings-gear by Microsoft, official VS Code Codicons, CC BY 4.0 (not MIT).
  // Source: https://github.com/microsoft/vscode-codicons/blob/8853e0b1b0e2058b099fde515d5f1f478db2f8e1/src/icons/settings-gear.svg
  // License: https://github.com/microsoft/vscode-codicons/blob/8853e0b1b0e2058b099fde515d5f1f478db2f8e1/LICENSE
  // https://creativecommons.org/licenses/by/4.0/ — supplied without warranties.
  // Original SVG/geometry unchanged; CSS scales to 25px and inherits currentColor.
  // Do not pass through icon(): the official artwork is filled, with no stroke.
  const settingsGear = `<svg width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M12 9C10.3425 9 9.00002 10.3425 9.00002 12C9.00002 13.6575 10.3425 15 12 15C13.6575 15 15 13.6575 15 12C15 10.3425 13.6575 9 12 9ZM12 13.5C11.172 13.5 10.5 12.828 10.5 12C10.5 11.172 11.172 10.5 12 10.5C12.828 10.5 13.5 11.172 13.5 12C13.5 12.828 12.828 13.5 12 13.5ZM21.8475 14.5725L19.9185 12.942C19.8675 12.8985 19.8195 12.8505 19.776 12.7995C19.332 12.279 19.3965 11.5005 19.9185 11.058L21.8475 9.4275C22.0395 9.2655 22.113 9.0045 22.0365 8.766C21.579 7.3545 20.823 6.06 19.8285 4.962C19.7085 4.83 19.5405 4.758 19.368 4.758C19.2975 4.758 19.227 4.77 19.1595 4.794L16.779 5.6415C16.716 5.664 16.65 5.682 16.584 5.694C16.509 5.7075 16.434 5.715 16.3605 5.715C15.7725 5.715 15.2505 5.298 15.141 4.701L14.6865 2.223C14.6415 1.977 14.451 1.782 14.205 1.7295C13.485 1.5765 12.7485 1.5 12.0015 1.5C11.2545 1.5 10.5165 1.578 9.79652 1.7295C9.55052 1.782 9.36002 1.977 9.31502 2.223L8.86202 4.701C8.85002 4.767 8.83202 4.8315 8.80952 4.8945C8.62802 5.4 8.15102 5.715 7.64102 5.715C7.50302 5.715 7.36202 5.691 7.22402 5.643L4.84352 4.7955C4.77602 4.7715 4.70402 4.7595 4.63502 4.7595C4.46252 4.7595 4.29452 4.8315 4.17452 4.9635C3.17852 6.0615 2.42402 7.356 1.96502 8.7675C1.88702 9.006 1.96202 9.267 2.15402 9.429L4.08302 11.0595C4.13402 11.103 4.18202 11.151 4.22552 11.202C4.66952 11.7225 4.60502 12.501 4.08302 12.9435L2.15402 14.574C1.96202 14.736 1.88852 14.997 1.96502 15.2355C2.42252 16.647 3.17852 17.9415 4.17452 19.0395C4.29452 19.1715 4.46252 19.2435 4.63502 19.2435C4.70552 19.2435 4.77602 19.2315 4.84352 19.2075L7.22402 18.36C7.28702 18.3375 7.35302 18.3195 7.41902 18.3075C7.49402 18.294 7.56902 18.288 7.64252 18.288C8.23052 18.288 8.75252 18.705 8.86202 19.302L9.31502 21.78C9.36002 22.026 9.55052 22.221 9.79652 22.2735C10.5165 22.4265 11.2545 22.503 12.0015 22.503C12.7485 22.503 13.4865 22.425 14.205 22.2735C14.451 22.221 14.6415 22.026 14.6865 21.78L15.141 19.302C15.153 19.236 15.171 19.1715 15.1935 19.1085C15.375 18.603 15.852 18.288 16.362 18.288C16.5 18.288 16.641 18.312 16.779 18.36L19.158 19.2075C19.227 19.2315 19.2975 19.2435 19.3665 19.2435C19.539 19.2435 19.707 19.1715 19.827 19.0395C20.823 17.9415 21.5775 16.647 22.035 15.2355C22.113 14.997 22.038 14.736 21.846 14.574L21.8475 14.5725ZM19.092 17.589L17.2815 16.944C16.9845 16.839 16.6755 16.785 16.362 16.785C15.2085 16.785 14.1705 17.514 13.782 18.5985C13.731 18.738 13.6935 18.882 13.6665 19.029L13.3215 20.9055C12.8865 20.9685 12.444 21 12.0015 21C11.559 21 11.1165 20.9685 10.68 20.904L10.3365 19.0275C10.098 17.727 8.96552 16.7835 7.64252 16.7835C7.48052 16.7835 7.31552 16.7985 7.14902 16.8285C7.00352 16.8555 6.86102 16.893 6.72002 16.9425L4.90952 17.5875C4.35752 16.896 3.91652 16.1385 3.59102 15.321L5.05202 14.0865C5.61152 13.614 5.95202 12.951 6.01202 12.222C6.07202 11.493 5.84252 10.785 5.36702 10.227C5.27102 10.1145 5.16452 10.008 5.05202 9.912L3.59102 8.6775C3.91652 7.86 4.35752 7.101 4.90952 6.411L6.72002 7.056C7.01702 7.161 7.32602 7.215 7.64102 7.215C8.79452 7.215 9.83252 6.486 10.221 5.4015C10.272 5.2605 10.3095 5.1165 10.3365 4.971L10.68 3.0945C11.1165 3.0315 11.559 2.9985 12.0015 2.9985C12.444 2.9985 12.8865 3.03 13.3215 3.093L13.665 4.9695C13.9035 6.27 15.036 7.2135 16.359 7.2135C16.521 7.2135 16.686 7.1985 16.851 7.1685C16.9965 7.1415 17.1405 7.104 17.2815 7.0545L19.092 6.4095C19.644 7.0995 20.085 7.8585 20.4105 8.676L18.951 9.9105C18.3915 10.383 18.0495 11.046 17.991 11.775C17.931 12.504 18.1605 13.2135 18.636 13.77C18.7335 13.884 18.8385 13.989 18.9525 14.085L20.4135 15.3195C20.088 16.137 19.647 16.896 19.095 17.586L19.092 17.589Z"/></svg>`;
  const icon = (content, extra = "") => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" ${extra}>${content}</svg>`;
  const searchIcon = icon('<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>');
  const plusIcon = icon('<path d="M12 5v14M5 12h14"/>');
  const refreshIcon = icon('<path d="M19 8a8 8 0 1 0 1 7M19 3v6h-6"/>');
  const shellHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; frame-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'">
  <meta name="viewport" content="width=device-width, initial-scale=1"><title>Synthetic Session Hub preview</title>
  <style>
  :root { color-scheme: dark; --chrome: #181818; --edge: #303030; --text: #cccccc; --dim: #919191; --sidebar: #252526; }
  * { box-sizing: border-box; } body { margin:0; height:100dvh; display:grid; grid-template-rows:40px minmax(0,1fr) 24px; background:var(--chrome); color:var(--text); font:13px Arial,system-ui,sans-serif; overflow:hidden; }
  .titlebar { display:flex; align-items:center; gap:18px; padding:0 14px; border-bottom:1px solid var(--edge); background:#1f1f1f; }
  .app-symbol { color:#75beff; font-size:20px; font-weight:700; } .menus { display:flex; gap:16px; font-size:12px; }
  .command { position:absolute; left:34%; width:40%; height:27px; display:flex; align-items:center; justify-content:center; gap:9px; border:1px solid #414141; border-radius:6px; background:#292929; font-size:12px; color:#bdbdbd; }
  .command svg { width:14px; height:14px; } .window-controls { margin-left:auto; display:flex; gap:28px; color:#aaa; font-size:16px; }
  .workbench { display:grid; grid-template-columns:48px 318px minmax(0,1fr); min-height:0; }
  .activity { display:flex; flex-direction:column; align-items:center; border-right:1px solid var(--edge); background:#181818; }
  .activity-item { width:48px; height:49px; display:grid; place-items:center; color:#858585; } .activity-item svg,.activity-item img { width:25px; height:25px; }
  .activity-item.selected { border-left:2px solid #79b8ff; color:#eee; background:#202020; padding-right:2px; } .activity-spacer { flex:1; }
  .sidebar { background:var(--sidebar); border-right:1px solid var(--edge); min-height:0; display:grid; grid-template-rows:38px 28px minmax(0,1fr); }
  .side-title { display:flex; align-items:center; justify-content:space-between; padding:0 18px; font-size:11px; letter-spacing:.8px; } .ellipsis { font-size:18px; letter-spacing:2px; }
  .section-title { display:flex; align-items:center; padding:0 10px; background:#252526; font-size:11px; font-weight:700; gap:7px; }
  .section-tools { margin-left:auto; display:flex; align-items:center; gap:12px; } .section-tools svg { width:15px; height:15px; color:#c5c5c5; }
  .editor { min-height:0; min-width:0; display:grid; grid-template-rows:36px minmax(0,1fr); }
  .tabs { display:flex; align-items:stretch; background:#181818; border-bottom:1px solid var(--edge); }
  .tab { display:flex; align-items:center; gap:9px; padding:0 15px; background:#1b232d; border-top:1px solid #80d4c7; border-right:1px solid var(--edge); font-size:12px; color:#eee; }
  .tab img { width:16px; height:16px; } .tab-close { margin-left:24px; color:#a8b4bf; font-size:16px; }
  .tab-note { margin-left:auto; display:flex; align-items:center; padding:0 15px; color:#9ba6af; font-size:11px; white-space:nowrap; }
  iframe { display:block; border:0; width:100%; height:100%; min-height:0; background:var(--sidebar); }
  .statusbar { display:flex; align-items:center; gap:15px; border-top:1px solid var(--edge); background:#181818; color:#bfbfbf; font-size:11px; padding-right:12px; }
  .remote { align-self:stretch; display:flex; align-items:center; gap:7px; background:#176b97; padding:0 12px; color:#fff; }
  .statusbar svg { width:13px; height:13px; } .status-spacer { flex:1; }
  </style></head><body>
  <header class="titlebar"><span class="app-symbol">⌁</span><nav class="menus"><span>File</span><span>Edit</span><span>Selection</span><span>View</span><span>Go</span><span>Run</span><span>Terminal</span><span>Help</span></nav><div class="command">${searchIcon}<span>lumen-demo [SSH: demo-host.invalid]</span></div><div class="window-controls"><span>−</span><span>□</span><span>×</span></div></header>
  <div class="workbench">
  <nav class="activity" aria-label="Activity Bar">
    <div class="activity-item">${icon('<path d="M8 3h10v15H8zM5 7H3v14h11v-2"/>')}</div>
    <div class="activity-item">${searchIcon}</div>
    <div class="activity-item">${icon('<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10M8 14c7 0 10-1 10-5"/>')}</div>
    <div class="activity-item">${icon('<path d="m10 5 10 7-10 7zM4 10v10M1 14h6M2 18h5"/>')}</div>
    <div class="activity-item">${icon('<path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z"/>')}</div>
    <div class="activity-item selected"><img src="/media/session-hub.svg" alt="Session Hub"></div>
    <div class="activity-spacer"></div>
    <div class="activity-item">${icon('<circle cx="12" cy="8" r="4"/><path d="M4 22v-2a8 8 0 0 1 16 0v2"/>')}</div>
    <div class="activity-item">${settingsGear}</div>
  </nav>
  <aside class="sidebar"><div class="side-title"><span>SESSION HUB</span><span class="ellipsis">···</span></div><div class="section-title"><span>⌄</span><span>SESSION HISTORY</span><div class="section-tools">${searchIcon}${plusIcon}${refreshIcon}</div></div><iframe id="sidebar-frame" title="Actual Session History sidebar" src="/sidebar"></iframe></aside>
  <section class="editor"><div class="tabs"><div class="tab"><img src="/media/harness/dark/pi.svg" alt="Pi"><span>Design project-scoped search</span><span class="tab-close">×</span></div><span class="tab-note">Simulated preview · synthetic sessions</span></div><iframe id="reader-frame" title="Actual conversation reader" src="/reader"></iframe></section>
  </div>
  <footer class="statusbar"><span class="remote">${icon('<path d="m8 5-5 7 5 7M16 5l5 7-5 7"/>')} SSH: demo-host.invalid</span><span>⑂ demo/synthetic-preview</span><span>ⓧ 0　⚠ 0</span><span class="status-spacer"></span><span>Session Hub</span><span>UTF-8</span><span>◉</span></footer>
  </body></html>`;

  const files = new Map([
    ["/media/sidebar.css", [path.join(media, "sidebar.css"), "text/css"]],
    ["/media/sidebar.js", [path.join(media, "sidebar.js"), "text/javascript"]],
    ["/media/session-hub.svg", [path.join(media, "session-hub.svg"), "image/svg+xml"]],
    ...["app.js", "transport.js", "style.css"].map(file => [`/${file}`, [path.join(publicDir, file), file.endsWith("js") ? "text/javascript" : "text/css"]]),
    ...harnesses.flatMap(harness => ["light", "dark"].map(theme => [`/media/harness/${theme}/${harness}.svg`, [path.join(media, "harness", theme, `${harness}.svg`), "image/svg+xml"]])),
  ]);
  const katexDir = path.join(path.dirname(extensionRequire.resolve("katex/package.json")), "dist");
  files.set("/katex/katex.min.css", [path.join(katexDir, "katex.min.css"), "text/css"]);
  for (const file of fs.readdirSync(path.join(katexDir, "fonts"))) if (/\.woff2?$/.test(file)) files.set(`/katex/fonts/${file}`, [path.join(katexDir, "fonts", file), file.endsWith("woff2") ? "font/woff2" : "font/woff"]);
  // Fail before launching Chrome if any packaged resource is absent. These
  // paths are repository assets and installed package assets, never dist output.
  for (const [route, [file]] of files) assert.ok(fs.statSync(file).isFile(), `Missing local resource: ${route}`);
  console.log(`PASS preflight: ${files.size} local resources available; no vscode-extension/dist dependency`);
  const served = new Set(), missing = [];
  server = http.createServer((req, res) => {
    const route = new URL(req.url, "http://127.0.0.1").pathname;
    served.add(route);
    res.setHeader("Cache-Control", "no-store");
    const html = route === "/" ? shellHtml : route === "/sidebar" ? sidebarHtml : route === "/reader" ? readerHtml : null;
    if (html) { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(html); return; }
    if (route === "/host-theme.css") { res.setHeader("Content-Type", "text/css"); res.end(themeCss); return; }
    if (route === "/favicon.ico") { res.writeHead(204); res.end(); return; }
    const file = files.get(route);
    if (!file) { missing.push(route); res.writeHead(404); res.end(); return; }
    res.setHeader("Content-Type", file[1]); res.end(fs.readFileSync(file[0]));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  readerHtml = mod.exports.viewerHtml(fs.readFileSync(path.join(publicDir, "index.html"), "utf8"), synthetic.uid, origin, nonce, file => `${origin}/${file}`);
  // Inject the mock before either real webview script executes. The fixture and
  // messages below are all in-memory constants; no host service is activated.
  const mock = `(() => {
    const state = ${JSON.stringify(sidebarState)};
    const detail = ${JSON.stringify(detail)};
    const send = data => window.dispatchEvent(new MessageEvent('message', {data}));
    let saved = {collapsed:{current:false,unscoped:false,other:false}}, calls = [];
    window.previewCalls = calls;
    window.acquireVsCodeApi = () => ({ getState:()=>saved, setState:value=>{saved=value;}, postMessage:request=>{
      calls.push(request);
      setTimeout(()=>{
        if(request.type==='sessionHub.sidebar') {
          if(request.action==='ready'||request.action==='search') send(state);
          if(request.action==='star') { for(const group of state.groups) for(const row of group.sessions) if(row.uid===request.uid) row.starred=request.starred; send(state); }
          send({type:'sessionHub.sidebar.result',id:request.id});
        } else if(request.type==='sessionHub.request') {
          const result = request.operation==='getSession' ? detail : request.operation==='status' ? {scan:{total:10,errors:[]},harnesses:${JSON.stringify(harnesses)}} : {ok:true};
          send({type:'sessionHub.response',id:request.id,result});
        }
      },0);
    }});
  })();`;

  chrome = spawn(process.env.CHROME_BIN ?? "google-chrome", [
    "--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--disable-background-networking", "--disable-component-update", "--disable-sync",
    "--disable-default-apps", "--disable-extensions", "--no-first-run", "--no-default-browser-check",
    "--disable-features=MediaRouter,OptimizationHints,AutofillServerCommunication",
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
    "--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=127.0.0.1",
    "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
    `--user-data-dir=${path.join(temp, "fresh-browser-profile")}`, "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
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
  const pending = new Map(), exceptions = [], failures = [], requests = [], denied = [];
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (message.id) { const entry = pending.get(message.id); if (entry) { clearTimeout(entry.timer); pending.delete(message.id); if (message.error) entry.reject(new Error(message.error.message)); else entry.resolve(message.result); } }
    if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails);
    if (message.method === "Network.loadingFailed") failures.push(message.params.errorText);
    if (message.method === "Network.requestWillBeSent") requests.push(message.params.request.url);
    if (message.method === "Fetch.requestPaused") {
      const { requestId, request } = message.params;
      const allowed = new URL(request.url).origin === origin;
      if (!allowed) denied.push(request.url);
      cdp(allowed ? "Fetch.continueRequest" : "Fetch.failRequest", allowed ? { requestId } : { requestId, errorReason: "BlockedByClient" }).catch(error => exceptions.push(error.message));
    }
  });
  const evaluate = async expression => {
    const result = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const wait = async expression => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { if (await evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 40)); }
    throw new Error(`Preview did not become ready: ${expression}\n${JSON.stringify({ exceptions, failures, missing })}`);
  };
  await cdp("Runtime.enable"); await cdp("Network.enable"); await cdp("Page.enable");
  await cdp("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
  await cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: dpr, mobile: false });
  await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }, { name: "prefers-reduced-motion", value: "reduce" }] });
  await cdp("Page.addScriptToEvaluateOnNewDocument", { source: mock });
  await cdp("Page.navigate", { url: origin + "/" });
  const side = `document.getElementById('sidebar-frame').contentDocument`;
  const reader = `document.getElementById('reader-frame').contentDocument`;
  await wait(`${side}?.querySelectorAll('.session-card').length===10 && ${reader}?.querySelectorAll('.message-user').length===4`);
  await evaluate(`Promise.all([document.fonts.ready, ${side}.fonts.ready, ${reader}.fonts.ready])`);
  await wait(`Array.from(${side}.images).every(image=>image.complete && image.naturalWidth>0)`);
  await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);

  // Verify the exact DOM that is photographed, including the actual action and
  // question navigation. Undo the navigation before capturing the top of reader.
  const checks = await evaluate(`(() => {
    const s=${side}, r=${reader};
    const resume=r.querySelector('.resume-button');
    const rect=resume.getBoundingClientRect();
    return {
      groups:s.querySelectorAll('.group[open]').length,
      harnesses:[...new Set(Array.from(s.querySelectorAll('.harness-icon-slot'),n=>n.dataset.harness))],
      stars:s.querySelectorAll('.star-button[aria-pressed="true"]').length,
      userQuestions:r.querySelectorAll('.outline-item').length,
      resume:resume.textContent.includes('Resume in terminal') && rect.top>=0 && rect.bottom<r.documentElement.clientHeight,
      overflow:[document,s,r].some(d=>d.documentElement.scrollWidth>d.documentElement.clientWidth),
      sidebarClipped:s.documentElement.scrollHeight>s.documentElement.clientHeight,
      annotation:document.body.innerText.includes('Simulated preview · synthetic sessions'),
      english:r.documentElement.lang==='en' && s.documentElement.lang==='en',
    };
  })()`);
  assert.equal(checks.groups, 3); assert.equal(checks.harnesses.length, 6);
  assert.equal(checks.stars, 3); assert.equal(checks.userQuestions, 4);
  assert.ok(checks.resume && checks.annotation && checks.english);
  assert.equal(checks.overflow, false); assert.equal(checks.sidebarClipped, false);
  await evaluate(`${reader}.querySelector('.resume-button').click(); ${reader}.querySelector('#next-user').click()`);
  await wait(`${reader}.querySelector('#outline-position').textContent==='User message 2 / 4'`);
  assert.ok(await evaluate(`document.getElementById('reader-frame').contentWindow.previewCalls.some(call=>call.operation==='resume')`));
  await evaluate(`${reader}.querySelector('#previous-user').click(); ${reader}.querySelector('#viewer').scrollTop=0`);
  await wait(`${reader}.querySelector('#outline-position').textContent==='User message 1 / 4'`);
  await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  assert.deepEqual(exceptions, []); assert.deepEqual(failures, []); assert.deepEqual(missing, []); assert.deepEqual(denied, []);
  assert.ok(requests.every(url => new URL(url).origin === origin));
  for (const harness of harnesses) assert.ok(served.has(`/media/harness/dark/${harness}.svg`));
  const screenshot = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, fromSurface: true });
  const png = Buffer.from(screenshot.data, "base64");
  // Keep only standard PNG image/color chunks: no text, EXIF, time, source path,
  // or other ancillary metadata can enter the committed README artwork.
  const chunks = [png.subarray(0, 8)], kept = [];
  for (let pos = 8; pos < png.length;) {
    const length = png.readUInt32BE(pos), type = png.toString("ascii", pos + 4, pos + 8);
    if (["IHDR", "IDAT", "IEND", "PLTE", "tRNS", "sRGB", "gAMA", "cHRM"].includes(type)) { chunks.push(png.subarray(pos, pos + length + 12)); kept.push(type); }
    pos += length + 12;
  }
  const cleanPng = Buffer.concat(chunks);
  assert.equal(cleanPng.readUInt32BE(16), width * dpr); assert.equal(cleanPng.readUInt32BE(20), height * dpr);
  fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, cleanPng);
  console.log(`PASS real sidebar / reader / Markdown assets; ${checks.harnesses.length} harness icons; ${checks.groups} expanded groups; ${checks.stars} stars; ${checks.userQuestions} questions`);
  console.log("PASS Resume in terminal mock and Previous/Next question navigation");
  console.log(`PASS ${served.size} local routes; no missing resources, external requests, JS exceptions, horizontal overflow, or clipped sidebar`);
  console.log(`PASS PNG metadata allowlist: ${[...new Set(kept)].join(", ")}`);
  console.log(`Saved assets/vscode-session-hub-preview.png (${width}×${height}, DPR ${dpr}, ${cleanPng.length} bytes)`);
} finally {
  socket?.close();
  if (chrome && chrome.exitCode === null) {
    const exited = once(chrome, "exit"); chrome.kill("SIGTERM");
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
    if (chrome.exitCode === null) { chrome.kill("SIGKILL"); await exited; }
  }
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  fs.rmSync(temp, { recursive: true, force: true });
}
