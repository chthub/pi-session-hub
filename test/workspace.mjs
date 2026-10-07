import assert from "node:assert/strict";
import { createJiti } from "jiti";
const { isSessionInWorkspace, sessionProjectScope } = await createJiti(import.meta.url).import("../vscode-extension/src/projectScope.ts");
const session = (cwd, repo = null) => ({ cwd, repo });
for (const [name, source, roots, expected] of [
  ["same project", session("/work/app"), ["/work/app"], true],
  ["nested cwd", session("/work/app/src"), ["/work/app"], true],
  ["different project", session("/work/other"), ["/work/app"], false],
  ["no substring containment", session("/work/app-extra"), ["/work/app"], false],
  ["multi-root", session("/work/other/src"), ["/work/app", "/work/other"], true],
  ["trailing separators", session("/work/app/"), ["/work/app///"], true],
  ["dot segments", session("/work/app/../app/src"), ["/work/app/./"], true],
  ["repo fallback", session(null, "/work/app"), ["/work/app"], true],
  ["recorded repo matches even if cwd moved", session("/tmp/run", "/work/app"), ["/work/app"], true],
  ["posix root", session("/work/app"), ["/"], true],
  ["posix case sensitivity", session("/work/App"), ["/work/app"], false],
  ["Windows mixed separators and case", session("C:\\Work\\App\\src\\"), ["c:/work/app/"], true],
  ["Windows prefix boundary", session("C:\\work\\app-other"), ["C:\\work\\app"], false],
  ["Windows drive root", session("C:\\work\\app"), ["c:/"], true],
  ["different drive", session("D:\\work\\app"), ["C:\\work\\app"], false],
  ["UNC", session("\\\\server\\share\\app\\src"), ["\\\\SERVER\\share\\app"], true],
  ["relative source is not reliable", session("work/app"), ["/work/app"], false],
  ["unknown cwd", session(null), ["/work/app"], false],
]) {
  assert.equal(isSessionInWorkspace(source, roots), expected, name);
  console.log(`PASS ${name}`);
}
assert.equal(sessionProjectScope(session(null), ["/work/app"]), "unscoped");
assert.equal(sessionProjectScope(session("relative"), ["/work/app"]), "unscoped");
assert.equal(sessionProjectScope(session("/work/app"), []), "unscoped");
assert.equal(sessionProjectScope(session("/work/app"), ["/work/other"]), "other");
console.log("PASS unknown projects remain accessible as unscoped sessions");
