import assert from "node:assert/strict";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { sessionRecency } = await jiti.import("../vscode-extension/src/sessionTime.ts");
const now = Date.parse("2026-05-10T12:00:00Z");
const minute = 60_000, day = 24 * 60 * minute;
const ago = ms => new Date(now - ms).toISOString();
for (const [age, expected] of [
  [0, "Just now"], [59_999, "Just now"], [minute, "1 minute ago"], [59 * minute, "59 minutes ago"],
  [60 * minute, "1 hour ago"], [23 * 60 * minute, "23 hours ago"], [day, "1 day ago"],
  [2 * day, "2 days ago"], [3 * day, "3 days ago"],
]) assert.equal(sessionRecency(ago(age), now), expected);
for (const age of [3 * day + 1, 4 * day, 400 * day]) {
  const date = new Date(now - age);
  const expected = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  assert.equal(sessionRecency(date.toISOString(), now), expected);
  assert.match(expected, /^\d{4}-\d{2}-\d{2}$/);
}
assert.equal(sessionRecency(null, now), "Unknown date");
assert.equal(sessionRecency("invalid", now), "Unknown date");
assert.equal(sessionRecency(new Date(now + day).toISOString(), now), "Just now");
console.log("PASS English relative time through exactly 3 days, local YYYY-MM-DD thereafter, invalid/future date handling");
