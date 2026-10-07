import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { buildFakeHome } = await jiti.import("./fixtures/fake-home.mjs");
const { AdapterRegistry } = await jiti.import("../src/adapters/registry.ts");
const { scan } = await jiti.import("../src/index/scan.ts");
const { openIndex, querySessions, removeSessions } = await jiti.import("../src/index/db.ts");
const { indexDbPath } = await jiti.import("../src/security.ts");
const harnesses = ["pi", "claude-code", "codex", "jcode"];
const home = fs.mkdtempSync(path.join(os.tmpdir(), "session-hub-scan-"));
let index;
let reads = [];
let parses = [];
const tracked = new Set();
const readFileSync = fs.readFileSync;
const openSync = fs.openSync;

function check(name, predicate = true) {
  assert.ok(predicate, name);
  console.log(`PASS ${name}`);
}
function record(file) {
  if (tracked.has(file)) reads.push(file);
}
function reset() { reads = []; parses = []; }
function touched(expected) {
  const paths = [...expected].sort();
  assert.deepEqual([...new Set(reads)].sort(), paths, "source files read");
  assert.deepEqual(parses.sort(), paths, "source files parsed");
}
function snapshot() {
  return {
    search: index.db.all("select uid, title, body from search where uid not like 'opencode:%' and uid not like 'crush:%' order by uid"),
    files: index.db.all("select * from files where uid not like 'opencode:%' and uid not like 'crush:%' order by uid, path, kind"),
  };
}

