/** Synthetic homes only. Run: node test/codex-homes.mjs */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { parseCodexHomes, loadCodexHomes, parsePiEnvironments, loadPiEnvironments,
  hubConfigPath, HubConfigError } = await jiti.import("../src/core/config.ts");
const { CodexAdapter } = await jiti.import("../src/adapters/codex.ts");
const { AdapterRegistry } = await jiti.import("../src/adapters/registry.ts");
const { SessionHubService } = await jiti.import("../src/core/service.ts");
const { isDeniedPath } = await jiti.import("../src/security.ts");

const ids = Array.from({ length: 12 }, (_, i) => `${String(i + 1).padStart(8, "0")}-2222-4333-8444-555555555555`);
const rawRead = fs.readFileSync;
const rawRealpath = fs.realpathSync;
const canonical = file => rawRealpath(file);
const ref = (file, id = ids[0]) => ({ harness: "codex", uid: `codex:${id}`, nativeId: id, path: file });
const sortedIds = rows => rows.map(row => row.nativeId).sort();

function fixture() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "hub-codex-homes-"));
  const home = path.join(temp, "home");
  const roots = [path.join(home, ".codex"), path.join(temp, "alternate Codex home"), path.join(temp, "third-home")];
  const configFile = hubConfigPath(home);
  const snapshots = new Map();
  const services = [];
  const write = (file, contents) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
    snapshots.set(file, Buffer.from(contents));
    return file;
  };
  function session(root, id, marker = "syntheticneedle", options = {}) {
    const file = options.file ?? path.join(root, "sessions", "2026", "06", "12", `rollout-${id}.jsonl`);
    const cwd = options.cwd ?? path.join(temp, "projects", id);
    fs.mkdirSync(cwd, { recursive: true });
    return write(file, [
      { timestamp: "2026-06-12T10:00:00.000Z", type: "session_meta", payload: { id, cwd, cli_version: "0.0.0-synthetic" } },
      { timestamp: "2026-06-12T10:00:01.000Z", type: "turn_context", payload: { model: "synthetic-model", cwd } },
      { timestamp: "2026-06-12T10:00:02.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: marker }] } },
      { timestamp: "2026-06-12T10:00:03.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `reply ${marker}` }] } },
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
  }
  function config(value) {
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify(value));
  }
  function service() {
    const registry = new AdapterRegistry(home);
    for (const adapter of registry.all()) registry.setEnabled(adapter.id, adapter.id === "codex");
    const hub = new SessionHubService({ home, registry });
    services.push(hub);
    return { hub, adapter: registry.get("codex") };
  }
  return { temp, home, roots, configFile, snapshots, write, session, config, service,
    cleanup() {
      try {
        for (const hub of services) hub.close();
        for (const [file, before] of snapshots) assert.deepEqual(rawRead(file), before, `source changed: ${file}`);
      } finally { fs.rmSync(temp, { recursive: true, force: true }); }
    } };
}

/** Record attempts even if provider code catches the thrown error. */
async function guarded(f, run, beforeRead = () => {}) {
  const attempts = [];
  const originals = [];
  function inspect(file) {
    if (file instanceof URL) file = fileURLToPath(file);
    if (Buffer.isBuffer(file)) file = file.toString();
    if (typeof file !== "string") return;
    let real;
    try { real = rawRealpath(file); } catch { /* Missing paths have no real target. */ }
    if (isDeniedPath(file) || (real && isDeniedPath(real))) {
      attempts.push(file);
      throw new Error(`credential read forbidden: ${file}`);
    }
    beforeRead(file);
  }
  for (const [target, keys] of [[fs, ["readFileSync", "openSync", "readFile", "open"]], [fs.promises, ["readFile", "open"]]]) {
    for (const key of keys) {
      const original = target[key];
      originals.push([target, key, original]);
      target[key] = function(file, ...args) {
        const flags = args[0];
        const readCapable = typeof flags === "number" ? (flags & 3) !== fs.constants.O_WRONLY
          : typeof flags !== "string" || flags.startsWith("r") || flags.includes("+");
        if (!key.startsWith("open") || readCapable) inspect(file);
        return original.call(this, file, ...args);
      };
    }
  }
  try { return await run(); }
  finally {
    for (const [target, key, original] of originals) target[key] = original;
    assert.deepEqual(attempts, [], "configuration/discovery/read/resume must never attempt credential reads");
  }
}

async function check(name, run) {
  await test(name, async () => {
    const f = fixture();
    try { await guarded(f, () => run(f)); }
    finally { f.cleanup(); }
  });
}

async function blocked(run, message) {
  let result;
  try { result = await run(); }
  catch (error) { assert.ok(error instanceof Error, message); return; }
  assert.equal(result, null, message);
}

await check("config: defaults, replacement, tilde/absolute normalization and combined Pi config", async f => {
  assert.equal(typeof parseCodexHomes, "function");
  assert.equal(typeof loadCodexHomes, "function");
  assert.deepEqual(parseCodexHomes({}, f.home), [f.roots[0]]);
  assert.deepEqual(loadCodexHomes(f.home), [f.roots[0]]);
  const config = { codexHomes: ["~/profiles/../codex research/", f.roots[1] + "/./"],
    piEnvironments: [{ id: "team", label: "Pi Team", agentDir: "~/.pi/agent-team" }] };
  assert.deepEqual(parseCodexHomes(config, f.home), [path.join(f.home, "codex research"), f.roots[1]]);
  assert.deepEqual(parsePiEnvironments(config, f.home), [{ id: "team", label: "Pi Team", agentDir: path.join(f.home, ".pi", "agent-team") }]);
  assert.deepEqual(parsePiEnvironments({ codexHomes: [f.roots[1]] }, f.home), parsePiEnvironments({}, f.home));
  assert.deepEqual(parseCodexHomes({ piEnvironments: config.piEnvironments }, f.home), [f.roots[0]]);
  assert.deepEqual(parseCodexHomes({ codexHomes: [f.roots[1]] }, f.home), [f.roots[1]], "explicit list replaces, not appends, the default");
});

await check("config: both parsers reject invalid Codex/Pi fields and unknown keys fail closed", async f => {
  const badRoots = [[], "~/.codex", null, {}, 12, [null], [12], [true], [{}], [[f.roots[0]]], [""],
    ["relative/codex"], [".codex"], ["~someone/.codex"], ["~"], [f.roots[0], f.roots[0] + "/"],
    ["~/.codex", f.roots[0]], [f.roots[0], path.join(f.home, "profiles", "..", ".codex")],
    ...["\0", "\n", "\r", "\t", "\x1b", "\x7f"].map(control => [f.roots[1] + control]),
    ...["auth.json", "credentials.json", ".env", ".env.local", ".git-credentials", ".netrc", "credentials/account", "backups/codex"].map(name => [path.join(f.temp, name)])];
  const invalid = [null, [], "config", 1, true,
    ...badRoots.map(codexHomes => ({ codexHomes })),
    { codexHomes: [f.roots[1]], unknown: true },
    { codexHomes: [f.roots[1]], command: "evil" },
    { codexHomes: [f.roots[1]], apiKey: "synthetic" },
    { codexHomes: [f.roots[1]], piEnvironments: [] },
    { codexHomes: [f.roots[1]], piEnvironments: [{ id: "x", agentDir: "relative" }] },
    { codexHomes: [f.roots[1]], piEnvironments: [{ id: "x", agentDir: "~/.pi/a", command: "evil" }] },
    { codexHomes: [f.roots[1]], piEnvironments: [{ id: "x", agentDir: "~/.pi/a" }, { id: "x", agentDir: "~/.pi/b" }] },
  ];
  for (const value of invalid) {
    for (const parse of [parseCodexHomes, parsePiEnvironments]) {
      assert.throws(() => parse(value, f.home), HubConfigError, `${parse.name}: ${JSON.stringify(value)}`);
    }
  }
});

await check("loaders reread combined config every call; malformed/unsafe config never falls back", async f => {
  const pi = { id: "research", label: "Pi Research", agentDir: "~/.pi/research" };
  f.config({ codexHomes: [f.roots[1]], piEnvironments: [pi] });
  assert.deepEqual(loadCodexHomes(f.home), [f.roots[1]]);
  assert.equal(loadPiEnvironments(f.home)[0].id, "research");
  f.config({ codexHomes: [f.roots[2]], piEnvironments: [{ ...pi, id: "renamed" }] });
  assert.deepEqual(loadCodexHomes(f.home), [f.roots[2]]);
  assert.equal(loadPiEnvironments(f.home)[0].id, "renamed");
  for (const contents of ["not JSON", "{", JSON.stringify({ codexHomes: [] }), JSON.stringify({ piEnvironments: [] }), JSON.stringify({ unknown: 1 })]) {
    fs.writeFileSync(f.configFile, contents);
    for (const load of [loadCodexHomes, loadPiEnvironments]) assert.throws(() => load(f.home), HubConfigError);
  }
  fs.unlinkSync(f.configFile);
  assert.deepEqual(loadCodexHomes(f.home), [f.roots[0]]);
  assert.deepEqual(loadPiEnvironments(f.home), parsePiEnvironments({}, f.home));
  const credentials = f.write(path.join(f.home, "auth.json"), '{"synthetic":"never read"}');
  fs.symlinkSync(credentials, f.configFile);
  for (const load of [loadCodexHomes, loadPiEnvironments]) assert.throws(() => load(f.home), HubConfigError);
});

await check("same adapter reloads roots on detect/list; either sole existing sessions root is available", async f => {
  const adapter = new CodexAdapter(f.home);
  assert.equal((await adapter.detect()).status, "path_missing");
  f.session(f.roots[1], ids[1]);
  f.config({ codexHomes: [f.roots[0], f.roots[1]] });
  assert.equal((await adapter.detect()).status, "available", "missing default must not hide alternate");
  assert.deepEqual(sortedIds(await adapter.listSessions()), [ids[1]]);
  f.session(f.roots[0], ids[0]);
  f.config({ codexHomes: [f.roots[0], f.roots[2]] });
  assert.equal((await adapter.detect()).status, "available", "missing alternate must not hide default");
  assert.deepEqual(sortedIds(await adapter.listSessions()), [ids[0]]);
  f.session(f.roots[2], ids[2]);
  assert.deepEqual(sortedIds(await adapter.listSessions()), ids.slice(0, 1).concat(ids[2]));
  f.config({ codexHomes: [f.roots[1]] });
  assert.deepEqual(sortedIds(await adapter.listSessions()), [ids[1]], "removed roots and implicit default are excluded");
  fs.unlinkSync(f.configFile);
  assert.deepEqual(sortedIds(await adapter.listSessions()), [ids[0]]);
  fs.writeFileSync(f.configFile, "invalid JSON");
  await assert.rejects(() => adapter.detect(), HubConfigError);
  await assert.rejects(() => adapter.listSessions(), HubConfigError);
});

await check("service scans, reads and searches every configured home; refresh reuses all unchanged sources", async f => {
  const files = f.roots.map((root, i) => f.session(root, ids[i], `rootneedle${i}`));
  f.config({ codexHomes: f.roots, piEnvironments: [{ id: "default", agentDir: "~/.pi/agent" }] });
  for (const root of f.roots) {
    f.write(path.join(root, "auth.json"), '{"token":"synthetic"}');
    f.write(path.join(root, "credentials.json"), "synthetic");
    f.write(path.join(root, ".env"), "SYNTHETIC=never-read");
    f.session(root, ids[10], "outside sessions must not be indexed", { file: path.join(root, "rollout-outside.jsonl") });
  }
  const { hub, adapter } = f.service();
  const first = await hub.refresh();
  assert.deepEqual(first.errors, []);
  assert.equal(first.total, 3);
  const rows = await hub.listSessions();
  assert.deepEqual(sortedIds(rows), ids.slice(0, 3));
  for (let i = 0; i < files.length; i++) {
    const matches = await hub.listSessions({ text: `rootneedle${i}`, harness: "codex" });
    assert.deepEqual(sortedIds(matches), [ids[i]]);
    const detail = await hub.getSession(`codex:${ids[i]}`);
    assert.equal(canonical(detail.path), files[i]);
    assert.ok(detail.messages.some(message => message.text.includes(`rootneedle${i}`)));
  }
  const seen = new Set();
  await guarded(f, async () => {
    const repeated = await hub.refresh();
    assert.equal(repeated.skipped, 3);
    assert.equal(repeated.added, 0);
    assert.equal(repeated.updated, 0);
    assert.deepEqual(repeated.errors, []);
    assert.deepEqual(sortedIds(await hub.listSessions({ text: "rootneedle1" })), [ids[1]]);
  }, file => { if (files.includes(file)) { seen.add(file); throw new Error("unchanged refresh/query reread a source"); } });
  assert.deepEqual([...seen], [], "cached refresh and indexed search never open source content");
  assert.equal(typeof adapter.buildNativeResumeByRef, "function");
});

await check("exact indexed refs read/resume only their source, without walking any session history", async f => {
  const files = f.roots.map((root, i) => f.session(root, ids[i], `exactneedle${i}`));
  f.config({ codexHomes: f.roots });
  const { hub, adapter } = f.service();
  await hub.refresh();
  const rows = await hub.listSessions();
  const originalReaddir = fs.readdirSync;
  const walked = [];
  fs.readdirSync = function(dir, ...args) {
    if (typeof dir === "string" && f.roots.some(root => dir === path.join(root, "sessions") || dir.startsWith(path.join(root, "sessions") + path.sep))) {
      walked.push(dir);
      throw new Error("per-ref operation must not rescan histories");
    }
    return originalReaddir.call(this, dir, ...args);
  };
  try {
    for (const row of rows) {
      const openedOther = [];
      await guarded(f, async () => {
        const detail = await adapter.getSessionByRef(row);
        assert.equal(detail.path, row.path);
        assert.equal(detail.uid, row.uid);
        const action = await adapter.buildNativeResumeByRef(row);
        assert.equal(action.env.CODEX_HOME, f.roots[ids.indexOf(row.nativeId)]);
        assert.equal(action.cwd, row.cwd);
        assert.equal(action.command, "codex");
        assert.deepEqual(action.args, ["resume", row.nativeId]);
        assert.equal(action.verified, true);
        const resolved = await hub.resolveResume(row.uid);
        assert.equal(resolved.action.env.CODEX_HOME, action.env.CODEX_HOME);
        assert.equal(resolved.action.cwd, row.cwd);
        assert.equal((await hub.getSession(row.uid)).uid, row.uid);
      }, file => {
        if (files.includes(file) && file !== row.path) { openedOther.push(file); throw new Error("read unrelated source"); }
      });
      assert.deepEqual(openedOther, []);
    }
    assert.deepEqual(walked, []);
  } finally { fs.readdirSync = originalReaddir; }
});

await check("root additions/removals affect existing service/adapter; removed indexed refs cannot resume", async f => {
  f.session(f.roots[0], ids[0]);
  f.session(f.roots[1], ids[1]);
  f.session(f.roots[2], ids[2]);
  f.config({ codexHomes: [f.roots[0], f.roots[1]] });
  const { hub, adapter } = f.service();
  await hub.refresh();
  const removed = (await hub.listSessions()).find(row => row.nativeId === ids[0]);
  f.config({ codexHomes: [f.roots[1], f.roots[2]] });
  await blocked(() => adapter.buildNativeResumeByRef(removed), "removed root blocks old indexed ref before refresh");
  await blocked(() => hub.resolveResume(removed.uid), "service blocks stale indexed resume before refresh");
  assert.equal(await adapter.buildNativeResume(ids[0]), null);
  assert.deepEqual(sortedIds(await adapter.listSessions()), ids.slice(1, 3));
  const changed = await hub.refresh();
  assert.equal(changed.total, 2);
  assert.equal(changed.removed, 1);
  assert.deepEqual(sortedIds(await hub.listSessions()), ids.slice(1, 3));
  assert.equal((await hub.resolveResume(`codex:${ids[2]}`)).action.env.CODEX_HOME, f.roots[2]);
  fs.writeFileSync(f.configFile, "{ malformed");
  await assert.rejects(() => adapter.buildNativeResumeByRef(ref(path.join(f.roots[1], "sessions", "missing.jsonl"), ids[1])), HubConfigError);
  const failed = await hub.refresh();
  assert.ok(failed.failed.includes("codex"));
  assert.equal(failed.removed, 0);
  assert.equal((await hub.listSessions()).length, 2, "bad config cannot delete indexed history");
  await assert.rejects(() => hub.resolveResume(`codex:${ids[1]}`), HubConfigError);
});

await check("global listing cap/cache spans all homes; cap/read gaps report incomplete and never prune", async f => {
  f.roots.forEach((root, i) => f.session(root, ids[i]));
  f.config({ codexHomes: f.roots });
  const { hub, adapter } = f.service();
  await hub.refresh();
  const cached = new Map((await hub.listSessions()).map(row => [row.path, row]));
  const reused = [];
  const gaps = [];
  const limited = await adapter.listSessions({ maxSessions: 2, onIncomplete: reason => gaps.push(reason),
    reuseUnchanged: (file, stat) => { assert.ok(stat.size > 0); reused.push(file); return cached.get(file); } });
  assert.equal(limited.length, 2, "cap is global, not independently applied per home");
  assert.equal(reused.length, 2, "shared cache callback applies to every listed root");
  assert.ok(gaps.length > 0);
  const zeroGaps = [];
  assert.deepEqual(await adapter.listSessions({ maxSessions: 0, onIncomplete: reason => zeroGaps.push(reason) }), []);
  assert.ok(zeroGaps.length > 0);
  const capped = await hub.refresh({ maxPerHarness: 1 });
  assert.ok(capped.incomplete.includes("codex"));
  assert.equal(capped.total, 3);
  assert.equal(capped.removed, 0);
  for (const maxSessions of [-1, 1.5, NaN, Infinity]) await assert.rejects(() => adapter.listSessions({ maxSessions }), /limit/i);
  const originalReaddir = fs.readdirSync;
  fs.readdirSync = function(dir, ...args) {
    if (dir === path.join(f.roots[1], "sessions")) throw Object.assign(new Error("synthetic permission gap"), { code: "EACCES" });
    return originalReaddir.call(this, dir, ...args);
  };
  try {
    const gap = await hub.refresh();
    assert.ok(gap.incomplete.includes("codex"));
    assert.ok(gap.errors.some(error => error.harness === "codex"));
    assert.equal(gap.total, 3);
    assert.equal(gap.removed, 0);
  } finally { fs.readdirSync = originalReaddir; }
  // Empty files are unparseable even though the legacy reader can derive a
  // fallback ID for nonempty, malformed JSONL. Do not change that behavior.
  f.write(path.join(f.roots[2], "sessions", "unparseable.jsonl"), "");
  const parseGap = await hub.refresh();
  assert.ok(parseGap.incomplete.includes("codex"));
  assert.equal(parseGap.total, 3);
  assert.equal(parseGap.removed, 0);
});

await check("resolved-file aliases are deduplicated; duplicate UIDs across distinct homes remain one indexed row", async f => {
  const source = f.session(f.roots[0], ids[0], "aliasneedle");
  const alias = path.join(f.temp, "home-alias");
  fs.symlinkSync(f.roots[0], alias, "dir");
  f.config({ codexHomes: [f.roots[0], alias] });
  const { hub, adapter } = f.service();
  const rows = await adapter.listSessions();
  assert.equal(rows.length, 1);
  assert.equal(canonical(rows[0].path), source);
  const reused = [];
  await adapter.listSessions({ reuseUnchanged: file => { reused.push(canonical(file)); return rows[0]; } });
  assert.deepEqual(reused, [source], "dedup occurs before cache/parse work");
  assert.equal((await adapter.detect()).sessionCount, 1);
  f.config({ codexHomes: [alias] });
  const aliasedSource = path.join(alias, path.relative(f.roots[0], source));
  assert.equal((await adapter.buildNativeResumeByRef(ref(aliasedSource))).env.CODEX_HOME, alias,
    "resume keeps the configured home, not an inferred realpath account name");
  f.session(f.roots[1], ids[0], "duplicateneedle");
  f.config({ codexHomes: [f.roots[0], f.roots[1]] });
  await hub.refresh();
  assert.equal((await hub.listSessions()).length, 1, "existing UID index semantics choose either source");
  const indexed = (await hub.listSessions())[0];
  const expectedHome = canonical(indexed.path) === source ? f.roots[0] : f.roots[1];
  const resumed = await hub.resolveResume(indexed.uid);
  assert.equal(resumed.action.env.CODEX_HOME, expectedHome);
  const repeated = await hub.refresh();
  assert.equal(repeated.skipped, 2, "both physical duplicate-ID sources are cached");
  assert.equal(repeated.total, 1);
  assert.equal((await hub.listSessions())[0].path, indexed.path, "unchanged refresh preserves whichever source won");
});

await check("cached duplicate UID switches canonical source when only the winning home is unconfigured", async f => {
  const needles = ["defaultcopyuniqueneedle", "alternatecopyuniqueneedle"];
  const files = f.roots.slice(0, 2).map((root, i) => f.session(root, ids[0], needles[i]));
  f.config({ codexHomes: f.roots.slice(0, 2) });
  const { hub } = f.service();
  await hub.refresh();
  const repeated = await hub.refresh();
  assert.equal(repeated.skipped, 2, "both duplicate paths must already be fingerprint-cached");
  const indexed = (await hub.listSessions())[0];
  const removedIndex = files.indexOf(canonical(indexed.path));
  assert.ok(removedIndex === 0 || removedIndex === 1);
  const retainedIndex = 1 - removedIndex;
  f.config({ codexHomes: [f.roots[retainedIndex]] });
  const refreshed = await hub.refresh();
  assert.deepEqual(refreshed.errors, []);
  assert.equal(refreshed.total, 1);
  const remaining = (await hub.listSessions())[0];
  const resumed = await hub.resolveResume(remaining.uid);
  const detail = await hub.getSession(remaining.uid);
  assert.deepEqual({ path: canonical(remaining.path), resumeHome: resumed?.action.env?.CODEX_HOME ?? null,
    readPath: detail?.path ?? null },
  { path: files[retainedIndex], resumeHome: f.roots[retainedIndex], readPath: files[retainedIndex] },
  `cached remaining copy must replace canonical path from removed home ${f.roots[removedIndex]}`);
  for (const searchScope of [undefined, "user"]) {
    const query = searchScope === undefined ? {} : { searchScope };
    assert.deepEqual(sortedIds(await hub.listSessions({ ...query, text: needles[retainedIndex] })), [ids[0]],
      `${searchScope ?? "legacy"} search must index the retained copy's distinct prompt`);
    assert.deepEqual(await hub.listSessions({ ...query, text: needles[removedIndex] }), [],
      `${searchScope ?? "legacy"} search must discard the removed copy's distinct prompt`);
  }
});

await check("canonical path changing UID A to B relocates A to its cached surviving copy", async f => {
  const needles = ["originaldefaultuidneedle", "originalalternateuidneedle"];
  const replacementNeedle = "replacementuidbuniquepromptneedle";
  const files = f.roots.slice(0, 2).map((root, i) => f.session(root, ids[0], needles[i]));
  f.config({ codexHomes: f.roots.slice(0, 2) });
  const { hub } = f.service();
  await hub.refresh();
  assert.equal((await hub.refresh()).skipped, 2, "both A copies must be cached before replacing P");
  const canonicalA = (await hub.listSessions())[0];
  const replacedIndex = files.indexOf(canonical(canonicalA.path));
  assert.ok(replacedIndex === 0 || replacedIndex === 1);
  const survivingIndex = 1 - replacedIndex;
  f.session(f.roots[replacedIndex], ids[1], replacementNeedle, { file: files[replacedIndex] });
  const refreshed = await hub.refresh();
  assert.deepEqual(refreshed.errors, []);
  assert.equal(refreshed.total, 2);
  assert.equal(refreshed.removed, 0);
  const rows = await hub.listSessions();
  assert.deepEqual(sortedIds(rows), ids.slice(0, 2));
  for (const [id, sourceIndex, needle] of [
    [ids[0], survivingIndex, needles[survivingIndex]],
    [ids[1], replacedIndex, replacementNeedle],
  ]) {
    const row = rows.find(session => session.nativeId === id);
    assert.equal(canonical(row.path), files[sourceIndex], `${id}: canonical metadata must select its own source`);
    const detail = await hub.getSession(row.uid);
    assert.equal(detail?.uid, row.uid);
    assert.equal(detail?.path, files[sourceIndex]);
    assert.ok(detail.messages.some(message => message.role === "user" && message.text.includes(needle)));
    const resumed = await hub.resolveResume(row.uid);
    assert.equal(resumed?.session.path, files[sourceIndex]);
    assert.equal(resumed?.action.env.CODEX_HOME, f.roots[sourceIndex]);
    assert.deepEqual(resumed?.action.args, ["resume", id]);
    assert.equal(resumed?.action.cwd, path.join(f.temp, "projects", id));
  }
  for (const searchScope of [undefined, "user"]) {
    const query = searchScope === undefined ? {} : { searchScope };
    assert.deepEqual(sortedIds(await hub.listSessions({ ...query, text: needles[survivingIndex] })), [ids[0]],
      `${searchScope ?? "legacy"}: surviving Q supplies A's prompt`);
    assert.deepEqual(sortedIds(await hub.listSessions({ ...query, text: replacementNeedle })), [ids[1]],
      `${searchScope ?? "legacy"}: replaced P supplies B's prompt`);
    assert.deepEqual(await hub.listSessions({ ...query, text: needles[replacedIndex] }), [],
      `${searchScope ?? "legacy"}: P's obsolete A prompt must not survive relocation`);
  }
});

await check("resume validates UID/native id, current membership and lexical/realpath containment", async f => {
  const source = f.session(f.roots[0], ids[0]);
  f.config({ codexHomes: [f.roots[0]] });
  const adapter = new CodexAdapter(f.home);
  assert.ok(await adapter.buildNativeResumeByRef(ref(source)));
  assert.equal(await adapter.getSessionByRef(ref(source, ids[1])), null, "indexed UID must match source metadata");
  const invalidRefs = [
    ref(source, ids[1]),
    { ...ref(source), nativeId: ids[1] },
    { ...ref(source), uid: `codex:${ids[1]}` },
    { ...ref(source), harness: "pi" },
    { ...ref(source), nativeId: "--help", uid: "codex:--help" },
    { ...ref(source), nativeId: ids[0] + "\n", uid: `codex:${ids[0]}\n` },
    ref(path.join(f.roots[0], "sessions", "missing.jsonl")),
  ];
  const outside = f.session(f.roots[1], ids[0]);
  const prefix = f.session(f.roots[0], ids[0], "prefix escape", { file: path.join(f.roots[0], "sessions-escape", "source.jsonl") });
  const sibling = f.session(f.roots[0], ids[0], "outside sessions", { file: path.join(f.roots[0], "source.jsonl") });
  invalidRefs.push(ref(outside), ref(prefix), ref(sibling), ref(path.join(f.roots[0], "sessions", "..", "source.jsonl")));
  const link = path.join(f.roots[0], "sessions", "linked.jsonl");
  fs.symlinkSync(outside, link);
  const dirLink = path.join(f.roots[0], "sessions", "linked-directory");
  fs.symlinkSync(path.dirname(outside), dirLink, "dir");
  invalidRefs.push(ref(link), ref(path.join(dirLink, path.basename(outside))));
  for (const bad of invalidRefs) await blocked(() => adapter.buildNativeResumeByRef(bad), JSON.stringify(bad));
  for (const escaped of [outside, prefix, sibling, link, path.join(dirLink, path.basename(outside))]) {
    await blocked(() => adapter.getSessionByRef(ref(escaped)), `escaped source must not be read: ${escaped}`);
  }
  const credentials = f.session(f.roots[0], ids[0], "credential decoy", { file: path.join(f.roots[0], "sessions", "credentials", "source.jsonl") });
  await blocked(() => adapter.buildNativeResumeByRef(ref(credentials)), "credential-like source cannot be resumed");
  const auth = f.write(path.join(f.roots[0], "auth.json"), rawRead(source));
  const authLink = path.join(f.roots[0], "sessions", "auth-link.jsonl");
  fs.symlinkSync(auth, authLink);
  await blocked(() => adapter.buildNativeResumeByRef(ref(authLink)), "real credential target cannot be opened");
  f.session(f.roots[0], ids[1], "replaced source", { file: source });
  assert.equal(await adapter.getSessionByRef(ref(source)), null, "same path with changed source UID is not the indexed session");
  await blocked(() => adapter.buildNativeResumeByRef(ref(source)), "source replacement invalidates stale resume");
});

await check("overlapping configured trees dedup discovery and select the most-specific home", async f => {
  const innerHome = path.join(f.roots[0], "sessions", "nested-codex-home");
  const outer = f.session(f.roots[0], ids[0]);
  const inner = f.session(innerHome, ids[1]);
  f.config({ codexHomes: [f.roots[0], innerHome] });
  const adapter = new CodexAdapter(f.home);
  assert.deepEqual(sortedIds(await adapter.listSessions()), ids.slice(0, 2));
  assert.equal((await adapter.buildNativeResumeByRef(ref(outer))).env.CODEX_HOME, f.roots[0]);
  assert.equal((await adapter.buildNativeResumeByRef(ref(inner, ids[1]))).env.CODEX_HOME, innerHome);
  assert.equal((await adapter.buildNativeResume(ids[1])).env.CODEX_HOME, innerHome);
  f.config({ codexHomes: [innerHome, f.roots[0]] });
  assert.equal((await adapter.buildNativeResumeByRef(ref(inner, ids[1]))).env.CODEX_HOME, innerHome,
    "source ownership does not depend on config order");
});

await check("legacy native-id resume locates actual source/home and source cwd; unknown ids return null", async f => {
  f.roots.forEach((root, i) => f.session(root, ids[i]));
  f.config({ codexHomes: [f.roots[1], f.roots[2]] });
  const adapter = new CodexAdapter(f.home);
  for (const i of [1, 2]) {
    const action = await adapter.buildNativeResume(ids[i]);
    assert.equal(action.env.CODEX_HOME, f.roots[i]);
    assert.equal(action.cwd, path.join(f.temp, "projects", ids[i]));
    assert.deepEqual(action.args, ["resume", ids[i]]);
  }
  assert.equal(await adapter.buildNativeResume(ids[0]), null, "unconfigured default source is not eligible");
  assert.equal(await adapter.buildNativeResume(ids[9]), null);
  assert.equal(await adapter.buildNativeResume("--help"), null);
  assert.equal(await adapter.buildNativeResume("../outside"), null);
});
