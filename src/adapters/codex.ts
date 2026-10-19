/**
 * Codex adapter.
 *
 * Source: configured codexHomes, default ~/.codex, under sessions/YYYY/MM/DD/.
 * Format: undocumented JSONL with `type` + `payload`. Session metadata lives in
 * the `session_meta` record; model comes from `turn_context`; conversation
 * messages are `response_item` records with `payload.type === "message"`.
 */

import fs from "node:fs";
import path from "node:path";
import { loadCodexHomes } from "../core/config.ts";
import { ScopedSearchText } from "./search-content.ts";
import { readSessionJsonl, transcriptMessages, toolCounter, TRANSCRIPT_FORMAT_NOTE } from "./reader.ts";
import type { SessionRef } from "../core/types.ts";
import type {
  DetectionResult,
  ExternalSession,
  SessionDetail,
  ToolUseSummary,
} from "../types.ts";
import { emptyFidelity } from "../types.ts";
import type { ListOptions, NativeResumeAction, SessionAdapter, SessionReadOptions } from "./types.ts";
import { clip, cleanText, cleanTranscriptText, isDeniedPath } from "../security.ts";
import {
  addSearchText,
  deriveRepo,
  extractCommand,
  isoFromMs,
  parseIso,
  probePath,
  pushCommand,
  pushToolCall,
  pushToolResult,
  listFileSessions,
  safeStat,
  searchTextFrom,
  titleFromPreview,
  uniqSorted,
  walkFiles,
} from "./util.ts";

interface Parsed {
  session: ExternalSession;
  messages: { role: string; text: string }[];
  tools: Map<string, number>;
  commands: string[];
}

export class CodexAdapter implements SessionAdapter {
  id = "codex" as const;
  displayName = "Codex";

  private readonly home: string;
  constructor(home: string) { this.home = home; }

  async detect(): Promise<DetectionResult> {
    const roots = loadCodexHomes(this.home).map(home => path.join(home, "sessions"));
    const probes = roots.map(root => probePath(root));
    const root = roots.join(path.delimiter);
    if (!probes.includes("directory")) {
      return { harness: this.id, status: probes.includes("denied") ? "permission_denied" : "path_missing", root, sessionCount: 0 };
    }
    const gaps = new Set<string>();
    const sessionCount = this.files({ onIncomplete: reason => gaps.add(reason) }).length;
    return { harness: this.id, status: "available", root, sessionCount,
      ...(gaps.size ? { detail: [...gaps].join("; ") } : {}) };
  }

  private files(opts?: ListOptions): string[] {
    const homes = loadCodexHomes(this.home);
    const seen = new Set<string>();
    const files: string[] = [];
    for (const home of homes) {
      for (const file of walkFiles(path.join(home, "sessions"), { exts: [".jsonl"], onIncomplete: opts?.onIncomplete })) {
        if (!this.homeForSource(file, homes)) {
          if (!opts?.onIncomplete) throw new Error("Could not verify a Codex source path");
          opts.onIncomplete("Could not verify a Codex source path");
          continue;
        }
        const real = fs.realpathSync(file);
        if (!seen.has(real)) { seen.add(real); files.push(file); }
      }
    }
    return files;
  }

  /** A source must stay in a configured sessions tree both lexically and after
   * resolving symlinks. Never select an account from transcript text. */
  private homeForSource(file: string, homes = loadCodexHomes(this.home)): string | null {
    if (!path.isAbsolute(file) || path.extname(file) !== ".jsonl" || isDeniedPath(file)) return null;
    try {
      const real = fs.realpathSync(file);
      if (isDeniedPath(real) || !fs.statSync(real).isFile()) return null;
      for (const home of [...homes].sort((a, b) => b.length - a.length)) {
        const root = path.join(home, "sessions");
        if (!inside(root, file)) continue;
        const realRoot = fs.realpathSync(root);
        if (!isDeniedPath(realRoot) && inside(realRoot, real)) return home;
      }
    } catch { /* Missing, unreadable or escaped sources cannot choose a home. */ }
    return null;
  }

  async listSessions(opts?: ListOptions): Promise<ExternalSession[]> {
    return listFileSessions(this.files(opts), file => this.parse(file, false)?.session ?? null, opts);
  }

