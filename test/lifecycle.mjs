// Deterministic lifecycle/failure tests; never use the developer's home.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { SessionHubService } = await jiti.import("../src/core/service.ts");
const { openIndex, querySessions, rowToSession, upsertSessions, SCHEMA_VERSION } = await jiti.import("../src/index/db.ts");
const { indexDbPath } = await jiti.import("../src/security.ts");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "hub-lifecycle-"));
// Prime node:sqlite through the project's warning-suppressing loader.
const prime = await openIndex(path.join(temp, "prime.sqlite"));
prime.close();
const { DatabaseSync } = await import("node:sqlite");
const originalClose = DatabaseSync.prototype.close;
const originalPrepare = DatabaseSync.prototype.prepare;
const closed = new Set();
const statements = [];
let failSchema = false;
DatabaseSync.prototype.close = function () {
  assert.ok(!closed.has(this), "each allocated database handle closes exactly once");
  closed.add(this);
  return originalClose.call(this);
};
DatabaseSync.prototype.prepare = function (sql) {
  statements.push(sql);
  if (failSchema && sql.startsWith("CREATE TABLE IF NOT EXISTS sessions")) {
    failSchema = false;
    throw new Error("synthetic schema failure");
  }
  return originalPrepare.call(this, sql);
};
const services = [];
function service(name) {
  const value = new SessionHubService({ home: path.join(temp, name) });
  services.push(value);
  return value;
}

try {
  const unused = service("unused");
  unused.close(); unused.close();
  await assert.rejects(unused.init(), /closed/);
  assert.equal(fs.existsSync(path.join(temp, "unused")), false);
  assert.equal(closed.size, 0);
  console.log("PASS closing an unused service neither initializes nor creates directories");

  const closing = service("closing");
  const pending = [closing.init(), closing.init()];
  // openIndex always crosses an asynchronous DB-open boundary, even after the
  // sqlite module is cached. Close before it can publish the handle.
  closing.close(); closing.close();
  const settled = await Promise.allSettled(pending);
  assert.ok(settled.every(result => result.status === "rejected" && /closed/.test(result.reason.message)));
  assert.equal(closed.size, 1, "concurrent init shares and releases the late handle");
  await assert.rejects(closing.listSessions(), /closed/);
  console.log("PASS shutdown during shared asynchronous init releases the late handle and rejects all waiters");

  const retry = service("retry");
  failSchema = true;
  const failed = await Promise.allSettled([retry.init(), retry.init()]);
  assert.ok(failed.every(result => result.status === "rejected" && /synthetic schema failure/.test(result.reason.message)));
  assert.equal(closed.size, 2, "failed schema setup closes its database handle");
  await Promise.all([retry.init(), retry.init()]);
  assert.equal((await retry.listSessions()).length, 0);
  retry.close(); retry.close();
  assert.equal(closed.size, 3);
  console.log("PASS failed schema initialization rolls back/closes, and concurrent retry opens one usable handle");

  const file = indexDbPath(path.join(temp, "retry"));
  statements.length = 0;
  const a = await openIndex(file);
  a.close();
  assert.ok(!statements.some(sql => /DELETE FROM search|INSERT OR REPLACE INTO meta/.test(sql)),
    "opening a current index must not sweep FTS or rewrite schema_version");
  console.log("PASS opening a current index skips FTS cleanup and redundant schema-version writes");

  const dirty = await openIndex(file);
  try {
    dirty.db.run("INSERT INTO sessions(rowid,uid,harness,native_id,path,fidelity) VALUES (42,'pi:live','pi','live','/synthetic/live','{}')");
    dirty.db.run("INSERT INTO search(rowid,uid,body) VALUES (42,'missing','orphanneedle')");
    dirty.db.run("INSERT INTO search_scopes(rowid,uid,user_text) VALUES (42,'missing','orphanneedle')");
    assert.equal(querySessions(dirty, { text: "orphanneedle" }).length, 0);
    assert.equal(querySessions(dirty, { text: "orphanneedle", searchScope: "user" }).length, 0);
    const live = rowToSession(dirty.db.get("SELECT * FROM sessions WHERE uid = 'pi:live'"));
    // REPLACE will allocate rowid 43; an orphan can already occupy that rowid.
    dirty.db.run("INSERT INTO search(rowid,uid,body) VALUES (43,'missing-next','orphanneedle')");
    dirty.db.run("INSERT INTO search_scopes(rowid,uid,user_text) VALUES (43,'missing-next','orphanneedle')");
    upsertSessions(dirty, [{ ...live, searchText: "liveneedle", searchScopes: { user: "liveneedle" } }]);
    assert.equal(querySessions(dirty, { text: "liveneedle" })[0]?.uid, live.uid);
    assert.equal(querySessions(dirty, { text: "liveneedle", searchScope: "user" })[0]?.uid, live.uid);
    assert.equal(querySessions(dirty, { text: "orphanneedle" }).length, 0);
  } finally { dirty.close(); }
  console.log("PASS deferred FTS orphans cannot match unrelated reused rowids or block session upserts");

  // Recreate a legacy schema and let independent JS threads initialize it at
  // once. SQLite, not a service-local promise, must serialize the migrations.
  const legacy = await openIndex(file);
  legacy.db.run("DROP TABLE sources");
  legacy.db.run("CREATE TABLE sources (harness TEXT, path TEXT, mtime_ms REAL, size INTEGER, PRIMARY KEY(harness,path))");
  legacy.db.run("UPDATE meta SET value = '1' WHERE key = 'schema_version'");
  legacy.close();
  const workerSource = `
    const { parentPort, workerData } = require('node:worker_threads');
    const { createJiti } = require(workerData.jiti);
    (async () => {
      const { openIndex } = await createJiti(workerData.entry).import(workerData.db);
      parentPort.postMessage('ready');
      parentPort.once('message', async () => {
        try { const index = await openIndex(workerData.file); if (!index) throw new Error('no index'); index.close(); }
        catch (error) { throw error; }
      });
    })();
  `;
  const workers = Array.from({ length: 3 }, () => new Worker(workerSource, { eval: true, workerData: {
    jiti: import.meta.resolve("jiti").replace("file://", ""),
    entry: path.join(temp, "worker.mjs"),
    db: new URL("../src/index/db.ts", import.meta.url).pathname,
    file,
  } }));
  try {
    await Promise.all(workers.map(worker => new Promise((resolve, reject) => {
      worker.once("message", resolve); worker.once("error", reject);
    })));
    const exits = workers.map(worker => new Promise((resolve, reject) => {
      worker.once("error", reject);
      worker.once("exit", code => code === 0 ? resolve() : reject(new Error(`worker exited ${code}`)));
    }));
    workers.forEach(worker => worker.postMessage("open"));
    await Promise.all(exits);
  } finally { await Promise.all(workers.map(worker => worker.terminate())); }
  const migrated = await openIndex(file);
  try {
    assert.ok(["uid", "parser_version"].every(name => migrated.db.all("PRAGMA table_info(sources)").some(col => col.name === name)));
    assert.equal(migrated.db.get("SELECT value FROM meta WHERE key = 'schema_version'").value, SCHEMA_VERSION);
  } finally { migrated.close(); }
  console.log("PASS independent concurrent openers migrate a shared legacy index atomically");
} finally {
  services.forEach(value => value.close());
  DatabaseSync.prototype.close = originalClose;
  DatabaseSync.prototype.prepare = originalPrepare;
  fs.rmSync(temp, { recursive: true, force: true });
}
