import fs from "node:fs";
import { readSessionText, SESSION_READ_LIMIT } from "./reader.ts";
import path from "node:path";
import type { ExternalSession, PreviewMessage } from "../types.ts";
import type { ListOptions } from "./types.ts";
import { clip, cleanText, cleanTranscriptText, redact } from "../security.ts";

export interface StatInfo {
  mtimeMs: number;
  size: number;
}

export function safeStat(p: string): StatInfo | null {
  try {
    const s = fs.statSync(p);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
}

export function safeReaddir(p: string): fs.Dirent[] {
  try {
    return fs.readdirSync(p, { withFileTypes: true });
  } catch {
    return [];
  }
}

export type PathProbe =
  | "missing"
  | "denied"
  | "directory"
  | "file"
  | "other";

/** Distinguish "does not exist" from "exists but I cannot read it". */
export function probePath(p: string): PathProbe {
  let st: fs.Stats;
  try {
    st = fs.statSync(p);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") return "denied";
    return "missing";
  }
  if (st.isDirectory()) {
    try {
      fs.accessSync(p, fs.constants.R_OK);
      return "directory";
    } catch {
      return "denied";
    }
  }
  if (st.isFile()) {
    try {
      fs.accessSync(p, fs.constants.R_OK);
      return "file";
    } catch {
      return "denied";
    }
  }
  return "other";
}

export interface WalkOptions {
  exts?: string[];
  maxDepth?: number;
  maxFiles?: number;
  /** False for formats whose transcript namespace is root-only (JCode). */
  recursive?: boolean;
  onIncomplete?: (reason: string) => void;
}

/** Uncapped traversal. Read gaps are reported, never disguised as deletion. */
export function walkFiles(root: string, opts: WalkOptions = {}): string[] {
  const exts = opts.exts ?? [".jsonl"];
  const maxDepth = sessionLimit(opts.maxDepth);
  const maxFiles = sessionLimit(opts.maxFiles);
  const out: string[] = [];
  const pending = [{ dir: root, depth: 0 }];
  const incomplete = (reason: string): void => {
    if (opts.onIncomplete) opts.onIncomplete(reason);
    else throw new Error(reason);
  };

  while (pending.length) {
    const { dir, depth } = pending.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      // A missing store is a valid empty source; disappearing child directories
      // and permission/I/O failures are not authoritative listings.
      if (dir === root && (err as NodeJS.ErrnoException).code === "ENOENT") continue;
      incomplete("Could not enumerate a session directory");
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && opts.recursive !== false) {
        if (depth >= maxDepth) incomplete("Session traversal depth cap reached");
        else pending.push({ dir: full, depth: depth + 1 });
      } else if (entry.isFile() && exts.some(e => entry.name.endsWith(e))) {
        if (out.length >= maxFiles) {
          incomplete("Session traversal file cap reached");
          return out;
        }
        out.push(full);
      }
    }
  }
  return out;
}

/** Shared validation: omitted means uncapped; zero is an explicit empty scan. */
export function sessionLimit(value?: number): number {
  if (value === undefined) return Infinity;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Session limit must be a non-negative safe integer");
  }
  return value;
}

/** List file-backed metadata, checking the scan cache before reading content. */
export function listFileSessions(
  files: string[],
  parse: (file: string) => ExternalSession | null,
  opts: ListOptions = {},
): ExternalSession[] {
  const out: ExternalSession[] = [];
  const limit = sessionLimit(opts.maxSessions);
  for (const file of files) {
    if (out.length >= limit) {
      opts.onIncomplete?.("Session listing cap reached");
      break;
    }
    let session: ExternalSession | null = null;
    if (opts.reuseUnchanged) {
      const stat = safeStat(file);
      if (!stat) {
        opts.onIncomplete?.("Could not stat a session file");
        continue;
      }
      session = opts.reuseUnchanged(file, stat);
    }
    session ??= parse(file);
    if (session) out.push(session);
    else opts.onIncomplete?.("Could not read or parse a session file");
  }
  return out;
}

