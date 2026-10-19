"use strict";
const $ = id => document.getElementById(id);
const transport = window.sessionHubTransport;
const { t, locale } = window.sessionHubLocale;
const harnessLabels = { pi: "Pi", "claude-code": "Claude Code", codex: "Codex", opencode: "OpenCode", crush: "Crush", jcode: "JCode" };
let sessions = [];
let selected = null;
let detail = null;
let raw = false;
let listVersion = 0;
let detailVersion = 0;
let timer;
let users = [];
let positions = [];
let activeUser = null;
let outlineButtons = new Map();
let resizeObserver;
let measureFrame;
let scrollFrame;
let exportingPdf = false;
// Steps match Chrome's Ctrl+wheel zoom levels.
const zoomLevels = [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200];
let zoom = readZoom();

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function button(text, action, className) {
  const node = element("button", text, className);
  node.type = "button";
  node.addEventListener("click", action);
  return node;
}
function preview(text, length = 150) {
  const flat = text.replace(/<[^>]*>/g, " ").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/^[#>\s]+/, "").replace(/[*`]/g, "").replace(/\s+/g, " ").trim();
  return flat.length > length ? flat.slice(0, length) + "…" : flat;
}
function projectName(value) { return value?.split(/[\\/]/).filter(Boolean).pop() || t("未记录项目", "Project not recorded"); }
function dateLabel(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return t("时间未知", "Unknown time");
  return new Intl.DateTimeFormat(locale, { month: "2-digit", day: "2-digit" }).format(date);
}
function notice(text, error = false) {
  $("notice").textContent = text;
  $("notice").title = text;
  $("notice").classList.toggle("error", error);
}
async function loadStatus() {
  const data = await transport.status();
  const warnings = data.scan.errors.map(item => `${item.harness}: ${item.message}`).join(t("；", "; "));
  notice(t(`已连接 · ${data.scan.total} 条本机会话 · 正文不会上传${warnings ? " · 部分来源读取失败：" + warnings : ""}`, `Connected · ${data.scan.total} local sessions · Transcript stays local${warnings ? " · Some sources could not be read: " + warnings : ""}`), Boolean(warnings));
}
function setSidebar(open) {
  document.body.dataset.sidebar = open ? "open" : "closed";
  $("sidebar-toggle").setAttribute("aria-expanded", String(open));
  $("sidebar-backdrop").hidden = !open;
  if (open) $("search").focus();
}
function renderList(revealSelection = false) {
  const fragment = document.createDocumentFragment();
  for (const session of sessions) {
    const row = button(undefined, () => openSession(session.uid), "session");
    row.setAttribute("aria-current", String(session.uid === selected));
    row.title = session.title || session.preview || session.uid;
    const topline = element("span", undefined, "session-topline");
    topline.append(element("span", harnessLabels[session.harness] || session.harness, "harness-badge"), element("span", dateLabel(session.updatedAt)));
    row.append(topline, element("strong", preview(session.title || session.preview || session.uid, 220), "session-title"));
    const project = element("span", projectName(session.repo), "session-project");
    project.title = session.repo || t("未记录项目", "Project not recorded");
    row.append(project, element("span", `${t(`${session.messageCount} 条消息`, `${session.messageCount} messages`)}${session.model ? " · " + session.model : ""}`, "session-meta"));
    fragment.append(row);
  }
  $("sessions").replaceChildren(fragment);
  if (revealSelection) revealInPanel(document.querySelector('.session[aria-current="true"]'), document.querySelector(".session-scroll"));
}
async function loadList(append = false) {
  const version = ++listVersion;
  $("more").disabled = true;
  $("list-status").textContent = t("正在搜索…", "Searching…");
  const query = { q: $("search").value, harness: $("harness").value, limit: "50", offset: String(append ? sessions.length : 0) };
  try {
    const result = await transport.listSessions(query);
    if (version !== listVersion) return;
    sessions = append ? sessions.concat(result.sessions) : result.sessions;
    renderList();
    $("list-status").textContent = sessions.length ? t(`已显示 ${sessions.length} 条${result.hasMore ? " · 还有更多" : ""}`, `${sessions.length} shown${result.hasMore ? " · More available" : ""}`) : t("没有匹配的会话，试试其他关键词", "No matching sessions. Try different keywords.");
    $("more").hidden = !result.hasMore;
  } catch (error) {
    if (version !== listVersion) return;
    $("list-status").textContent = t(`搜索失败：${error.message}`, `Search failed: ${error.message}`);
    $("more").hidden = true;
  } finally {
    if (version === listVersion) $("more").disabled = false;
  }
}

function clearOutline(message = t("选择会话后显示目录", "Select a session to show its outline")) {
  resizeObserver?.disconnect();
  cancelAnimationFrame(measureFrame);
  cancelAnimationFrame(scrollFrame);
  users = [];
  positions = [];
  activeUser = null;
  outlineButtons.clear();
  $("outline-items").replaceChildren();
  $("outline-count").textContent = "0";
  $("outline-status").textContent = message;
  $("outline-position").textContent = t("尚未定位", "No position selected");
  $("outline-filter").disabled = true;
  $("previous-user").disabled = true;
  $("next-user").disabled = true;
}
function renderOutline() {
  outlineButtons = new Map();
  const query = $("outline-filter").value.trim().toLocaleLowerCase();
  const filtered = users.filter(user => user.text.toLocaleLowerCase().includes(query));
  const fragment = document.createDocumentFragment();
  for (const user of filtered) {
    const row = button(undefined, () => jumpToUser(user.id), "outline-item");
    row.dataset.target = user.id;
    row.title = t(`第 ${user.ordinal} 条用户消息 · 对话消息 #${user.index + 1}\n${preview(user.text, 600)}`, `User message ${user.ordinal} · Transcript message #${user.index + 1}\n${preview(user.text, 600)}`);
    row.setAttribute("aria-label", t(`第 ${user.ordinal} 条用户消息：${preview(user.text)}`, `User message ${user.ordinal}: ${preview(user.text)}`));
    row.append(element("span", String(user.ordinal).padStart(2, "0"), "outline-number"), element("span", preview(user.text) || t("空白用户消息", "Empty user message"), "outline-text"));
    if (user.id === activeUser) row.setAttribute("aria-current", "location");
    outlineButtons.set(user.id, row);
    fragment.append(row);
  }
  if (!filtered.length) fragment.append(element("p", users.length ? t("没有匹配的提问，试试其他关键词。", "No matching questions. Try different keywords.") : t("这个会话没有可恢复的用户消息。", "No recoverable user messages in this session."), "outline-empty"));
  $("outline-items").replaceChildren(fragment);
  $("outline-status").textContent = users.length ? (query ? t(`找到 ${filtered.length} / ${users.length} 条用户消息`, `${filtered.length} / ${users.length} user messages found`) : t(`${users.length} 次提问 · 点击即可跳转`, `${users.length} questions · Click to jump`)) : t("仅列出来源中可恢复的用户消息", "Only recoverable user messages are listed");
}
function revealInPanel(row, panel) {
  if (!row || !panel.clientHeight) return;
  const rect = row.getBoundingClientRect();
  const bounds = panel.getBoundingClientRect();
  if (rect.top < bounds.top) panel.scrollTop += rect.top - bounds.top - 8;
  else if (rect.bottom > bounds.bottom) panel.scrollTop += rect.bottom - bounds.bottom + 8;
}
function setActiveUser(id, reveal = true) {
  const changed = id !== activeUser;
  if (changed && activeUser) {
    outlineButtons.get(activeUser)?.removeAttribute("aria-current");
    $(activeUser)?.removeAttribute("data-current");
  }
  activeUser = id;
  const row = outlineButtons.get(id);
  row?.setAttribute("aria-current", "location");
  if (id) $(id)?.setAttribute("data-current", "true");
  const index = users.findIndex(user => user.id === id);
  $("outline-position").textContent = index >= 0 ? t(`第 ${index + 1} / ${users.length} 条用户消息`, `User message ${index + 1} / ${users.length}`) : t("没有用户消息", "No user messages");
  $("previous-user").disabled = index <= 0;
  $("next-user").disabled = index < 0 || index >= users.length - 1;
  if (changed && reveal) revealInPanel(row, $("outline-items"));
}
function toolbarHeight() { return document.querySelector(".transcript-toolbar")?.getBoundingClientRect().height || 0; }
function trackReadingPosition() {
  if (!positions.length) return;
  const viewer = $("viewer");
  if (viewer.scrollTop > 0 && viewer.scrollTop + viewer.clientHeight >= viewer.scrollHeight - 2) {
    setActiveUser(positions[positions.length - 1].id);
    return;
  }
  const cursor = viewer.scrollTop + toolbarHeight() + 24;
  let low = 0, high = positions.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (positions[mid].top <= cursor) low = mid;
    else high = mid - 1;
  }
  setActiveUser(positions[low].id);
}
function measurePositions() {
  const viewer = $("viewer");
  const top = viewer.getBoundingClientRect().top;
  positions = users.map(user => ({ id: user.id, top: $(user.id).getBoundingClientRect().top - top + viewer.scrollTop }));
  trackReadingPosition();
}
function scheduleMeasure() {
  cancelAnimationFrame(measureFrame);
  measureFrame = requestAnimationFrame(measurePositions);
}
function jumpToUser(id) {
  const node = $(id);
  if (!node) return;
  const viewer = $("viewer");
  const top = node.getBoundingClientRect().top - viewer.getBoundingClientRect().top + viewer.scrollTop - toolbarHeight() - 16;
  viewer.scrollTo({ top: Math.max(0, top), behavior: "instant" });
  node.focus({ preventScroll: true });
  setActiveUser(id);
}
function captureReadingPosition() {
  const top = $("viewer").getBoundingClientRect().top + toolbarHeight();
  const node = Array.from(document.querySelectorAll(".message")).find(item => item.getBoundingClientRect().bottom > top);
  return node ? { id: node.id, offset: node.getBoundingClientRect().top - $("viewer").getBoundingClientRect().top } : null;
}
function restoreReadingPosition(reading) {
  const node = reading && $(reading.id);
  if (node) $("viewer").scrollTop += node.getBoundingClientRect().top - $("viewer").getBoundingClientRect().top - reading.offset;
}
function readZoom() {
  try {
    const value = Number(localStorage.getItem("session-hub-zoom"));
    return zoomLevels.includes(value) ? value : 100;
  } catch { return 100; }
}
function updateZoomControls() {
  $("zoom-level").textContent = `${zoom}%`;
  $("zoom-out").disabled = zoom === zoomLevels[0];
  $("zoom-in").disabled = zoom === zoomLevels[zoomLevels.length - 1];
}
function setZoom(value) {
  if (value === zoom) return;
  const reading = captureReadingPosition();
  zoom = value;
  try { localStorage.setItem("session-hub-zoom", String(zoom)); } catch {}
  $("transcript-messages").style.zoom = String(zoom / 100);
  updateZoomControls();
  restoreReadingPosition(reading);
  scheduleMeasure();
}
function stepZoom(direction) {
  const index = zoomLevels.indexOf(zoom) + direction;
  if (index >= 0 && index < zoomLevels.length) setZoom(zoomLevels[index]);
}
function isToolMessage(message) { return /tool|function/i.test(message.role); }
function isToolCall(message) { return /^(toolCall|tool_call|tool_use|function_call|custom_tool_call)$/i.test(message.role); }
function renderMessageBody(message) {
  const body = element(raw ? "pre" : "div", undefined, raw ? "raw" : "message-body");
  if (raw) body.textContent = message.text;
  else {
    // Only server-rendered, HTML-disabled Markdown + untrusted-mode KaTeX.
    // Transcript strings, outline previews and metadata use textContent.
    body.innerHTML = message.html;
    for (const link of body.querySelectorAll("a[data-session-link]")) {
      link.addEventListener("click", async event => {
        event.preventDefault();
        try { await transport.openLink(selected, link.dataset.sessionLink); }
        catch (error) { notice(t(`打开链接失败：${error.message}`, `Unable to open link: ${error.message}`), true); }
      });
    }
    for (const table of body.querySelectorAll("table")) {
      const scroll = element("div", undefined, "table-scroll");
      table.replaceWith(scroll);
      scroll.append(table);
    }
  }
  return body;
}
function renderToolGroup(start, end, openGroups) {
  const group = element("details", undefined, "message message-tool");
  group.id = `tool-group-${start + 1}`;
  group.tabIndex = -1;
  group.open = openGroups.has(group.id);
  const heading = element("summary", undefined, "role");
  const range = end - start === 1 ? `#${start + 1}` : `#${start + 1}–#${end}`;
  const calls = detail.messages.slice(start, end).filter(isToolCall).length;
  const outputs = end - start - calls;
  const count = calls ? t(`${calls} 次调用${outputs ? ` · ${outputs} 条输出` : ""}`, `${calls} calls${outputs ? ` · ${outputs} outputs` : ""}`) : t(`${outputs} 条`, `${outputs} outputs`);
  heading.append(element("span", calls ? t("工具活动", "Tool activity") : t("工具输出", "Tool output"), "role-label"), element("span", count, "tool-group-count"), element("span", range, "message-index"));
  group.append(heading);
  for (let index = start; index < end; index++) {
    const message = detail.messages[index];
    const call = isToolCall(message);
    const output = element("section", undefined, `tool-entry ${call ? "tool-call" : "tool-output"}`);
    output.id = `message-${index + 1}`;
    output.tabIndex = -1;
    const label = element("h4", undefined, "tool-entry-heading");
    label.title = message.role;
    label.append(element("span", `${call ? t("调用", "Call") : t("输出", "Output")}${message.toolName ? " · " + message.toolName : ""}`), element("span", `#${index + 1}`, "message-index"));
    output.append(label);
    if (!call && message.toolCallId) output.append(element("p", t(`调用 ID：${message.toolCallId}`, `Call ID: ${message.toolCallId}`), "tool-call-id"));
    output.append(renderMessageBody(message));
    group.append(output);
  }
  return group;
}
function renderDetail(restore = null) {
  // Switching rendered/raw views keeps expanded tool runs open. A new session
  // still starts with every tool-output group collapsed.
  const openGroups = new Set(restore ? Array.from(document.querySelectorAll(".message-tool[open]")).map(node => node.id) : []);
  clearOutline();
  const viewer = $("viewer");
  viewer.replaceChildren();
  const content = element("div", undefined, "transcript-content");
  content.append(element("span", harnessLabels[detail.harness] || detail.harness, "harness-badge"), element("h2", preview(detail.title || detail.uid, 200), "session-heading"));
  content.append(element("p", [projectName(detail.repo || detail.cwd), detail.model, t(`${detail.messages.length} 条已恢复记录`, `${detail.messages.length} recovered records`)].filter(Boolean).join(" · "), "session-subtitle"));
  const info = element("details", undefined, "session-info");
  info.append(element("summary", t("会话信息与读取说明", "Session information and reading notes")));
  info.append(element("p", [detail.uid, detail.repo || detail.cwd, t(`来源：${detail.path}`, `Source: ${detail.path}`)].filter(Boolean).join("\n"), "metadata"));
  info.append(element("p", t(`恢复 ${detail.messages.length} 条阅读记录（含工具调用与输出）；来源计数 ${detail.messageCount} 条消息。沿用 adapter 的读取上限，不保证恢复全部历史。目录仅包含已恢复的用户消息。`, `${detail.messages.length} reading records recovered (including tool calls and outputs); source count: ${detail.messageCount} messages. Adapter read limits apply; full history recovery is not guaranteed. The outline includes only recovered user messages.`), "metadata"));
  const missing = [];
  if (!detail.fidelity.hasToolCalls) missing.push(t("工具调用", "tool calls"));
  if (!detail.fidelity.hasToolResults) missing.push(t("工具结果", "tool results"));
  if (!detail.fidelity.hasReasoning) missing.push(t("推理记录", "reasoning"));
  if (missing.length) info.append(element("p", t(`来源未提供：${missing.join("、")}。`, `Not provided by the source: ${missing.join(", ")}.`), "metadata"));
  for (const note of detail.fidelity.notes) info.append(element("p", note, "metadata"));
  content.append(info);
  const toolbar = element("div", undefined, "transcript-toolbar");
  const actions = element("div", undefined, "toolbar-actions");
  const toggle = button(raw ? t("查看渲染正文", "View rendered text") : t("查看原文", "View raw text"), () => {
    const reading = captureReadingPosition();
    raw = !raw;
    renderDetail(reading);
  });
  toggle.setAttribute("aria-pressed", String(raw));
  actions.append(toggle, button(t("回到开头", "Back to top"), () => viewer.scrollTo({ top: 0 })), button(t("跳到末尾", "Jump to bottom"), () => viewer.scrollTo({ top: viewer.scrollHeight })));
  const zoomGroup = element("div", undefined, "zoom-controls");
  zoomGroup.setAttribute("role", "group");
  zoomGroup.setAttribute("aria-label", t("正文缩放", "Transcript zoom"));
  const zoomOut = button("−", () => stepZoom(-1));
  const zoomLevel = button("100%", () => setZoom(100), "zoom-level");
  const zoomIn = button("+", () => stepZoom(1));
  zoomOut.id = "zoom-out";
  zoomLevel.id = "zoom-level";
  zoomIn.id = "zoom-in";
  zoomOut.title = t("缩小正文", "Zoom out");
  zoomLevel.title = t("恢复 100%", "Reset to 100%");
  zoomIn.title = t("放大正文", "Zoom in");
  for (const control of [zoomOut, zoomLevel, zoomIn]) control.setAttribute("aria-label", control.title);
  zoomGroup.append(zoomOut, zoomLevel, zoomIn);
  actions.append(zoomGroup);
  for (const action of transport.sessionActions) {
    const control = button(action.label, async () => {
      try { await action.run(selected); }
      catch (error) { notice(error.message, true); }
    }, action.className);
    if (action.icon) {
      const icon = element("span", action.icon, "button-icon");
      icon.setAttribute("aria-hidden", "true");
      control.prepend(icon);
    }
    actions.append(control);
  }
  toolbar.append(element("span", t("对话正文", "Transcript"), "transcript-count"), actions);
  content.append(toolbar);
  // CSS zoom scales the messages like browser zoom while the toolbar keeps
  // its size, so the zoom buttons stay under the pointer.
  const messages = element("div", undefined, "transcript-messages");
  messages.id = "transcript-messages";
  messages.style.zoom = String(zoom / 100);
  content.append(messages);
  for (let index = 0; index < detail.messages.length; index++) {
    const message = detail.messages[index];
    if (isToolMessage(message)) {
      let end = index + 1;
      while (end < detail.messages.length && isToolMessage(detail.messages[end])) end++;
      messages.append(renderToolGroup(index, end, openGroups));
      index = end - 1;
      continue;
    }
    const isUser = message.role.toLowerCase() === "user";
    const article = element("article", undefined, `message message-${isUser ? "user" : "assistant"}`);
    article.id = `message-${index + 1}`;
    article.tabIndex = -1;
    if (isUser) users.push({ id: article.id, ordinal: users.length + 1, index, text: message.text });
    const heading = element("h3", undefined, "role");
    const label = isUser ? t("你", "You") : message.role === "assistant" ? t("助手", "Assistant") : message.role;
    heading.append(element("span", label, "role-label"));
    if (isUser) heading.append(element("span", t(`第 ${users.length} 次提问`, `Question ${users.length}`)));
    heading.append(element("span", `#${index + 1}`, "message-index"));
    article.append(heading, renderMessageBody(message));
    messages.append(article);
  }
  if (!detail.messages.length) messages.append(element("p", t("来源没有可恢复的文本消息。", "No recoverable text messages in the source."), "muted"));
  viewer.append(content);
  updateZoomControls();
  $("outline-count").textContent = String(users.length);
  $("outline-filter").disabled = !users.length;
  renderOutline();
  setActiveUser(users[0]?.id || null, false);
  restoreReadingPosition(restore);
  resizeObserver = new ResizeObserver(scheduleMeasure);
  resizeObserver.observe(content);
  resizeObserver.observe(viewer);
  scheduleMeasure();
  document.fonts.ready.then(scheduleMeasure);
}
async function openSession(uid) {
  const version = ++detailVersion;
  selected = uid;
  detail = null;
  $("export-pdf").disabled = true;
  setSidebar(false);
  $("outline-filter").value = "";
  clearOutline(t("正在读取用户消息…", "Loading user messages…"));
  renderList(true);
  $("viewer").replaceChildren(element("p", t("正在读取对话…", "Loading conversation…"), "muted"));
  try {
    const result = await transport.getSession(uid);
    if (version !== detailVersion) return;
    detail = result;
    $("export-pdf").disabled = exportingPdf;
    renderDetail();
    $("viewer").scrollTop = 0;
    scheduleMeasure();
  } catch (error) {
    if (version === detailVersion) {
      $("viewer").replaceChildren(element("p", t(`读取失败：${error.message}`, `Read failed: ${error.message}`), "error"));
      clearOutline(t("读取失败，暂无目录", "Read failed; outline unavailable"));
    }
  }
}
$("viewer").addEventListener("scroll", () => {
  if (scrollFrame) return;
  scrollFrame = requestAnimationFrame(() => { scrollFrame = null; trackReadingPosition(); });
}, { passive: true });
$("viewer").addEventListener("toggle", scheduleMeasure, true);
$("outline-filter").addEventListener("input", renderOutline);
$("previous-user").addEventListener("click", () => { const index = users.findIndex(user => user.id === activeUser); if (index > 0) jumpToUser(users[index - 1].id); });
$("next-user").addEventListener("click", () => { const index = users.findIndex(user => user.id === activeUser); if (index >= 0 && index + 1 < users.length) jumpToUser(users[index + 1].id); });
$("sidebar-toggle").addEventListener("click", () => setSidebar(document.body.dataset.sidebar !== "open"));
$("sidebar-backdrop").addEventListener("click", () => { setSidebar(false); $("sidebar-toggle").focus(); });
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && document.body.dataset.sidebar === "open") { setSidebar(false); $("sidebar-toggle").focus(); }
});
function isDarkTheme() {
  const explicit = document.documentElement.dataset.theme;
  if (explicit) return explicit === "dark";
  if (document.body.dataset.host === "vscode") {
    if (document.body.classList.contains("vscode-dark") || document.body.classList.contains("vscode-high-contrast")) return true;
    if (document.body.classList.contains("vscode-light") || document.body.classList.contains("vscode-high-contrast-light")) return false;
  }
  return matchMedia("(prefers-color-scheme: dark)").matches;
}
function updateThemeButton() {
  const dark = isDarkTheme();
  $("theme-toggle").textContent = "◐";
  $("theme-toggle").title = dark ? t("切换浅色模式", "Switch to light mode") : t("切换深色模式", "Switch to dark mode");
  $("theme-toggle").setAttribute("aria-label", $("theme-toggle").title);
}
$("theme-toggle").addEventListener("click", () => {
  const dark = isDarkTheme();
  document.documentElement.dataset.theme = dark ? "light" : "dark";
  updateThemeButton();
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", updateThemeButton);
if (document.body.dataset.host === "vscode") {
  new MutationObserver(updateThemeButton).observe(document.body, { attributes: true, attributeFilter: ["class"] });
}
updateThemeButton();
$("search").addEventListener("input", () => {
  ++listVersion;
  $("more").hidden = true;
  clearTimeout(timer);
  timer = setTimeout(() => loadList(), 250);
});
$("harness").addEventListener("change", () => { clearTimeout(timer); loadList(); });
$("more").addEventListener("click", () => loadList(true));
$("export-pdf").addEventListener("click", async () => {
  if (!detail || exportingPdf) return;
  exportingPdf = true;
  $("export-pdf").disabled = true;
  $("export-pdf").textContent = "Exporting…";
  notice("Exporting conversation as PDF…");
  try {
    const result = await transport.exportPdf(selected);
    notice(result.cancelled ? "PDF export cancelled." : `PDF exported: ${result.path}`);
  } catch (error) { notice(`PDF export failed: ${error.message}`, true); }
  finally {
    exportingPdf = false;
    $("export-pdf").disabled = !detail;
    $("export-pdf").textContent = "Export PDF";
  }
});
$("refresh").addEventListener("click", async () => {
  $("refresh").disabled = true;
  notice(t("正在扫描本机会话…", "Scanning local sessions…"));
  try {
    await transport.refresh();
    await loadStatus();
    if (transport.hasSessionList) await loadList();
    if (selected) await openSession(selected);
  } catch (error) { notice(t(`刷新失败：${error.message}`, `Refresh failed: ${error.message}`), true); }
  finally { $("refresh").disabled = false; }
});
loadStatus().then(() => transport.initialUid ? openSession(transport.initialUid) : loadList()).catch(error => notice(error.message, true));
