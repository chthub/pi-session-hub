import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";
import { buildToolHome } from "./fixtures/tool-home.mjs";
const jiti = createJiti(import.meta.url);
const { PiEnvironmentDetector, selectPiEnvironment, assertPiEnvironmentSelected } = await jiti.import("../src/core/pi-environment.ts");
const { loadPiEnvironments, parsePiEnvironments, hubConfigPath, HubConfigError } = await jiti.import("../src/core/config.ts");
const { SessionHubService } = await jiti.import("../src/core/service.ts");
const { AdapterRegistry } = await jiti.import("../src/adapters/registry.ts");
const { launchNativeResume, describeNativeResume } = await jiti.import("../src/native.ts");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "hub-pi-environment-"));
const home = path.join(temp, "home");
const research = path.join(home, "profiles", "research with spaces");
const config = { piEnvironments: [
  { id: "default", label: "Pi", agentDir: "~/.pi/agent" },
  { id: "research", label: "Pi Research", agentDir: research },
  { id: "team", label: "Pi Team", agentDir: "~/.pi/agent-team" },
] };
const profiles = parsePiEnvironments(config, home);
const context = (profile, file = "AGENTS.md") => `<project_context><project_instructions path="${path.join(profile.agentDir, file)}">rules</project_instructions></project_context>`;
const system = text => ({ type: "message", message: { role: "system", content: "", sections: { project_context: text } } });
function detect(entries, truncated = false) {
  const detector = new PiEnvironmentDetector(home, profiles);
  entries.forEach(entry => detector.observe(entry));
  return detector.resolve(truncated);
}
let checks = 0;
function check(name, value) { assert.ok(value, name); console.log(`PASS ${name}`); checks++; }
let service;
try {
  for (const profile of profiles) {
    const result = detect([system(context(profile))]);
    check(`${profile.id}: configured directory identifies source environment`, result.status === "detected" && result.selected.agentDir === profile.agentDir);
  }
  check("tilde and startup-style relative paths identify configured directories", detect([system('<project_instructions path=".pi/agent-team/AGENTS.md">rules</project_instructions>')]).selected.id === "team" && detect([system('<project_instructions path="~/.pi/agent-team/AGENTS.md">rules</project_instructions>')]).selected.id === "team");
  const quotedProfile = parsePiEnvironments({ piEnvironments: [{ id: "quoted", agentDir: path.join(home, "researcher\'s profile") }] }, home)[0];
  const quoted = new PiEnvironmentDetector(home, [quotedProfile]);
  quoted.observe(system(context(quotedProfile)));
  check("valid apostrophes in configured directory paths are preserved", quoted.resolve().selected?.id === "quoted");
  check("supported instruction filenames identify config identity", detect([system(context(profiles[1], "AGENTS.override.md"))]).selected.id === "research");
  const spoof = context(profiles[1]);
  check("user, assistant, tool and custom text cannot choose an account", detect([
    ...["user", "assistant", "toolResult"].map(role => ({ type: "message", message: { role, content: spoof, sections: { project_context: spoof } } })),
    { type: "custom", data: { project_context: spoof } },
  ]).status === "unknown");
  check("skills/tool definitions/model identifiers are not account evidence", detect([
    { type: "message", message: { role: "system", content: "", sections: { skills: spoof, tools: spoof } } },
    { type: "model_change", provider: "research", modelId: "research" },
  ]).status === "unknown");
  check("system checkpoint in compaction preserves source evidence", detect([{ type: "compaction", systemMessage: system(spoof).message }]).selected.id === "research");
  check("legacy structured system prompt is supported", detect([{ type: "message", message: { role: "system", content: spoof } }]).selected.id === "research");
  check("unstructured system text mentions are insufficient", detect([{ type: "message", message: { role: "system", content: path.join(research, "AGENTS.md") } }]).status === "unknown");
  const nested = `<project_instructions path="${path.join(profiles[1].agentDir, "AGENTS.md")}">example: ${context(profiles[2])}</project_instructions>`;
  check("examples nested inside instructions cannot introduce another identity", detect([system(nested)]).selected.id === "research");
  check("repeated matching contexts remain unambiguous", detect([system(spoof), system(spoof)]).status === "detected");
  const conflict = detect([system(spoof), system(context(profiles[2]))]);
  check("multiple environments anywhere in source require manual choice", conflict.status === "conflict" && conflict.selected === null);
  check("unconfigured Pi directories cannot silently inherit a host account", detect([system('<project_instructions path="' + path.join(home, ".pi", "agent-unconfigured", "AGENTS.md") + '">rules</project_instructions>')]).status === "unknown");
  check("foreign-home or project-local lookalikes are not source account evidence", detect([system('<project_instructions path="/another-user/.pi/agent-team/AGENTS.md">rules</project_instructions>')]).status === "unknown");
  check("malformed Context fails closed", detect([system(`<project_instructions path="${path.join(research, "AGENTS.md")}">unfinished`)]).status === "unknown");
  check("truncation cannot conceal later conflicting source environments", detect([system(spoof)], true).status === "unknown");

  const action = { command: "pi", args: ["--session", "/source.jsonl"], verified: true,
    verificationBasis: "cli-help", verificationNote: "test", requiresConfirmation: true, description: "test",
    piEnvironment: conflict };
  assert.throws(() => assertPiEnvironmentSelected(action));
  check("legacy launch refuses unresolved environments before spawning", !launchNativeResume(action).ok);
  const chosen = selectPiEnvironment(action, "team");
  assertPiEnvironmentSelected(chosen);
  check("manual choice accepts only configured IDs and explicitly sets agent dir", chosen.env.PI_CODING_AGENT_DIR === profiles[2].agentDir && chosen.piEnvironment.status === "selected");
  assert.throws(() => selectPiEnvironment(action, "/arbitrary/path"));
  assert.throws(() => selectPiEnvironment({ ...action, piEnvironment: detect([system(spoof)]) }, "team"));
  check("caller cannot replace a detected identity or supply arbitrary paths", true);
  check("Pi confirmation describes selected environment without credential contents", describeNativeResume(chosen).includes("Pi Team") && describeNativeResume(chosen).includes("PI_CODING_AGENT_DIR="));

  for (const bad of [
    { piEnvironments: [] },
    { piEnvironments: [{ id: "x", agentDir: "relative/path" }] },
    { piEnvironments: [{ id: "x", agentDir: "~/.pi/agent", command: "evil" }] },
    { piEnvironments: [{ id: "x", agentDir: "~/.pi/agent", apiKey: "secret" }] },
    { piEnvironments: [{ id: "x", agentDir: "~/.pi/agent" }, { id: "x", agentDir: research }] },
    { piEnvironments: [{ id: "x", agentDir: research }, { id: "y", agentDir: research + "/" }] },
  ]) assert.throws(() => parsePiEnvironments(bad, home), HubConfigError);
  check("user configuration validates duplicates and rejects commands/credentials", true);
  check("absent configuration has only the standard Pi default, no private account names", loadPiEnvironments(home).length === 1 && loadPiEnvironments(home)[0].agentDir === path.join(home, ".pi", "agent"));

  await buildToolHome(home);
  const configFile = hubConfigPath(home);
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify(config));
  for (const profile of profiles) fs.mkdirSync(profile.agentDir, { recursive: true });
  const registry = new AdapterRegistry(home);
  service = new SessionHubService({ home, registry });
  await service.refresh();
  const pi = (await service.listSessions()).find(session => session.harness === "pi");
  const append = entry => fs.appendFileSync(pi.path, JSON.stringify(entry) + "\n");
  append(system(spoof));
  const fileBefore = fs.readFileSync(pi.path);
  const originalFiles = registry.get("pi").files;
  registry.get("pi").files = () => { throw new Error("no provider walk"); };
  // Fail the test if any inference/configuration operation attempts auth reads.
  const originalRead = fs.readFileSync;
  const originalOpen = fs.openSync;
  const forbidAuth = file => { if (typeof file === "string" && /(?:auth|credentials)\.json$/.test(file)) throw new Error("credential read forbidden"); };
  fs.readFileSync = function(file, ...args) { forbidAuth(file); return originalRead.call(this, file, ...args); };
  fs.openSync = function(file, ...args) { forbidAuth(file); return originalOpen.call(this, file, ...args); };
  try {
    const resumed = await service.resolveResume(pi.uid);
    check("service resolves exact source and restores configured environment without auth reads", resumed.action.env.PI_CODING_AGENT_DIR === research && resumed.action.piEnvironment.selected.id === "research");
    check("environment resolution never writes the source", fs.readFileSync(pi.path).equals(fileBefore));
  } finally { registry.get("pi").files = originalFiles; fs.readFileSync = originalRead; fs.openSync = originalOpen; }
  const renamedConfig = { piEnvironments: config.piEnvironments.map(profile => profile.id === "research" ? { ...profile, id: "renamed", label: "Renamed Profile" } : profile) };
  fs.writeFileSync(configFile, JSON.stringify(renamedConfig));
  check("user config changes are reloaded on next Resume, not compiled into extension", (await service.resolveResume(pi.uid)).action.piEnvironment.selected.id === "renamed");
  fs.writeFileSync(configFile, "invalid JSON");
  await assert.rejects(() => service.resolveResume(pi.uid), HubConfigError);
  check("invalid user config is a clear error, not a silent fallback", true);
  fs.unlinkSync(configFile);
  const denied = path.join(home, "auth.json");
  fs.writeFileSync(denied, "must not be read");
  fs.symlinkSync(denied, configFile);
  assert.throws(() => loadPiEnvironments(home), HubConfigError);
  check("config symlink cannot redirect to credential-like stores", true);
} finally { service?.close(); fs.rmSync(temp, { recursive: true, force: true }); }
console.log(`${checks} Pi environment/config checks passed (synthetic sources only).`);