/**
 * Read a text file with a byte ceiling. Returns null when unreadable.
 * Session files can be megabytes; the cap protects against pathological ones.
 */
export function readTextCapped(p: string, maxBytes = SESSION_READ_LIMIT): string | null {
  return readSessionText(p, maxBytes)?.content ?? null;
}

/** Parse a JSONL blob, skipping malformed lines (including a torn last line). */
export function parseJsonl(text: string, maxLines = 200000): unknown[] {
  const out: unknown[] = [];
  let start = 0;
  let count = 0;
  while (start < text.length && count < maxLines) {
    let end = text.indexOf("\n", start);
    if (end === -1) end = text.length;
    const line = text.slice(start, end).trim();
    start = end + 1;
    if (!line) continue;
    count++;
    try {
      out.push(JSON.parse(line));
    } catch {
      // Truncated or corrupt line: ignore and keep going.
    }
  }
  return out;
}

/** Walk up from a directory looking for a VCS root. */
export function deriveRepo(cwd: string | null): string | null {
  if (!cwd) return null;
  let dir = path.resolve(cwd);
  for (let i = 0; i < 24; i++) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return cwd;
}

export function repoLabel(repo: string | null): string | null {
  if (!repo) return null;
  const base = path.basename(repo);
  return base || repo;
}

export function isoFromMs(ms: number | null | undefined): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return null;
  try {
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
}

export function isoFromSec(sec: number | null | undefined): string | null {
  if (typeof sec !== "number" || !Number.isFinite(sec) || sec <= 0) return null;
  return isoFromMs(sec * 1000);
}

export function parseIso(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

/** Extract plain text from a harness content field of unknown shape. */
export function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === "string") {
        parts.push(block);
      } else if (block && typeof block === "object") {
        const b = block as Record<string, unknown>;
        if (typeof b.text === "string") parts.push(b.text);
        else if (typeof b.content === "string") parts.push(b.content);
      }
    }
    return parts.join("\n");
  }
  return "";
}

export function pushMessage(
  messages: PreviewMessage[],
  role: string,
  text: string,
  maxPerRole = 1000,
  preserveFormatting = false,
): void {
  const clean = preserveFormatting ? cleanTranscriptText(text) : cleanText(text);
  if (!clean) return;
  if (messages.length >= maxPerRole * 2) return;
  // Per-message cap. Long enough that real user prompts survive intact; the
  // context builder applies the overall budget, not this.
  messages.push({ role, text: clip(clean, 8000) });
}

function parseToolInput(input: unknown): unknown {
  if (typeof input !== "string") return input;
  try { return JSON.parse(input); } catch { return input; }
}

function toolValue(value: unknown): string {
  if (value === undefined) return "未记录";
  if (value === null) return "null";
  if (typeof value === "string") return redact(value);
  return redact(JSON.stringify(value, (key, item) =>
    /^(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|authorization)$/i.test(key)
      ? "[REDACTED]" : typeof item === "string" ? redact(item) : item, 2) ?? "未记录");
}

export function pushToolCall(messages: PreviewMessage[], name: string, input: unknown, callId?: unknown, max = 4000): void {
  if (messages.length >= max) return;
  const args = parseToolInput(input);
  const parts = [`工具：${name}`];
  if (typeof callId === "string" && callId) parts.push(`调用 ID：${callId}`);
  // Show source command/argv fields verbatim, never manufacture shell quoting.
  if (args && typeof args === "object" && !Array.isArray(args)) {
    const record = args as Record<string, unknown>;
    for (const key of ["command", "cmd", "script", "shell_command"]) {
      if (typeof record[key] === "string" || Array.isArray(record[key])) {
        parts.push(`\n命令（${key}）：\n${toolValue(record[key])}`);
        break;
      }
    }
  }
  parts.push(`\n调用参数：\n${toolValue(args)}`);
  messages.push({ role: "toolCall", text: clip(redact(parts.join("\n")), 8000), toolName: clip(redact(name), 200),
    ...(typeof callId === "string" && callId ? { toolCallId: clip(redact(callId), 200) } : {}) });
}

