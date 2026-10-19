import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { pdfFileName, saveSessionPdf } = await jiti.import("../src/web/pdf-file.ts");
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "session-hub-pdf-save-"));
try {
  const detail = { harness: "pi", title: '../../Escape\\attempt: password=supersecret <bad> 中文'.repeat(5) };
  const fileName = pdfFileName(detail);
  assert.equal(path.basename(fileName), fileName);
  assert.ok(!/[<>:"/\\|?*\u0000-\u001f]/.test(fileName));
  assert.ok(!fileName.includes("supersecret"));
  const bytes = Buffer.from("%PDF-1.4\nSynthetic PDF file persistence fixture\n%%EOF");
  const first = await saveSessionPdf(directory, detail, bytes);
  const second = await saveSessionPdf(directory, detail, bytes);
  assert.equal(path.dirname(first), directory);
  assert.notEqual(first, second);
  assert.deepEqual(await fs.readFile(first), bytes);
  if (process.platform !== "win32") assert.equal((await fs.stat(first)).mode & 0o777, 0o600);
  await assert.rejects(saveSessionPdf(directory, detail, Buffer.from("not a PDF")), /invalid document/);
  assert.equal((await fs.readdir(directory)).length, 2);
  console.log("PASS PDF exports use safe redacted unique basenames, private permissions, and reject invalid documents");
} finally { await fs.rm(directory, { recursive: true, force: true }); }
