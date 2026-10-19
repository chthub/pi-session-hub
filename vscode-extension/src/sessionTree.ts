import * as vscode from "vscode";
import { createHash } from "node:crypto";
import type { SessionHubService } from "../../src/core/service.ts";
import { HARNESS_LABEL, type ExternalSession, type SearchScope } from "../../src/types.ts";
import { redact } from "../../src/security.ts";
import { sessionProjectScope, type ProjectScope } from "./projectScope.ts";
import type { SessionStars } from "./sessionStars.ts";
import { sessionRecency } from "./sessionTime.ts";

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
    this.description = `${HARNESS_LABEL[session.harness]} · ${sessionRecency(session.updatedAt ?? session.createdAt)}`;
    this.tooltip = redact([starred ? "Starred" : null, HARNESS_LABEL[session.harness], session.model, session.repo || session.cwd,
      session.nativeId, `${session.messageCount} messages`].filter(Boolean).join("\n"));
    this.iconPath = {
      light: vscode.Uri.joinPath(extensionUri, "media", "harness", "light", `${session.harness}.svg`),
      dark: vscode.Uri.joinPath(extensionUri, "media", "harness", "dark", `${session.harness}.svg`),
    };
    this.command = { command: "sessionHub.open", title: "Open Session", arguments: [session.uid] };
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

export class SessionTree implements vscode.TreeDataProvider<Node>, vscode.FileDecorationProvider, vscode.Disposable {
  private readonly change = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.change.event;
  private readonly decorationsChanged = new vscode.EventEmitter<vscode.Uri | undefined>();
  readonly onDidChangeFileDecorations = this.decorationsChanged.event;
  private decorationUids = new Map<string, string>();
  private sessions: ExternalSession[] = [];
  private searchVersion = 0;
  private requestedSearch = { text: "", searchScope: "user" as SearchScope };
  private appliedSearch = this.requestedSearch;
  private matches?: Set<string>;
  get sidebarSearch(): Readonly<{ text: string; searchScope: SearchScope }> { return this.appliedSearch; }
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
    await this.setSearch(this.requestedSearch.text, this.requestedSearch.searchScope);
  }
  /** Query every index page before grouping/pinning/slicing sidebar results.
   * Newer requests always win, including searches racing an index refresh. */
  async setSearch(text: string, searchScope: SearchScope = "user"): Promise<void> {
    const version = ++this.searchVersion;
    const query = { text: text.trim(), searchScope };
    this.requestedSearch = query;
    let matches: Set<string> | undefined;
    if (query.text) {
      matches = new Set();
      for (let offset = 0; ; offset += 500) {
        const page = await this.service.listSessions({ ...query, limit: 500, offset });
        if (version !== this.searchVersion) return;
        for (const session of page) matches.add(session.uid);
        if (page.length < 500) break;
      }
    }
    if (version !== this.searchVersion) return;
    this.matches = matches;
    this.appliedSearch = query;
    this.change.fire(undefined);
  }
  async setStarred(uid: string, starred: boolean): Promise<void> {
    if (!this.sessions.some(session => session.uid === uid)) throw new Error("Session not found. Refresh and try again.");
    await this.stars.set(uid, starred);
    this.decorationsChanged.fire(sessionResource(uid));
    this.change.fire(undefined);
  }
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const uid = this.decorationUids.get(uri.toString());
    if (!uid || !this.stars.has(uid)) return undefined;
    return { color: new vscode.ThemeColor("sessionHub.starredForeground"), tooltip: "Starred", propagate: false };
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
    for (const session of this.orderedSessions()) {
      if (!this.matches || this.matches.has(session.uid)) buckets[sessionProjectScope(session, roots)].push(session);
    }
    return ([["current", "Current Project"], ["unscoped", "Unassigned"], ["other", "Other Projects"]] as const).map(([scope, label]) => ({
      scope, label, total: buckets[scope].length,
      sessions: buckets[scope].slice(0, limits[scope]).map(session => ({
        uid: session.uid, title: redact(session.title || session.preview || session.nativeId),
        harness: session.harness, harnessLabel: HARNESS_LABEL[session.harness],
        recency: sessionRecency(session.updatedAt ?? session.createdAt), starred: this.stars.has(session.uid),
      })),
    }));
  }
  rescope(): void { this.change.fire(undefined); }
  getTreeItem(node: Node): vscode.TreeItem { return node; }
  getChildren(node?: Node): Node[] {
    const roots = this.roots();
    const groups: [ProjectScope, string][] = [["current", "Current Project"], ["unscoped", "Unassigned"], ["other", "Other Projects"]];
    if (node instanceof SessionTreeItem) return [];
    if (node) return this.orderedSessions().filter(session => sessionProjectScope(session, roots) === node.scope).map(session => new SessionTreeItem(session, this.extensionUri, this.stars.has(session.uid)));
    return groups.map(([scope, label]) => new GroupItem(scope, label,
      this.sessions.filter(session => sessionProjectScope(session, roots) === scope).length));
  }
  dispose(): void { this.searchVersion++; this.change.dispose(); this.decorationsChanged.dispose(); this.decorationUids.clear(); }
}
