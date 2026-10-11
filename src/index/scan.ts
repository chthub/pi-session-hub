/**
 * Scan orchestration.
 *
 * Walks the enabled adapters and folds their results into the local index.
 * File-backed harnesses reuse indexed metadata before reading/parsing unchanged
 * files. Directory traversal and stat checks still run on every scan.
 */

import type { ExternalSession, HarnessId } from "../types.ts";
import type { AdapterRegistry } from "../adapters/registry.ts";
import {
  indexCount,
  markIndexed,
  removeSessions,
  indexedFileSessions,
  sourceFingerprint,
  setSourceFingerprint,
  transaction,
  upsertSessions,
  type IndexHandle,
} from "./db.ts";

export interface ScanProgress {
  phase: string;
  done: number;
  total: number;
  message?: string;
}

export interface ScanResult {
  total: number;
  added: number;
  updated: number;
  removed: number;
  skipped: number;
  perHarness: Record<string, number>;
  errors: { harness: HarnessId; message: string }[];
  /** Harnesses successfully listed this pass (including reused metadata). */
  scanned: HarnessId[];
  /** Harnesses that failed. Their indexed sessions are preserved, not deleted. */
  failed: HarnessId[];
  /** Successfully listed, but not authoritative for deletion (caps/read gaps). */
  incomplete: HarnessId[];
  durationMs: number;
}

export interface ScanOptions {
  /** Ignore fingerprints and re-read every source. */
  force?: boolean;
  /** Optional work cap. Capped scans never prune, even below the cap. */
  maxPerHarness?: number;
  onProgress?: (p: ScanProgress) => void;
}

/**
 * Harnesses whose sessions live in one database. Their fingerprint is the
 * database file itself, so a full re-read is the only correct behaviour.
 */
const DB_BACKED: HarnessId[] = ["opencode", "crush"];

export async function scan(
  handle: IndexHandle,
  registry: AdapterRegistry,
  opts: ScanOptions = {},
): Promise<ScanResult> {
  if (opts.maxPerHarness !== undefined && (!Number.isSafeInteger(opts.maxPerHarness) || opts.maxPerHarness < 0)) {
    throw new Error("maxPerHarness must be a non-negative safe integer");
  }
  const started = Date.now();
  const adapters = registry.active();
  const result: ScanResult = {
    total: 0,
    added: 0,
    updated: 0,
    removed: 0,
    skipped: 0,
    perHarness: {},
    errors: [],
    scanned: [],
    failed: [],
    incomplete: [],
    durationMs: 0,
  };

  const seen = new Set<string>();
  const succeeded = new Set<HarnessId>();
  const complete = new Set<HarnessId>();
  let done = 0;

  for (const adapter of adapters) {
    opts.onProgress?.({
      phase: "scan",
      done,
      total: adapters.length,
      message: `reading ${adapter.displayName}`,
    });

    let sessions: ExternalSession[] = [];
    const reused = new Set<ExternalSession>();
    let cachedUids = new Set<string>();
    let incomplete = opts.maxPerHarness !== undefined;
    const gaps = new Set<string>();
    try {
      const cached = !opts.force && !DB_BACKED.includes(adapter.id)
        ? new Map(indexedFileSessions(handle, adapter.id).map(s => [s.path, s]))
        : null;
      cachedUids = new Set(cached ? [...cached.values()].map(s => s.uid) : []);
      sessions = await adapter.listSessions({
        maxSessions: opts.maxPerHarness,
        onIncomplete: reason => { incomplete = true; gaps.add(reason); },
        reuseUnchanged: cached ? (path, stat) => {
          const prev = cached.get(path);
          if (prev && prev.mtimeMs === stat.mtimeMs && prev.size === stat.size) {
            reused.add(prev);
            return prev;
          }
          return null;
        } : undefined,
      });
      succeeded.add(adapter.id);
      if (incomplete) result.incomplete.push(adapter.id);
      else complete.add(adapter.id);
      if (gaps.size) result.errors.push({ harness: adapter.id, message: [...gaps].join("; ") });
    } catch (err) {
      result.errors.push({
        harness: adapter.id,
        message: err instanceof Error ? err.message : String(err),
      });
      result.failed.push(adapter.id);
      done++;
      continue;
    }

    const toWrite: ExternalSession[] = [];
    const parsed: ExternalSession[] = [];
    for (const s of sessions) {
      seen.add(s.uid);
      if (reused.has(s)) {
        result.skipped++;
        continue;
      }
      parsed.push(s);
      // v1 indexes cannot map non-canonical duplicate paths to a session ID.
      // Learn that mapping after one read, without overwriting canonical text.
      if (cachedUids.has(s.uid)) {
        const prev = sourceFingerprint(handle, adapter.id, s.path);
        if (prev && prev.mtime_ms === s.mtimeMs && prev.size === s.size) {
          result.skipped++;
          continue;
        }
      }
      toWrite.push(s);
    }

    const before = indexCount(handle);
    // One transaction per adapter: without it, each statement is its own
    // fsync and a full scan takes tens of seconds.
    transaction(handle, () => {
      for (const s of parsed) {
        setSourceFingerprint(handle, adapter.id, s.path, s.mtimeMs, s.size, s.uid);
      }
      upsertSessions(handle, toWrite);
    });
    const after = indexCount(handle);
    result.added += Math.max(0, after - before);
    result.updated += toWrite.length - Math.max(0, after - before);
    result.perHarness[adapter.id] = sessions.length;
    done++;
  }

  // Only an uncapped, complete listing is evidence of deletion. Partial or
  // failed scans can add/update rows, but must preserve all undiscovered rows.
  const stale = handle.db
    .all<{ uid: string; harness: HarnessId }>("select uid, harness from sessions")
    .filter((row) => complete.has(row.harness) && !seen.has(row.uid))
    .map((row) => row.uid);
  if (stale.length > 0) {
    transaction(handle, () => removeSessions(handle, stale));
    result.removed = stale.length;
  }

  result.scanned = [...succeeded];

  result.total = indexCount(handle);
  result.durationMs = Date.now() - started;
  markIndexed(handle, new Date().toISOString());
  opts.onProgress?.({ phase: "done", done: adapters.length, total: adapters.length });
  return result;
}

/** Detection only, without touching the index. */
export async function detectSources(registry: AdapterRegistry) {
  return registry.detectAll();
}
