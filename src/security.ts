/**
 * Privacy and path safety.
 *
 * Two jobs:
 *  1. Never read credential stores, even if a directory scan stumbles into them.
 *  2. Redact secret-looking substrings before any transcript text is stored in
 *     the local index or written into a handoff document.
 */

import path from "node:path";

/**
 * Absolute paths that must never be opened by this extension. Some harnesses
 * keep OAuth tokens next to session data, and Hermes keeps failed request dumps
 * that embed `Authorization: Bearer <token>` headers in plain text.
 */
const DENIED_BASENAMES = new Set([
  "auth.json",
  "account.json",
  "credentials.json",
  ".credentials.json",
  "oauth_creds.json",
  "gemini_oauth.json",
  "openai-auth.json",
  "auth.bak",
  "openai_oauth_usage.json",
  "provider_activity.json",
  "telemetry_id",
  "servers.json",
  "models-store.json",
  "settings.json",
  ".env",
  ".git-credentials",
  ".netrc",
]);

/** Directory names whose contents are never indexed. */
const DENIED_DIR_SEGMENTS = new Set([
  "request_dump",
  "credentials",
  "browser-profile",
  "paste-cache",
  "backups",
]);

export function isDeniedPath(p: string): boolean {
  const base = path.basename(p);
  if (DENIED_BASENAMES.has(base)) return true;
  if (base.startsWith(".env")) return true;
  if (base.startsWith("request_dump")) return true;
  const segments = p.split(path.sep);
  for (const seg of segments) {
    if (DENIED_DIR_SEGMENTS.has(seg)) return true;
  }
  return false;
}

/**
 * The only directory this extension is allowed to write to.
 * Everything else in the harness stores is strictly read-only.
 */
export function indexDir(home: string): string {
  return path.join(home, ".pi", "agent", "pi-session-hub");
}

export function indexDbPath(home: string): string {
  return path.join(indexDir(home), "index.sqlite");
}

export function assertWritableTarget(target: string, home: string): void {
  const allowedDir = path.resolve(indexDir(home));
  const resolved = path.resolve(target);
  // The index directory itself is allowed, as is anything beneath it.
  const ok = resolved === allowedDir || resolved.startsWith(allowedDir + path.sep);
  if (!ok) {
    throw new Error(
      `refusing to write outside the extension index directory: ${resolved}`,
    );
  }
}

const REDACTIONS: Array<[RegExp, string]> = [
  // Tool arguments often use quoted JSON keys; the assignment pattern below
  // cannot match the closing quote between a key and its colon.
  [/("(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|authorization)"\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"[REDACTED]"'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]"],
  [/\b(sk|pk|rk)-[A-Za-z0-9_-]{12,}/g, "[REDACTED_KEY]"],
  [/\bghp_[A-Za-z0-9]{20,}/g, "[REDACTED_KEY]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED_KEY]"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED_KEY]"],
  [/\bAIza[A-Za-z0-9_-]{20,}/g, "[REDACTED_KEY]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[REDACTED_JWT]"],
  [
    /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|authorization)\b\s*[:=]\s*["']?([^\s"',;]{6,})/gi,
    "$1=[REDACTED]",
  ],
];

/** Replace secret-looking substrings with a placeholder. */
export function redact(text: string): string {
  let out = text;
  for (const [re, replacement] of REDACTIONS) {
    out = out.replace(re, replacement);
  }
  return out;
}

/** Truncate to a character budget without cutting mid-word where avoidable. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + "\u2026";
}

/** Recovered prose keeps Markdown/TeX whitespace; only known boilerplate is removed. */
export function cleanTranscriptText(text: string): string {
  const clean = redact(text.replace(/<(system-reminder|environment_context|skills_instructions)>[\s\S]*?<\/\1>/gi, ""));
  return clean.trim() ? clean : "";
}

/** Collapse whitespace and boilerplate for list previews and search excerpts. */
export function cleanText(text: string): string {
  let t = text;
  t = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, " ");
  t = t.replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, " ");
  t = t.replace(/<skills_instructions>[\s\S]*?<\/skills_instructions>/gi, " ");
  t = t.replace(/<[a-z_]+>[\s\S]*?<\/[a-z_]+>/gi, " ");
  t = t.replace(/\s+/g, " ").trim();
  return redact(t);
}
