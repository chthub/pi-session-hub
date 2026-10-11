import type { Memento } from "vscode";

export const SESSION_STARS_KEY = "sessionHub.starredSessionUids.v1";

function isUid(value: unknown): value is string {
  return typeof value === "string" && value.length <= 2000 && /^[a-z][a-z0-9-]*:[^\r\n\0]+$/.test(value);
}

/** Extension-owned preferences only. Never prune absent sessions: a source may
 * be temporarily unavailable. Store full namespaced UIDs, not titles or paths. */
export class SessionStars {
  private starred = new Set<string>();
  private pending: Promise<void> = Promise.resolve();
  private needsRecovery = false;

  constructor(private readonly state: Pick<Memento, "get" | "update">) {}

  private read(): Set<string> {
    const value = this.state.get<unknown>(SESSION_STARS_KEY);
    if (value === undefined) return new Set();
    // Fail closed rather than silently replacing corrupt/unrecognized state.
    if (!Array.isArray(value) || !value.every(isUid)) throw new Error("会话星标存储格式无效；未覆盖已有数据");
    return new Set(value);
  }

  load(): void { this.starred = this.read(); }
  has(uid: string): boolean { return this.starred.has(uid); }

  set(uid: string, starred: boolean): Promise<void> {
    if (!isUid(uid)) return Promise.reject(new Error("无效的会话 ID"));
    // Serialize read/modify/write so rapid clicks cannot lose another star.
    // Reread preferences unless a rejected update may have polluted Memento's
    // in-memory cache. Recover from our last acknowledged snapshot in that case.
    const operation = this.pending.then(async () => {
      const next = this.needsRecovery ? new Set(this.starred) : this.read();
      if (next.has(uid) !== starred || this.needsRecovery) {
        if (starred) next.add(uid);
        else next.delete(uid);
        try { await this.state.update(SESSION_STARS_KEY, [...next].sort()); }
        catch {
          this.needsRecovery = true;
          throw new Error("无法保存会话星标；请重试（显示状态未改变）");
        }
        this.needsRecovery = false;
      }
      // Publish only after persistence succeeds; failed writes need no rollback.
      this.starred = next;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
}