  async getSession(nativeId: string, opts: SessionReadOptions = {}): Promise<SessionDetail | null> {
    for (const file of this.files()) {
      const parsed = this.parse(file, true, opts.preserveFormatting, opts.includeToolActivity, opts.locale);
      if (!parsed || parsed.session.nativeId !== nativeId) continue;
      return {
        ...parsed.session,
        messages: parsed.messages,
        tools: toSummaries(parsed.tools),
        commands: parsed.commands,
      };
    }
    return null;
  }

  async getSessionByRef(ref: SessionRef, opts: SessionReadOptions = {}): Promise<SessionDetail | null> {
    if (ref.harness !== this.id || !this.homeForSource(ref.path)) return null;
    const parsed = this.parse(ref.path, true, opts.preserveFormatting, opts.includeToolActivity, opts.locale);
    if (!parsed || parsed.session.uid !== ref.uid) return null;
    return { ...parsed.session, messages: parsed.messages, tools: toSummaries(parsed.tools), commands: parsed.commands };
  }

  async buildNativeResume(nativeId: string): Promise<NativeResumeAction | null> {
    for (const file of this.files()) {
      const parsed = this.parse(file, false);
      if (parsed?.session.nativeId !== nativeId) continue;
      const home = this.homeForSource(file);
      if (home) return this.resumeAction(parsed.session, home);
    }
    return null;
  }

  async buildNativeResumeByRef(ref: SessionRef): Promise<NativeResumeAction | null> {
    if (ref.harness !== this.id) return null;
    const home = this.homeForSource(ref.path);
    if (!home) return null;
    const parsed = this.parse(ref.path, false);
    if (!parsed || parsed.session.uid !== ref.uid || parsed.session.nativeId !== ref.nativeId) return null;
    return this.resumeAction(parsed.session, home);
  }

  private resumeAction(session: ExternalSession, home: string): NativeResumeAction {
    return {
      command: "codex", args: ["resume", session.nativeId], cwd: session.cwd ?? undefined,
      env: { CODEX_HOME: home }, verificationBasis: "cli-help", verified: true,
      verificationNote: "subcommand documented in `codex resume --help`; CODEX_HOME selected from the indexed source path",
      requiresConfirmation: true,
      description: `Resume session ${session.nativeId.slice(0, 8)} with Codex (CODEX_HOME=${home})`,
    };
  }

