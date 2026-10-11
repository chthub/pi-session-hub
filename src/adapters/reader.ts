import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";
import type { PreviewMessage } from "../types.ts";
import type { ReadOnlyDb } from "../sqlite.ts";
import { isDeniedPath } from "../security.ts";

export const SESSION_READ_LIMIT = 64 * 1024 * 1024;
export interface SessionText {
  content: string;
  bytesRead: number;
  fileSize: number;
  truncated: boolean;
  notes: string[];
}

/** Bounded text helper for small auxiliary files, NOT transcript hydration.
 * Transcript adapters use the streaming readers below. */
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

export interface ReadProgress {
  bytesRead: number;
  fileSize: number;
  truncated: boolean;
  notes: string[];
}

const CHUNK_BYTES = 256 * 1024;
/** Per-record guard, not a file-size limit. */
export const SESSION_RECORD_LIMIT = 64 * 1024 * 1024;

function* sourceChunks(file: string, progress: ReadProgress): Generator<Buffer> {
  if (isDeniedPath(file) || isDeniedPath(fs.realpathSync(file))) throw new Error("Denied session path");
  const fd = fs.openSync(file, "r");
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error("Not a regular session file");
    progress.fileSize = stat.size;
    const buffer = Buffer.alloc(CHUNK_BYTES);
    // A finite snapshot: an actively appended log must not keep this loop alive.
    while (progress.bytesRead < stat.size) {
      const n = fs.readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - progress.bytesRead), progress.bytesRead);
      if (!n) throw new Error("Session shortened during read");
      progress.bytesRead += n;
      yield buffer.subarray(0, n);
    }
    const after = fs.fstatSync(fd);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) {
      progress.truncated = true;
      progress.notes.push("source changed during read; this is a snapshot, refresh to recover newer changes");
    }
  } finally { fs.closeSync(fd); }
}

/** Complete JSONL scan with bounded record memory; malformed/oversized lines
 * never prevent later records from being recovered. Iterate once to completion. */
export function readSessionJsonl(file: string, maxRecordBytes = SESSION_RECORD_LIMIT) {
  if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1 || maxRecordBytes > SESSION_RECORD_LIMIT) throw new Error("Invalid record limit");
  const progress: ReadProgress = { bytesRead: 0, fileSize: 0, truncated: false, notes: [] };
  function* records(): Generator<Record<string, unknown>> {
    let pieces: Buffer[] = [], size = 0, oversized = 0, malformed = 0, skipping = false;
    function parse(): Record<string, unknown> | undefined {
      if (skipping) { oversized++; return; }
      const text = Buffer.concat(pieces, size).toString("utf8").trim();
      if (!text) return;
      try {
        const value: unknown = JSON.parse(text);
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Not an object");
        return value as Record<string, unknown>;
      } catch { malformed++; }
    }
    try {
      for (const chunk of sourceChunks(file, progress)) {
        let start = 0;
        while (start < chunk.length) {
          const newline = chunk.indexOf(10, start);
          const end = newline < 0 ? chunk.length : newline;
          if (!skipping) {
            size += end - start;
            if (size > maxRecordBytes) { skipping = true; pieces = []; }
            else pieces.push(Buffer.from(chunk.subarray(start, end)));
          }
          if (newline < 0) break;
          const value = parse();
          if (value) yield value;
          pieces = []; size = 0; skipping = false;
          start = end + 1;
        }
      }
      if (size || skipping) { const value = parse(); if (value) yield value; }
    } catch {
      progress.truncated = true;
      progress.notes.push("incomplete source read: file unavailable or changed while reading; later records may be missing");
    } finally {
      if (oversized || malformed) {
        progress.truncated = true;
        progress.notes.push(`source records omitted: ${oversized} exceeded ${maxRecordBytes} bytes; ${malformed} malformed/non-object JSONL records (including possible torn final writes); later records were still scanned`);
      }
    }
  }
  return Object.assign(progress, { records: records() });
}

/** Streaming cursor for a monolithic JSON object. Only one top-level value or
 * messages-array element is materialized at a time, never the whole document. */
class JsonCursor {
  private chunk = "";
  private offset = 0;
  private readonly chunks: Generator<string>;
  constructor(file: string, progress: ReadProgress) {
    this.chunks = (function* () {
      const decoder = new StringDecoder("utf8");
      for (const chunk of sourceChunks(file, progress)) yield decoder.write(chunk);
      yield decoder.end();
    })();
  }
  peek(): string {
    while (this.offset >= this.chunk.length) {
      const next = this.chunks.next();
      if (next.done) return "";
      this.chunk = next.value; this.offset = 0;
    }
    return this.chunk[this.offset]!;
  }
  take(): string { const c = this.peek(); this.offset++; return c; }
  space(): void { while (/^[\t\n\r ]$/.test(this.peek())) this.take(); }
  expect(c: string): void { this.space(); if (this.take() !== c) throw new Error("Malformed JSON document"); }
  value(): unknown {
    this.space();
    const pieces: string[] = [];
    let size = 0, depth = 0, quoted = false, escaped = false;
    while (this.peek()) {
      const start = this.offset;
      while (this.offset < this.chunk.length) {
        const c = this.chunk[this.offset]!;
        if (!quoted && depth === 0 && /[\s,\]}:]/.test(c)) break;
        this.offset++;
        if (quoted) {
          if (escaped) escaped = false;
          else if (c === "\\") escaped = true;
          else if (c === '"') quoted = false;
        } else if (c === '"') quoted = true;
        else if (c === "{" || c === "[") depth++;
        else if (c === "}" || c === "]") depth--;
      }
      const piece = this.chunk.slice(start, this.offset);
      size += Buffer.byteLength(piece);
      if (size > SESSION_RECORD_LIMIT) throw new Error("JSON value exceeds record memory limit");
      pieces.push(piece);
      if (this.offset < this.chunk.length) break;
    }
    return JSON.parse(pieces.join(""));
  }
  close(): void { this.chunks.return(undefined); }
}

