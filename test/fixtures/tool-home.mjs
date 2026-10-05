import fs from "node:fs";
import path from "node:path";
import { createJiti } from "jiti";
import { buildWebHome } from "./web-home.mjs";
const { openIndexDb } = await createJiti(import.meta.url).import("../../src/sqlite.ts");
export const TOOL_COMMAND = "printf 'hello\\nworld'\nprintf 'done\\n'";
export const TOOL_SECRET = "TOOL_SECRET_VALUE";
const args = { command: TOOL_COMMAND, timeout: 17, env: { API_KEY: TOOL_SECRET } };
const before = "tool test before call";
const result = "tool test result $x$";
const after = "tool test after result";
const timestamp = "2026-01-01T00:01:00.000Z";
function append(file, rows) { fs.appendFileSync(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n"); }

export async function buildToolHome(home) {
  await buildWebHome(home);
  const uuid = "11111111-2222-3333-4444-555555555555";
  append(path.join(home, ".pi", "agent", "sessions", "--srv-work-acme-api--", `2026-01-01T00-00-00-000Z_${uuid}.jsonl`), [
    { type: "message", id: "p-call", timestamp, message: { role: "assistant", content: [
      { type: "text", text: before }, { type: "toolCall", id: "call-pi", name: "bash", arguments: args },
    ] } },
    { type: "message", id: "p-result", timestamp, message: { role: "toolResult", toolName: "bash", toolCallId: "call-pi", content: result } },
    { type: "message", id: "p-after", timestamp, message: { role: "assistant", content: [{ type: "text", text: after }] } },
  ]);
  append(path.join(home, ".claude", "projects", "-srv-work-acme-api", `${uuid}.jsonl`), [
    { type: "assistant", sessionId: uuid, timestamp, message: { role: "assistant", content: [
      { type: "text", text: before }, { type: "tool_use", id: "call-claude-code", name: "Bash", input: args },
    ] } },
    { type: "user", sessionId: uuid, timestamp, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call-claude-code", content: [{ type: "text", text: result }] }] } },
    { type: "assistant", sessionId: uuid, timestamp, message: { role: "assistant", content: [{ type: "text", text: after }] } },
  ]);
  append(path.join(home, ".codex", "sessions", "2026", "01", "01", `rollout-2026-01-01T00-00-00-${uuid}.jsonl`), [
    { type: "response_item", timestamp, payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: before }] } },
    { type: "response_item", timestamp, payload: { type: "function_call", call_id: "call-codex", name: "exec_command", arguments: JSON.stringify(args) } },
    { type: "response_item", timestamp, payload: { type: "function_call_output", call_id: "call-codex", output: result } },
    { type: "response_item", timestamp, payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: after }] } },
  ]);
  const jcodeFile = path.join(home, ".jcode", "sessions", "session_fake_1.json");
  const jcode = JSON.parse(fs.readFileSync(jcodeFile, "utf8"));
  jcode.messages.push(
    { role: "assistant", content: [{ type: "text", text: before }, { type: "tool_use", id: "call-jcode", name: "bash", input: args }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call-jcode", content: result }] },
    { role: "assistant", content: [{ type: "text", text: after }] },
  );
  fs.writeFileSync(jcodeFile, JSON.stringify(jcode));

  const crush = await openIndexDb(path.join(home, ".crush", "crush.db"));
  try {
    const rows = [
      ["tc-1", "assistant", [{ type: "text", data: { text: before } }, { type: "tool_call", data: { id: "call-crush", name: "bash", input: JSON.stringify(args) } }]],
      ["tc-2", "tool", [{ type: "tool_result", data: { name: "bash", tool_call_id: "call-crush", content: result } }]],
      ["tc-3", "assistant", [{ type: "text", data: { text: after } }]],
    ];
    for (const [index, [id, role, parts]] of rows.entries()) {
      const seconds = Math.floor(Date.parse(timestamp) / 1000) + index;
      crush.run("INSERT INTO messages (id,session_id,role,parts,created_at,updated_at) VALUES (?,?,?,?,?,?)", [id, "crush-fake-1", role, JSON.stringify(parts), seconds, seconds]);
    }
    crush.run("update sessions set message_count = message_count + 3 where id = ?", ["crush-fake-1"]);
  } finally { crush.close(); }

  const opencode = await openIndexDb(path.join(home, ".local", "share", "opencode", "opencode.db"));
  try {
    const ms = Date.parse(timestamp);
    for (const [id, time] of [["tc-msg", ms], ["tc-after", ms + 2]]) {
      opencode.run("INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?)", [id, "ses_fake_1", time, time, JSON.stringify({ role: "assistant" })]);
    }
    const parts = [
      ["tc-part-before", "tc-msg", ms, { type: "text", text: before }],
      ["tc-part-tool", "tc-msg", ms + 1, { type: "tool", tool: "bash", callID: "call-opencode", state: { status: "completed", input: args, output: result } }],
      ["tc-part-after", "tc-after", ms + 2, { type: "text", text: after }],
    ];
    for (const [id, messageId, time, data] of parts) {
      opencode.run("INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?,?)", [id, messageId, "ses_fake_1", time, time, JSON.stringify(data)]);
    }
  } finally { opencode.close(); }
}