  private parse(file: string, withMessages: boolean, preserveFormatting = false, includeToolActivity = false, locale: NonNullable<SessionReadOptions["locale"]> = "zh-CN"): Parsed | null {
    const stat = safeStat(file);
    if (!stat) return null;
    if (!stat.size) return null;
    const read = readSessionJsonl(file);
    if (withMessages) read.notes.push(TRANSCRIPT_FORMAT_NOTE);

    let id: string | null = null;
    let cwd: string | null = null;
    let createdAt: string | null = null;
    let updatedAt: string | null = null;
    let model: string | null = null;
    let cliVersion: string | null = null;

    const messages = transcriptMessages(read.notes);
    const searchAcc: string[] = [];
    const scopedSearch = new ScopedSearchText();
    const toolNames = toolCounter(read.notes);
    const commands: string[] = [];
    const filesChanged = new Set<string>();
    const filesRead = new Set<string>();
    let hasToolResults = false;
    let hasReasoning = false;
    let messageCount = 0;

    for (const e of read.records) {

      const ts = parseIso(e.timestamp);
      if (ts) updatedAt = ts;
      const type = e.type;
      const payload = (e.payload ?? {}) as Record<string, unknown>;

      if (type === "session_meta") {
        const sid = payload.session_id ?? payload.id;
        if (typeof sid === "string") id = sid;
        if (typeof payload.cwd === "string") cwd = payload.cwd;
        if (typeof payload.cli_version === "string") cliVersion = payload.cli_version;
        if (typeof payload.timestamp === "string") createdAt = parseIso(payload.timestamp);
        const instructions = payload.base_instructions as Record<string, unknown> | undefined;
        scopedSearch.add("system", typeof payload.base_instructions === "string" ? payload.base_instructions : instructions?.text);
        continue;
      }
      if (type === "turn_context") {
        if (typeof payload.model === "string") model = payload.model;
        if (typeof payload.cwd === "string" && !cwd) cwd = payload.cwd;
        scopedSearch.add("system", payload.developer_instructions);
        scopedSearch.add("system", payload.user_instructions);
        continue;
      }
      if (type !== "response_item") continue;

      const ptype = payload.type;
      if (ptype === "reasoning") {
        hasReasoning = true;
        scopedSearch.reasoning(payload.summary ?? payload.content);
        continue;
      }
      if (ptype === "custom_tool_call" || ptype === "function_call") {
        const name = typeof payload.name === "string" ? payload.name : "tool";
        toolNames.push(name);
        const rawArgs = payload.arguments ?? payload.input;
        scopedSearch.call(name, rawArgs);
        collectPaths(rawArgs, filesChanged, filesRead);
        pushCommand(commands, extractCommand(name, rawArgs));
        if (withMessages && includeToolActivity) pushToolCall(messages, name, "arguments" in payload ? payload.arguments : payload.input, payload.call_id ?? payload.id, Infinity, locale);
        continue;
      }
      if (ptype === "custom_tool_call_output" || ptype === "function_call_output") {
        hasToolResults = true;
        scopedSearch.result(payload.output);
        if (withMessages && includeToolActivity) pushToolResult(messages, payload.output, payload.name, payload.call_id, Infinity, locale);
        continue;
      }
      if (ptype !== "message") continue;

      const role = typeof payload.role === "string" ? payload.role : "";
      scopedSearch.add(role, payload.content);
      if (role !== "user" && role !== "assistant") continue;
      const prose = proseOnly(payload.content);
      if (!prose) continue;
      addSearchText(searchAcc, role, prose);
      messageCount++;

      // Boilerplate-only turns (environment_context, skills_instructions) clean
      // down to an empty string. Keep them out of the preview and search body.
      const clean = clip(withMessages && preserveFormatting ? cleanTranscriptText(prose) : cleanText(prose), 4000);
      if (!clean) continue;

      if (withMessages) {
        messages.push({ role, text: clean });
      } else if (role === "user" && messages.length < 3) {
        messages.push({ role, text: clean });
      }
    }

    if (!read.bytesRead) return null;

    if (!id) {
      const m = /rollout-.*?-([0-9a-f-]{36})\.jsonl$/.exec(path.basename(file));
      id = m ? m[1] : path.basename(file, ".jsonl");
    }

    const preview = messages.find((m) => m.role === "user")?.text ?? null;
    const fallback = `Codex session ${id.slice(0, 8)}`;

    return {
      session: {
        uid: `codex:${id}`,
        harness: "codex",
        nativeId: id,
        path: file,
        title: titleFromPreview(preview ? clip(preview, 160) : null, fallback),
        createdAt: createdAt ?? isoFromMs(stat.mtimeMs),
        updatedAt: updatedAt ?? isoFromMs(stat.mtimeMs),
        cwd,
        repo: deriveRepo(cwd),
        model,
        messageCount,
        toolCount: toolNames.length,
        preview: preview ? clip(preview, 160) : null,
        searchText: searchTextFrom(searchAcc),
        searchScopes: scopedSearch.finish(),
        fidelity: {
          ...emptyFidelity(read.notes),
          hasToolCalls: toolNames.length > 0,
          hasToolResults,
          hasReasoning,
          filesChanged: uniqSorted(filesChanged),
          filesRead: uniqSorted(filesRead),
        },
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      },
      messages,
      tools: toolNames.counts,
      commands,
    };
  }
}

function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function proseOnly(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    const t = b.type;
    if (t === "input_text" || t === "output_text" || t === "text") {
      if (typeof b.text === "string") parts.push(b.text);
    }
  }
  return parts.join("\n");
}

/**
 * Codex tool arguments are usually a JSON string. Pull out file paths when the
 * shape matches; otherwise record nothing rather than guessing.
 */
function collectPaths(
  args: unknown,
  changed: Set<string>,
  read: Set<string>,
): void {
  let parsed: unknown = args;
  if (typeof args === "string") {
    try {
      parsed = JSON.parse(args);
    } catch {
      return;
    }
  }
  if (!parsed || typeof parsed !== "object") return;
  const a = parsed as Record<string, unknown>;
  const cmd = typeof a.command === "string" ? a.command : "";
  const paths: string[] = [];
  for (const key of ["file_path", "path", "notebook_path"]) {
    const v = a[key];
    if (typeof v === "string" && v) paths.push(v);
  }
  for (const p of paths) {
    if (/\b(read|cat|open)\b/.test(cmd)) read.add(p);
    else changed.add(p);
  }
}

function toSummaries(map: Map<string, number>): ToolUseSummary[] {
  return Array.from(map.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}
