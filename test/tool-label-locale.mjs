/** Generated labels only: synthetic sources, native Node strip-only TS imports. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AdapterRegistry } from "../src/adapters/registry.ts";
import { pushToolCall, pushToolResult, pushTranscriptBlocks } from "../src/adapters/util.ts";
import { openIndexDb } from "../src/sqlite.ts";
import { buildToolHome, TOOL_COMMAND } from "./fixtures/tool-home.mjs";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "hub-tool-label-locale-"));
const userText = "用户原文：工具： 调用 ID： 命令（command）： 调用参数： 未记录 （空输出） 未记录工具名";
const assistantText = "助手原文：工具：和调用参数：都不能翻译";
const outputText = "中文工具输出：工具： 调用 ID： 命令（command）： 调用参数： 未记录 （空输出） 未记录工具名";
const command = "printf '中文命令 工具：调用参数：未记录\\n'";
const fieldValue = "中文 JSON 字段值：未记录";
let checks = 0;
function check(name, condition) {
  assert.ok(condition, name);
  checks++;
  console.log(`PASS ${name}`);
}
function transform(value) {
  if (Array.isArray(value)) return value.map(transform);
  if (value && typeof value === "object") {
    const result = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, transform(item)]));
    if (typeof value.command === "string") result["中文字段"] = fieldValue;
    return result;
  }
  if (typeof value !== "string") return value;
  if (value.startsWith("fake ")) return userText;
  if (value === "tool test before call" || value === "tool test after result") return assistantText;
  if (value === "tool test result $x$") return outputText;
  if (value === TOOL_COMMAND) return command;
  // Codex arguments / Crush inputs are serialized JSON source fields.
  if (value.startsWith("{")) {
    try { return JSON.stringify(transform(JSON.parse(value))); } catch { /* plain source string */ }
  }
  return value;
}
function rewriteFiles(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) rewriteFiles(file);
    else if (entry.name.endsWith(".jsonl")) {
      fs.writeFileSync(file, fs.readFileSync(file, "utf8").trim().split("\n").map(line => JSON.stringify(transform(JSON.parse(line)))).join("\n") + "\n");
    } else if (entry.name.endsWith(".json")) {
      fs.writeFileSync(file, JSON.stringify(transform(JSON.parse(fs.readFileSync(file, "utf8")))));
    }
  }
}
try {
  await buildToolHome(home);
  rewriteFiles(home);
  for (const [file, table, column] of [
    [path.join(home, ".crush", "crush.db"), "messages", "parts"],
    [path.join(home, ".local", "share", "opencode", "opencode.db"), "part", "data"],
  ]) {
    const db = await openIndexDb(file);
    try {
      for (const row of db.all(`select id, ${column} as payload from ${table}`)) {
        db.run(`update ${table} set ${column} = ? where id = ?`, [JSON.stringify(transform(JSON.parse(row.payload))), row.id]);
      }
      if (table === "part") {
        db.run("insert into part (id,message_id,session_id,time_created,time_updated,data) values (?,?,?,?,?,?)", [
          "locale-error", "tc-msg", "ses_fake_1", Date.parse("2026-01-01T00:02:00.000Z"), Date.parse("2026-01-01T00:02:00.000Z"),
          JSON.stringify({ type: "tool", tool: "bash", callID: "locale-error", state: { error: "中文错误原文：错误：不能替换", input: { command } } }),
        ]);
      }
    } finally { db.close(); }
  }
  const registry = new AdapterRegistry(home);
  for (const harness of ["pi", "claude-code", "codex", "opencode", "crush", "jcode"]) {
    const adapter = registry.get(harness);
    const session = (await adapter.listSessions())[0];
    const opts = { preserveFormatting: true, includeToolActivity: true };
    const english = await adapter.getSessionByRef(session, { ...opts, locale: "en" });
    const chinese = await adapter.getSessionByRef(session, opts);
    const explicitChinese = await adapter.getSession(session.nativeId, { ...opts, locale: "zh-CN" });
    const englishById = await adapter.getSession(session.nativeId, { ...opts, locale: "en" });
    check(`${harness}: exact-ref and native-id English reads agree`, JSON.stringify(english.messages) === JSON.stringify(englishById.messages));
    check(`${harness}: omitted locale remains identical to explicit zh-CN`, JSON.stringify(chinese.messages) === JSON.stringify(explicitChinese.messages));
    for (const [locale, detail] of [["en", english], ["zh-CN", chinese]]) {
      const call = detail.messages.find(message => message.role === "toolCall" && message.toolCallId === `call-${harness}`);
      const result = detail.messages.find(message => message.role === "toolResult" && message.toolCallId === `call-${harness}`);
      const headings = locale === "en" ? [`Tool: ${call.toolName}`, `Call ID: call-${harness}`, "Command (command):", "Arguments:"] : [`工具：${call.toolName}`, `调用 ID：call-${harness}`, "命令（command）：", "调用参数："];
      check(`${harness} ${locale}: generated tool labels use selected locale`, headings.every(heading => call.text.includes(heading)));
      check(`${harness} ${locale}: Chinese user and assistant prose stays authored`, detail.messages.some(message => message.role === "user" && message.text === userText) && detail.messages.some(message => message.role === "assistant" && message.text === assistantText));
      check(`${harness} ${locale}: Chinese tool output stays byte-for-byte authored`, result.text === outputText);
      check(`${harness} ${locale}: commands and JSON field names/values are not translated`, call.text.includes(command) && call.text.includes('"中文字段"') && call.text.includes(fieldValue));
    }
    check(`${harness}: locale does not change indexed role excerpts`, JSON.stringify(english.searchScopes) === JSON.stringify(chinese.searchScopes));
    const noTools = await adapter.getSessionByRef(session, { locale: "en" });
    const defaultNoTools = await adapter.getSessionByRef(session);
    check(`${harness}: locale does not enable tool activity or alter legacy prose`, JSON.stringify(noTools.messages) === JSON.stringify(defaultNoTools.messages));
    if (harness === "opencode") {
      check("OpenCode: only the generated error prefix switches to English", english.messages.some(message => message.toolCallId === "locale-error" && message.text === "Error: 中文错误原文：错误：不能替换"));
      check("OpenCode: omitted locale keeps the Chinese error prefix", chinese.messages.some(message => message.toolCallId === "locale-error" && message.text === "错误：中文错误原文：错误：不能替换"));
    }
  }

  for (const locale of ["en", "zh-CN"]) {
    const messages = [];
    pushToolCall(messages, "read", undefined, "missing", Infinity, locale);
    pushToolResult(messages, undefined, undefined, undefined, Infinity, locale);
    pushToolResult(messages, "", undefined, undefined, Infinity, locale);
    pushToolResult(messages, null, undefined, undefined, Infinity, locale);
    pushTranscriptBlocks(messages, "assistant", [{ type: "toolCall" }, { type: "tool_result", content: "" }], { max: Infinity }, locale);
    const missing = locale === "en" ? "Not recorded" : "未记录";
    const empty = locale === "en" ? "(empty output)" : "（空输出）";
    const unnamed = locale === "en" ? "Tool name not recorded" : "未记录工具名";
    check(`${locale}: missing input/result markers are localized`, messages[0].text.endsWith(missing) && messages[1].text === missing);
    check(`${locale}: empty output markers are localized in direct and block helpers`, messages[2].text === empty && messages[5].text === empty);
    check(`${locale}: unknown tool name is localized without translating a real name`, messages[4].toolName === unnamed);
    check(`${locale}: explicit null is source data, not a generated missing marker`, messages[3].text === "null");
    const bounded = [];
    pushToolCall(bounded, "bash", { command }, "bounded", 0, locale);
    pushToolResult(bounded, outputText, undefined, undefined, 0, locale);
    pushTranscriptBlocks(bounded, "assistant", [{ type: "toolCall" }], { max: 0 }, locale);
    check(`${locale}: existing max limits remain effective`, bounded.length === 0);
  }
  const defaults = [];
  pushToolCall(defaults, "bash", undefined);
  pushToolResult(defaults, "");
  pushTranscriptBlocks(defaults, "assistant", [{ type: "toolCall" }]);
  check("helper signatures without locale remain Chinese", defaults[0].text.startsWith("工具：bash") && defaults[0].text.endsWith("未记录") && defaults[1].text === "（空输出）" && defaults[2].toolName === "未记录工具名");
} finally { fs.rmSync(home, { recursive: true, force: true }); }
console.log(`${checks} generated-tool-label locale checks passed (synthetic sources only).`);
