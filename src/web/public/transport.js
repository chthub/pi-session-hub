"use strict";
// Only this boundary knows which host is displaying the shared reader.
(() => {
  class HttpTransport {
    constructor() {
      const incoming = new URLSearchParams(location.hash.slice(1)).get("token");
      if (incoming) {
        sessionStorage.setItem("session-hub-token", incoming);
        history.replaceState(null, "", location.pathname + location.search);
      }
      this.token = sessionStorage.getItem("session-hub-token");
      this.hasSessionList = true;
      this.initialUid = null;
      this.sessionActions = [];
    }
    async request(path, method = "GET") {
      if (!this.token) throw new Error("请使用启动时显示的完整链接（包含访问令牌）。");
      const response = await fetch(path, { method, headers: { Authorization: `Bearer ${this.token}` }, cache: "no-store", credentials: "omit" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? `请求失败：${response.status}`);
      return data;
    }
    status() { return this.request("/api/status"); }
    listSessions(query) { return this.request(`/api/sessions?${new URLSearchParams(query)}`); }
    getSession(uid) { return this.request(`/api/session?${new URLSearchParams({ uid })}`); }
    refresh() { return this.request("/api/refresh", "POST"); }
  }
  class VscodeTransport {
    constructor() {
      this.vscode = acquireVsCodeApi();
      this.pending = new Map();
      this.sequence = 0;
      this.hasSessionList = false;
      this.initialUid = document.body.dataset.sessionUid;
      this.sessionActions = [
        { label: "在终端中继续", icon: "▶", className: "primary-button resume-button", run: uid => this.request("resume", uid) },
        { label: "复制会话 ID", run: uid => this.request("copyId", uid) },
      ];
      window.addEventListener("message", event => {
        const message = event.data;
        if (message?.type !== "sessionHub.response" || !Number.isSafeInteger(message.id)) return;
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timeout);
        if (typeof message.error === "string") pending.reject(new Error(message.error));
        else pending.resolve(message.result);
      });
      window.addEventListener("pagehide", () => {
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timeout);
          pending.reject(new Error("会话页面已关闭"));
        }
        this.pending.clear();
      });
    }
    request(operation, uid) {
      const id = ++this.sequence;
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { this.pending.delete(id); reject(new Error("扩展响应超时，请重新打开会话")); }, 120000);
        this.pending.set(id, { resolve, reject, timeout });
        this.vscode.postMessage({ type: "sessionHub.request", id, operation, ...(uid ? { uid } : {}) });
      });
    }
    status() { return this.request("status"); }
    getSession(uid) { return this.request("getSession", uid); }
    refresh() { return this.request("refresh"); }
  }
  window.sessionHubTransport = document.body.dataset.host === "vscode" ? new VscodeTransport() : new HttpTransport();
})();
