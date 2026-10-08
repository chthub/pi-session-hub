import * as vscode from "vscode";
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import type { SessionHubService } from "../../src/core/service.ts";
import { sanitize, viewerDetail } from "../../src/web/presentation.ts";
import { redact } from "../../src/security.ts";
import { parseViewerRequest, type ViewerResponse } from "./protocol.ts";
import { sessionTabTitle } from "./sessionTitle.ts";
import { SessionLinks } from "./sessionLinks.ts";

function escapeAttribute(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

/** Generate from the SAME template/assets as the standalone reader. */
export function viewerHtml(template: string, uid: string, cspSource: string, nonce: string, resource: (file: string) => string): string {
  const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src ${cspSource} 'unsafe-inline'; font-src ${cspSource}; img-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'`;
  return template.replace("<head>", `<head>\n  <meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}">`)
    .replace("<body>", `<body data-host="vscode" data-session-uid="${escapeAttribute(uid)}">`)
    .replace(/href="\/(katex\/katex.min.css|style.css)"/g, (_match, file: string) => `href="${escapeAttribute(resource(file))}"`)
    .replace(/<script src="\/(transport.js|app.js)" defer><\/script>/g, (_match, file: string) =>
      `<script nonce="${nonce}" src="${escapeAttribute(resource(file))}" defer></script>`);
}

export class SessionViewer implements vscode.Disposable {
  private readonly panels = new Map<string, vscode.WebviewPanel>();
  constructor(private readonly service: SessionHubService, private readonly extensionUri: vscode.Uri,
    private readonly resume: (uid: string) => Promise<void>, private readonly refresh: () => Promise<unknown>) {}

  async open(uid: string): Promise<void> {
    const existing = this.panels.get(uid);
    if (existing) { existing.reveal(); return; }
    const session = await this.service.getSessionMetadata(uid);
    if (!session) throw new Error("会话不存在，请刷新索引");
    // Re-check after the await: simultaneous opens must not create duplicate tabs.
    const concurrent = this.panels.get(uid);
    if (concurrent) { concurrent.reveal(); return; }
    const media = vscode.Uri.joinPath(this.extensionUri, "dist", "media");
    const panel = vscode.window.createWebviewPanel("sessionHub.viewer", sessionTabTitle(session.title, session.nativeId),
      vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [media] });
    this.panels.set(uid, panel);
    const disposables: vscode.Disposable[] = [];
    let links = new SessionLinks(null);
    disposables.push(panel.webview.onDidReceiveMessage(async (value: unknown) => {
      const id = value && typeof value === "object" ? (value as { id?: unknown }).id : undefined;
      if (!Number.isSafeInteger(id) || Number(id) < 1) return;
      const response: ViewerResponse = { type: "sessionHub.response", id: Number(id) };
      try {
        const request = parseViewerRequest(value, uid);
        switch (request.operation) {
          case "status": {
            const status = await this.service.getStatus();
            response.result = { scan: status.scan ?? { total: status.total, errors: [] }, harnesses: status.harnesses };
            break;
          }
          case "getSession": {
            const detail = await this.service.getSession(uid, { preserveFormatting: true, includeToolActivity: true });
            if (!detail) throw new Error("源会话已消失或无法读取");
            const nextLinks = new SessionLinks(detail.cwd);
            response.result = viewerDetail(detail, { localLink: href => nextLinks.register(href) });
            links = nextLinks;
            break;
          }
          case "openLink": {
            const target = links.resolve(request.linkId!);
            await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(target.path).with({ fragment: target.fragment }));
            response.result = { ok: true };
            break;
          }
          case "refresh": response.result = await this.refresh(); break;
          case "resume": await this.resume(uid); response.result = { ok: true }; break;
          case "copyId": {
            if (!(await this.service.getSessionMetadata(uid))) throw new Error("会话不存在");
            await vscode.env.clipboard.writeText(uid);
            response.result = { ok: true };
            break;
          }
        }
      } catch (error) { response.error = redact(error instanceof Error ? error.message : String(error)); }
      await panel.webview.postMessage(sanitize(response));
    }));
    panel.onDidDispose(() => {
      this.panels.delete(uid);
      for (const disposable of disposables) disposable.dispose();
    });
    try {
      const template = fs.readFileSync(vscode.Uri.joinPath(media, "index.html").fsPath, "utf8");
      panel.webview.html = viewerHtml(template, uid, panel.webview.cspSource, randomBytes(24).toString("hex"),
        file => panel.webview.asWebviewUri(vscode.Uri.joinPath(media, file)).toString());
    } catch (error) { panel.dispose(); throw error; }
  }

  dispose(): void {
    for (const panel of [...this.panels.values()]) panel.dispose();
    this.panels.clear();
  }
}
