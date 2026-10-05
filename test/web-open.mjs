import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { openLocalBrowser } = await jiti.import("../src/web/browser.ts");
const { buildWebHome } = await jiti.import("./fixtures/web-home.mjs");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "session-hub-open-"));
const browser = path.join(temp, "mock browser.mjs");
const record = path.join(temp, "opened-url.txt");
const url = "http://127.0.0.1:43123/#token=abc123";
let checks = 0, child;
const check = (name, value) => { assert.ok(value, name); console.log(`PASS ${name}`); checks++; };
function mock(source) {
  fs.writeFileSync(browser, `#!${process.execPath}\n${source}\n`, { mode: 0o755 });
  fs.chmodSync(browser, 0o755);
}
try {
  check("missing BROWSER degrades to instructions", (await openLocalBrowser(url, { browser: "" })).includes("没有 BROWSER"));
  check("missing executable is nonfatal", (await openLocalBrowser(url, { browser: path.join(temp, "missing") })).includes("不可执行"));
  mock(`import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)));`);
  check("BROWSER helper request succeeds", (await openLocalBrowser(url, { browser })).includes("已通过 BROWSER 请求"));
  check("URL and fragment passed as one literal argument", JSON.stringify(JSON.parse(fs.readFileSync(record, "utf8"))) === JSON.stringify([url]));
  mock('console.error("failure"); process.exit(2);');
  check("browser failure is nonfatal", (await openLocalBrowser(url, { browser })).includes("服务仍在运行"));
  mock('console.error("Ignoring option --open-external");');
  check("ignored option is not reported as success", (await openLocalBrowser(url, { browser })).includes("失败"));
  mock('setTimeout(() => {}, 10000);');
  check("browser request has a timeout", (await openLocalBrowser(url, { browser, timeoutMs: 100 })).includes("超时"));
  mock(`import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)));`);
  fs.unlinkSync(record);
  const home = path.join(temp, "home");
  await buildWebHome(home);
  child = spawn(process.execPath, ["bin/web.mjs", "--port", "0"], {
    cwd: path.resolve(import.meta.dirname, ".."), env: { ...process.env, HOME: home, BROWSER: browser }, stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  let output = "", errors = "";
  child.stderr.on("data", data => { errors += data; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CLI timeout: ${errors}`)), 15000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`CLI exited ${code}: ${errors}`)); });
    child.stdout.on("data", data => {
      output += data;
      if (output.includes("已通过 BROWSER 请求")) { clearTimeout(timer); resolve(); }
    });
  });
  const [opened] = JSON.parse(fs.readFileSync(record, "utf8"));
  check("CLI automatically uses BROWSER with full token URL", opened === output.match(/http:\/\/127\.0\.0\.1:\d+\/#token=[a-f0-9]+/)[0]);
  check("browser opening leaves viewer available", (await fetch(opened)).status === 200);
  child.kill("SIGTERM");
  const [code] = await exited;
  child = null;
  check("CLI shuts down after browser request", code === 0);
  console.log(`\n${checks} external-browser opener checks passed.`);
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
  }
  fs.rmSync(temp, { recursive: true, force: true });
}
