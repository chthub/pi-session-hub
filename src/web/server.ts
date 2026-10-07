import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { SessionHubService } from "../core/service.ts";
import { HARNESS_ORDER, type HarnessId } from "../types.ts";
import { sanitize, sessionSummary, viewerDetail } from "./presentation.ts";

const require = createRequire(import.meta.url);
const publicDir = fileURLToPath(new URL("./public/", import.meta.url));
const katexDir = path.join(path.dirname(require.resolve("katex/package.json")), "dist");
const assets = new Map<string, { file: string; type: string }>([
  ["/", { file: path.join(publicDir, "index.html"), type: "text/html; charset=utf-8" }],
  ["/transport.js", { file: path.join(publicDir, "transport.js"), type: "text/javascript; charset=utf-8" }],
  ["/app.js", { file: path.join(publicDir, "app.js"), type: "text/javascript; charset=utf-8" }],
  ["/style.css", { file: path.join(publicDir, "style.css"), type: "text/css; charset=utf-8" }],
  ["/katex/katex.min.css", { file: path.join(katexDir, "katex.min.css"), type: "text/css; charset=utf-8" }],
]);
for (const font of fs.readdirSync(path.join(katexDir, "fonts"))) {
  if (font.endsWith(".woff2")) assets.set(`/katex/fonts/${font}`, { file: path.join(katexDir, "fonts", font), type: "font/woff2" });
}

class RequestError extends Error {}

function integer(value: string | null, fallback: number, maximum: number): number {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value) || Number(value) > maximum) throw new RequestError("分页参数无效");
  return Number(value);
}

// A tunnel may expose a different port on the user's computer. Check the
// literal hostname, not the listener's port; never trust X-Forwarded-* headers.
function isLoopbackAuthority(authority: string): boolean {
  const match = /^(localhost|127\.0\.0\.1|\[::1\])(?::(\d{1,5}))?$/i.exec(authority);
  return Boolean(match && (!match[2] || (Number(match[2]) > 0 && Number(match[2]) <= 65535)));
}

function isLoopbackOrigin(origin: string): boolean {
  const match = /^https?:\/\/([^/]+)$/.exec(origin);
  return Boolean(match && isLoopbackAuthority(match[1]));
}

export async function startWebViewer(options: { home?: string; port?: number } = {}) {
  const home = options.home ?? os.homedir();
  const port = options.port ?? 43123;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("端口必须是 0–65535 的整数");
  const service = new SessionHubService({ home });
  await service.init();
  const token = randomBytes(32).toString("hex");
  const refresh = () => service.refresh();
  const json = (res: http.ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(sanitize(value)));
  };
  let actualPort = port;
  const server = http.createServer((req, res) => {
    void (async () => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; img-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
      // Only literal loopback hosts/origins are accepted, including remapped
      // local ports. Tokens still protect every API, including cross-port calls.
      if (!isLoopbackAuthority(req.headers.host ?? "")) {
        json(res, 403, { error: "请求主机不是本机地址，请使用 VS Code 端口面板中的 localhost 或 127.0.0.1 地址" }); return;
      }
      if (req.headers.origin && !isLoopbackOrigin(req.headers.origin)) {
        json(res, 403, { error: "拒绝非本机来源" }); return;
      }
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${actualPort}`);
      if (!url.pathname.startsWith("/api/")) {
        if (req.method !== "GET") { json(res, 405, { error: "方法不允许" }); return; }
        const asset = assets.get(url.pathname);
        if (!asset) { json(res, 404, { error: "页面不存在" }); return; }
        const content = await fs.promises.readFile(asset.file);
        res.writeHead(200, { "Content-Type": asset.type }); res.end(content); return;
      }
      const auth = Buffer.from(req.headers.authorization ?? "");
      const expected = Buffer.from(`Bearer ${token}`);
      if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
        json(res, 401, { error: "访问令牌无效，请使用启动时显示的完整链接" }); return;
      }
      if (url.pathname === "/api/refresh" && req.method === "POST") {
        json(res, 200, await refresh()); return;
      }
      if (req.method !== "GET") { json(res, 405, { error: "方法不允许" }); return; }
      if (url.pathname === "/api/status") {
        const status = await service.getStatus();
        json(res, 200, { scan: status.scan, harnesses: status.harnesses }); return;
      }
      if (url.pathname === "/api/sessions") {
        const harness = url.searchParams.get("harness");
        if (harness && !HARNESS_ORDER.includes(harness as HarnessId)) { json(res, 400, { error: "未知会话来源" }); return; }
        const limit = integer(url.searchParams.get("limit"), 50, 200);
        const offset = integer(url.searchParams.get("offset"), 0, 1000000);
        const text = url.searchParams.get("q") ?? "";
        if (text.length > 1000 || limit === 0) { json(res, 400, { error: "查询参数无效" }); return; }
        const rows = await service.listSessions({ text, harness: harness as HarnessId | null, limit: limit + 1, offset });
        json(res, 200, { sessions: rows.slice(0, limit).map(sessionSummary), hasMore: rows.length > limit }); return;
      }
      if (url.pathname === "/api/session") {
        // Resolve only an indexed UID. Never accept a caller-supplied filesystem path.
        const detail = await service.getSession(url.searchParams.get("uid") ?? "", { preserveFormatting: true, includeToolActivity: true });
        if (!detail) { json(res, 404, { error: "源会话已消失或无法读取，请刷新索引" }); return; }
        json(res, 200, viewerDetail(detail)); return;
      }
      json(res, 404, { error: "接口不存在" });
    })().catch(error => {
      if (!res.headersSent) json(res, error instanceof RequestError ? 400 : 500, { error: error instanceof Error ? error.message : String(error) });
      else res.end();
    });
  });
  try {
    await refresh();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("无法确定监听端口");
    actualPort = address.port;
  } catch (error) {
    service.close(); throw error;
  }
  let closing: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${actualPort}/#token=${token}`,
    async close() {
      if (!closing) closing = (async () => {
        const stopped = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        server.closeIdleConnections();
        await stopped;
        service.close();
      })();
      return closing;
    },
  };
}
