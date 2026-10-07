import fs from "node:fs";
import { AdapterRegistry } from "../adapters/registry.ts";
import type { SessionReadOptions } from "../adapters/types.ts";
import { distinctRepos, indexCount, lastIndexedAt, openIndex, querySessions, rowToSession,
  type IndexHandle, type IndexedSessionRow } from "../index/db.ts";
import { scan, type ScanOptions, type ScanResult } from "../index/scan.ts";
import { assertWritableTarget, indexDbPath, isDeniedPath } from "../security.ts";
import { HARNESS_ORDER, type ExternalSession, type SessionDetail } from "../types.ts";
import type { HubStatus, ResolvedResume, SessionQuery } from "./types.ts";
import { HubConfigError } from "./config.ts";

/** Owns the index and all provider orchestration. Hosts only own presentation
 * and launching. No host-supplied source paths ever enter the read API. */
export class SessionHubService {
  private readonly registry: AdapterRegistry;
  private index: IndexHandle | null = null;
  private initializing?: Promise<void>;
  private refreshing?: Promise<ScanResult>;
  private refreshingForce = false;
  private report: ScanResult | null = null;
  private detecting?: ReturnType<AdapterRegistry["detectAll"]>;
  private closed = false;

  constructor(private readonly options: { home: string; registry?: AdapterRegistry }) {
    this.registry = options.registry ?? new AdapterRegistry(options.home);
  }

  async init(): Promise<void> {
    this.assertOpen();
    if (!this.initializing) this.initializing = (async () => {
      const file = indexDbPath(this.options.home);
      assertWritableTarget(file, this.options.home);
      const handle = await openIndex(file);
      if (!handle) throw new Error("Could not open the session index (Node 22.5+ with node:sqlite is required)");
      if (this.closed) { handle.close(); throw new Error("Session Hub service is closed"); }
      this.index = handle;
    })().catch(error => { this.initializing = undefined; throw error; });
    await this.initializing;
    this.assertOpen();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Session Hub service is closed");
  }

  async getStatus(): Promise<HubStatus> {
    await this.init();
    const detections = await (this.detecting ??= this.registry.detectAll());
    this.assertOpen();
    return { total: indexCount(this.index!), indexedAt: lastIndexedAt(this.index!),
      repos: distinctRepos(this.index!).map(row => row.repo), detections,
      harnesses: [...HARNESS_ORDER], scan: this.report };
  }

  async refresh(options: ScanOptions = {}): Promise<ScanResult> {
    await this.init();
    this.assertOpen();
    if (this.refreshing) {
      // A forced request must not be swallowed by an incremental scan.
      if (options.force && !this.refreshingForce) {
        await this.refreshing;
        return this.refresh(options);
      }
      return this.refreshing;
    }
    this.refreshingForce = Boolean(options.force);
    this.refreshing = scan(this.index!, this.registry, options)
      .then(result => { this.report = result; this.detecting = undefined; return result; })
      .finally(() => {
        this.refreshing = undefined;
        if (this.closed) this.releaseIndex();
      });
    return this.refreshing;
  }

  async listSessions(query: SessionQuery = {}): Promise<ExternalSession[]> {
    await this.init();
    this.assertOpen();
    return querySessions(this.index!, query).map(rowToSession);
  }

  async getSessionMetadata(uid: string): Promise<ExternalSession | null> {
    return this.resolve(uid);
  }

  private async resolve(uid: string): Promise<ExternalSession | null> {
    await this.init();
    this.assertOpen();
    const row = this.index!.db.get<IndexedSessionRow>("select * from sessions where uid = ?", [uid]);
    if (!row || isDeniedPath(row.path)) return null;
    try {
      if (isDeniedPath(fs.realpathSync(row.path))) return null;
    } catch { return null; }
    return rowToSession(row);
  }

  async getSession(uid: string, options: SessionReadOptions = {}): Promise<SessionDetail | null> {
    const session = await this.resolve(uid);
    if (!session) return null;
    const adapter = this.registry.get(session.harness);
    if (!adapter) return null;
    const detail = await adapter.getSessionByRef(session, options);
    if (!detail || detail.uid !== uid || detail.path !== session.path) return null;
    return detail;
  }

  async resolveResume(uid: string): Promise<ResolvedResume | null> {
    const session = await this.resolve(uid);
    if (!session) return null;
    const adapter = this.registry.get(session.harness);
    if (!adapter) return null;
    try {
      const action = adapter.buildNativeResumeByRef
        ? await adapter.buildNativeResumeByRef(session)
        : await adapter.buildNativeResume(session.nativeId);
      if (!action?.verified) return null;
      // Only source-backed cwd, never the session store or the host workspace.
      return { session, action: { ...action, cwd: session.cwd || action.cwd || undefined } };
    } catch (error) {
      if (error instanceof HubConfigError) throw error;
      return null;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // A scan owns its handle until it settles. No use-after-close on shutdown.
    if (!this.refreshing) this.releaseIndex();
  }

  private releaseIndex(): void {
    this.index?.close();
    this.index = null;
  }
}
