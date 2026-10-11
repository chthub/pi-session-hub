import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { SessionStars, SESSION_STARS_KEY } = await jiti.import("../vscode-extension/src/sessionStars.ts");
const data = new Map();
let writes = 0, failWrite = false, failRead = false, inFlight = 0, maxInFlight = 0;
const state = {
  get(key) {
    if (failRead) throw new Error("storage unavailable");
    return data.has(key) ? structuredClone(data.get(key)) : undefined;
  },
  async update(key, value) {
    assert.equal(key, SESSION_STARS_KEY);
    writes++;
    maxInFlight = Math.max(maxInFlight, ++inFlight);
    try {
      await new Promise(resolve => setTimeout(resolve, 2));
      if (failWrite) { failWrite = false; throw new Error("disk full"); }
      data.set(key, structuredClone(value));
    } finally { inFlight--; }
  },
};
const stars = new SessionStars(state);
stars.load();
assert.equal(writes, 0);
assert.equal(stars.has("pi:same"), false);
await Promise.all([stars.set("pi:same", true), stars.set("codex:same", true), stars.set("pi:other", true)]);
assert.equal(maxInFlight, 1);
assert.deepEqual(data.get(SESSION_STARS_KEY), ["codex:same", "pi:other", "pi:same"]);
await stars.set("pi:same", false);
assert.equal(stars.has("codex:same"), true);
assert.equal(stars.has("pi:same"), false);
const restored = new SessionStars(state);
restored.load();
assert.equal(restored.has("codex:same"), true);
assert.equal(restored.has("pi:same"), false);
const beforeNoop = writes;
await stars.set("codex:same", true);
await stars.set("pi:same", false);
assert.equal(writes, beforeNoop);
// A UID temporarily absent from the tree must not be pruned on another edit.
data.set(SESSION_STARS_KEY, [...data.get(SESSION_STARS_KEY), "jcode:temporarily-missing"]);
await stars.set("pi:new", true);
assert.equal(stars.has("jcode:temporarily-missing"), true);
console.log("PASS star preferences use full namespaced UIDs, survive new instances, preserve absent sessions and serialize writes");

failWrite = true;
await assert.rejects(stars.set("pi:new", false), /无法保存/);
assert.equal(stars.has("pi:new"), true);
assert.ok(data.get(SESSION_STARS_KEY).includes("pi:new"));
failWrite = true;
const failed = stars.set("pi:failed", true);
const recovered = stars.set("pi:recovered", true);
await assert.rejects(failed, /无法保存/);
await recovered;
assert.equal(stars.has("pi:failed"), false);
assert.equal(stars.has("pi:recovered"), true);
// Even a synchronous storage exception must not poison the queue.
const syncFailure = new SessionStars({ get: state.get, update() { throw new Error("sync failure"); } });
syncFailure.load();
await assert.rejects(syncFailure.set("pi:sync", true), /无法保存/);
assert.equal(syncFailure.has("pi:sync"), false);
failRead = true;
await assert.rejects(stars.set("pi:read-failed", true), /storage unavailable/);
assert.equal(stars.has("pi:read-failed"), false);
failRead = false;
await stars.set("pi:after-read-failure", true);
console.log("PASS failed writes/reads keep visible state unchanged and later updates recover");

// Real Memento updates its in-memory cache before the durable write resolves.
// A rejected write can therefore leave get() reporting an UNSAVED value.
let cached = [], durable = [], rejectCachedWrite = false;
const cachedState = {
  get() { return structuredClone(cached); },
  async update(_key, value) {
    cached = structuredClone(value);
    if (rejectCachedWrite) { rejectCachedWrite = false; throw new Error("write rejected after cache update"); }
    durable = structuredClone(value);
  },
};
const cachedStars = new SessionStars(cachedState);
cachedStars.load();
rejectCachedWrite = true;
await assert.rejects(cachedStars.set("pi:unsaved", true));
assert.equal(cachedStars.has("pi:unsaved"), false);
assert.deepEqual(cached, ["pi:unsaved"]);
assert.deepEqual(durable, []);
await cachedStars.set("codex:saved", true);
assert.deepEqual(durable, ["codex:saved"]);
assert.equal(cachedStars.has("pi:unsaved"), false);
rejectCachedWrite = true;
await assert.rejects(cachedStars.set("codex:saved", false));
assert.equal(cachedStars.has("codex:saved"), true);
await cachedStars.set("codex:saved", false);
assert.deepEqual(durable, []);
rejectCachedWrite = true;
await assert.rejects(cachedStars.set("pi:unsaved", true));
// An opposite click is a no-op in visible state, but must repair storage cache.
await cachedStars.set("pi:unsaved", false);
assert.deepEqual(cached, []);
assert.deepEqual(durable, []);
rejectCachedWrite = true;
await assert.rejects(cachedStars.set("pi:retry", true));
await cachedStars.set("pi:retry", true);
assert.deepEqual(durable, ["pi:retry"]);
assert.equal(cachedStars.has("pi:retry"), true);
console.log("PASS rejected Memento writes cannot leak cached phantom stars or make retries skip persistence");

const beforeInvalid = writes;
for (const uid of [undefined, {}, "", "native-only", "pi:", "pi:x\ny", "pi:\0", "pi:" + "x".repeat(2000)]) {
  await assert.rejects(stars.set(uid, true), /无效/);
}
assert.equal(writes, beforeInvalid);
for (const value of [null, {}, "pi:old", ["pi:valid", 42], ["native-only"]]) {
  data.set(SESSION_STARS_KEY, value);
  const corrupt = new SessionStars(state);
  assert.throws(() => corrupt.load(), /格式无效/);
  await assert.rejects(corrupt.set("pi:new", true), /格式无效/);
  assert.deepEqual(data.get(SESSION_STARS_KEY), value);
}
assert.equal(writes, beforeInvalid);
console.log("PASS invalid UIDs and malformed saved preferences cannot overwrite stored data");
