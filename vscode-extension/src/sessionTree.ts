import * as vscode from "vscode";
import type { SessionHubService } from "../../src/core/service.ts";
import { HARNESS_LABEL, type ExternalSession } from "../../src/types.ts";
import { redact } from "../../src/security.ts";
import { sessionProjectScope, type ProjectScope } from "./projectScope.ts";

export class SessionTreeItem extends vscode.TreeItem {
  constructor(readonly session: ExternalSession, extensionUri: vscode.Uri) {
    super(redact(session.title || session.preview || session.nativeId), vscode.TreeItemCollapsibleState.None);
    this.id = session.uid;
    this.contextValue = "session";
    this.description = `${HARNESS_LABEL[session.harness]} · ${recency(session.updatedAt ?? session.createdAt)}`;
    this.tooltip = redact([HARNESS_LABEL[session.harness], session.model, session.repo || session.cwd,
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

export class SessionTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly change = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.change.event;
  private sessions: ExternalSession[] = [];
  constructor(private readonly service: SessionHubService, private readonly roots: () => string[],
    private readonly extensionUri: vscode.Uri) {}

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
    this.change.fire(undefined);
  }
  rescope(): void { this.change.fire(undefined); }
  getTreeItem(node: Node): vscode.TreeItem { return node; }
  getChildren(node?: Node): Node[] {
    const roots = this.roots();
    const groups: [ProjectScope, string][] = [["current", "当前项目"], ["unscoped", "项目未识别"], ["other", "其他项目"]];
    if (node instanceof SessionTreeItem) return [];
    if (node) return this.sessions.filter(session => sessionProjectScope(session, roots) === node.scope).map(session => new SessionTreeItem(session, this.extensionUri));
    return groups.map(([scope, label]) => new GroupItem(scope, label,
      this.sessions.filter(session => sessionProjectScope(session, roots) === scope).length));
  }
  dispose(): void { this.change.dispose(); }
}
