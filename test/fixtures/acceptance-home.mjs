import fs from "node:fs";
import path from "node:path";
import { buildToolHome } from "./tool-home.mjs";

/** Deterministic coverage for the historical acceptance assertions, including
 * long prose, search probes and non-resumable Claude subagents. */
export async function buildAcceptanceHome(home) {
  await buildToolHome(home);
  const uuid = "11111111-2222-3333-4444-555555555555";
  const pi = path.join(home, ".pi", "agent", "sessions", "--srv-work-acme-api--", `2026-01-01T00-00-00-000Z_${uuid}.jsonl`);
  const claude = path.join(home, ".claude", "projects", "-srv-work-acme-api", `${uuid}.jsonl`);
  const codex = path.join(home, ".codex", "sessions", "2026", "01", "01", `rollout-2026-01-01T00-00-00-${uuid}.jsonl`);
  const rows = { pi: [], claude: [], codex: [] };
  for (let index = 0; index < 64; index++) {
    const role = index % 2 ? "assistant" : "user";
    const content = `Acceptance step ${index}: pliego turnero. ` + `This is a substantive synthetic ${role} message about implementation, diagnostics, regression coverage and independently traceable project evidence. `.repeat(2);
    const timestamp = new Date(Date.parse("2026-01-01T00:02:00Z") + index * 1000).toISOString();
    rows.pi.push({ type: "message", id: `long-${index}`, timestamp, message: { role, content } });
    rows.claude.push({ type: role, sessionId: uuid, timestamp, cwd: "/srv/work/acme-api", message: { role, content } });
    rows.codex.push({ type: "response_item", timestamp, payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text: content }] } });
  }
  for (const [name, file] of [["pi", pi], ["claude", claude], ["codex", codex]]) fs.appendFileSync(file, rows[name].map(row => JSON.stringify(row)).join("\n") + "\n");
  const subagent = path.join(path.dirname(claude), uuid, "subagents", "agent-acceptance.jsonl");
  fs.mkdirSync(path.dirname(subagent), { recursive: true });
  fs.writeFileSync(subagent, JSON.stringify({ type: "user", sessionId: uuid, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "A synthetic non-resumable subagent transcript." } }) + "\n");
}
