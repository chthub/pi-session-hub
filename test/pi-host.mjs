import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";
import { buildToolHome } from "./fixtures/tool-home.mjs";
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "hub-pi-host-"));
const home = path.join(temp, "home");
const previous = process.env.PI_SESSION_HUB_HOME;
const stubs = path.join(temp, "host-stubs.mjs");
fs.writeFileSync(stubs, `export class BorderedLoader { setMessage() {} }
export class Box {
  children = [];
  addChild(child) { this.children.push(child); }
  clear() { this.children = []; }
  render(width) { return this.children.flatMap(child => child.render(width)); }
}
export class Text {
  constructor(text) { this.text = text; }
  render() { return this.text.split("\\n"); }
}
export class MouseRegion {
  constructor(child, onMouse) { this.child = child; this.onMouse = onMouse; }
  render(width) { return this.child.render(width); }
  handleMouse(event) { return this.onMouse(event); }
}
let expandKey = "ctrl+o";
export function keyText() { return expandKey; }
export function setExpandKey(key) { expandKey = key; }
const field = value => value;
export const Type = { Object: field, Optional: field, String: field, Number: field };
`);
const aliases = Object.fromEntries(["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"].map(name => [name, stubs]));
const commands = new Map(), tools = new Map(), events = new Map(), renderers = new Map();
const notices = [], editors = [], selections = [], confirmations = [];
let handoff, active = [];
const pi = {
  registerCommand(name, command) { commands.set(name, command); },
  registerTool(tool) { tools.set(tool.name, tool); },
  registerShortcut() {},
  registerMessageRenderer(name, renderer) { renderers.set(name, renderer); },
  on(name, handler) { events.set(name, handler); },
  getAllTools() { return [...tools.values()]; },
  getActiveTools() { return active; }, setActiveTools(value) { active = value; },
};
const ctx = {
  mode: "tui", sessionManager: { getSessionFile: () => null },
  ui: {
    notify(text, level) { notices.push({ text, level }); },
    async custom(factory) { return new Promise(done => { factory({}, {}, {}, done); }); },
    async editor(title, body) { editors.push({ title, body }); },
    async select(title, options) { selections.push({ title, options }); return options[0]; },
    async confirm(_title, body) { confirmations.push(body); return false; },
  },
  async newSession({ withSession }) {
    await withSession({ ui: { setEditorText(text) { handoff = text; }, notify() {} } });
    return { cancelled: false };
  },
};
try {
  await buildToolHome(home);
  process.env.PI_SESSION_HUB_HOME = home;
  const jiti = createJiti(import.meta.url, { alias: aliases });
  const { default: activate } = await jiti.import("../extensions/session-hub.ts");
  activate(pi);
  const dbPath = path.join(home, ".pi", "agent", "pi-session-hub", "index.sqlite");
  assert.equal(fs.existsSync(dbPath), false);
  const started = performance.now();
  await events.get("session_start")();
  assert.equal(fs.existsSync(dbPath), false, "session_start must not open/create the index");
  console.log(`PASS lazy session_start: ${(performance.now() - started).toFixed(3)} ms, no index created`);
  assert.equal(commands.size, 6); // /hub is an alias for /session-hub.
  assert.equal(tools.size, 3);
  console.log("PASS Pi host loads and keeps its commands/tools after service extraction");

  const renderImport = renderers.get("session-hub-import");
  const theme = { fg: (_color, text) => text, bg: (_color, text) => text, bold: text => text };
  const message = {
    content: ["- Original objective: synthetic objective", ...Array.from({ length: 350 }, (_, i) => `line ${i}`), "END_IMPORTED_CONTEXT"].join("\n"),
    details: { harness: "claude-code", sourcePath: "/synthetic/session.jsonl" },
  };
  const options = { expanded: false, outputPad: 1 };
  let importedBox = renderImport(message, options, theme);
  const rendered = () => importedBox.render(100).join("\n");
  const click = event => importedBox.children.find(child => child.handleMouse)?.handleMouse(event);
  assert.ok(rendered().includes("click to expand") && rendered().includes("ctrl+o"));
  assert.ok(!rendered().includes("END_IMPORTED_CONTEXT"));
  for (const event of [{ type: "click", button: "right" }, { type: "wheel", button: "none" }, { type: "drag", button: "left" }]) {
    assert.equal(click(event), undefined);
    assert.ok(!rendered().includes("END_IMPORTED_CONTEXT"));
  }
  assert.deepEqual(click({ type: "click", button: "left" }), { handled: true, render: true });
  assert.ok(rendered().includes("END_IMPORTED_CONTEXT") && rendered().includes("click to collapse"));
  importedBox = renderImport(message, options, theme); // Resize/theme rebuild, unchanged global expansion.
  assert.ok(rendered().includes("END_IMPORTED_CONTEXT"));
  assert.ok(!renderImport({ ...message }, options, theme).render(100).join("\n").includes("END_IMPORTED_CONTEXT"));
  click({ type: "click", button: "left" });
  assert.ok(!rendered().includes("END_IMPORTED_CONTEXT"));
  importedBox = renderImport(message, { ...options, expanded: true }, theme);
  assert.ok(rendered().includes("END_IMPORTED_CONTEXT"));
  importedBox = renderImport(message, options, theme);
  assert.ok(!rendered().includes("END_IMPORTED_CONTEXT"));
  const { setExpandKey } = await jiti.import(stubs);
  setExpandKey("alt+o");
  importedBox = renderImport(message, options, theme);
  assert.ok(rendered().includes("alt+o") && !rendered().includes("ctrl+o"));
  setExpandKey("");
  importedBox = renderImport(message, options, theme);
  assert.ok(rendered().includes("click to expand") && !rendered().includes("toggles all"));
  setExpandKey("ctrl+o");
  console.log("PASS imported transcript click/keyboard expansion, local-state isolation, rebuild persistence, custom/disabled keys and content beyond 300 lines");

  await tools.get("session_hub_enable").execute();
  assert.equal(fs.existsSync(dbPath), false, "enabling history tools must not access history");
  await commands.get("session-search").handler("billing", ctx);
  assert.equal(fs.existsSync(dbPath), true, "first history use initializes the index");
  assert.ok(notices.some(note => note.text.includes("pi:11111111")));
  console.log("PASS Pi search indexes/queries through shared service");
  await commands.get("session-open").handler("pi:11111111", ctx);
  assert.ok(editors[0].body.includes("fake pi") && editors[0].body.includes("/srv/work/acme-api"));
  console.log("PASS Pi open resolves existing prefixes then reads the indexed source");
  const imported = await tools.get("session_hub_context").execute("test", { id: "pi:11111111" }, null, null, ctx);
  assert.ok(imported.content[0].text.includes("# Imported Session Context"));
  await commands.get("session-handoff").handler("pi:11111111", ctx);
  assert.ok(handoff.includes("# Imported Session Handoff"));
  console.log("PASS Pi context/handoff retain imported-source semantics");
  await commands.get("session-native").handler("pi:11111111", ctx);
  assert.ok(notices.some(note => note.text === "Cancelled"));
  assert.ok(selections.length === 1 && selections[0].title.includes("Pi environment"));
  assert.ok(confirmations.at(-1).includes(`PI_CODING_AGENT_DIR=${path.join(home, ".pi", "agent")}`));
  console.log("PASS Pi native resume selects unresolved config identity before confirmation");
  await tools.get("session_hub_enable").execute();
  assert.deepEqual(active, ["session_hub_search", "session_hub_context"]);
  console.log("PASS history tools retain explicit enable-on-request behavior");
  await events.get("session_shutdown")();
  await events.get("session_shutdown")();
  const beforeRestart = fs.readFileSync(dbPath);
  const mtime = fs.statSync(dbPath).mtimeMs;
  await events.get("session_start")();
  assert.deepEqual(fs.readFileSync(dbPath), beforeRestart);
  assert.equal(fs.statSync(dbPath).mtimeMs, mtime, "session restart must not maintain the index");
  const coldContext = await tools.get("session_hub_context").execute("cold", { id: "pi:11111111" }, null, null, ctx);
  assert.ok(coldContext.content[0].text.includes("# Imported Session Context"));
  await commands.get("session-search").handler("billing", ctx);
  assert.ok(!notices.some(note => note.level === "error"));
  console.log("PASS Pi shutdown/restart reopens service without a closed-handle regression");
} finally {
  await events.get("session_shutdown")?.();
  if (previous === undefined) delete process.env.PI_SESSION_HUB_HOME;
  else process.env.PI_SESSION_HUB_HOME = previous;
  fs.rmSync(temp, { recursive: true, force: true });
}
