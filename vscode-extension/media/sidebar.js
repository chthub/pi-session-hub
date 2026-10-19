/* global acquireVsCodeApi */
"use strict";
(() => {
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  const collapsed = { current: false, unscoped: true, other: true };
  for (const scope of Object.keys(collapsed)) if (typeof saved.collapsed?.[scope] === "boolean") collapsed[scope] = saved.collapsed[scope];
  const groups = document.getElementById("groups"), status = document.getElementById("status");
  const search = document.getElementById("search"), scope = document.getElementById("search-scope"), summary = document.getElementById("search-summary");
  const searchPanel = document.getElementById("search-panel");
  let panelOpen = false;
  search.value = typeof saved.text === "string" ? saved.text.slice(0, 2000) : "";
  scope.value = ["user", "conversation", "all"].includes(saved.searchScope) ? saved.searchScope : "user";
  const pending = new Map(), busy = new Set();
  let sequence = 0, state, error = "", firstRender = true, searchVersion = 0, searchTimer, searching = false, showingSearch = false;
  const query = () => ({ text: search.value.trim(), searchScope: scope.value });
  const save = () => vscode.setState({ collapsed, scrollTop: window.scrollY, text: search.value, searchScope: scope.value });
  window.addEventListener("scroll", save, { passive: true });
  function notice() {
    status.textContent = error || state?.status || "";
    status.classList.toggle("error", Boolean(error));
    groups.setAttribute("aria-busy", String(searching));
    for (const more of groups.querySelectorAll('button[data-action="more"]')) more.disabled = searching || busy.has(more.dataset.key);
    const total = state?.groups.reduce((sum, group) => sum + group.total, 0) || 0;
    summary.textContent = searching ? "Searching…" : query().text ? (total ? `${total} ${total === 1 ? "session" : "sessions"} found · local excerpts` : "No matches. Try another query or a wider scope.") : "Search local excerpts, not full transcripts.";
    search.placeholder = scope.value === "user" ? "Search user prompts…" : scope.value === "conversation" ? "Search user + assistant messages…" : "Search all content, including tools…";
  }
  async function runSearch() {
    clearTimeout(searchTimer);
    const version = ++searchVersion;
    searching = true; error = ""; save(); notice();
    try { await request("search", query()); }
    catch (e) { if (version === searchVersion) error = e.message; }
    finally { if (version === searchVersion) { searching = false; notice(); } }
  }
  function scheduleSearch() {
    clearTimeout(searchTimer); searchVersion++; searching = true; error = ""; save(); notice();
    searchTimer = setTimeout(runSearch, 200);
  }
  search.addEventListener("input", event => { if (!event.isComposing) scheduleSearch(); });
  search.addEventListener("compositionstart", () => { clearTimeout(searchTimer); searchVersion++; });
  search.addEventListener("compositionend", scheduleSearch);
  search.addEventListener("keydown", event => {
    if (event.isComposing) return;
    if (event.key === "Enter") { event.preventDefault(); void runSearch(); }
    if (event.key === "Escape") { event.preventDefault(); search.value = ""; void runSearch(); }
  });
  scope.addEventListener("change", () => { void runSearch(); });
  document.getElementById("search-close").addEventListener("click", () => {
    request("closeSearch").catch(e => { error = e.message; notice(); });
  });
  function request(action, fields = {}) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("The extension did not respond. Please try again.")); }, 120000);
      pending.set(id, { resolve, reject, timer });
      vscode.postMessage({ type: "sessionHub.sidebar", id, action, ...fields });
    });
  }
  function button(action, text, key, fields) {
    const node = document.createElement("button");
    node.type = "button"; node.textContent = text; node.dataset.action = action; node.dataset.key = key;
    node.disabled = busy.has(key) || action === "more" && searching;
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
    if (!showingSearch) for (const section of groups.querySelectorAll(".group")) collapsed[section.dataset.scope] = !section.open;
    showingSearch = Boolean(query().text);
    const focusKey = document.activeElement?.dataset.key;
    const scroll = firstRender && Number.isFinite(saved.scrollTop) ? Math.max(0, saved.scrollTop) : window.scrollY;
    firstRender = false;
    const fragment = document.createDocumentFragment();
    for (const group of state.groups) {
      const section = document.createElement("details");
      section.className = "group"; section.dataset.scope = group.scope; section.open = showingSearch || !collapsed[group.scope];
      const summary = document.createElement("summary");
      summary.textContent = group.label;
      const count = document.createElement("span"); count.className = "group-count"; count.textContent = String(group.total);
      summary.append(count); section.append(summary);
      section.addEventListener("toggle", () => { if (section.isConnected && !showingSearch) { collapsed[group.scope] = !section.open; save(); } });
      for (const row of group.sessions) {
        const card = document.createElement("article");
        card.className = "session-card"; card.classList.toggle("is-starred", row.starred); card.dataset.uid = row.uid;
        card.dataset.vscodeContext = JSON.stringify({ webviewSection: "session", sessionUid: row.uid, sessionStarred: row.starred, preventDefaultContextMenuItems: true });
        const title = button("open", row.title, row.uid + ":open", { uid: row.uid });
        title.className = "session-title"; title.title = row.title; title.setAttribute("aria-label", "Open session: " + row.title);
        const meta = document.createElement("div"); meta.className = "session-meta";
        for (const theme of ["light", "dark"]) {
          const icon = document.createElement("img");
          icon.className = "harness-icon icon-" + theme; icon.src = row.icons[theme]; icon.alt = ""; icon.setAttribute("aria-hidden", "true"); meta.append(icon);
        }
        const info = document.createElement("span"); info.className = "session-info";
        info.textContent = row.harnessLabel + " · " + row.recency; info.title = info.textContent; meta.append(info);
        const star = button("star", row.starred ? "★" : "☆", row.uid + ":star", { uid: row.uid, starred: !row.starred });
        star.className = "star-button"; star.title = row.starred ? "Unstar session" : "Star session";
        star.setAttribute("aria-label", star.title + ": " + row.title); star.setAttribute("aria-pressed", String(row.starred)); meta.append(star);
        card.addEventListener("click", event => {
          if (event.button === 0 && !event.target.closest("button")) title.click();
        });
        card.append(title, meta); section.append(card);
      }
      if (!group.total) { const empty = document.createElement("div"); empty.className = "empty"; empty.textContent = showingSearch ? "No matching sessions" : "No sessions yet"; section.append(empty); }
      if (group.sessions.length < group.total) {
        const more = button("more", "Load more (" + group.sessions.length + " of " + group.total + ")", group.scope + ":more", { scope: group.scope });
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
    if (data?.type === "sessionHub.sidebar.state") {
      const incoming = data.search || { text: "", searchScope: "user" };
      const opening = !panelOpen && data.searchOpen === true;
      if (typeof data.searchOpen === "boolean") {
        panelOpen = data.searchOpen;
        searchPanel.hidden = !panelOpen;
        if (!panelOpen) {
          clearTimeout(searchTimer); searchVersion++; searching = false;
          search.value = ""; scope.value = incoming.searchScope; save();
        }
      }
      if (opening) search.focus({ preventScroll: true });
      const current = query();
      if (incoming.text !== current.text || incoming.searchScope !== current.searchScope) return;
      state = data; render();
    }
    else if (data?.type === "sessionHub.sidebar.result") {
      const entry = pending.get(data.id);
      if (!entry) return;
      clearTimeout(entry.timer); pending.delete(data.id);
      if (data.error) entry.reject(new Error(data.error)); else entry.resolve();
    }
  });
  window.addEventListener("pagehide", () => {
    clearTimeout(searchTimer); searchVersion++;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("The sidebar was closed")); }
    pending.clear();
  });
  notice();
  request("ready").then(() => runSearch()).catch(e => { error = e.message; notice(); });
})();
