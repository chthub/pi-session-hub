import * as vscode from "vscode";
import { createHash } from "node:crypto";
import type { SessionHubService } from "../../src/core/service.ts";
import { HARNESS_LABEL, type ExternalSession } from "../../src/types.ts";
import { redact } from "../../src/security.ts";
import { sessionProjectScope, type ProjectScope } from "./projectScope.ts";
import type { SessionStars } from "./sessionStars.ts";

/** Decoration-only identity: never expose the source path or claim a real file. */
function sessionResource(uid: string): vscode.Uri {
  return vscode.Uri.from({ scheme: "session-hub", authority: "sessions", path: `/${createHash("sha256").update(uid).digest("hex")}` });
}

export class SessionTreeItem extends vscode.TreeItem {
  constructor(readonly session: ExternalSession, extensionUri: vscode.Uri, starred = false) {
    super(`${starred ? "★ " : ""}${redact(session.title || session.preview || session.nativeId)}`, vscode.TreeItemCollapsibleState.None);
    this.id = session.uid;
    this.resourceUri = sessionResource(session.uid);
    this.contextValue = starred ? "sessionStarred" : "session";
    this.description = `${HARNESS_LABEL[session.harness]} · ${recency(session.updatedAt ?? session.createdAt)}`;
    this.tooltip = redact([starred ? "已加星标" : null, HARNESS_LABEL[session.harness], session.model, session.repo || session.cwd,
      session.nativeId, `${session.messageCount} 条消息`].filter(Boolean).join("\n"));
    this.iconPath = {
      light: vscode.Uri.joinPath(extensionUri, "media", "harness", "light", `${session.harness}.svg`),
      dark: vscode.Uri.joinPath(extensionUri, "media", "harness", "dark", `${session.harness}.svg`),
    };
    this.command = { command: "sessionHub.open", title: "打开会话", arguments: [session.uid] };
  }
}
class GroupItem extends vscode.TreeItem {
  constructor(readonly scope: ProjectScope, label: string, count: number) {
    super(label, scope === "current" ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `scope:${scope}`;
    this.description = String(count);
  }
}
type Node = SessionTreeItem | GroupItem;
function recency(value: string | null): string {
  const time = value ? Date.parse(value) : NaN;
  if (!Number.isFinite(time)) return "时间未知";
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前`;
  return `${Math.floor(minutes / 1440)} 天前`;
}

export class SessionTree implements vscode.TreeDataProvider<Node>, vscode.FileDecorationProvider, vscode.Disposable {
  private readonly change = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.change.event;
  private readonly decorationsChanged = new vscode.EventEmitter<vscode.Uri | undefined>();
  readonly onDidChangeFileDecorations = this.decorationsChanged.event;
  private decorationUids = new Map<string, string>();
  private sessions: ExternalSession[] = [];
  constructor(private readonly service: SessionHubService, private readonly roots: () => string[],
    private readonly extensionUri: vscode.Uri, private readonly stars: SessionStars) {}

  async reload(): Promise<void> {
    // Scope AFTER pagination, so an old current-project session isn't hidden
    // by more recent history from an unrelated project.
    const sessions: ExternalSession[] = [];
    for (let offset = 0; ; offset += 500) {
      const page = await this.service.listSessions({ limit: 500, offset });
      sessions.push(...page);
      if (page.length < 500) break;
    }
    this.sessions = sessions;
    this.decorationUids = new Map(sessions.map(session => [sessionResource(session.uid).toString(), session.uid]));
    this.decorationsChanged.fire(undefined);
    this.change.fire(undefined);
  }
  async setStarred(uid: string, starred: boolean): Promise<void> {
    if (!this.sessions.some(session => session.uid === uid)) throw new Error("会话不存在；请刷新后重试");
    await this.stars.set(uid, starred);
    this.decorationsChanged.fire(sessionResource(uid));
    this.change.fire(undefined);
  }
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const uid = this.decorationUids.get(uri.toString());
    if (!uid || !this.stars.has(uid)) return undefined;
    return { color: new vscode.ThemeColor("sessionHub.starredForeground"), tooltip: "已加星标", propagate: false };
  }
  hasSession(uid: string): boolean { return this.sessions.some(session => session.uid === uid); }
  /** Stable partition of the index's newest-first order. Never mutate the cache:
   * unstar restores chronological placement, and no source timestamps change. */
  private orderedSessions(): ExternalSession[] {
    const starred: ExternalSession[] = [], ordinary: ExternalSession[] = [];
    for (const session of this.sessions) (this.stars.has(session.uid) ? starred : ordinary).push(session);
    return starred.concat(ordinary);
  }
  /** Bounded, source-path-free rows for the two-line sidebar. Pagination is only
   * presentation: the underlying index and project grouping remain complete. */
  sidebarGroups(limits: Record<ProjectScope, number>) {
    const roots = this.roots();
    const buckets: Record<ProjectScope, ExternalSession[]> = { current: [], unscoped: [], other: [] };
    // Pin before slicing pages so even old stars appear on the first page.
    for (const session of this.orderedSessions()) buckets[sessionProjectScope(session, roots)].push(session);
    return ([["current", "当前项目"], ["unscoped", "项目未识别"], ["other", "其他项目"]] as const).map(([scope, label]) => ({
      scope, label, total: buckets[scope].length,
      sessions: buckets[scope].slice(0, limits[scope]).map(session => ({
        uid: session.uid, title: redact(session.title || session.preview || session.nativeId),
        harness: session.harness, harnessLabel: HARNESS_LABEL[session.harness],
        recency: recency(session.updatedAt ?? session.createdAt), starred: this.stars.has(session.uid),
      })),
    }));
  }
  rescope(): void { this.change.fire(undefined); }
  getTreeItem(node: Node): vscode.TreeItem { return node; }
  getChildren(node?: Node): Node[] {
    const roots = this.roots();
    const groups: [ProjectScope, string][] = [["current", "当前项目"], ["unscoped", "项目未识别"], ["other", "其他项目"]];
    if (node instanceof SessionTreeItem) return [];
    if (node) return this.orderedSessions().filter(session => sessionProjectScope(session, roots) === node.scope).map(session => new SessionTreeItem(session, this.extensionUri, this.stars.has(session.uid)));
    return groups.map(([scope, label]) => new GroupItem(scope, label,
      this.sessions.filter(session => sessionProjectScope(session, roots) === scope).length));
  }
  dispose(): void { this.change.dispose(); this.decorationsChanged.dispose(); this.decorationUids.clear(); }
}
