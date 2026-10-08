import * as vscode from "vscode";
import os from "node:os";
import { SessionHubService } from "../../src/core/service.ts";
import { selectPiEnvironment, type PiEnvironment } from "../../src/core/pi-environment.ts";
import { redact } from "../../src/security.ts";
import { SessionTree, SessionTreeItem } from "./sessionTree.ts";
import { SessionViewer } from "./sessionViewer.ts";
import { TerminalLauncher } from "./terminalLauncher.ts";

let service: SessionHubService | undefined;
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const hub = new SessionHubService({ home: os.homedir() });
  service = hub;
  const tree = new SessionTree(hub, () => (vscode.workspace.workspaceFolders ?? [])
    .filter(folder => folder.uri.scheme === "file" || folder.uri.scheme === "vscode-remote").map(folder => folder.uri.fsPath), context.extensionUri);
  const view = vscode.window.createTreeView("sessionHub.sessions", { treeDataProvider: tree });
  const launcher = new TerminalLauncher();
  const uidFrom = (value: unknown): string => {
    const uid = value instanceof SessionTreeItem ? value.session.uid : value;
    if (typeof uid !== "string" || !uid || uid.length > 2000) throw new Error("请选择一条会话");
    return uid;
  };
  const resume = async (uid: string): Promise<void> => {
    const resolved = await hub.resolveResume(uid);
    if (!resolved) throw new Error("此会话没有经过验证的继续命令（子 agent 记录不可直接继续）");
    let action = resolved.action;
    if (action.piEnvironment && !action.piEnvironment.selected) {
      const selection = await vscode.window.showQuickPick<vscode.QuickPickItem & { profile: PiEnvironment }>(
        action.piEnvironment.choices.map(profile => ({ label: profile.label, description: profile.agentDir, profile })),
        { title: "选择本次继续使用的 Pi 环境", placeHolder: action.piEnvironment.reason, ignoreFocusOut: true });
      if (!selection) return;
      action = selectPiEnvironment(action, selection.profile.id);
    }
    await launcher.launch(action);
  };
  let refreshing: Promise<unknown> | undefined;
  const refresh = (): Promise<unknown> => {
    if (!refreshing) refreshing = Promise.resolve(vscode.window.withProgress({ location: { viewId: "sessionHub.sessions" }, title: "刷新会话索引" }, async () => {
      const result = await hub.refresh();
      await tree.reload();
      view.message = result.errors.length ? redact(`部分来源读取失败：${result.errors.map(e => `${e.harness}: ${e.message}`).join("；")}`) : undefined;
      return result;
    })).finally(() => { refreshing = undefined; });
    return refreshing;
  };
  const viewer = new SessionViewer(hub, context.extensionUri, resume, refresh);
  const command = (name: string, handler: (value: unknown) => Promise<unknown>): vscode.Disposable =>
    vscode.commands.registerCommand(name, async (value: unknown) => {
      try { return await handler(value); }
      catch (error) { await vscode.window.showErrorMessage(redact(`Session Hub: ${error instanceof Error ? error.message : String(error)}`)); }
    });
  context.subscriptions.push({ dispose: () => hub.close() }, tree, view, viewer,
    command("sessionHub.refresh", () => refresh()),
    command("sessionHub.open", value => viewer.open(uidFrom(value))),
    command("sessionHub.resume", value => resume(uidFrom(value))),
    command("sessionHub.copyId", async value => {
      const uid = uidFrom(value);
      if (!(await hub.getSessionMetadata(uid))) throw new Error("会话不存在");
      await vscode.env.clipboard.writeText(uid);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => tree.rescope()));
  try { await hub.init(); await refresh(); }
  catch (error) {
    view.message = redact(`索引读取失败：${error instanceof Error ? error.message : String(error)}`);
    await vscode.window.showErrorMessage(view.message);
  }
}
export function deactivate(): void { service?.close(); service = undefined; }
