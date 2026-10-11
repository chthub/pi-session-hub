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
const { walkFiles, listFileSessions } = await jiti.import("../src/adapters/util.ts");
const { openIndexDb } = await jiti.import("../src/sqlite.ts");
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
  check("capped scans retain undiscovered history and cached fingerprints", limited.total === 10 && limited.removed === 0 && limited.skipped === 4 && limited.incomplete.length === 6 && harnesses.every(id => limited.perHarness[id] === 1));
  reset();
  await scan(index, registry);
  touched([]);
  check("uncapped follow-up reuses sessions retained by the capped scan");
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
  // Old parser fingerprints must not lock head-only metadata into the cache.
  index.db.run("alter table sources drop column parser_version");
  index.db.run("update meta set value = '2' where key = 'schema_version'");
  const beforeParserUpgrade = snapshot();
  index.close();
  index = await openIndex(indexDbPath(home));
  assert.deepEqual(snapshot(), beforeParserUpgrade);
  reset();
  const upgradePartial = await scan(index, registry, { maxPerHarness: 0 });
  touched([]);
  check("parser upgrade plus zero-cap scan retains old indexed history", upgradePartial.total === 6 && upgradePartial.removed === 0);
  reset();
  const upgraded = await scan(index, registry);
  touched([...tracked].filter(file => fs.existsSync(file)));
  check("v2 parser upgrade rereads unchanged files including duplicate paths", upgraded.skipped === 0 && upgraded.errors.length === 0);
  reset();
  await scan(index, registry);
  touched([]);
  check("upgraded parser fingerprints are reusable");

  // Discovery failure, stat failure, and parse failure all preserve old rows.
  const originalReaddir = fs.readdirSync;
  const piRoot = path.dirname(path.dirname(files.get("pi")));
  fs.readdirSync = function(dir, ...args) {
    if (dir === piRoot) throw Object.assign(new Error("synthetic EACCES"), { code: "EACCES" });
    return originalReaddir.call(this, dir, ...args);
  };
  try {
    const gap = await scan(index, registry);
    check("unreadable discovery cannot prune history", gap.incomplete.includes("pi") && gap.total === 6 && gap.removed === 0 && gap.errors.some(e => e.harness === "pi"));
  } finally { fs.readdirSync = originalReaddir; }

  const originalStat = fs.statSync;
  fs.statSync = function(file, ...args) {
    if (tracked.has(file) && String(file).includes("/.pi/")) throw new Error("synthetic stat failure");
    return originalStat.call(this, file, ...args);
  };
  try {
    const gap = await scan(index, registry);
    check("stat failures cannot prune cached sessions", gap.incomplete.includes("pi") && gap.total === 6 && gap.removed === 0);
  } finally { fs.statSync = originalStat; }

  const piAdapter = registry.get("pi");
  const originalParse = piAdapter.parse;
  piAdapter.parse = () => null;
  try {
    const gap = await scan(index, registry, { force: true });
    check("unparseable sources cannot prune indexed sessions", gap.incomplete.includes("pi") && gap.total === 6 && gap.removed === 0);
  } finally { piAdapter.parse = originalParse; }

  // Limits must never become accidental empty, apparently complete scans.
  for (const value of [NaN, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(scan(index, registry, { maxPerHarness: value }), /limit|maxPerHarness/i);
    await assert.rejects(registry.listAll(value), /limit/i);
    for (const adapter of registry.all()) await assert.rejects(adapter.listSessions({ maxSessions: value }), /limit/i);
  }
  check("invalid limits are rejected before indexing or pruning");

  // Exercise the former 5,000 file-list and 20,000 walk ceilings without
  // creating 20,001 physical files. All mocked paths are inside our temp home.
  const walkRoot = path.join(home, "synthetic-walk");
  const names = Array.from({ length: 20001 }, (_, i) => ({
    name: `${i}.jsonl`, isDirectory: () => false, isFile: () => true,
  }));
  fs.readdirSync = function(dir, ...args) {
    if (dir === walkRoot) return names;
    return originalReaddir.call(this, dir, ...args);
  };
  try {
    const allFiles = walkFiles(walkRoot);
    assert.equal(allFiles.length, 20001);
    assert.equal(listFileSessions(allFiles, file => ({ path: file })).length, 20001);
    let incomplete = false;
    assert.equal(walkFiles(walkRoot, { maxFiles: 20000, onIncomplete: () => { incomplete = true; } }).length, 20000);
    assert.ok(incomplete);
    check("default discovery/listing crosses 20,000 files; explicit walk caps report incompleteness");
  } finally { fs.readdirSync = originalReaddir; }

  const deepRoot = path.join(home, "deep-walk");
  const deepFile = path.join(deepRoot, ...Array(10).fill("nested"), "deep.jsonl");
  fs.mkdirSync(path.dirname(deepFile), { recursive: true });
  fs.writeFileSync(deepFile, "{}");
  assert.deepEqual(walkFiles(deepRoot), [deepFile]);
  let depthGap = false;
  walkFiles(deepRoot, { maxDepth: 6, onIncomplete: () => { depthGap = true; } });
  assert.ok(depthGap);
  check("default traversal is not depth-capped; explicit depth caps report incompleteness");

  // >2,000 real synthetic sessions in EVERY harness, including both SQLite
  // adapters. New indexed rows and a reopen/cache pass exercise the full path.
  const bulkHome = path.join(home, "bulk-home");
  const bulkFixture = await buildFakeHome(bulkHome);
  const bulkRegistry = new AdapterRegistry(bulkHome);
  const count = 2003;
  const bulkFiles = [];
  for (const id of harnesses) {
    const source = bulkRegistry.get(id).files()[0];
    const template = readFileSync(source, "utf8");
    for (let i = 1; i < count; i++) {
      const nativeId = `${String(i).padStart(8, "0")}-2222-3333-4444-555555555555`;
      const file = id === "jcode" ? source.replace("session_fake_1", `session_bulk_${i}`) : source.replace(bulkFixture.uuid, nativeId);
      fs.writeFileSync(file, template.replaceAll(bulkFixture.uuid, nativeId).replaceAll("session_fake_1", `session_bulk_${i}`));
      if (i === count - 1) bulkFiles.push(file);
    }
  }
  const bulkDbs = [
    ["opencode", path.join(bulkHome, ".local/share/opencode/opencode.db"), "session"],
    ["crush", path.join(bulkHome, ".crush/crush.db"), "sessions"],
  ];
  for (const [id, file] of bulkDbs) {
    const db = await openIndexDb(file);
    try {
      db.run("begin");
      for (let i = 1; i < count; i++) {
        if (id === "opencode") db.run("insert into session (id,project_id,slug,directory,title,version,time_created,time_updated) values (?,?,?,?,?,?,?,?)", [`bulk_${i}`, "project", "bulk", bulkHome, `Bulk ${i}`, "1", i, i]);
        else db.run("insert into sessions (id,title,message_count,created_at,updated_at) values (?,?,?,?,?)", [`bulk_${i}`, `Bulk ${i}`, 0, i, i]);
      }
      db.run("commit");
    } finally { db.close(); }
  }
  const all = await bulkRegistry.listAll();
  assert.equal(all.errors.length, 0);
  assert.equal(all.sessions.length, count * 6);
  // Separate indexes keep this regression quick despite FTS UID deletion's
  // existing linear cost; every real adapter still crosses the old cap.
  for (const adapter of bulkRegistry.all()) {
    for (const other of bulkRegistry.all()) bulkRegistry.setEnabled(other.id, other.id === adapter.id);
    const dbPath = indexDbPath(path.join(bulkHome, `index-${adapter.id}`));
    let bulkIndex = await openIndex(dbPath);
    try {
      const firstBulk = await scan(bulkIndex, bulkRegistry);
      assert.equal(firstBulk.errors.length, 0);
      assert.equal(firstBulk.total, count);
      assert.equal(firstBulk.perHarness[adapter.id], count);
      bulkIndex.close();
      bulkIndex = await openIndex(dbPath);
      const repeatedBulk = await scan(bulkIndex, bulkRegistry);
      assert.equal(repeatedBulk.total, count);
      assert.equal(repeatedBulk.skipped, harnesses.includes(adapter.id) ? count : 0);
      const cappedBulk = await scan(bulkIndex, bulkRegistry, { maxPerHarness: 2000 });
      assert.equal(cappedBulk.total, count);
      assert.equal(cappedBulk.removed, 0);
      assert.equal(bulkIndex.db.get("select count(*) as n from search").n, count);
      check(`${adapter.id}: >2,000 sessions survive uncapped listing, reopen, incremental and capped scans`);

      if (harnesses.includes(adapter.id)) fs.unlinkSync(bulkFiles[harnesses.indexOf(adapter.id)]);
      else {
        const [, file, table] = bulkDbs.find(([id]) => id === adapter.id);
        const db = await openIndexDb(file);
        try { db.run(`delete from ${table} where id = ?`, [`bulk_${count - 1}`]); }
        finally { db.close(); }
      }
      const partialDelete = await scan(bulkIndex, bulkRegistry, { maxPerHarness: count + 10 });
      assert.equal(partialDelete.removed, 0);
      assert.equal(partialDelete.total, count);
      const fullDelete = await scan(bulkIndex, bulkRegistry);
      assert.equal(fullDelete.removed, 1);
      assert.equal(fullDelete.total, count - 1);
      check(`${adapter.id}: non-binding caps cannot prune; complete scans prune real deletions`);
    } finally { bulkIndex.close(); }
  }
  console.log("All incremental-scan checks passed (synthetic home only).");
} finally {
  fs.readFileSync = readFileSync;
  fs.openSync = openSync;
  index?.close();
  fs.rmSync(home, { recursive: true, force: true });
}
