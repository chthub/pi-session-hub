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
export class Box { addChild() {} }
export class Text {}
const field = value => value;
export const Type = { Object: field, Optional: field, String: field, Number: field };
`);
const aliases = Object.fromEntries(["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"].map(name => [name, stubs]));
const commands = new Map(), tools = new Map(), events = new Map();
const notices = [], editors = [], selections = [], confirmations = [];
let handoff, active = [];
const pi = {
  registerCommand(name, command) { commands.set(name, command); },
  registerTool(tool) { tools.set(tool.name, tool); },
  registerShortcut() {}, registerMessageRenderer() {},
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
  const { default: activate } = await createJiti(import.meta.url, { alias: aliases }).import("../extensions/session-hub.ts");
  activate(pi);
  await events.get("session_start")();
  assert.equal(commands.size, 6); // /hub is an alias for /session-hub.
  assert.equal(tools.size, 3);
  console.log("PASS Pi host loads and keeps its commands/tools after service extraction");
  await commands.get("session-search").handler("billing", ctx);
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
  assert.ok(selections.length === 1 && selections[0].title.includes("Pi 环境"));
  assert.ok(confirmations.at(-1).includes(`PI_CODING_AGENT_DIR=${path.join(home, ".pi", "agent")}`));
  console.log("PASS Pi native resume selects unresolved config identity before confirmation");
  await tools.get("session_hub_enable").execute();
  assert.deepEqual(active, ["session_hub_search", "session_hub_context"]);
  console.log("PASS history tools retain explicit enable-on-request behavior");
  await events.get("session_shutdown")();
  await events.get("session_shutdown")();
  await events.get("session_start")();
  await commands.get("session-search").handler("billing", ctx);
  assert.ok(!notices.some(note => note.level === "error"));
  console.log("PASS Pi shutdown/restart reopens service without a closed-handle regression");
} finally {
  await events.get("session_shutdown")?.();
  if (previous === undefined) delete process.env.PI_SESSION_HUB_HOME;
  else process.env.PI_SESSION_HUB_HOME = previous;
  fs.rmSync(temp, { recursive: true, force: true });
}
