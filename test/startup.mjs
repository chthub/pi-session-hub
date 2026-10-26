// No prompts or model calls. All stores, settings and sessions are synthetic.
// PI_BIN may select a Pi installation; TMPDIR may select an NFS scratch directory.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const root = fileURLToPath(new URL("../", import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "hub-startup-"));
const home = path.join(temp, "home");
const agent = path.join(temp, "agent");
const jiti = createJiti(import.meta.url);
const { openIndex, transaction } = await jiti.import("../src/index/db.ts");
const { indexDbPath } = await jiti.import("../src/security.ts");
const rows = Number(process.env.HUB_STARTUP_ROWS ?? 4000);
assert.ok(Number.isSafeInteger(rows) && rows >= 0);
const dbPath = indexDbPath(home);
const benchmark = process.argv.includes("--benchmark");

async function ready(extension) {
  const start = performance.now();
  const child = spawn(process.env.PI_BIN || "pi", [
    "--mode", "rpc", "--no-session", "--offline", "--no-extensions", "--no-mcp",
    "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
    ...(extension ? ["-e", path.join(root, "extensions/session-hub.ts")] : []),
  ], {
    cwd: temp,
    env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agent, PI_SESSION_HUB_HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", data => { stderr += data; });
  const lines = createInterface({ input: child.stdout });
  try {
    const elapsed = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`RPC readiness timeout: ${stderr}`)), 30000);
      const fail = error => { clearTimeout(timer); reject(error); };
      child.once("error", fail);
      child.stdin.once("error", fail);
      child.once("exit", () => fail(new Error(`Pi exited before RPC readiness: ${stderr}`)));
      let stateMs;
      lines.on("line", line => {
        let result;
        try { result = JSON.parse(line); } catch { return; }
        if (result.id !== "startup" && result.id !== "commands") return;
        if (!result.success) { fail(new Error(JSON.stringify(result))); return; }
        if (result.id === "startup") {
          stateMs = performance.now() - start;
          if (extension) {
            // A failed extension load must not masquerade as a faster startup.
            child.stdin.write(JSON.stringify({ id: "commands", type: "get_commands" }) + "\n");
            return;
          }
        } else if (!result.data.commands.some(command => command.name === "session-hub" && command.source === "extension")) {
          fail(new Error("Session Hub extension did not load"));
          return;
        }
        clearTimeout(timer);
        resolve(stateMs);
      });
      child.stdin.write(JSON.stringify({ id: "startup", type: "get_state" }) + "\n");
    });
    assert.ok(!/extension.*(?:error|failed)/i.test(stderr), stderr);
    return Math.round(elapsed * 100) / 100;
  } finally {
    lines.close();
    child.stdin.end(); // RPC EOF requests orderly session_shutdown/disposal.
    const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
    await exited;
    clearTimeout(timer);
  }
}

try {
  fs.mkdirSync(agent, { recursive: true });
  // First verify startup cannot create an index, even when history tools are registered.
  const freshMs = await ready(true);
  if (!benchmark) assert.equal(fs.existsSync(dbPath), false, "startup must not create the index");
  const index = await openIndex(dbPath);
  assert.ok(index);
  try {
    transaction(index, () => {
      const params = [rows];
      const cte = "WITH RECURSIVE n(i) AS (SELECT 1 WHERE ? > 0 UNION ALL SELECT i+1 FROM n WHERE i < ?) ";
      index.db.run(cte + "INSERT INTO sessions(uid,harness,native_id,path) SELECT 'pi:synthetic-'||i,'pi',i,'/synthetic/'||i FROM n", [...params, rows]);
      const body = "synthetic history searchable text ".repeat(256);
      index.db.run("INSERT INTO search(rowid,uid,title,body) SELECT rowid,uid,'synthetic',? FROM sessions", [body]);
      index.db.run("INSERT INTO search_scopes(rowid,uid,user_text,conversation_text,all_text) SELECT rowid,uid,?,?,? FROM sessions", [body, body, body]);
      // A sentinel catches cleanup on startup without ever reading real history.
      index.db.run("INSERT INTO search(uid,body) VALUES ('orphan','sentinel')");
      index.db.run("INSERT INTO search_scopes(uid,user_text) VALUES ('orphan','sentinel')");
    });
  } finally { index.close(); }
  const bytes = fs.readFileSync(dbPath);
  const mtime = fs.statSync(dbPath).mtimeMs;
  const hubMs = [], bareMs = [];
  for (let i = 0; i < 3; i++) {
    bareMs.push(await ready(false));
    hubMs.push(await ready(true));
  }
  if (!benchmark) {
    assert.deepEqual(fs.readFileSync(dbPath), bytes, "startup must not maintain an existing index");
    assert.equal(fs.statSync(dbPath).mtimeMs, mtime);
    console.log("PASS actual Pi RPC startup neither creates nor modifies the index (synthetic home only)");
  }
  console.log(JSON.stringify({ benchmark, rows, indexBytes: bytes.length, freshMs, bareMs, hubMs }));
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
