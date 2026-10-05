#!/usr/bin/env node
import { createJiti } from "jiti";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log("Usage: pi-session-hub-web [--port 43123] [--no-open]\nLocal, read-only session viewer. Stop with Ctrl+C.\nUse --port 0 to choose an available port.\nBy default, use $BROWSER to ask VS Code/local client to open an external browser.");
} else {
  try {
    let port;
    let open = true;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--no-open") open = false;
      else if (args[i] === "--port" && port === undefined && /^\d+$/.test(args[i + 1] ?? "")) port = Number(args[++i]);
      else throw new Error("Usage: pi-session-hub-web [--port 43123] [--no-open]");
    }
    const jiti = createJiti(import.meta.url);
    const { startWebViewer } = await jiti.import("../src/web/server.ts");
    console.log("Scanning local sessions before starting the viewer…");
    const viewer = await startWebViewer({ port });
    console.log("Session Hub Web Viewer (read-only, localhost only)\n" + viewer.url + "\nKeep this URL private. Stop with Ctrl+C.");
    console.log("VS Code 转发端口可以与远端端口不同；手动打开时使用端口面板的本地地址，再补上上方链接的 #token=…。");
    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.once(signal, () => {
        viewer.close().then(() => process.exit(0), error => { console.error(error.message); process.exit(1); });
      });
    }
    if (open) {
      const { openLocalBrowser } = await jiti.import("../src/web/browser.ts");
      console.log(await openLocalBrowser(viewer.url));
    }
  } catch (error) {
    console.error("Web Viewer: " + error.message);
    process.exitCode = 1;
  }
}
