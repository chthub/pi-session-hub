import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";
import { buildToolHome } from "./fixtures/tool-home.mjs";
const jiti = createJiti(import.meta.url);
const { readSessionJsonl, readSessionJson, SESSION_READ_LIMIT, TRANSCRIPT_CHAR_LIMIT, TRANSCRIPT_MESSAGE_LIMIT } = await jiti.import("../src/adapters/reader.ts");
const { PiAdapter } = await jiti.import("../src/adapters/pi.ts");
const { ClaudeCodeAdapter } = await jiti.import("../src/adapters/claude-code.ts");
const { CodexAdapter } = await jiti.import("../src/adapters/codex.ts");
const { JCodeAdapter } = await jiti.import("../src/adapters/jcode.ts");
const { AdapterRegistry } = await jiti.import("../src/adapters/registry.ts");
const { openIndexDb } = await jiti.import("../src/sqlite.ts");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "hub-streaming-"));
const check = (name, value) => { assert.ok(value, name); console.log(`PASS ${name}`); };
const stamp = "2026-02-01T01:02:03Z";
const marker = "LATEST beyond former byte and message caps 中文 🦊";
const payload = "x".repeat(8100);
function ref(harness, file, id = "large") { return { harness, path: file, nativeId: id, uid: `${harness}:${id}` }; }
function verify(detail) {
  assert.ok(detail);
  assert.equal(detail.messageCount, 8401);
  assert.ok(detail.messages.at(-1).text.includes(marker));
  assert.ok(detail.messages.length <= TRANSCRIPT_MESSAGE_LIMIT);
  assert.ok(detail.messages.reduce((n, m) => n + m.text.length, 0) <= TRANSCRIPT_CHAR_LIMIT);
  assert.ok(detail.fidelity.notes.some(n => n.includes("middle blocks omitted")));
  assert.ok(!detail.fidelity.notes.some(n => n.includes("first 67108864")));
}
try {
  for (const [id, Adapter, header, entry] of [
    ["pi", PiAdapter, { type: "session", id: "large" }, text => ({ type: "message", timestamp: stamp, message: { role: "user", content: text } })],
    ["claude-code", ClaudeCodeAdapter, { type: "system", sessionId: "large" }, text => ({ type: "user", sessionId: "large", timestamp: stamp, message: { role: "user", content: text } })],
    ["codex", CodexAdapter, { type: "session_meta", payload: { id: "large" } }, text => ({ type: "response_item", timestamp: stamp, payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } })],
  ]) {
    // Codex refs must remain inside a configured sessions tree; still exercise
    // the same large-file parser without bypassing the source-path boundary.
    const file = id === "codex" ? path.join(temp, ".codex", "sessions", `${id}.jsonl`) : path.join(temp, `${id}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(file, "w");
    fs.writeSync(fd, JSON.stringify(header) + "\n");
    const row = JSON.stringify(entry(payload)) + "\n";
    for (let i = 0; i < 8400; i++) fs.writeSync(fd, row);
    fs.writeSync(fd, JSON.stringify(entry(marker))); // valid final record without LF
    fs.closeSync(fd);
    assert.ok(fs.statSync(file).size > SESSION_READ_LIMIT);
    const adapter = new Adapter(temp);
    for (const includeToolActivity of [false, true]) verify(await adapter.getSessionByRef(ref(id, file), { includeToolActivity, preserveFormatting: true }));
    check(`${id}: >64 MiB + >8000 messages preserve opening/latest with bounded excerpts`, true);
    fs.unlinkSync(file);
  }

  // A single mixed-content message can itself exceed the old helper caps.
  for (const [id, Adapter, type] of [["pi", PiAdapter, "toolCall"], ["claude-code", ClaudeCodeAdapter, "tool_use"], ["jcode", JCodeAdapter, "tool_use"]]) {
    const content = Array.from({ length: 8500 }, (_, i) => ({ type, id: `call-${i}`, name: "bash", input: { command: "true" }, arguments: { command: "true" } }));
    content.push({ type: "text", text: marker });
    const file = path.join(temp, `mixed-${id}.jsonl`);
    const message = { role: "assistant", content };
    const text = id === "pi" ? JSON.stringify({ type: "session", id: "large" }) + "\n" + JSON.stringify({ type: "message", message })
      : id === "claude-code" ? JSON.stringify({ type: "assistant", sessionId: "large", message })
      : JSON.stringify({ id: "large", messages: [message] });
    fs.writeFileSync(file, text);
    const detail = await new Adapter(temp).getSessionByRef(ref(id, file), { includeToolActivity: true });
    assert.ok(detail.messages.at(-1).text.includes(marker));
    assert.equal(detail.toolCount, 8500);
    assert.equal(detail.tools.find(t => t.name === "bash").count, 8500);
    assert.ok(detail.messages.length <= TRANSCRIPT_MESSAGE_LIMIT);
    assert.ok(detail.fidelity.notes.some(n => n.includes("middle blocks omitted")));
    check(`${id}: one mixed-content message retains latest beyond helper limits and aggregates all tools`, true);
  }

  const file = path.join(temp, "jcode.json");
  const fd = fs.openSync(file, "w");
  fs.writeSync(fd, '{"unknown":{"escaped":"\\\"},["},"messages":[');
  const row = JSON.stringify({ role: "user", content: payload });
  for (let i = 0; i < 8400; i++) fs.writeSync(fd, row + ",");
  fs.writeSync(fd, JSON.stringify({ role: "assistant", content: marker }) + '],"id":"large","title":"metadata after messages"}');
  fs.closeSync(fd);
  assert.ok(fs.statSync(file).size > SESSION_READ_LIMIT);
  const jcode = new JCodeAdapter(temp);
  for (const includeToolActivity of [false, true]) {
    const detail = await jcode.getSessionByRef(ref("jcode", file), { includeToolActivity });
    verify(detail);
    assert.equal(detail.title, "metadata after messages");
  }
  check("JCode streams >64 MiB monolithic JSON and metadata after messages", true);
  fs.unlinkSync(file);

  for (const text of ['{"messages":[{},]}', '{"messages":[{}]', '{"messages":[]} garbage', '{"messages":[],"messages":[]}', '{"messages":[],}', 'null']) {
    fs.writeFileSync(file, text);
    assert.equal(readSessionJson(file, () => {}), null);
    assert.equal(await jcode.getSessionByRef(ref("jcode", file)), null);
  }
  check("malformed/torn/duplicate-key monolithic documents fail closed", true);
  const oversizedFd = fs.openSync(file, "w");
  fs.writeSync(oversizedFd, '{"id":"large","messages":[{"role":"user","content":"');
  const padding = "x".repeat(1024 * 1024);
  for (let i = 0; i < 65; i++) fs.writeSync(oversizedFd, padding);
  fs.writeSync(oversizedFd, '"}]}');
  fs.closeSync(oversizedFd);
  assert.equal(readSessionJson(file, () => {}), null);
  check("a monolithic value above 64 MiB fails closed rather than allocating the full document", true);
  fs.writeFileSync(file, '{"id":"valid","messages":[{"text":"中文 🦊 \\\""}]}');
  const recovered = [];
  assert.equal(readSessionJson(file, value => recovered.push(value)).doc.id, "valid");
  assert.equal(recovered[0].text, '中文 🦊 "');

  const jsonl = path.join(temp, "records.jsonl");
  fs.writeFileSync(jsonl, JSON.stringify({ text: "x".repeat(500) }) + '\nnull\nnot JSON\n' + JSON.stringify({ text: marker }) + '\n{"torn":');
  const result = readSessionJsonl(jsonl, 128);
  assert.deepEqual([...result.records], [{ text: marker }]);
  assert.ok(result.truncated && result.notes.some(n => n.includes("1 exceeded 128 bytes; 3 malformed")));
  check("oversized/malformed/torn JSONL records warn without suppressing later records", true);
  // Split a multi-byte UTF-8 sequence across the 256 KiB chunk boundary.
  fs.writeFileSync(jsonl, JSON.stringify({ text: "x".repeat(256 * 1024 - 10) + "🦊中文" }) + "\r\n" + JSON.stringify({ text: marker }));
  const unicode = readSessionJsonl(jsonl);
  assert.deepEqual([...unicode.records].map(r => r.text.slice(-4)), ["🦊中文", marker.slice(-4)]);
  assert.deepEqual(unicode.notes, []);
  check("UTF-8 chunk boundaries, CRLF and no-final-newline remain intact", true);
  const denied = path.join(temp, "credentials.json");
  fs.writeFileSync(denied, '{"messages":[]}');
  assert.equal(readSessionJson(denied, () => {}), null);
  const deniedRead = readSessionJsonl(denied);
  assert.deepEqual([...deniedRead.records], []);
  assert.ok(deniedRead.truncated);
  const missing = path.join(temp, "missing.jsonl");
  const empty = path.join(temp, "empty.jsonl");
  fs.writeFileSync(empty, "");
  const symlink = path.join(temp, "disguised.jsonl");
  fs.symlinkSync(denied, symlink);
  for (const [id, Adapter] of [["pi", PiAdapter], ["claude-code", ClaudeCodeAdapter], ["codex", CodexAdapter]]) {
    for (const source of [denied, missing, empty, symlink]) {
      assert.equal(await new Adapter(temp).getSessionByRef(ref(id, source)), null);
    }
  }
  check("file adapters never manufacture sessions from denied/missing/empty sources", true);

  const home = path.join(temp, "synthetic-home");
  await buildToolHome(home);
  const registry = new AdapterRegistry(home);
  for (const id of ["crush", "opencode"]) {
    const dbFile = id === "crush" ? path.join(home, ".crush", "crush.db") : path.join(home, ".local", "share", "opencode", "opencode.db");
    const db = await openIndexDb(dbFile);
    db.run("BEGIN");
    try {
      for (let i = 0; i < 4100; i++) {
        const text = i === 4099 ? marker : `synthetic ${i}`;
        const key = `large-${String(i).padStart(5, "0")}`;
        if (id === "crush") db.run("INSERT INTO messages (id,session_id,role,parts,created_at,updated_at) VALUES (?,?,?,?,?,?)", [key, "crush-fake-1", "user", JSON.stringify([{ type: "text", data: { text } }]), 2000000000 + i, 2000000000 + i]);
        else {
          db.run("INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?)", [key, "ses_fake_1", 2000000000000 + i, 2000000000000 + i, '{"role":"user"}']);
          db.run("INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?,?)", [key, key, "ses_fake_1", 2000000000000 + i, 2000000000000 + i, JSON.stringify({ type: "text", text })]);
        }
      }
      db.run("COMMIT");
    } finally { db.close(); }
    for (const includeToolActivity of [false, true]) {
      const detail = await registry.get(id).getSession(id === "crush" ? "crush-fake-1" : "ses_fake_1", { includeToolActivity });
      assert.ok(detail.messages.at(-1).text.includes(marker));
    }
    check(`${id}: paged details recover latest beyond former 4000-row limit`, true);
  }
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
