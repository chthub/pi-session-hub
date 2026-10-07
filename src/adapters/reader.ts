import fs from "node:fs";
import { isDeniedPath } from "../security.ts";

export const SESSION_READ_LIMIT = 64 * 1024 * 1024;
export interface SessionText {
  content: string;
  bytesRead: number;
  fileSize: number;
  truncated: boolean;
  notes: string[];
}

/** Independent bounded reader. A partial head is explicitly NOT a complete
 * append-only transcript; latest turns can be absent. Future chunk hydration
 * belongs here, rather than in any particular host. */
export function readSessionText(file: string, maxBytes = SESSION_READ_LIMIT): SessionText | null {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > SESSION_READ_LIMIT) throw new Error("Invalid session byte limit");
  if (isDeniedPath(file)) return null;
  let fd: number | undefined;
  try {
    if (isDeniedPath(fs.realpathSync(file))) return null;
    fd = fs.openSync(file, "r");
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return null;
    const buffer = Buffer.alloc(Math.min(stat.size, maxBytes));
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const n = fs.readSync(fd, buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (!n) break;
      bytesRead += n;
    }
    const truncated = stat.size > bytesRead;
    return { content: buffer.subarray(0, bytesRead).toString("utf8"), bytesRead, fileSize: stat.size, truncated,
      notes: truncated ? [`truncated: only the first ${bytesRead} of ${stat.size} source bytes were read; latest messages may be missing`] : [] };
  } catch { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
