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
  const SVG_NS = "http://www.w3.org/2000/svg";
  function svg(className, markup) {
    // Static, trusted markup only; never pass session data here.
    const node = document.createElementNS(SVG_NS, "svg");
    node.setAttribute("viewBox", "0 0 16 16"); node.setAttribute("aria-hidden", "true");
    if (className) node.setAttribute("class", className);
    node.innerHTML = markup; return node;
  }
  /** "3 minutes ago" -> "3m", "2 days ago" -> "2d", this year's "2026-10-15" -> "10-15". Full text stays in the tooltip. */
  function compactRecency(text) {
    if (text === "Just now") return "now";
    const ago = /^(\d+) (minute|hour|day)s? ago$/.exec(text);
    if (ago) return ago[1] + ago[2][0];
    const date = /^(\d{4})-(\d\d-\d\d)$/.exec(text);
    if (date && Number(date[1]) === new Date().getFullYear()) return date[2];
    return text;
  }
  const textCanvas = document.createElement("canvas");
  const textMetrics = textCanvas.getContext("2d", { willReadFrequently: true });
  const inkAscents = new Map();
  let alignmentFrame;
  function alignIconTops() {
    if (!textMetrics) return;
    // A zero-height inline marker locates the *real* text baseline, including
    // Chromium's button layout and the user's font. An em-box inset cannot do that.
    const entries = Array.from(groups.querySelectorAll(".session-title"))
      .filter(title => title.getClientRects().length)
      .map(title => {
        const marker = document.createElement("span");
        marker.className = "title-baseline"; marker.setAttribute("aria-hidden", "true"); title.prepend(marker);
        return { title, marker, slot: title.closest(".session-card").querySelector(".harness-icon-slot") };
      });
    // Batch layout reads before writes; moving artwork must not change row height.
    const offsets = entries.map(({ title, marker, slot }) => {
      const style = getComputedStyle(title);
      const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const text = title.textContent.replace(/\s+/g, " ").trim() || "Ag";
      const baseline = marker.getBoundingClientRect().top, scale = window.devicePixelRatio || 1;
      const fraction = baseline * scale - Math.floor(baseline * scale);
      const left = title.getBoundingClientRect().left * scale;
      const xFraction = left - Math.floor(left);
      const width = Math.max(1, Math.ceil(title.clientWidth * scale) + 1);
      const key = JSON.stringify([font, text, width, scale, fraction, xFraction]);
      let ascent = inkAscents.get(key);
      if (ascent === undefined) {
        textMetrics.font = font;
        const localBaseline = Math.ceil(textMetrics.measureText(text).actualBoundingBoxAscent + 2) + fraction / scale;
        textCanvas.width = width;
        textCanvas.height = Math.ceil((localBaseline + parseFloat(style.fontSize) + 2) * scale);
        textMetrics.setTransform(scale, 0, 0, scale, 0, 0);
        textMetrics.font = font; textMetrics.textBaseline = "alphabetic"; textMetrics.fillStyle = "#fff";
        textMetrics.fillText(text, xFraction / scale, localBaseline);
        // Font outlines still differ from painted pixels because of hinting.
        // Scan the actual raster, ignoring nearly transparent antialias fringes.
        const pixels = textMetrics.getImageData(0, 0, width, textCanvas.height).data;
        let first = 0;
        while (first < width * textCanvas.height && pixels[first * 4 + 3] < 64) first++;
        ascent = first < width * textCanvas.height ? localBaseline - Math.floor(first / width) / scale : 0;
        if (inkAscents.size >= 512) inkAscents.clear();
        inkAscents.set(key, ascent);
      }
      const opticalY = parseFloat(getComputedStyle(slot).getPropertyValue("--harness-icon-optical-y")) || 0;
      const top = baseline - ascent + opticalY;
      // Snap the final optical position too, so fractional display scaling does
      // not blur pixel-art marks or shift their first visible row unpredictably.
      return Math.round(top * scale) / scale - slot.getBoundingClientRect().top;
    });
    entries.forEach(({ marker, slot }, index) => {
      marker.remove(); slot.style.setProperty("--harness-icon-top", offsets[index] + "px");
    });
  }
  function scheduleIconAlignment() {
    cancelAnimationFrame(alignmentFrame);
    alignmentFrame = requestAnimationFrame(alignIconTops);
  }
  window.addEventListener("resize", scheduleIconAlignment);
  groups.addEventListener("toggle", scheduleIconAlignment, true);
  document.fonts.ready.then(scheduleIconAlignment);
  document.fonts.addEventListener("loadingdone", () => { inkAscents.clear(); scheduleIconAlignment(); });
  const fontChanges = new MutationObserver(scheduleIconAlignment);
  for (const node of [document.documentElement, document.body]) fontChanges.observe(node, { attributes: true, attributeFilter: ["class", "style"] });
  fontChanges.observe(document.head, { childList: true, characterData: true, subtree: true });
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
    const compact = state.density === "compact";
    document.body.dataset.density = compact ? "compact" : "comfortable";
    const fragment = document.createDocumentFragment();
    for (const group of state.groups) {
      const section = document.createElement("details");
      section.className = "group"; section.dataset.scope = group.scope; section.open = showingSearch || !collapsed[group.scope];
      const summary = document.createElement("summary");
      summary.append(svg("group-chevron", '<path d="m4.5 6 3.5 3.5L11.5 6"/>'));
      const label = document.createElement("span"); label.className = "group-label"; label.textContent = group.label;
      const count = document.createElement("span"); count.className = "group-count"; count.textContent = String(group.total);
      summary.append(label, count); section.append(summary);
      section.addEventListener("toggle", () => { if (section.isConnected && !showingSearch) { collapsed[group.scope] = !section.open; save(); } });
      for (const row of group.sessions) {
        const card = document.createElement("article");
        card.className = "session-card"; card.classList.toggle("is-starred", row.starred); card.dataset.uid = row.uid;
        card.title = row.title + "\n" + row.harnessLabel + " · " + row.recency;
        card.dataset.vscodeContext = JSON.stringify({ webviewSection: "session", sessionUid: row.uid, sessionStarred: row.starred, preventDefaultContextMenuItems: true });
        const iconSlot = document.createElement("span");
        iconSlot.className = "harness-icon-slot"; iconSlot.dataset.harness = row.harness; iconSlot.setAttribute("aria-hidden", "true");
        for (const theme of ["light", "dark"]) {
          const icon = document.createElement("img");
          icon.className = "harness-icon icon-" + theme; icon.src = row.icons[theme]; icon.alt = ""; iconSlot.append(icon);
        }
        card.append(iconSlot);
        const title = button("open", row.title, row.uid + ":open", { uid: row.uid });
        title.className = "session-title"; title.setAttribute("aria-label", "Open session: " + row.title + ", " + row.harnessLabel + ", " + row.recency);
        const time = document.createElement("time"); time.className = "session-time"; time.textContent = compact ? compactRecency(row.recency) : row.recency;
        const star = button("star", "", row.uid + ":star", { uid: row.uid, starred: !row.starred });
        star.className = "star-button"; star.title = row.starred ? "Unstar session" : "Star session";
        star.append(svg("", '<path d="M8 1.8l1.85 3.95 4.3.5-3.18 2.95.84 4.25L8 11.3l-3.81 2.15.84-4.25L1.85 6.25l4.3-.5z"/>'));
        star.setAttribute("aria-label", star.title + ": " + row.title); star.setAttribute("aria-pressed", String(row.starred));
        card.append(title, time, star);
        card.addEventListener("click", event => {
          if (event.button === 0 && !event.target.closest("button")) title.click();
        });
        section.append(card);
      }
      if (!group.total) { const empty = document.createElement("div"); empty.className = "empty"; empty.textContent = showingSearch ? "No matching sessions" : "No sessions yet"; section.append(empty); }
      if (group.sessions.length < group.total) {
        const more = button("more", "Load more (" + group.sessions.length + " of " + group.total + ")", group.scope + ":more", { scope: group.scope });
        more.className = "more"; section.append(more);
      }
      fragment.append(section);
    }
    groups.replaceChildren(fragment);
    alignIconTops();
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
    cancelAnimationFrame(alignmentFrame); fontChanges.disconnect();
    clearTimeout(searchTimer); searchVersion++;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("The sidebar was closed")); }
    pending.clear();
  });
  notice();
  request("ready").then(() => runSearch()).catch(e => { error = e.message; notice(); });
})();
