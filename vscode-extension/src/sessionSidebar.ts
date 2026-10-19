import * as vscode from "vscode";
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { redact } from "../../src/security.ts";
import type { SearchScope } from "../../src/types.ts";
import type { SessionTree } from "./sessionTree.ts";
import type { ProjectScope } from "./projectScope.ts";

const PAGE_SIZE = 100;
const SCOPES = ["current", "unscoped", "other"] as const;
type SidebarAction = "ready" | "search" | "closeSearch" | "more" | "open" | "star" | "resume" | "copyId";
interface SidebarRequest { type: "sessionHub.sidebar"; id: number; action: SidebarAction; uid?: string; starred?: boolean; scope?: ProjectScope; text?: string; searchScope?: SearchScope }

function parseRequest(value: unknown): SidebarRequest {
  if (!value || typeof value !== "object") throw new Error("Invalid sidebar request");
  const r = value as Record<string, unknown>;
  if (r.type !== "sessionHub.sidebar" || !Number.isSafeInteger(r.id) || Number(r.id) < 1) throw new Error("Invalid sidebar request");
  const keys = ["type", "id", "action"];
  switch (r.action) {
    case "ready": case "closeSearch": break;
    case "search":
      keys.push("text", "searchScope");
      if (typeof r.text !== "string" || r.text.length > 2000) throw new Error("Invalid search query (maximum 2,000 characters)");
      if (!["user", "conversation", "all"].includes(r.searchScope as string)) throw new Error("Unknown search scope");
      break;
    case "more":
      keys.push("scope");
      if (!SCOPES.includes(r.scope as ProjectScope)) throw new Error("Unknown project group");
      break;
    case "star":
      keys.push("starred");
      if (typeof r.starred !== "boolean") throw new Error("Invalid star state");
      // falls through: star requests must also identify a known UID.
    case "open": case "resume": case "copyId":
      keys.push("uid");
      if (typeof r.uid !== "string" || !r.uid || r.uid.length > 2000) throw new Error("Invalid session ID");
      break;
    default: throw new Error("Unknown sidebar action");
  }
  if (Object.keys(r).some(key => !keys.includes(key))) throw new Error("Sidebar request contains unexpected fields");
  return r as unknown as SidebarRequest;
}

function sidebarDensity(): "comfortable" | "compact" {
  return vscode.workspace.getConfiguration("sessionHub.sidebar").get("density") === "compact" ? "compact" : "comfortable";
}

function escapeAttribute(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

/** The sidebar is a view, not an editor tab or an HTTP server. Its only inputs
 * are validated UIDs/actions and bounded search queries; paths and arbitrary
 * commands never cross the API. */
export class SessionSidebar implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private ready = false;
  private searchOpen = false;
  private status: string | undefined = "Loading session index…";
  private readonly limits: Record<ProjectScope, number> = { current: PAGE_SIZE, unscoped: PAGE_SIZE, other: PAGE_SIZE };
  private viewDisposables: vscode.Disposable[] = [];
  private readonly changed: vscode.Disposable[];
  constructor(private readonly tree: SessionTree, private readonly extensionUri: vscode.Uri,
    private readonly actions: { open: (uid: string) => Promise<void>; resume: (uid: string) => Promise<void>; copyId: (uid: string) => Promise<void> }) {
    this.changed = [tree.onDidChangeTreeData(() => this.publish()),
      vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration("sessionHub.sidebar.density")) this.publish(); })];
  }

  set message(value: string | undefined) { this.status = value; this.publish(); }
  get message(): string | undefined { return this.status; }

  async toggleSearch(): Promise<void> {
    if (!this.view) await vscode.commands.executeCommand("sessionHub.sessions.focus");
    this.view?.show(true);
    this.searchOpen = !this.searchOpen;
    if (!this.searchOpen) await this.clearSearch();
    else this.publish();
  }

  private async clearSearch(): Promise<void> {
    for (const scope of SCOPES) this.limits[scope] = PAGE_SIZE;
    await this.tree.setSearch("", this.tree.sidebarSearch.searchScope);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.releaseView();
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, "media");
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    this.viewDisposables.push(view.webview.onDidReceiveMessage(async (value: unknown) => {
      const id = value && typeof value === "object" ? (value as { id?: unknown }).id : undefined;
      if (!Number.isSafeInteger(id) || Number(id) < 1) return;
      const response: { type: string; id: number; error?: string } = { type: "sessionHub.sidebar.result", id: Number(id) };
      try {
        const request = parseRequest(value);
        if (request.uid && !this.tree.hasSession(request.uid)) throw new Error("Session not found. Refresh and try again.");
        switch (request.action) {
          case "ready": this.ready = true; this.publish(); break;
          case "closeSearch": this.searchOpen = false; await this.clearSearch(); break;
          case "search":
            for (const scope of SCOPES) this.limits[scope] = PAGE_SIZE;
            await this.tree.setSearch(request.text!, request.searchScope!);
            break;
          case "more": this.limits[request.scope!] += PAGE_SIZE; this.publish(); break;
          case "star": await this.tree.setStarred(request.uid!, request.starred!); break;
          case "open": await this.actions.open(request.uid!); break;
          case "resume": await this.actions.resume(request.uid!); break;
          case "copyId": await this.actions.copyId(request.uid!); break;
        }
      } catch (error) { response.error = redact(error instanceof Error ? error.message : String(error)); }
      if (this.view === view) await view.webview.postMessage(response);
    }), view.onDidDispose(() => { if (this.view === view) this.releaseView(); }));
    const nonce = randomBytes(24).toString("hex");
    const resource = (file: string) => escapeAttribute(view.webview.asWebviewUri(vscode.Uri.joinPath(media, file)).toString());
    const source = escapeAttribute(view.webview.cspSource);
    view.webview.html = fs.readFileSync(vscode.Uri.joinPath(media, "sidebar.html").fsPath, "utf8")
      .replaceAll("{{cspSource}}", source).replaceAll("{{nonce}}", nonce)
      .replace("{{style}}", resource("sidebar.css")).replace("{{script}}", resource("sidebar.js"));
  }

  private publish(): void {
    const view = this.view;
    if (!view || !this.ready) return;
    const groups = this.tree.sidebarGroups(this.limits).map(group => ({ ...group,
      sessions: group.sessions.map(row => ({ ...row, icons: {
        light: view.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "harness", "light", `${row.harness}.svg`)).toString(),
        dark: view.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "harness", "dark", `${row.harness}.svg`)).toString(),
      } })),
    }));
    void Promise.resolve(view.webview.postMessage({ type: "sessionHub.sidebar.state", groups, search: this.tree.sidebarSearch, searchOpen: this.searchOpen, density: sidebarDensity(), status: this.status ? redact(this.status) : "" })).catch(() => {});
  }
  private releaseView(): void {
    this.view = undefined; this.ready = false;
    for (const disposable of this.viewDisposables.splice(0)) disposable.dispose();
  }
  dispose(): void { for (const disposable of this.changed) disposable.dispose(); this.releaseView(); }
}