export function pushToolResult(messages: PreviewMessage[], output: unknown, name?: unknown, callId?: unknown, max = 4000): void {
  if (messages.length >= max) return;
  const text = typeof output === "string" ? output : Array.isArray(output) ? contentToText(output) || toolValue(output) : toolValue(output);
  messages.push({ role: "toolResult", text: clip(redact(text || "（空输出）"), 8000),
    ...(typeof name === "string" && name ? { toolName: clip(redact(name), 200) } : {}),
    ...(typeof callId === "string" && callId ? { toolCallId: clip(redact(callId), 200) } : {}) });
}

/** Recover mixed text/call/result blocks in source order; never for indexing. */
export function pushTranscriptBlocks(
  messages: PreviewMessage[], role: string, content: unknown,
  opts: { preserveFormatting?: boolean; textLimit?: number; max?: number } = {},
): void {
  const max = opts.max ?? 4000;
  const prose = (text: string) => {
    const clean = opts.preserveFormatting ? cleanTranscriptText(text) : cleanText(text);
    if (clean && messages.length < max) messages.push({ role, text: clip(clean, opts.textLimit ?? 4000) });
  };
  if (typeof content === "string") { prose(content); return; }
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (messages.length >= max) break;
    if (typeof block === "string") { prose(block); continue; }
    if (!block || typeof block !== "object") continue;
    const source = block as Record<string, unknown>;
    const b = source.data && typeof source.data === "object" ? source.data as Record<string, unknown> : source;
    const type = source.type;
    if (type === "toolCall" || type === "tool_call" || type === "tool_use" || type === "tool") {
      const name = b.name ?? b.tool ?? b.toolName;
      const input = "arguments" in b ? b.arguments : "input" in b ? b.input : "parameters" in b ? b.parameters :
        (["command", "cmd", "script", "shell_command"].some(key => key in b) ? b : undefined);
      pushToolCall(messages, typeof name === "string" ? name : "未记录工具名", input, b.id ?? b.call_id ?? source.id, max);
      if ("output" in b) pushToolResult(messages, b.output, name, b.id ?? b.call_id ?? source.id, max);
    } else if (type === "tool_result" || type === "toolResult") {
      const output = "content" in b ? b.content : "output" in b ? b.output : "result" in b ? b.result : b.text;
      pushToolResult(messages, output, b.name ?? b.toolName,
        b.tool_use_id ?? b.tool_call_id ?? b.call_id ?? b.id, max);
    } else if (type !== "thinking" && type !== "reasoning" && type !== "reasoning_trace" && type !== "open_a_i_reasoning") {
      if (typeof b.text === "string") prose(b.text);
      else if (typeof b.content === "string") prose(b.content);
    }
  }
}

/** First user-facing line, used as a preview and as a fallback title. */
export function firstPreview(messages: PreviewMessage[]): string | null {
  for (const m of messages) {
    if (m.role === "user" && m.text.trim().length > 0) return clip(m.text, 160);
  }
  for (const m of messages) {
    if (m.text.trim().length > 0) return clip(m.text, 160);
  }
  return null;
}

export function titleFromPreview(preview: string | null, fallback: string): string {
  if (!preview) return fallback;
  const t = preview.trim();
  if (t.length <= 90) return t;
  return t.slice(0, 89).trimEnd() + "\u2026";
}

export function uniqSorted(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort();
}

/**
 * Character budget for the searchable conversation excerpt per session.
 *
 * Large enough to cover a whole ordinary session (the longest on this machine
 * had ~25k characters of prose) so "where did we discuss X" works for something
 * mentioned anywhere, not just in the opening line. The cap keeps a pathological
 * session from dominating the index.
 */
