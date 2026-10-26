/** Synthetic stores only. Run: node test/search-scopes.mjs */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { buildFakeHome } = await jiti.import("./fixtures/fake-home.mjs");
const { AdapterRegistry } = await jiti.import("../src/adapters/registry.ts");
const { scan } = await jiti.import("../src/index/scan.ts");
const { openIndex, querySessions, removeSessions, indexedFileSessions, sourceFingerprint, PARSER_VERSION } = await jiti.import("../src/index/db.ts");
const { openIndexDb } = await jiti.import("../src/sqlite.ts");
const { ScopedSearchText, SCOPE_BLOCK_BUDGET } = await jiti.import("../src/adapters/search-content.ts");
const { SEARCH_TEXT_BUDGET } = await jiti.import("../src/adapters/util.ts");
const { viewerDetail } = await jiti.import("../src/web/presentation.ts");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "hub-search-scopes-"));
const dbPath = path.join(home, "index.sqlite");
const harnesses = ["pi", "claude-code", "codex", "opencode", "crush", "jcode"];
const text = value => ({ type: "text", text: value });
const user = [text("userneedle exact prompt phrase"), { type: "tool_result", content: "nestedoutputneedle", tool_use_id: "nested" }, text("mixeduserneedle")];
const assistant = [text("assistantneedle exact answer phrase"), { type: "tool_use", name: "toolnameneedle", input: { command: "argumentneedle", password: "credentialneedle" } }, { type: "thinking", thinking: "reasoningneedle" }];
const messages = [
  { role: "user", content: user },
  { role: "assistant", content: assistant },
  { role: "toolResult", content: "outputneedle" },
  { role: "system", content: "systemneedle" },
  // More than 400 early tool records must not hide the prompts/prose at either
  // end. It also exercises DB-backed complete scans beyond legacy opening caps.
  ...Array.from({ length: 450 }, (_, i) => ({ role: "toolResult", content: `tool flood ${i} ${"payload ".repeat(700)}` })),
  { role: "user", content: "lateuserneedle" },
  { role: "assistant", content: "lateassistantneedle" },
];
let index;
try {
  await buildFakeHome(home);
  const registry = new AdapterRegistry(home);
  const paths = new Map();
  for (const id of ["pi", "claude-code", "codex", "jcode"]) paths.set(id, registry.get(id).files()[0]);
  const writeLines = (id, records) => fs.writeFileSync(paths.get(id), records.map(row => JSON.stringify(row)).join("\n") + "\n");
  writeLines("pi", [
    { type: "session", id: "scopes", cwd: "/synthetic/metadataonly" },
    { type: "session_info", name: "titleonly" },
    { type: "message", message: { role: "assistant", content: "", tool_calls: [
      { type: "function", function: { name: "openaicallneedle", arguments: JSON.stringify({ command: "openaiargumentneedle" }) } },
      { id: "legacy", name: "legacycallneedle", arguments: { command: "legacyargumentneedle" } },
    ] } },
    { type: "message", message: { role: "system", content: "", sections: { project_context: "sectionneedle", tools: "toolsectionneedle" } } },
    { type: "compaction", summary: "compactionneedle", systemMessage: { role: "system", content: "checkpointneedle", sections: { project_context: "checkpointsectionneedle" } } },
    { type: "message", message: { role: "user", content: "normal prompt", sections: { project_context: "untrustedsectionneedle" } } },
    { type: "compaction", systemMessage: { role: "user", sections: { project_context: "untrustedcheckpointneedle" } } },
    ...messages.map(message => ({ type: "message", message })),
  ]);
  writeLines("claude-code", [
    { type: "ai-title", title: "titleonly", sessionId: "scopes", cwd: "/synthetic/metadataonly" },
    ...messages.map(message => ({ type: message.role === "system" ? "system" : message.role === "assistant" ? "assistant" : "user", message: message.role === "toolResult" ? { role: "user", content: [{ type: "tool_result", content: message.content }] } : message })),
    { type: "user", isMeta: true, message: { role: "user", content: "metaneedle" } },
  ]);
  writeLines("codex", [
    { type: "session_meta", payload: { id: "scopes", cwd: "/synthetic/metadataonly" } },
    ...messages.flatMap(message => {
      if (message.role === "toolResult") return [{ type: "response_item", payload: { type: "function_call_output", output: message.content } }];
      if (message.role === "assistant" && Array.isArray(message.content)) return [
        { type: "response_item", payload: { type: "message", role: "assistant", content: [message.content[0]] } },
        { type: "response_item", payload: { type: "function_call", name: "toolnameneedle", arguments: JSON.stringify({ command: "argumentneedle", password: "credentialneedle" }) } },
        { type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: "reasoningneedle" }] } },
      ];
      return [{ type: "response_item", payload: { type: "message", ...message } }];
    }),
  ]);
  fs.writeFileSync(paths.get("jcode"), JSON.stringify({ id: "scopes", title: "titleonly", working_dir: "/synthetic/metadataonly", messages }));
  const crush = await openIndexDb(path.join(home, ".crush", "crush.db"));
  crush.run("delete from messages");
  crush.run("update sessions set title = ?", ["titleonly"]);
  for (const [i, message] of messages.entries()) {
    // Exercise nested data payloads, including tool args/results/reasoning.
    const parts = typeof message.content === "string" ? message.content : message.content.map(({ type, ...data }) => ({ type, data }));
    crush.run("insert into messages (id,session_id,role,parts,created_at,updated_at) values (?,?,?,?,?,?)", [String(i), "crush-fake-1", message.role, JSON.stringify(parts), i, i]);
  }
  crush.close();
  const oc = await openIndexDb(path.join(home, ".local", "share", "opencode", "opencode.db"));
  oc.run("delete from part"); oc.run("delete from message");
  const ocId = oc.get("select id from session").id;
  oc.run("update session set title = ?, directory = ?", ["titleonly", "/synthetic/metadataonly"]);
  let partId = 0;
  for (const [i, message] of messages.entries()) {
    oc.run("insert into message (id,session_id,time_created,time_updated,data) values (?,?,?,?,?)", [String(i), ocId, i, i, JSON.stringify({ role: message.role })]);
    const blocks = typeof message.content === "string" ? [text(message.content)] : message.content;
    for (let block of blocks) {
      if (block.type === "tool_use") block = { type: "tool", tool: block.name, state: { input: block.input, output: "stateoutputneedle" } };
      if (block.type === "thinking") block = { type: "reasoning", text: block.thinking };
      oc.run("insert into part (id,message_id,session_id,time_created,time_updated,data) values (?,?,?,?,?,?)", [String(partId++), String(i), ocId, i, i, JSON.stringify(block)]);
    }
  }
  oc.close();
  index = await openIndex(dbPath);
  assert.ok(index);
  const first = await scan(index, registry);
  assert.equal(first.total, 6);
  assert.deepEqual(first.errors, []);
  const matches = (needle, scope, extra = {}) => querySessions(index, { text: needle, ...(scope === undefined ? {} : { searchScope: scope }), ...extra });
  const ids = rows => rows.map(row => row.harness).sort();
  const allHarnesses = [...harnesses].sort();
  for (const scope of ["user", "conversation", "all"]) {
    for (const needle of ["userneedle", "mixeduserneedle", "lateuserneedle", '"exact prompt phrase"', "userneed", "userneedle -absentneedle"]) assert.deepEqual(ids(matches(needle, scope)), allHarnesses, `${scope}: ${needle}`);
  }
  for (const needle of ["assistantneedle", "lateassistantneedle", '"exact answer phrase"', "userneedle assistantneedle"]) {
    assert.equal(matches(needle, "user").length, 0, needle);
    for (const scope of ["conversation", "all"]) assert.deepEqual(ids(matches(needle, scope)), allHarnesses, `${scope}: ${needle}`);
  }
  for (const needle of ["toolnameneedle", "argumentneedle", "nestedoutputneedle", "outputneedle", "reasoningneedle", "systemneedle"]) {
    for (const scope of ["user", "conversation"]) assert.equal(matches(needle, scope).length, 0, `${scope} excludes ${needle}`);
    assert.deepEqual(ids(matches(needle, "all")), allHarnesses, `all: ${needle}`);
  }
  for (const scope of ["user", "conversation"]) {
    assert.equal(matches("titleonly", scope).length, 0);
    assert.equal(matches("metadataonly", scope).length, 0);
    assert.equal(matches("metaneedle", scope).length, 0);
    assert.equal(matches("stateoutputneedle", scope).length, 0);
  }
  assert.equal(matches("titleonly", "all").length, 5); // Codex has no source title.
  assert.equal(matches("titleonly").length, 5); // Legacy metadata search remains.
  assert.equal(matches("toolnameneedle").length, 0); // Legacy body remains prose-only.
  assert.equal(matches("metaneedle", "all").length, 1);
  assert.equal(matches("stateoutputneedle", "all").length, 1);
  for (const needle of ["openaicallneedle", "openaiargumentneedle", "legacycallneedle", "legacyargumentneedle", "sectionneedle", "toolsectionneedle", "compactionneedle", "checkpointneedle", "checkpointsectionneedle"]) {
    assert.equal(matches(needle, "all", { harness: "pi" }).length, 1, needle);
    for (const scope of ["user", "conversation"]) assert.equal(matches(needle, scope).length, 0, `${scope} excludes ${needle}`);
    assert.equal(matches(needle).length, 0, `legacy excludes ${needle}`);
  }
  assert.equal(matches("untrustedsectionneedle", "all").length, 0);
  assert.equal(matches("untrustedcheckpointneedle", "all").length, 0);
  assert.equal(matches("credentialneedle", "all").length, 0);
  assert.equal(matches("userneedle -assistantneedle", "user").length, 6);
  assert.equal(matches("userneedle -assistantneedle", "conversation").length, 0);
  assert.equal(matches("userneedle", "user", { harness: "pi", repo: "/synthetic/metadataonly" }).length, 1);
  assert.equal(matches("userneedle", "user", { harness: "crush", filePath: "uploader.ts", changedOnly: true }).length, 1);
  assert.equal(matches("userneedle", "user", { limit: 2, offset: 2 }).length, 2);
  assert.equal(querySessions(index, { searchScope: "user", text: "" }).length, 6);
  console.log("PASS all six adapters: strict role boundaries, nested tool envelopes, source tool names/arguments/results, reasoning/system, legacy search, phrases/prefix/negation and filters");
  console.log("PASS Pi typed/OpenAI and untyped legacy tool_calls, structured system sections and compaction checkpoints index only in all scope");

  const detail = await registry.get("pi").getSessionByRef({ uid: "pi:scopes", nativeId: "scopes", harness: "pi", path: paths.get("pi") });
  assert.ok(detail.searchScopes);
  assert.ok(!("searchScopes" in viewerDetail(detail)));
  assert.ok(!("searchText" in viewerDetail(detail)));

  const scopeSnapshot = () => index.db.all("select uid, user_text, conversation_text, all_text from search_scopes order by uid");
  const before = scopeSnapshot();
  const originalOpen = fs.openSync;
  fs.openSync = function(file, ...args) {
    if ([...paths.values()].includes(file)) throw new Error("query reread a source transcript");
    return originalOpen.call(this, file, ...args);
  };
  try { for (let i = 0; i < 10; i++) assert.equal(matches("userneedle", "user").length, 6); }
  finally { fs.openSync = originalOpen; }
  assert.equal((await scan(index, registry)).skipped, 4);
  assert.deepEqual(scopeSnapshot(), before);
  assert.equal(index.db.get("select count(*) as n from search_scopes").n, 6);
  console.log("PASS index-only repeated queries, independent excerpt survival after tool floods, incremental refresh and replacement without duplicate scope rows; wire model omits excerpts");

  const legacy = index.db.all("select uid, title, body from search order by uid");
  index.db.run("update sources set parser_version = '3'");
  index.db.run("update meta set value = '3' where key = 'schema_version'");
  index.db.run("drop table search_scopes");
  index.close(); index = await openIndex(dbPath);
  assert.notEqual(PARSER_VERSION, "3");
  assert.equal(indexedFileSessions(index, "pi").length, 0);
  assert.equal(sourceFingerprint(index, "pi", paths.get("pi")), null);
  assert.equal((await scan(index, registry)).updated, 6);
  assert.equal(matches("userneedle", "user").length, 6);
  assert.deepEqual(index.db.all("select uid, title, body from search order by uid"), legacy);
  const originalPi = fs.readFileSync(paths.get("pi"), "utf8");
  fs.writeFileSync(paths.get("pi"), originalPi.replace("userneedle", "replacementneedle"));
  assert.equal((await scan(index, registry)).updated, 3); // changed Pi + both DB adapters
  assert.equal(matches("replacementneedle", "user").length, 1);
  assert.equal(matches("userneedle", "user").length, 5);
  fs.unlinkSync(paths.get("pi"));
  assert.equal((await scan(index, registry)).removed, 1);
  assert.equal(index.db.get("select count(*) as n from search_scopes where uid = 'pi:scopes'").n, 0);
  removeSessions(index, [matches("userneedle", "user")[0].uid]);
  assert.equal(index.db.get("select count(*) as n from search_scopes").n, 4);
  index.db.run("insert into search (rowid,uid,body) values (-1000,'orphan','orphanneedle')");
  index.db.run("insert into search_scopes (rowid,uid,user_text) values (-1000,'orphan','orphanneedle')");
  index.close(); index = await openIndex(dbPath);
  const orphanCounts = () => ["search", "search_scopes"].map(table =>
    index.db.get(`select count(*) as n from ${table} where uid = 'orphan'`).n);
  assert.deepEqual(orphanCounts(), [1, 1], "opening the index must not sweep FTS");
  assert.equal(matches("orphanneedle", "user").length, 0, "orphan rows must not appear in searches");
  await scan(index, registry, { maxPerHarness: 0 });
  assert.deepEqual(orphanCounts(), [1, 1], "capped refreshes do not run full-table maintenance");
  const piAdapter = registry.get("pi");
  const listPi = piAdapter.listSessions;
  piAdapter.listSessions = async () => { throw new Error("synthetic maintenance failure"); };
  try {
    assert.ok((await scan(index, registry)).failed.includes("pi"));
    assert.deepEqual(orphanCounts(), [1, 1], "failed refreshes defer full-table maintenance");
  } finally { piAdapter.listSessions = listPi; }
  await scan(index, registry);
  assert.deepEqual(orphanCounts(), [0, 0], "complete refreshes repair both FTS tables");
  console.log("PASS v3 migration invalidates parser fingerprints, unchanged sources rebuild scope data without changing legacy bodies; changed/deleted sessions and orphan cleanup stay consistent");

  const bounded = new ScopedSearchText();
  bounded.add("user", "openinguserneedle");
  bounded.add("assistant", "openingassistantneedle");
  for (let i = 0; i < 3000; i++) {
    bounded.add("user", `user ${i} ${"u ".repeat(3000)}`);
    bounded.add("assistant", `assistant ${i} ${"a ".repeat(3000)}`);
    bounded.result(`result ${i} ${"o ".repeat(3000)}`);
    bounded.call("tool", { command: `input ${i} ${"c ".repeat(3000)}` });
    bounded.reasoning(`reason ${i} ${"r ".repeat(3000)}`);
    bounded.add("system", `system ${i} ${"s ".repeat(3000)}`);
  }
  bounded.add("user", "closinguserneedle");
  bounded.add("assistant", "closingassistantneedle");
  const scopes = bounded.finish();
  for (const needle of ["openinguserneedle", "closinguserneedle"]) assert.ok(scopes.user.includes(needle));
  for (const needle of ["openingassistantneedle", "closingassistantneedle"]) assert.ok(scopes.conversation.includes(needle));
  assert.ok(scopes.user.length <= SEARCH_TEXT_BUDGET);
  assert.ok(scopes.conversation.length <= 2 * SEARCH_TEXT_BUDGET + 1);
  assert.ok(scopes.all.length <= 6 * SEARCH_TEXT_BUDGET + 5);
  const block = new ScopedSearchText();
  block.add("user", `blockheadneedle ${"x ".repeat(20000)} blocktailneedle`);
  assert.ok(block.finish().user.includes("blockheadneedle"));
  assert.ok(block.finish().user.includes("blocktailneedle"));
  assert.ok(block.finish().user.length <= SCOPE_BLOCK_BUDGET);
  // Explicitly record sampling limitations rather than implying full text.
  assert.ok(!scopes.user.includes("user 1500"));
  console.log("PASS bounded sampling: each category <=20,000 chars, each block <=4,000 head/tail chars; first/latest 200 blocks, middle content intentionally not guaranteed");
} finally {
  index?.close();
  fs.rmSync(home, { recursive: true, force: true });
}
console.log("All role-scoped indexed-search checks passed (synthetic homes only).");
