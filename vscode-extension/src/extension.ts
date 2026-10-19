import * as vscode from "vscode";
import os from "node:os";
import path from "node:path";
import { SessionHubService } from "../../src/core/service.ts";
import { newSessionTargets, type NewSessionTarget } from "../../src/core/new-session.ts";
import { selectPiEnvironment, type PiEnvironment } from "../../src/core/pi-environment.ts";
import { redact } from "../../src/security.ts";
import { SessionTree, SessionTreeItem } from "./sessionTree.ts";
import { SessionStars } from "./sessionStars.ts";
import { SessionViewer } from "./sessionViewer.ts";
import { SessionSidebar } from "./sessionSidebar.ts";
import { TerminalLauncher } from "./terminalLauncher.ts";

let service: SessionHubService | undefined;
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const hub = new SessionHubService({ home: os.homedir() });
  service = hub;
  const stars = new SessionStars(context.globalState);
  try { stars.load(); }
  catch (error) {
    await vscode.window.showErrorMessage(redact(`Session Hub: Could not load starred sessions: ${error instanceof Error ? error.message : String(error)}`));
  }
  const tree = new SessionTree(hub, () => workspaceDirs(), context.extensionUri, stars);
  const launcher = new TerminalLauncher();
  const uidFrom = (value: unknown): string => {
    const uid = value instanceof SessionTreeItem ? value.session.uid
      : value && typeof value === "object" ? (value as { sessionUid?: unknown }).sessionUid : value;
    if (typeof uid !== "string" || !uid || uid.length > 2000) throw new Error("Select a session first.");
    return uid;
  };
  const resume = async (uid: string): Promise<void> => {
    const resolved = await hub.resolveResume(uid);
    if (!resolved) throw new Error("No verified resume command is available for this session (subagent records cannot be resumed directly).");
    let action = resolved.action;
    if (action.piEnvironment && !action.piEnvironment.selected) {
      const selection = await vscode.window.showQuickPick<vscode.QuickPickItem & { profile: PiEnvironment }>(
        action.piEnvironment.choices.map(profile => ({ label: profile.label, description: profile.agentDir, profile })),
        { title: "Select a Pi environment to resume", placeHolder: action.piEnvironment.reason, ignoreFocusOut: true });
      if (!selection) return;
      action = selectPiEnvironment(action, selection.profile.id);
    }
    await launcher.launch(action);
  };
  const workspaceDirs = (): string[] => (vscode.workspace.workspaceFolders ?? [])
    .filter(folder => folder.uri.scheme === "file" || folder.uri.scheme === "vscode-remote").map(folder => folder.uri.fsPath);
  const newSession = async (): Promise<void> => {
    const targets = newSessionTargets(os.homedir());
    if (!targets.length) throw new Error("No supported agent CLI found on PATH (pi, claude, codex, opencode, crush, jcode).");
    const target = await vscode.window.showQuickPick<vscode.QuickPickItem & { target: NewSessionTarget }>(
      targets.map(target => ({ label: target.label, description: target.executable,
        detail: target.piEnvironment ? `PI_CODING_AGENT_DIR=${target.piEnvironment.agentDir}` : undefined, target })),
      { title: "New Session: Select an Agent", placeHolder: "Start a blank session in a new terminal", ignoreFocusOut: true });
    if (!target) return;
    const dirs = workspaceDirs();
    let cwd: string | undefined = dirs[0];
    if (dirs.length > 1) {
      const folder = await vscode.window.showQuickPick<vscode.QuickPickItem & { cwd: string }>(
        dirs.map(dir => ({ label: path.basename(dir) || dir, description: dir, cwd: dir })),
        { title: `New ${target.label} Session: Select a Working Directory`, ignoreFocusOut: true });
      if (!folder) return;
      cwd = folder.cwd;
    }
    launcher.startNew(target.target, cwd);
  };
  let refreshing: Promise<unknown> | undefined;
  const refresh = (): Promise<unknown> => {
    if (!refreshing) refreshing = Promise.resolve(vscode.window.withProgress({ location: { viewId: "sessionHub.sessions" }, title: "Refresh Session Index" }, async () => {
      const result = await hub.refresh();
      await tree.reload();
      view.message = result.errors.length ? redact(`Some sources could not be read: ${result.errors.map(e => `${e.harness}: ${e.message}`).join("; ")}`) : undefined;
      return result;
    })).finally(() => { refreshing = undefined; });
    return refreshing;
  };
  const viewer = new SessionViewer(hub, context.extensionUri, resume, refresh);
  const copyId = async (uid: string): Promise<void> => {
    if (!(await hub.getSessionMetadata(uid))) throw new Error("Session not found.");
    await vscode.env.clipboard.writeText(uid);
  };
  const view = new SessionSidebar(tree, context.extensionUri, { open: uid => viewer.open(uid), resume, copyId });
  const command = (name: string, handler: (value: unknown) => Promise<unknown>): vscode.Disposable =>
    vscode.commands.registerCommand(name, async (value: unknown) => {
      try { return await handler(value); }
      catch (error) { await vscode.window.showErrorMessage(redact(`Session Hub: ${error instanceof Error ? error.message : String(error)}`)); }
    });
  context.subscriptions.push({ dispose: () => hub.close() }, tree, view, viewer,
    vscode.window.registerFileDecorationProvider(tree),
    vscode.window.registerWebviewViewProvider("sessionHub.sessions", view),
    command("sessionHub.search", () => view.toggleSearch()),
    command("sessionHub.refresh", () => refresh()),
    command("sessionHub.newSession", () => newSession()),
    command("sessionHub.open", value => viewer.open(uidFrom(value))),
    command("sessionHub.resume", value => resume(uidFrom(value))),
    command("sessionHub.star", value => tree.setStarred(uidFrom(value), true)),
    command("sessionHub.unstar", value => tree.setStarred(uidFrom(value), false)),
    command("sessionHub.copyId", value => copyId(uidFrom(value))),
    vscode.workspace.onDidChangeWorkspaceFolders(() => tree.rescope()));
  try { await hub.init(); await refresh(); }
  catch (error) {
    view.message = redact(`Could not read the session index: ${error instanceof Error ? error.message : String(error)}`);
    await vscode.window.showErrorMessage(view.message);
  }
}
export function deactivate(): void { service?.close(); service = undefined; }