export const SEARCH_TEXT_BUDGET = 20_000;

/**
 * Accumulate a bounded slice of conversation prose for the search index.
 * Only user and assistant text is collected: tool output is noise here.
 */
export function addSearchText(acc: string[], role: string, text: string): void {
  if (role !== "user" && role !== "assistant") return;
  const clean = cleanText(text);
  if (!clean) return;
  // Keep the opening 200 records and a rolling tail of 200, not just the
  // first 400. Otherwise searchTextFrom's "tail" misses the actual ending.
  if (acc.length >= 400) acc.splice(200, acc.length - 399);
  acc.push(clip(clean, 4000));
}

/**
 * Build the searchable excerpt from BOTH ends of the conversation.
 *
 * Taking only the opening was a real defect: the final turns are usually the
 * densest (summaries, conclusions, the actual resolution), so a phrase from the
 * end of a long session was unsearchable. Sampling head and tail covers the
 * question "where did we discuss X" for most X.
 */
export function searchTextFrom(acc: string[]): string | null {
  if (acc.length === 0) return null;
  const full = acc.join(" ");
  if (full.length <= SEARCH_TEXT_BUDGET) return full;
  const separator = "\n\u2026\n";
  const half = Math.floor((SEARCH_TEXT_BUDGET - separator.length) / 2);
  const head = full.slice(0, half).trimEnd();
  const tail = full.slice(full.length - half).trimStart();
  return `${head}${separator}${tail}`;
}

/** Count occurrences of tool names. */
export function countTools(names: Iterable<string>): Map<string, number> {
  const map = new Map<string, number>();
  for (const n of names) map.set(n, (map.get(n) ?? 0) + 1);
  return map;
}

/**
 * Tool names that look like shell execution across the harnesses we support.
 * Matching is case-insensitive and by suffix so `container.exec` and `exec` both
 * land here.
 */
const SHELL_TOOLS = new Set([
  "bash",
  "shell",
  "sh",
  "exec",
  "run",
  "command",
  "execute_bash",
  "local_shell",
  "terminal",
]);

/**
 * Pull the command string out of a tool input when the tool is a shell tool.
 * Returns null when the shape is not recognised: the handoff must not invent a
 * command that was never run.
 */
export function extractCommand(toolName: string, input: unknown): string | null {
  const raw = extractCommandRaw(toolName, input);
  if (!raw) return null;
  // Commands frequently contain embedded newlines (heredocs, python -c blocks).
  // Collapse them so the handoff document's list indentation stays intact.
  return raw.replace(/\s*\n\s*/g, " \u23ce ").replace(/\s{2,}/g, " ").slice(0, 300);
}

function extractCommandRaw(toolName: string, input: unknown): string | null {
  const name = toolName.toLowerCase();
  const isShell =
    SHELL_TOOLS.has(name) || name.endsWith(".exec") || name.endsWith("_exec");
  if (!isShell) return null;
  if (input === null || input === undefined) return null;

  let obj: unknown = input;
  if (typeof input === "string") {
    try {
      obj = JSON.parse(input);
    } catch {
      const trimmed = input.trim();
      return trimmed ? trimmed.slice(0, 400) : null;
    }
  }
  if (typeof obj !== "object" || obj === null) return null;

  const o = obj as Record<string, unknown>;
  for (const key of ["command", "cmd", "script", "shell_command"]) {
    const v = o[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  // OpenCode and Codex nest the payload one level down.
  const nested = o.input;
  if (typeof nested === "object" && nested !== null) {
    const n = nested as Record<string, unknown>;
    for (const key of ["command", "cmd", "script"]) {
      const v = n[key];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return null;
}

/** Bounded, de-duplicated command list for handoff evidence. */
export function pushCommand(list: string[], command: string | null, max = 25): void {
  if (!command) return;
  if (list.length >= max) return;
  if (list.includes(command)) return;
  list.push(command);
}
