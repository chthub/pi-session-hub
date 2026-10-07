import path from "node:path";
import fs from "node:fs";
import type { NativeResumeAction } from "../adapters/types.ts";

export interface PiEnvironment {
  id: string;
  label: string;
  agentDir: string;
}
export interface PiEnvironmentResolution {
  status: "detected" | "unknown" | "conflict" | "selected";
  selected: PiEnvironment | null;
  choices: PiEnvironment[];
  evidencePaths: string[];
  reason: string;
}

export function defaultPiEnvironments(home: string): PiEnvironment[] {
  return [{ id: "default", label: "Pi", agentDir: path.join(home, ".pi", "agent") }];
}
function pathKey(value: string): string {
  const normalized = path.resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

const CONTEXT_FILES = new Set(["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]);
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Read only outer instruction wrappers. Examples inside an AGENTS document
 * must not become a second account identity. Malformed wrappers fail closed. */
function contextPaths(context: string): { paths: string[]; malformed: boolean } {
  const paths: string[] = [];
  let depth = 0;
  let malformed = false;
  for (const match of context.matchAll(/<\/?project_instructions\b[^>]*>/g)) {
    const tag = match[0];
    if (tag.startsWith("</")) {
      if (depth === 0) malformed = true;
      else depth--;
    } else {
      if (depth === 0) {
        const attribute = /^<project_instructions\s+path=(?:"([^"]+)"|'([^']+)')\s*>$/.exec(tag);
        if (attribute) paths.push((attribute[1] ?? attribute[2])!);
        else malformed = true;
      }
      depth++;
    }
  }
  return { paths, malformed: malformed || depth !== 0 };
}

/** Source-backed inference only: system project_context, or the equivalent
 * system checkpoint in compaction. Never user prose, tool output, model IDs,
 * session-store symlinks, skills paths or the host's inherited environment. */
export class PiEnvironmentDetector {
  private readonly choices: PiEnvironment[];
  private readonly home: string;
  private readonly evidence = new Set<string>();
  private readonly detected = new Set<string>();
  private unsupported = false;
  private malformed = false;
  constructor(home: string, choices = defaultPiEnvironments(home)) {
    this.home = home;
    this.choices = choices;
  }

  observe(entry: unknown): void {
    const value = record(entry);
    if (!value) return;
    const message = value.type === "message" ? record(value.message)
      : value.type === "compaction" ? record(value.systemMessage) : null;
    if (message?.role !== "system") return;
    const sections = record(message.sections);
    if (typeof sections?.project_context === "string") {
      this.observeContext(sections.project_context);
    } else if (!sections && typeof message.content === "string") {
      // Older, unstructured system prompts must still contain the explicit
      // project_context boundary; arbitrary text mentions are not evidence.
      for (const match of message.content.matchAll(/<project_context>([\s\S]*?)<\/project_context>/g)) this.observeContext(match[1]!);
    }
  }

  private observeContext(context: string): void {
    const parsed = contextPaths(context);
    this.malformed ||= parsed.malformed;
    for (const sourcePath of parsed.paths) {
      let candidate = sourcePath;
      if (candidate.startsWith("~/")) candidate = path.join(this.home, candidate.slice(2));
      else if (candidate.startsWith(".pi/")) candidate = path.join(this.home, candidate);
      if (!path.isAbsolute(candidate) || !CONTEXT_FILES.has(path.basename(candidate))) continue;
      const directory = path.normalize(path.dirname(candidate));
      const profile = this.choices.find(choice => pathKey(choice.agentDir) === pathKey(directory));
      if (profile) {
        this.detected.add(profile.id);
        this.evidence.add(sourcePath);
      } else if (path.dirname(directory) === path.join(this.home, ".pi") && path.basename(directory).startsWith("agent")) {
        this.unsupported = true;
        this.evidence.add(sourcePath);
      }
    }
  }

  resolve(truncated = false): PiEnvironmentResolution {
    const evidencePaths = [...this.evidence];
    const base = { choices: this.choices, evidencePaths };
    if (truncated || this.malformed || this.unsupported) return { ...base, status: "unknown", selected: null,
      reason: truncated ? "会话读取被截断，无法排除后续环境变化，请选择 Pi 环境"
        : this.malformed ? "系统 Context 结构不完整，请选择 Pi 环境"
        : "系统 Context 指向未支持的 Pi 配置目录，请选择 Pi 环境" };
    if (this.detected.size > 1) return { ...base, status: "conflict", selected: null,
      reason: "会话的系统 Context 包含多个 Pi 环境，请选择本次继续使用的环境" };
    const selected = this.choices.find(choice => this.detected.has(choice.id)) ?? null;
    return selected ? { ...base, status: "detected", selected, reason: "根据保存的系统 Context 路径识别" }
      : { ...base, status: "unknown", selected: null, reason: "会话未保存可识别的 Pi 环境，请手动选择" };
  }
}

/** Hosts supply only a picker ID, never an arbitrary environment/path. */
export function selectPiEnvironment(action: NativeResumeAction, id: string): NativeResumeAction {
  const resolution = action.piEnvironment;
  if (action.command !== "pi" || !resolution) throw new Error("不是 Pi 环境选择请求");
  if (resolution.status === "detected" && resolution.selected?.id !== id) throw new Error("不能覆盖已识别的源 Pi 环境");
  const selected = resolution.choices.find(choice => choice.id === id);
  if (!selected) throw new Error("无效的 Pi 环境");
  return { ...action, env: { ...action.env, PI_CODING_AGENT_DIR: selected.agentDir },
    piEnvironment: { ...resolution, status: "selected", selected, reason: "用户手动选择的 Pi 环境" } };
}

/** Directory existence is checked at launch, not guessed or created by Hub. */
export function assertPiEnvironmentAvailable(action: NativeResumeAction): void {
  assertPiEnvironmentSelected(action);
  const profile = action.piEnvironment?.selected;
  if (!profile) return;
  try { if (fs.statSync(profile.agentDir).isDirectory()) return; }
  catch { /* Report the source environment, not an implicit default fallback. */ }
  throw new Error("源 Pi 配置目录不可用，不会切换到默认账号");
}

export function assertPiEnvironmentSelected(action: NativeResumeAction): void {
  if (action.piEnvironment && (!action.piEnvironment.selected ||
      action.env?.PI_CODING_AGENT_DIR !== action.piEnvironment.selected.agentDir)) {
    throw new Error("必须先选择 Pi 环境，不能继承默认账号配置");
  }
}
