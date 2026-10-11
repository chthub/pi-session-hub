/* global acquireVsCodeApi */
"use strict";
(() => {
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  const collapsed = { current: false, unscoped: true, other: true };
  for (const scope of Object.keys(collapsed)) if (typeof saved.collapsed?.[scope] === "boolean") collapsed[scope] = saved.collapsed[scope];
  const groups = document.getElementById("groups"), status = document.getElementById("status");
  const pending = new Map(), busy = new Set();
  let sequence = 0, state, error = "", firstRender = true;
  const save = () => vscode.setState({ collapsed, scrollTop: window.scrollY });
  window.addEventListener("scroll", save, { passive: true });
  function notice() {
    status.textContent = error || state?.status || "";
    status.classList.toggle("error", Boolean(error));
  }
  function request(action, fields = {}) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("扩展响应超时，请重试")); }, 120000);
      pending.set(id, { resolve, reject, timer });
      vscode.postMessage({ type: "sessionHub.sidebar", id, action, ...fields });
    });
  }
  function button(action, text, key, fields) {
    const node = document.createElement("button");
    node.type = "button"; node.textContent = text; node.dataset.action = action; node.dataset.key = key;
    node.disabled = busy.has(key);
    node.addEventListener("click", async event => {
      event.stopPropagation();
      if (busy.has(key)) return;
      error = ""; busy.add(key); render();
      try { await request(action, fields); }
      catch (e) { error = e.message; }
      finally {
        busy.delete(key); render();
        if (document.hasFocus()) Array.from(groups.querySelectorAll("button")).find(b => b.dataset.key === key)?.focus({ preventScroll: true });
      }
    });
    return node;
  }
  function render() {
    notice();
    if (!state) return;
    // A native <details> toggle event is queued. Capture its live state before
    // replacing nodes so an immediate host update cannot undo a user toggle.
    for (const section of groups.querySelectorAll(".group")) collapsed[section.dataset.scope] = !section.open;
    const focusKey = document.activeElement?.dataset.key;
    const scroll = firstRender && Number.isFinite(saved.scrollTop) ? Math.max(0, saved.scrollTop) : window.scrollY;
    firstRender = false;
    const fragment = document.createDocumentFragment();
    for (const group of state.groups) {
      const section = document.createElement("details");
      section.className = "group"; section.dataset.scope = group.scope; section.open = !collapsed[group.scope];
      const summary = document.createElement("summary");
      summary.textContent = group.label;
      const count = document.createElement("span"); count.className = "group-count"; count.textContent = String(group.total);
      summary.append(count); section.append(summary);
      section.addEventListener("toggle", () => { if (section.isConnected) { collapsed[group.scope] = !section.open; save(); } });
      for (const row of group.sessions) {
        const card = document.createElement("article");
        card.className = "session-card"; card.classList.toggle("is-starred", row.starred); card.dataset.uid = row.uid;
        card.dataset.vscodeContext = JSON.stringify({ webviewSection: "session", sessionUid: row.uid, sessionStarred: row.starred, preventDefaultContextMenuItems: true });
        const title = button("open", row.title, row.uid + ":open", { uid: row.uid });
        title.className = "session-title"; title.title = row.title; title.setAttribute("aria-label", "打开会话：" + row.title);
        const meta = document.createElement("div"); meta.className = "session-meta";
        for (const theme of ["light", "dark"]) {
          const icon = document.createElement("img");
          icon.className = "harness-icon icon-" + theme; icon.src = row.icons[theme]; icon.alt = ""; icon.setAttribute("aria-hidden", "true"); meta.append(icon);
        }
        const info = document.createElement("span"); info.className = "session-info";
        info.textContent = row.harnessLabel + " · " + row.recency; info.title = info.textContent; meta.append(info);
        const star = button("star", row.starred ? "★" : "☆", row.uid + ":star", { uid: row.uid, starred: !row.starred });
        star.className = "star-button"; star.title = row.starred ? "取消星标与高亮" : "加星标并高亮";
        star.setAttribute("aria-label", star.title + "：" + row.title); star.setAttribute("aria-pressed", String(row.starred)); meta.append(star);
        card.append(title, meta); section.append(card);
      }
      if (!group.total) { const empty = document.createElement("div"); empty.className = "empty"; empty.textContent = "暂无会话"; section.append(empty); }
      if (group.sessions.length < group.total) {
        const more = button("more", "加载更多（已显示 " + group.sessions.length + " / " + group.total + "）", group.scope + ":more", { scope: group.scope });
        more.className = "more"; section.append(more);
      }
      fragment.append(section);
    }
    groups.replaceChildren(fragment);
    if (focusKey) Array.from(groups.querySelectorAll("button")).find(b => b.dataset.key === focusKey)?.focus({ preventScroll: true });
    window.scrollTo(0, scroll);
  }
  window.addEventListener("message", event => {
    const data = event.data;
    if (data?.type === "sessionHub.sidebar.state") { state = data; render(); }
    else if (data?.type === "sessionHub.sidebar.result") {
      const entry = pending.get(data.id);
      if (!entry) return;
      clearTimeout(entry.timer); pending.delete(data.id);
      if (data.error) entry.reject(new Error(data.error)); else entry.resolve();
    }
  });
  window.addEventListener("pagehide", () => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("侧栏已关闭")); }
    pending.clear();
  });
  request("ready").catch(e => { error = e.message; notice(); });
})();
