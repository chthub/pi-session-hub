// Real Chromium layout/interaction checks for the shipped sidebar assets.
// Only acquireVsCodeApi/postMessage is mocked; no real session history is used.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
const media = path.resolve(import.meta.dirname, "../vscode-extension/media");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "hub-sidebar-browser-"));
let server, chrome, socket;
let checks = 0;
const check = (name, value) => { assert.ok(value, name); console.log(`PASS ${name}`); checks++; };
try {
  server = http.createServer((req, res) => {
    if (req.url === "/") {
      const html = fs.readFileSync(path.join(media, "sidebar.html"), "utf8")
        .replaceAll("{{nonce}}", "synthetic-sidebar-nonce").replaceAll("{{cspSource}}", "'self'")
        .replace("{{style}}", "/sidebar.css").replace("{{script}}", "/sidebar.js");
      res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(html); return;
    }
    const file = req.url?.slice(1);
    if (!file || !/^(sidebar\.(css|js)|harness\/(light|dark)\/(pi|codex)\.svg)$/.test(file)) { res.writeHead(404); res.end(); return; }
    res.setHeader("Content-Type", file.endsWith("css") ? "text/css" : file.endsWith("js") ? "text/javascript" : "image/svg+xml");
    res.end(fs.readFileSync(path.join(media, file)));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  chrome = spawn(process.env.CHROME_BIN ?? "google-chrome", ["--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--disable-background-networking", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${path.join(temp, "chrome")}`, "about:blank"],
  { stdio: ["ignore", "ignore", "pipe"] });
  let log = "";
  const debuggerURL = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Chrome startup timed out: ${log}`)), 15000);
    chrome.once("error", error => { clearTimeout(timer); reject(error); });
    chrome.once("exit", code => { clearTimeout(timer); reject(new Error(`Chrome exited ${code}: ${log}`)); });
    chrome.stderr.on("data", data => { log += data; const match = log.match(/DevTools listening on (ws:\/\/\S+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
  });
  const debugOrigin = new URL(debuggerURL).origin.replace("ws:", "http:");
  const targets = await (await fetch(debugOrigin + "/json/list")).json();
  socket = new WebSocket(targets.find(t => t.type === "page").webSocketDebuggerUrl); await once(socket, "open");
  let sequence = 0;
  const pending = new Map(), exceptions = [], failures = [], network = [];
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (message.id) { const waiter = pending.get(message.id); pending.delete(message.id); if (message.error) waiter?.reject(new Error(message.error.message)); else waiter?.resolve(message.result); }
    if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails);
    if (message.method === "Network.loadingFailed") failures.push(message.params);
    if (message.method === "Network.requestWillBeSent") network.push(message.params.request.url);
  });
  const cdp = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => {
    const result = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const wait = async expression => {
    const until = Date.now() + 10000;
    while (Date.now() < until) { if (await evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 25)); }
    throw new Error(`Browser wait timed out: ${expression}\n${JSON.stringify({ exceptions, failures, page: await evaluate('({text:document.body?.innerText, requests:window.requests, api:typeof acquireVsCodeApi})') })}`);
  };
  await cdp("Page.enable"); await cdp("Runtime.enable"); await cdp("Network.enable");
  await cdp("Emulation.setDeviceMetricsOverride", { width: 320, height: 700, deviceScaleFactor: 1, mobile: false });
  await cdp("Page.addScriptToEvaluateOnNewDocument", { source: `
    window.requests = []; window.savedState = JSON.parse(sessionStorage.getItem('sidebar-state') || '{}'); window.failNextStar = false;
    const rows = Array.from({length:205}, (_, i) => ({uid:'pi:row-'+i, title:i === 0 ? '修复会话索引与大文件读取 <img src=x onerror="window.injected=true"> 中文标题与超长标识符_identifier_'.repeat(4) : '第'+i+'条会话：检查实现并解释结果', harness:'pi', harnessLabel:'Pi', recency:'3 minutes ago', starred:false, icons:{light:${JSON.stringify(origin + "/harness/light/pi.svg")},dark:${JSON.stringify(origin + "/harness/dark/pi.svg")}}}));
    let limit = 100, searchQuery = {text:'', searchScope:'user'}, searchOpen=sessionStorage.getItem('host-search-open')==='true';
    const send = data => window.dispatchEvent(new MessageEvent('message',{data}));
    function publish() {
      const matches=rows.filter((row,i)=>!searchQuery.text || searchQuery.text==='allrows' ||
        searchQuery.text==='userneedle'&&i===0 || searchQuery.text==='assistantneedle'&&searchQuery.searchScope!=='user'&&i===1 ||
        searchQuery.text==='toolneedle'&&searchQuery.searchScope==='all'&&i===2);
      const ordered=matches.filter(row=>row.starred).concat(matches.filter(row=>!row.starred));
      send({type:'sessionHub.sidebar.state',search:{...searchQuery},searchOpen,status:'',groups:[{scope:'current',label:'Current Project',total:matches.length,sessions:ordered.slice(0,limit)},{scope:'unscoped',label:'Unassigned',total:0,sessions:[]},{scope:'other',label:'Other Projects',total:0,sessions:[]}]});
    }
    window.toggleSidebarSearch=()=>{searchOpen=!searchOpen;sessionStorage.setItem('host-search-open',String(searchOpen));if(!searchOpen){searchQuery.text='';limit=100;}publish();};
    window.acquireVsCodeApi = () => ({getState:()=>window.savedState,setState:value=>{window.savedState=structuredClone(value);sessionStorage.setItem('sidebar-state',JSON.stringify(value));},postMessage:request=>{
      window.requests.push(request);
      setTimeout(()=>{
        let error;
        if(request.action === 'star') { if(window.failNextStar){window.failNextStar=false;error='Simulated save failure';}else{rows.find(row=>row.uid===request.uid).starred=request.starred;publish();} }
        if(request.action === 'more'){limit+=100;publish();}
        if(request.action === 'ready') publish();
        if(request.action === 'closeSearch'){searchOpen=false;searchQuery.text='';limit=100;sessionStorage.setItem('host-search-open','false');publish();}
        if(request.action === 'search') {searchQuery={text:request.text,searchScope:request.searchScope};limit=100;publish();}
        send({type:'sessionHub.sidebar.result',id:request.id,error});
      },10);
    }});
  ` });
  await cdp("Page.navigate", { url: origin + "/" });
  await wait('document.querySelectorAll(".session-card").length === 100');
  check("search controls are collapsed by default without leaving layout space", await evaluate(`document.querySelector('#search-panel').hidden && document.querySelector('#search-panel').getClientRects().length===0 && document.documentElement.lang==='en'`));
  check("sidebar initially renders bounded two-line cards with a persistent second-row star button", await evaluate(`(() => {
    const card=document.querySelector('.session-card'), title=card.querySelector('.session-title'), meta=card.querySelector('.session-meta'), star=card.querySelector('.star-button');
    const a=title.getBoundingClientRect(), b=meta.getBoundingClientRect(), c=star.getBoundingClientRect();
    return card.children.length===2 && b.top>=a.bottom && c.top>=b.top && c.bottom<=b.bottom && star.getAttribute('aria-pressed')==='false' && !star.hidden;
  })()`));
  for (const theme of ["light", "dark"]) {
    const svg = fs.readFileSync(path.join(media, "harness", theme, "pi.svg"), "utf8");
    check(`${theme} Pi glyph is optically centered in its SVG viewport`, await evaluate(`(() => {
      const svg=new DOMParser().parseFromString(${JSON.stringify(svg)},'image/svg+xml').documentElement;
      svg.style.cssText='position:absolute;width:16px;height:16px;visibility:hidden';document.body.append(svg);
      const path=svg.querySelector('path'), box=path.getBBox(), center=svg.createSVGPoint();
      center.x=box.x+box.width/2;center.y=box.y+box.height/2;
      const point=center.matrixTransform(path.getCTM());svg.remove();
      return Math.abs(point.x-8)<0.01 && Math.abs(point.y-8)<0.01;
    })()`));
  }
  check("session text remains literal and cannot inject HTML or scripts", await evaluate(`!window.injected && document.querySelector('.session-title').textContent.includes('<img') && !document.querySelector('.session-card img[src="x"]')`));
  for (const width of [220, 320, 480]) {
    await cdp("Emulation.setDeviceMetricsOverride", { width, height: 700, deviceScaleFactor: 1, mobile: false });
    check(`${width}px sidebar: title uses the complete first row, metadata/star stay on second, no horizontal overflow`, await evaluate(`(() => {
      const card=document.querySelector('.session-card'), title=card.querySelector('.session-title'), star=card.querySelector('.star-button'), meta=card.querySelector('.session-meta');
      const css=getComputedStyle(card), a=title.getBoundingClientRect(), b=card.getBoundingClientRect(), c=star.getBoundingClientRect();
      return Math.abs(a.width-(card.clientWidth-parseFloat(css.paddingLeft)-parseFloat(css.paddingRight)))<1 &&
        c.right<=b.right && c.bottom<=meta.getBoundingClientRect().bottom && a.height===24 && card.getBoundingClientRect().height>=58 &&
        document.documentElement.scrollWidth<=innerWidth && getComputedStyle(title).textOverflow==='ellipsis';
    })()`));
  }
  for (const theme of ["vscode-light", "vscode-dark", "vscode-high-contrast", "vscode-high-contrast-light"]) {
    await evaluate(`document.body.className=${JSON.stringify(theme)}`);
    check(`${theme}: harness icon, metadata and star share one vertical center and align with the title inset`, await evaluate(`(() => {
      const card=document.querySelector('.session-card'), title=card.querySelector('.session-title');
      const icon=Array.from(card.querySelectorAll('.harness-icon')).find(img=>getComputedStyle(img).display!=='none');
      const a=icon.getBoundingClientRect(), b=card.querySelector('.session-info').getBoundingClientRect(), c=card.querySelector('.star-button').getBoundingClientRect();
      return Math.abs(a.top+a.height/2-b.top-b.height/2)<0.1 && Math.abs(a.top+a.height/2-c.top-c.height/2)<0.1 &&
        Math.abs(a.left-title.getBoundingClientRect().left-parseFloat(getComputedStyle(title).paddingLeft))<0.1 &&
        getComputedStyle(card.querySelector('.session-info')).lineHeight==='16px';
    })()`));
  }
  await evaluate(`document.querySelector('.star-button').click()`);
  await wait(`document.querySelector('.session-card').classList.contains('is-starred') && !document.querySelector('.star-button').disabled`);
  check("star click highlights the card without opening the conversation", await evaluate(`document.querySelector('.star-button').getAttribute('aria-pressed')==='true' && document.querySelector('.star-button').textContent==='★' && !window.requests.some(r=>r.action==='open')`));
  for (const theme of ["vscode-light", "vscode-dark", "vscode-high-contrast", "vscode-high-contrast-light"]) {
    await evaluate(`document.body.className=${JSON.stringify(theme)}`);
    check(`${theme}: highlighted title and card differ from normal rows`, await evaluate(`(() => {
      const cards=document.querySelectorAll('.session-card');
      return getComputedStyle(cards[0].querySelector('.session-title')).color!==getComputedStyle(cards[1].querySelector('.session-title')).color &&
        getComputedStyle(cards[0]).backgroundColor!==getComputedStyle(cards[1]).backgroundColor;
    })()`));
  }
  await evaluate(`document.body.style.setProperty('--vscode-sessionHub-starredForeground','#ff00ff')`);
  check("VS Code custom star color also controls the two-line card", await evaluate(`getComputedStyle(document.querySelector('.session-title')).color==='rgb(255, 0, 255)'`));
  await evaluate(`window.failNextStar=true;document.querySelector('.star-button').click()`);
  await wait(`document.querySelector('#status').textContent==='Simulated save failure' && !document.querySelector('.star-button').disabled`);
  check("save failure keeps the highlighted state and presents a visible error", await evaluate(`document.querySelector('.session-card').classList.contains('is-starred') && document.querySelector('#status').classList.contains('error')`));
  await evaluate(`document.querySelector('.star-button').focus()`);
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
  await wait(`!document.querySelector('.session-card').classList.contains('is-starred') && !document.querySelector('.star-button').disabled`);
  check("keyboard Space toggles highlighting off and retains accessible focus", await evaluate(`document.activeElement.classList.contains('star-button') && document.querySelector('.star-button').getAttribute('aria-pressed')==='false'`));
  check("right-click context carries only the session identity and star state", await evaluate(`(() => {const c=JSON.parse(document.querySelector('.session-card').dataset.vscodeContext);return c.webviewSection==='session'&&c.sessionUid==='pi:row-0'&&c.sessionStarred===false&&!c.path;})()`));
  await evaluate(`document.querySelector('.session-title').click()`);
  await wait(`window.requests.some(r=>r.action==='open'&&r.uid==='pi:row-0')`);
  check("title click opens the correct conversation independently of starring", true);
  await wait(`!document.querySelector('.session-title').disabled`);
  await evaluate(`window.openCount=window.requests.filter(r=>r.action==='open').length;document.querySelector('.session-meta').click()`);
  await wait(`window.requests.filter(r=>r.action==='open').length===window.openCount+1 && !document.querySelector('.session-title').disabled`);
  check("second-row metadata and blank area open the conversation exactly once", await evaluate(`window.requests.at(-1).uid==='pi:row-0'`));
  const padding = await evaluate(`(() => {window.openCount=window.requests.filter(r=>r.action==='open').length;const r=document.querySelector('.session-card').getBoundingClientRect();return {x:r.left+2,y:r.top+2};})()`);
  await cdp('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...padding});
  await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...padding});
  await wait(`window.requests.filter(r=>r.action==='open').length===window.openCount+1 && !document.querySelector('.session-title').disabled`);
  check("card padding is clickable, while the star remains a separate action", true);
  await evaluate(`document.querySelector('[data-uid="pi:row-50"]').scrollIntoView(); window.scrollBeforeStar=scrollY;document.querySelector('[data-uid="pi:row-50"] .star-button').click()`);
  await wait(`document.querySelector('[data-uid="pi:row-50"]').classList.contains('is-starred') && !document.querySelector('[data-uid="pi:row-50"] .star-button').disabled`);
  check("star updates preserve scroll position in a long list", await evaluate(`Math.abs(scrollY-window.scrollBeforeStar)<2`));
  check("confirmed starred card moves to the top without opening its conversation", await evaluate(`document.querySelector(".session-card").dataset.uid==="pi:row-50" && !window.requests.some(r=>r.action==="open"&&r.uid==="pi:row-50")`));
  await evaluate(`document.querySelector(".star-button").click()`);
  await wait(`!document.querySelector('[data-uid="pi:row-50"]').classList.contains("is-starred") && !document.querySelector('[data-uid="pi:row-50"] .star-button').disabled`);
  check("unstar on the moved button still targets its UID and restores original order", await evaluate(`document.querySelector(".session-card").dataset.uid==="pi:row-0" && Array.from(document.querySelectorAll(".session-card"))[50].dataset.uid==="pi:row-50" && window.requests.at(-1).uid==="pi:row-50"`));
  await evaluate(`document.querySelector('.more').click()`);
  await wait(`document.querySelectorAll('.session-card').length===200`);
  await evaluate(`document.querySelector('.more').click()`);
  await wait(`document.querySelectorAll('.session-card').length===205`);
  check("load-more reaches every session without duplicate cards", await evaluate(`new Set(Array.from(document.querySelectorAll('.session-card'),c=>c.dataset.uid)).size===205 && !document.querySelector('.more')`));
  await evaluate(`document.querySelector('.group').open=false`);
  await wait(`window.savedState.collapsed.current===true`);
  check("project collapse state persists through client state storage", true);
  await evaluate(`document.querySelector('.group').open=true;document.querySelector('.star-button').click()`);
  await wait(`document.querySelector('.session-card').classList.contains('is-starred') && !document.querySelector('.star-button').disabled`);
  check("an immediate star/host update cannot undo a newly expanded project group", await evaluate(`document.querySelector('.group').open && document.querySelector('.session-card').getBoundingClientRect().height>0`));
  await evaluate(`window.toggleSidebarSearch()`);
  check("native magnifier expands search and moves keyboard focus into its field", await evaluate(`!document.querySelector('#search-panel').hidden && document.activeElement.id==='search' && document.querySelector('#search-panel').textContent.includes('Search sessions')`));
  check("search defaults to user prompts with three explicitly labeled scopes", await evaluate(`document.querySelector('#search-scope').value==='user' && document.querySelectorAll('#search-scope option').length===3`));
  const searchFor = async (text, scope = "user") => {
    await evaluate(`document.querySelector('#search-scope').value=${JSON.stringify(scope)};document.querySelector('#search').focus();document.querySelector('#search').value=${JSON.stringify(text)};document.querySelector('#search').dispatchEvent(new Event('input'));`);
    await wait(`window.requests.at(-1)?.action==='search' && window.requests.at(-1).text===${JSON.stringify(text)} && window.requests.at(-1).searchScope===${JSON.stringify(scope)} && document.querySelector('#groups').getAttribute('aria-busy')==='false'`);
  };
  check("IME composition does not search intermediate input or consume its Enter key", await evaluate(`(async () => {
    const input=document.querySelector('#search'), count=window.requests.length;
    input.dispatchEvent(new CompositionEvent('compositionstart')); input.value='输入中';
    input.dispatchEvent(new InputEvent('input',{isComposing:true}));
    const enter=new KeyboardEvent('keydown',{key:'Enter',isComposing:true,cancelable:true}); input.dispatchEvent(enter);
    await new Promise(resolve=>setTimeout(resolve,250));
    return window.requests.length===count && !enter.defaultPrevented;
  })()`));
  await evaluate(`document.querySelector('#search').value='userneedle';document.querySelector('#search').dispatchEvent(new CompositionEvent('compositionend'))`);
  await wait(`document.querySelector('.session-card')?.dataset.uid==='pi:row-0' && document.querySelector('#groups').getAttribute('aria-busy')==='false'`);
  check("committed IME text triggers the prompt-only search", await evaluate(`window.requests.at(-1).text==='userneedle' && window.requests.at(-1).searchScope==='user'`));
  await searchFor('assistantneedle');
  check("default prompt-only query has an actionable empty state", await evaluate(`!document.querySelector('.session-card') && document.querySelector('#search-summary').textContent.includes('wider scope')`));
  await evaluate(`document.querySelector('#search-scope').value='conversation';document.querySelector('#search-scope').dispatchEvent(new Event('change'))`);
  await wait(`document.querySelectorAll('.session-card').length===1 && document.querySelector('#groups').getAttribute('aria-busy')==='false'`);
  check("scope changes immediately rerun the same query and expand matching groups", await evaluate(`window.requests.at(-1).text==='assistantneedle' && window.requests.at(-1).searchScope==='conversation' && document.querySelector('.session-card').dataset.uid==='pi:row-1' && Array.from(document.querySelectorAll('.group')).every(g=>g.open)`));
  await searchFor('toolneedle', 'conversation');
  check("conversation scope excludes tool-only content", await evaluate(`!document.querySelector('.session-card')`));
  await searchFor('toolneedle', 'all');
  check("all-content scope returns tool matches and persists controls", await evaluate(`document.querySelector('.session-card').dataset.uid==='pi:row-2' && window.savedState.text==='toolneedle' && window.savedState.searchScope==='all'`));
  await evaluate(`window.dispatchEvent(new MessageEvent('message',{data:{type:'sessionHub.sidebar.state',search:{text:'outdated',searchScope:'user'},groups:[],status:''}}))`);
  check("stale host search responses cannot replace the current result", await evaluate(`document.querySelector('.session-card').dataset.uid==='pi:row-2'`));
  await cdp("Page.reload");
  await wait(`document.querySelector('.session-card')?.dataset.uid==='pi:row-2' && document.querySelector('#groups').getAttribute('aria-busy')==='false'`);
  check("webview recreation restores the query and range, then searches again", await evaluate(`document.querySelector('#search').value==='toolneedle' && document.querySelector('#search-scope').value==='all' && window.requests.some(r=>r.action==='search'&&r.text==='toolneedle'&&r.searchScope==='all')`));
  await searchFor('allrows', 'all');
  await evaluate(`document.querySelector('.more').click()`);
  await wait(`document.querySelectorAll('.session-card').length===200`);
  await searchFor('userneedle', 'user');
  check("new queries reset pagination and preserve search field focus", await evaluate(`document.querySelectorAll('.session-card').length===1 && document.querySelector('#search-summary').textContent.includes('1 session found') && document.activeElement.id==='search'`));
  await evaluate(`document.querySelector('#search').focus()`);
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await wait(`document.querySelectorAll('.session-card').length===100 && document.querySelector('#groups').getAttribute('aria-busy')==='false'`);
  check("Escape clears the query without changing the scope or saved group collapse state", await evaluate(`document.querySelector('#search').value==='' && document.querySelector('#search-scope').value==='user' && document.activeElement.id==='search' && !document.querySelector('[data-scope=other]').open`));
  for (const width of [220, 320, 480]) {
    await cdp("Emulation.setDeviceMetricsOverride", { width, height: 700, deviceScaleFactor: 1, mobile: false });
    check(`${width}px search controls fit the sidebar`, await evaluate(`document.documentElement.scrollWidth<=innerWidth && document.querySelector('#search-scope').getBoundingClientRect().right<=innerWidth`));
  }
  await searchFor('toolneedle','all');
  await evaluate(`document.querySelector('#search-close').click()`);
  await wait(`document.querySelector('#search-panel').hidden && document.querySelectorAll('.session-card').length===100`);
  check("closing search clears hidden filters and restores the full list", await evaluate(`window.requests.at(-1).action==='closeSearch' && document.querySelector('#search').value===''`));
  await evaluate(`window.toggleSidebarSearch()`);
  await searchFor('userneedle');
  await evaluate(`window.toggleSidebarSearch()`);
  await wait(`document.querySelector('#search-panel').hidden && document.querySelectorAll('.session-card').length===100`);
  check("clicking the magnifier again collapses and clears search", true);
  await evaluate(`window.toggleSidebarSearch()`);
  for (const theme of ['vscode-light','vscode-dark','vscode-high-contrast','vscode-high-contrast-light']) {
    await evaluate(`document.body.className=${JSON.stringify(theme)}`);
    check(`${theme} search panel uses visible inputs and no horizontal overflow`, await evaluate(`document.querySelector('#search').getBoundingClientRect().height>=30 && document.documentElement.scrollWidth<=innerWidth && getComputedStyle(document.querySelector('#search')).backgroundColor!=='rgba(0, 0, 0, 0)'`));
  }
  await evaluate(`document.querySelector('.star-button').click()`);
  await wait(`document.querySelector('.session-card').classList.contains('is-starred') && !document.querySelector('.star-button').disabled`);
  if (process.env.SIDEBAR_SCREENSHOT || process.env.SIDEBAR_HTML) {
    await evaluate(`document.querySelector('.group').open=true;document.body.className='vscode-dark';document.body.style.removeProperty('--vscode-sessionHub-starredForeground');window.scrollTo(0,0)`);
    await wait(`document.querySelector('.session-card').classList.contains('is-starred') && !document.querySelector('.star-button').disabled`);
    await cdp("Emulation.setDeviceMetricsOverride", { width: 320, height: 700, deviceScaleFactor: 1, mobile: false });
    if (process.env.SIDEBAR_SCREENSHOT) {
      const shot = await cdp("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(process.env.SIDEBAR_SCREENSHOT, Buffer.from(shot.data, "base64"));
    }
    if (process.env.SIDEBAR_HTML) {
      const html = await evaluate('document.documentElement.outerHTML');
      fs.writeFileSync(process.env.SIDEBAR_HTML, html.replace(/<link[^>]+href="\/sidebar.css"[^>]*>/, '<style>' + fs.readFileSync(path.join(media, 'sidebar.css'), 'utf8') + '</style>'));
    }
  }
  check("no page exceptions, blocked resources or external network requests", exceptions.length === 0 && failures.length === 0 && network.every(url => url.startsWith(origin)));
  console.log(`${checks} sidebar browser checks passed.`);
} finally {
  socket?.close();
  if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
    const exited = once(chrome, "exit");
    const kill = setTimeout(() => chrome.kill("SIGKILL"), 3000);
    chrome.kill("SIGTERM"); await exited; clearTimeout(kill);
  }
  if (server) await new Promise(resolve => server.close(resolve));
  // Chromium child processes can finish a profile write just after parent exit.
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
