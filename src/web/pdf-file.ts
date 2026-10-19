import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { SessionDetail } from "../types.ts";
import { redact } from "../security.ts";

/** A safe basename only: source paths and native IDs never choose the target. */
export function pdfFileName(detail: Pick<SessionDetail, "title" | "harness">): string {
  const title = Array.from(redact(detail.title || "Conversation")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").replace(/\s+/g, " ").trim()).slice(0, 48).join("")
    .replace(/[. ]+$/g, "") || "Conversation";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `session-${detail.harness}-${title}-${stamp}-${randomBytes(3).toString("hex")}.pdf`;
}

/** Only a host-selected directory may be passed here. Never overwrite a file,
 * follow an existing target symlink, or leave a partial PDF after write failure. */
export async function saveSessionPdf(directory: string, detail: Pick<SessionDetail, "title" | "harness">, pdf: Buffer): Promise<string> {
  if (pdf.length < 5 || pdf.subarray(0, 5).toString() !== "%PDF-") throw new Error("The PDF renderer returned an invalid document.");
  const file = path.join(path.resolve(directory), pdfFileName(detail));
  const handle = await fs.open(file, "wx", 0o600);
  try {
    await handle.writeFile(pdf);
    await handle.close();
    return file;
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.unlink(file).catch(() => {});
    throw error;
  }
}
