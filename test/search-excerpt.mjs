import assert from "node:assert/strict";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { addSearchText, searchTextFrom, SEARCH_TEXT_BUDGET } = await jiti.import("../src/adapters/util.ts");

const short = [];
addSearchText(short, "user", "opening question");
addSearchText(short, "assistant", "final answer");
assert.equal(searchTextFrom(short), "opening question final answer");
assert.equal(searchTextFrom([]), null);

const long = [];
for (let i = 0; i < 3000; i++) {
  addSearchText(long, i % 2 ? "assistant" : "user", `turn-${i} ` + "prose ".repeat(800));
  assert.ok(long.length <= 400);
}
assert.equal(long.length, 400);
assert.ok(long[0].startsWith("turn-0 "));
assert.ok(long[199].startsWith("turn-199 "));
assert.ok(long[200].startsWith("turn-2800 "));
addSearchText(long, "assistant", "unique closing resolution beyond record 400");
const beforeIgnored = [...long];
addSearchText(long, "toolResult", "ignored tool content");
addSearchText(long, "assistant", "   ");
assert.deepEqual(long, beforeIgnored);
assert.ok(long.every(text => text.length <= 4000));
const excerpt = searchTextFrom(long);
assert.ok(excerpt.length <= SEARCH_TEXT_BUDGET);
assert.ok(excerpt.startsWith("turn-0 "));
assert.ok(excerpt.endsWith("unique closing resolution beyond record 400"));
assert.ok(!excerpt.includes("ignored tool content"));
console.log("PASS search excerpts retain the real opening and latest turns within bounded storage");
