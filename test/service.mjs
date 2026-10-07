import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";
import { buildToolHome } from "./fixtures/tool-home.mjs";
const jiti = createJiti(import.meta.url);
const { SessionHubService } = await jiti.import("../src/core/service.ts");
const { AdapterRegistry } = await jiti.import("../src/adapters/registry.ts");
const { readSessionText, SESSION_READ_LIMIT } = await jiti.import("../src/adapters/reader.ts");
const { openIndex } = await jiti.import("../src/index/db.ts");
const { indexDbPath } = await jiti.import("../src/security.ts");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "hub-service-"));
let service;
function check(name, value) { assert.ok(value, name); console.log(`PASS ${name}`); }
try {
  const home = path.join(temp, "home");
  await buildToolHome(home);
  const registry = new AdapterRegistry(home);
  service = new SessionHubService({ home, registry });
  await Promise.all([service.init(), service.init()]);
  check("init is concurrent-safe and doesn't scan", (await service.getStatus()).total === 0);
  const [first, concurrent] = await Promise.all([service.refresh(), service.refresh()]);
  check("refresh is shared and indexes six synthetic harnesses", first === concurrent && first.total === 6);
  const list = await service.listSessions({ limit: 20 });
  check("list + query use the shared index", list.length === 6 && (await service.listSessions({ text: "billing" })).length > 0);
  check("incremental refresh reuses file metadata", (await service.refresh()).skipped === 4);
  const detectAll = registry.detectAll.bind(registry);
  let detectionCalls = 0;
  registry.detectAll = () => { detectionCalls++; return detectAll(); };
  await service.getStatus(); await service.getStatus();
  check("repeated viewer status requests do not walk providers again", detectionCalls === 1);

  for (const session of list) {
    const adapter = registry.get(session.harness);
    const files = adapter.files;
    const legacy = adapter.getSession;
    if (files) {
      adapter.files = () => { throw new Error("provider-wide walk forbidden"); };
      adapter.getSession = () => { throw new Error("legacy native-id lookup forbidden"); };
    }
    try {
      const detail = await service.getSession(session.uid, { preserveFormatting: true, includeToolActivity: true });
      check(`${session.harness}: indexed UID reads only its exact source`, detail?.uid === session.uid && detail.path === session.path && detail.messages.length > 0);
      const resume = await service.resolveResume(session.uid);
      check(`${session.harness}: resume action resolves without launching`, resume?.action.verified && resume.action.cwd === (session.cwd || undefined));
    } finally { if (files) adapter.files = files; adapter.getSession = legacy; }
  }
  check("unknown UID never becomes a path or prefix lookup", await service.getSession("/etc/passwd") === null && await service.getSession("pi:") === null && await service.resolveResume("bad") === null);

  // The filename need not contain the ID recorded by the source.
  const pi = list.find(s => s.harness === "pi");
  const originalPi = fs.readFileSync(pi.path, "utf8");
  fs.writeFileSync(pi.path, originalPi.replace(pi.nativeId, "replacement-id"));
  check("replaced source with a different UID is refused instead of misidentified", await service.getSession(pi.uid) === null);
  fs.writeFileSync(pi.path, originalPi);
  const opaque = path.join(path.dirname(pi.path), "opaque.jsonl");
  fs.renameSync(pi.path, opaque);
  await service.refresh({ force: true });
  check("recorded id with unrelated filename is read/resumed by exact path", (await service.getSession(pi.uid)).path === opaque && (await service.resolveResume(pi.uid)).action.args[1] === opaque);
  const claude = list.find(s => s.harness === "claude-code");
  const subagent = path.join(path.dirname(claude.path), "parent", "subagents", "agent-isolated.jsonl");
  fs.mkdirSync(path.dirname(subagent), { recursive: true });
  fs.copyFileSync(claude.path, subagent);
  await service.refresh();
  check("Claude subagent is readable but not resumable", (await service.getSession("claude-code:agent-isolated"))?.messages.length > 0 && await service.resolveResume("claude-code:agent-isolated") === null);

  const failing = registry.get("claude-code");
  const listSessions = failing.listSessions;
  failing.listSessions = async () => { throw new Error("synthetic provider failure"); };
  try {
    const result = await service.refresh();
    check("adapter failure is isolated and existing rows are preserved", result.failed.includes("claude-code") && result.scanned.includes("pi") && (await service.getSession(claude.uid)) !== null);
    const resultAll = await registry.listAll();
    check("registry attributes failure to the actual provider", resultAll.errors.length === 1 && resultAll.errors[0].harness === "claude-code");
  } finally { failing.listSessions = listSessions; }

  // Missing cwd must NOT become the session-store parent or host workspace.
  const text = fs.readFileSync(opaque, "utf8").replace('"cwd":"/srv/work/acme-api",', "").replace(',"cwd":"/srv/work/acme-api"', "");
  fs.writeFileSync(opaque, text);
  await service.refresh();
  check("missing source cwd remains unspecified", (await service.resolveResume(pi.uid)).action.cwd === undefined);

  const read = readSessionText(opaque, 32);
  check("bounded reader explicitly reports partial source bytes", read.truncated && read.bytesRead === 32 && read.fileSize > 32 && read.notes[0].includes("latest messages may be missing"));
  const huge = path.join(path.dirname(opaque), "huge.jsonl");
  fs.writeFileSync(huge, JSON.stringify({ type: "session", id: "huge", cwd: "/project" }) + "\n");
  const fd = fs.openSync(huge, "r+");
  fs.writeSync(fd, "\n" + JSON.stringify({ type: "message", message: { role: "user", content: "latest beyond cap" } }) + "\n", SESSION_READ_LIMIT + 100);
  fs.closeSync(fd);
  await service.refresh();
  const hugeDetail = await service.getSession("pi:huge");
  check("oversized append-only transcript is never silently called complete", hugeDetail.fidelity.notes.some(note => note.includes("truncated")) && !hugeDetail.messages.some(m => m.text.includes("latest beyond cap")));
  fs.unlinkSync(huge);
  await service.refresh();

  // Even a tampered cache must not redirect reads to credential-like files.
  const credential = path.join(home, ".claude", "credentials.json");
  fs.writeFileSync(credential, "must never be read");
  const index = await openIndex(indexDbPath(home));
  index.db.run("update sessions set path = ? where uid = ?", [credential, pi.uid]);
  index.close();
  check("credential paths are rejected after UID resolution", await service.getSession(pi.uid) === null && await service.resolveResume(pi.uid) === null);
  service.close(); service.close();
  await assert.rejects(() => service.listSessions(), /closed/);
  check("close is idempotent and subsequent operations fail clearly", true);

  const empty = new SessionHubService({ home: path.join(temp, "empty") });
  await empty.init(); await empty.refresh();
  check("empty stores yield an empty service without real-home dependencies", (await empty.listSessions()).length === 0);
  empty.close();

  const closingRegistry = new AdapterRegistry(home);
  let release;
  let started;
  const gate = new Promise(resolve => { release = resolve; });
  const began = new Promise(resolve => { started = resolve; });
  const original = closingRegistry.get("pi").listSessions.bind(closingRegistry.get("pi"));
  closingRegistry.get("pi").listSessions = async opts => { started(); await gate; return original(opts); };
  const closing = new SessionHubService({ home, registry: closingRegistry });
  const scan = closing.refresh();
  await began; closing.close(); release();
  await scan;
  await assert.rejects(() => closing.init(), /closed/);
  check("closing during a scan waits to release its owned handle", true);
} finally { service?.close(); fs.rmSync(temp, { recursive: true, force: true }); }
console.log("All shared-service checks passed (synthetic homes only).");