try {
  await buildFakeHome(home);
  const registry = new AdapterRegistry(home);
  const files = new Map();
  for (const id of harnesses) {
    const adapter = registry.get(id);
    const file = adapter.files()[0];
    files.set(id, file);
    tracked.add(file);
    // Exact whole-second mtimes allow tests to restore an unchanged timestamp.
    fs.utimesSync(file, 1767225600, 1767225600);
    const parse = adapter.parse;
    adapter.parse = function(file, ...args) {
      parses.push(file);
      return parse.call(this, file, ...args);
    };
  }
  fs.readFileSync = function(file, ...args) { record(file); return readFileSync.call(this, file, ...args); };
  fs.openSync = function(file, ...args) { record(file); return openSync.call(this, file, ...args); };
  index = await openIndex(indexDbPath(home));

  const first = await scan(index, registry);
  touched(files.values());
  check("first scan reads all four file-backed sources", first.added === 6 && first.skipped === 0 && first.errors.length === 0);
  const stored = snapshot();
  index.close();
  index = await openIndex(indexDbPath(home));
  reset();
  const repeat = await scan(index, registry);
  touched([]);
  assert.deepEqual(snapshot(), stored);
  check("unchanged scan after reopening the index does not read/parse sources or lose FTS/file mappings", repeat.skipped === 4 && repeat.updated === 2 && repeat.total === 6 && repeat.removed === 0);
  check("database-backed adapters still reread both stores", repeat.scanned.includes("opencode") && repeat.scanned.includes("crush") && repeat.updated === 2);

  for (const id of harnesses) {
    const file = files.get(id);
    const before = fs.statSync(file);
    const content = readFileSync(file, "utf8");
    if (id === "claude-code") {
      // No size change: mtime alone must invalidate the cache.
      fs.utimesSync(file, before.atime, new Date(before.mtimeMs + 10000));
    } else {
      const next = id === "codex"
        ? content.replaceAll("worker", "runner") // Same byte size, new mtime.
        : content.replace(`fake ${id}:`, `fake ${id}: incrementalsentinel`);
      assert.notEqual(next, content);
      fs.writeFileSync(file, next);
      if (id === "pi") {
        // No mtime change: size alone must invalidate the cache.
        fs.utimesSync(file, before.atime, before.mtime);
        assert.equal(fs.statSync(file).mtimeMs, before.mtimeMs);
      }
      if (id === "codex") assert.equal(fs.statSync(file).size, before.size);
    }
    reset();
    const changed = await scan(index, registry);
    touched([file]);
    check(`${id}: only the changed file is read and parsed`, changed.skipped === 3 && changed.updated === 3 && changed.added === 0 && changed.errors.length === 0);
  }
  check("changed excerpts become searchable", querySessions(index, { text: "incrementalsentinel", limit: 100 }).length === 2);
  const changedStored = snapshot();
  reset();
  await scan(index, registry);
  touched([]);
  assert.deepEqual(snapshot(), changedStored);
  check("subsequent cached scan preserves updated search text and file mappings");

  // A manual full reindex must bypass the cache.
  reset();
  const forced = await scan(index, registry, { force: true });
  touched(files.values());
  check("force reindex still reads/parses every source", forced.skipped === 0 && forced.updated === 6);

  // Cached entries count toward the same per-harness limit as parsed entries.
  const extras = [];
  const uuid = "11111111-2222-3333-4444-555555555555";
  const nextUuid = "99999999-2222-3333-4444-555555555555";
  for (const id of harnesses) {
    const original = files.get(id);
    const extra = id === "jcode" ? original.replace("session_fake_1", "session_fake_2") : original.replace(uuid, nextUuid);
    const content = readFileSync(original, "utf8").replaceAll(uuid, nextUuid).replaceAll("session_fake_1", "session_fake_2");
    fs.writeFileSync(extra, content);
    // Imported files may keep old timestamps, yet still need indexing.
    fs.utimesSync(extra, 1767139200, 1767139200);
    tracked.add(extra);
    extras.push(extra);
  }
  reset();
  const added = await scan(index, registry);
  touched(extras);
  check("new sessions with old timestamps are read while existing sessions are reused", added.added === 4 && added.skipped === 4 && added.total === 10);
  reset();
  const limited = await scan(index, registry, { maxPerHarness: 1 });
  touched([]);
  check("cached sessions honor the per-harness cap", limited.total === 6 && limited.skipped === 4 && harnesses.every(id => limited.perHarness[id] === 1));
  reset();
  await scan(index, registry);
  touched(extras);
  check("sessions dropped by the limit are read again, not skipped using orphan fingerprints");
  for (const file of extras) fs.unlinkSync(file);
  reset();
  const deleted = await scan(index, registry);
  touched([]);
  check("deleted files are removed without rereading surviving files", deleted.removed === 4 && deleted.total === 6 && deleted.skipped === 4);

  // A fingerprint is not a substitute for an actual session row.
  const pi = querySessions(index, { harness: "pi" })[0];
  removeSessions(index, [pi.uid]);
  reset();
  const repaired = await scan(index, registry);
  touched([files.get("pi")]);
  check("missing session row is rebuilt even if its fingerprint remains", repaired.added === 1 && repaired.skipped === 3);
  index.db.run("delete from sources where harness = ?", ["jcode"]);
  reset();
  const repairedSource = await scan(index, registry);
  touched([files.get("jcode")]);
  check("missing fingerprint also forces a read", repairedSource.skipped === 3);

  const claude = registry.get("claude-code");
  const list = claude.listSessions;
  const beforeFailure = snapshot();
  claude.listSessions = async () => { throw new Error("synthetic scan failure"); };
  reset();
  const failure = await scan(index, registry);
  touched([]);
  assert.deepEqual(snapshot(), beforeFailure);
  check("failed adapter preserves its cached sessions", failure.failed.includes("claude-code") && failure.total === 6 && failure.removed === 0 && failure.errors.length === 1);
  claude.listSessions = list;

  // Normal adapter listings / transcript reads must remain uncached.
  reset();
  const listed = await registry.get("pi").listSessions();
  touched([files.get("pi")]);
  check("standalone adapter listings still provide fresh search excerpts", listed[0].searchText.includes("incrementalsentinel"));
  reset();
  const detail = await registry.get("pi").getSession(pi.native_id);
  touched([files.get("pi")]);
  check("opening a transcript still reads the source", detail.messages.length > 0);
  // Different source paths may contain the same native session ID.
  const duplicates = [];
  for (const file of files.values()) {
    const ext = path.extname(file);
    const duplicate = file.slice(0, -ext.length) + "_duplicate" + ext;
    fs.writeFileSync(duplicate, readFileSync(file, "utf8"));
    tracked.add(duplicate);
    duplicates.push(duplicate);
  }
  await scan(index, registry, { force: true });
  const canonicalPaths = querySessions(index, { limit: 100 }).map(row => [row.uid, row.path]);
  reset();
  const duplicateRepeat = await scan(index, registry);
  touched([]);
  assert.deepEqual(querySessions(index, { limit: 100 }).map(row => [row.uid, row.path]), canonicalPaths);
  check("unchanged duplicate IDs do not cause rereads or overwrite canonical metadata", duplicateRepeat.skipped === 8 && duplicateRepeat.total === 6);
  const changedCopy = files.get("pi");
  fs.writeFileSync(changedCopy, readFileSync(changedCopy, "utf8").replace("billing", "duplicatebilling"));
  reset();
  const changedDuplicate = await scan(index, registry);
  touched([changedCopy]);
  check("only the changed copy of a duplicate ID is parsed", changedDuplicate.skipped === 7 && changedDuplicate.updated === 3);
  check("changed duplicate updates the canonical search row", querySessions(index, { text: "duplicatebilling" }).some(row => row.harness === "pi"));
  const duplicateStored = snapshot();
  const migratedPaths = querySessions(index, { limit: 100 }).map(row => [row.uid, row.path]);
  reset();
  await scan(index, registry);
  touched([]);
  assert.deepEqual(snapshot(), duplicateStored);
  check("unchanged copies cannot overwrite the newly updated canonical excerpt");

  // Recreate the old sources schema to exercise upgrade without a force scan.
  index.db.run("alter table sources drop column uid");
  index.db.run("update meta set value = '1' where key = 'schema_version'");
  index.close();
  index = await openIndex(indexDbPath(home));
  const canonicalSet = new Set(migratedPaths.map(([, file]) => file));
  reset();
  const migrated = await scan(index, registry);
  touched([...tracked].filter(file => !canonicalSet.has(file) && fs.existsSync(file)));
  assert.deepEqual(querySessions(index, { limit: 100 }).map(row => [row.uid, row.path]), migratedPaths);
  assert.deepEqual(snapshot(), duplicateStored);
  check("v1 upgrade reads unmapped copies once without rewriting canonical metadata", migrated.skipped === 8 && migrated.updated === 2);
  reset();
  const afterMigration = await scan(index, registry);
  touched([]);
  check("all duplicate paths are cached after upgrade", afterMigration.skipped === 8);
  console.log("All incremental-scan checks passed (synthetic home only).");
} finally {
  fs.readFileSync = readFileSync;
  fs.openSync = openSync;
  index?.close();
  fs.rmSync(home, { recursive: true, force: true });
}
