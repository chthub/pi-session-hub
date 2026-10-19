import * as vscode from "vscode";
import path from "node:path";
import os from "node:os";
import type { SessionDetail } from "../../src/types.ts";
import { renderSessionPdf } from "../../src/web/pdf.ts";
import { saveSessionPdf } from "../../src/web/pdf-file.ts";

/** Destination is selected by the host, never supplied by the webview. */
export async function exportSessionPdf(detail: SessionDetail, extensionUri: vscode.Uri): Promise<{ path: string; fileName: string } | { cancelled: true }> {
  const folders = (vscode.workspace.workspaceFolders ?? [])
    .filter(folder => folder.uri.scheme === "file" || folder.uri.scheme === "vscode-remote");
  let directory: vscode.Uri | undefined;
  if (folders.length === 1) directory = folders[0]!.uri;
  else if (folders.length > 1) directory = (await vscode.window.showWorkspaceFolderPick({
    placeHolder: "Select a workspace folder for the PDF", ignoreFocusOut: true,
  }))?.uri;
  else directory = (await vscode.window.showOpenDialog({
    title: "Choose a folder for the PDF", openLabel: "Export PDF",
    canSelectFiles: false, canSelectFolders: true, canSelectMany: false, defaultUri: vscode.Uri.file(os.homedir()),
  }))?.[0];
  if (!directory) return { cancelled: true };
  if (directory.scheme !== "file" && directory.scheme !== "vscode-remote") throw new Error("PDF export requires a local or Remote SSH folder.");
  const target = directory.fsPath;
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Exporting conversation as PDF…" }, async () => {
    const pdf = await renderSessionPdf(detail, { katexDir: vscode.Uri.joinPath(extensionUri, "dist", "media", "katex").fsPath });
    const file = await saveSessionPdf(target, detail, pdf);
    return { path: file, fileName: path.basename(file) };
  });
}
