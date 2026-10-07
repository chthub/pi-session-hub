import type { SessionRef } from "../core/types.ts";
import type { PiEnvironmentResolution } from "../core/pi-environment.ts";
import type {
  DetectionResult,
  ExternalSession,
  HarnessId,
  SessionDetail,
} from "../types.ts";

export interface ListOptions {
  /** Hard cap on sessions returned by a single adapter. */
  maxSessions?: number;
  /** File-backed scans may reuse indexed metadata before reading the source.
   * Return null to read/parse the file normally. */
  reuseUnchanged?: (path: string, stat: { mtimeMs: number; size: number }) => ExternalSession | null;
}

export interface SessionReadOptions {
  preserveFormatting?: boolean;
  /** Recover individual calls/results for the Web Viewer, without changing
   * the existing TUI/context/handoff transcript by default. */
  includeToolActivity?: boolean;
}

/**
 * Every harness gets one adapter. Adapters are strictly read-only: they open
 * files and SQLite databases for reading and never write outside the
 * extension's own index directory.
 */
export interface SessionAdapter {
  id: HarnessId;
  displayName: string;

  /** Cheap probe: does the store exist, is it readable, how many sessions. */
  detect(): Promise<DetectionResult>;

  /** Metadata-only listing. Must not load full transcripts. */
  listSessions(opts?: ListOptions): Promise<ExternalSession[]>;

  /** Recovered transcript. Opt into Markdown/TeX whitespace for the Web Viewer;
   * default normalization stays compatible with TUI/context/handoff callers. */
  getSession(nativeId: string, opts?: SessionReadOptions): Promise<SessionDetail | null>;

  /** Exact indexed source: never rediscover a file by substring/native id. */
  getSessionByRef(ref: SessionRef, opts?: SessionReadOptions): Promise<SessionDetail | null>;
  buildNativeResumeByRef?(ref: SessionRef): Promise<NativeResumeAction | null>;

  /**
   * Native resume command for the original harness, or null when no safe,
   * verified command exists. Never guesses.
   */
  buildNativeResume(nativeId: string): Promise<NativeResumeAction | null>;
}

export interface NativeResumeAction {
  command: string;
  args: string[];
  cwd?: string;
  /** Explicit launch overrides, derived from trusted source metadata or a host picker. */
  env?: Record<string, string>;
  /** Pi account/config identity is separate from provider/model identity. */
  piEnvironment?: PiEnvironmentResolution;
  /**
   * How we know this command line is real. The hub never offers a command it
   * cannot justify, and it says which justification it used.
   *  - "cli-help": the flag is documented in the harness's own `--help`
   *  - "executed": the command was actually run successfully during development
   */
  verificationBasis: "cli-help" | "executed";
  /** True only when the basis is strong enough to offer the action. */
  verified: boolean;
  /** Human-readable explanation of the evidence, shown before confirmation. */
  verificationNote: string;
  /** Always true: the hub never spawns a process without explicit consent. */
  requiresConfirmation: true;
  /** Human-readable explanation shown before confirmation. */
  description: string;
}