/** Validate the complete enclosing document, including trailing bytes. A torn
 * or oversized monolithic value fails closed, never masquerades as valid JSON.
 * The caller must discard callback output if this returns null. */
export function readSessionJson(file: string, onMessage: (value: unknown) => void): (ReadProgress & { doc: Record<string, unknown> }) | null {
  const progress: ReadProgress = { bytesRead: 0, fileSize: 0, truncated: false, notes: [] };
  const cursor = new JsonCursor(file, progress);
  const doc: Record<string, unknown> = Object.create(null);
  const keys = new Set<string>();
  try {
    cursor.expect("{"); cursor.space();
    if (cursor.peek() !== "}") while (true) {
      const key = cursor.value();
      if (typeof key !== "string" || keys.has(key)) throw new Error("Invalid or duplicate document key");
      keys.add(key); cursor.expect(":"); cursor.space();
      if (key === "messages" && cursor.peek() === "[") {
        cursor.take(); cursor.space();
        if (cursor.peek() !== "]") while (true) {
          onMessage(cursor.value()); cursor.space();
          if (cursor.peek() === "]") break;
          cursor.expect(",");
        }
        cursor.expect("]");
      } else {
        const value = cursor.value();
        // Only scalar session metadata is retained; unknown top-level payloads
        // are validated then released, rather than accumulating a second blob.
        if (["id", "working_dir", "title", "model", "provider_key", "created_at", "updated_at"].includes(key)) doc[key] = value;
      }
      cursor.space();
      if (cursor.peek() === "}") break;
      cursor.expect(",");
    }
    cursor.expect("}"); cursor.space();
    if (cursor.peek()) throw new Error("Trailing JSON content");
    return { ...progress, doc };
  } catch { return null; }
  finally { cursor.close(); }
}

/** Page complete SQLite detail queries instead of keeping only the first 4000
 * rows or materializing the entire result. Bound the pass to its initial count;
 * concurrent source edits are not a transactional snapshot. */
export function* readSessionRows<T>(db: ReadOnlyDb, sql: string, params: unknown[]): Generator<T> {
  const count = db.get<{ n: number }>(`select count(*) as n from (${sql})`, params)?.n ?? 0;
  for (let offset = 0; offset < count; offset += 256) {
    const rows = db.all<T>(`${sql} limit ? offset ?`, [...params, Math.min(256, count - offset), offset]);
    yield* rows;
    if (!rows.length) break;
  }
}

/** Aggregate calls without retaining one string per source event. */
export function toolCounter(notes: string[]) {
  const counts = new Map<string, number>();
  let total = 0, warned = false;
  return {
    counts,
    get length() { return total; },
    push(name: string) {
      total++;
      let key = name.slice(0, 200);
      if (!counts.has(key) && counts.size >= 4096) key = "[other tools]";
      if (key !== name && !warned) {
        warned = true;
        notes.push("tool summary bounded to 4096 distinct names / 200 characters per name; excess names grouped, total call count retained");
      }
      counts.set(key, (counts.get(key) ?? 0) + 1);
    },
  };
}

export const TRANSCRIPT_MESSAGE_LIMIT = 8000;
export const TRANSCRIPT_CHAR_LIMIT = 8 * 1024 * 1024;
/** Array-compatible sink for existing format helpers. Keep the opening three
 * blocks plus the latest tail, with explicit counts when bounded retention is
 * needed. Helpers must pass Infinity for their old first-N limits. */
export function transcriptMessages(notes: string[]): PreviewMessage[] {
  const messages: PreviewMessage[] = [];
  let chars = 0, omitted = 0, noteIndex = -1;
  Object.defineProperty(messages, "push", { value: (...items: PreviewMessage[]) => {
    for (const item of items) {
      Array.prototype.push.call(messages, item);
      chars += item.text.length;
      while (messages.length > TRANSCRIPT_MESSAGE_LIMIT || (chars > TRANSCRIPT_CHAR_LIMIT && messages.length > 4)) {
        const removed = messages.splice(3, 1)[0]!;
        chars -= removed.text.length; omitted++;
      }
    }
    if (omitted) {
      if (noteIndex < 0) { noteIndex = notes.length; notes.push(""); }
      notes[noteIndex] = `transcript retention: ${omitted} middle blocks omitted; opening 3 and latest blocks retained (limits: ${TRANSCRIPT_MESSAGE_LIMIT} blocks / ${TRANSCRIPT_CHAR_LIMIT} text characters)`;
    }
    return messages.length;
  } });
  return messages;
}

export const TRANSCRIPT_FORMAT_NOTE = "transcript formatting: prose/tool blocks may be clipped to 4000–8000 characters each; reasoning and non-text payloads are not rendered; search, command evidence and context are separately budgeted excerpts, not a lossless source copy";
