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
let server, chrome, socket, alignmentScreenshot;
let checks = 0;
const check = (name, value) => { assert.ok(value, name); console.log(`PASS ${name}`); checks++; };
try {
  server = http.createServer((req, res) => {
    if (/^\/alignment-check-\d+\.png$/.test(req.url) && alignmentScreenshot) {
      res.setHeader("Content-Type", "image/png"); res.setHeader("Cache-Control", "no-store"); res.end(alignmentScreenshot); return;
    }
    if (req.url === "/") {
      const html = fs.readFileSync(path.join(media, "sidebar.html"), "utf8")
        .replaceAll("{{nonce}}", "synthetic-sidebar-nonce").replaceAll("{{cspSource}}", "'self'")
        .replace("{{style}}", "/sidebar.css").replace("{{script}}", "/sidebar.js");
      res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(html); return;
    }
    const file = req.url?.slice(1);
    if (!file || !/^(sidebar\.(css|js)|harness\/(light|dark)\/(pi|claude-code|codex|opencode|crush|jcode)\.svg)$/.test(file)) { res.writeHead(404); res.end(); return; }
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
    const harnesses = ['pi','claude-code','codex','opencode','crush','jcode'];
    const labels = ['Pi','Claude Code','Codex','OpenCode','Crush','Jcode'];
    const rows = Array.from({length:205}, (_, i) => {
      const harness=harnesses[i%harnesses.length];
      return {uid:'pi:row-'+i, title:i === 0 ? '修复会话索引与大文件读取 <img src=x onerror="window.injected=true"> 中文标题与超长标识符_identifier_'.repeat(4) : '第'+i+'条会话：检查实现并解释结果', harness, harnessLabel:labels[i%labels.length], recency:'3 minutes ago', starred:false,
        icons:{light:${JSON.stringify(origin)}+'/harness/light/'+harness+'.svg',dark:${JSON.stringify(origin)}+'/harness/dark/'+harness+'.svg'}};
    });
    let limit = 100, searchQuery = {text:'', searchScope:'user'}, searchOpen=sessionStorage.getItem('host-search-open')==='true';
    const send = data => window.dispatchEvent(new MessageEvent('message',{data}));
    function publish() {
      const matches=rows.filter((row,i)=>!searchQuery.text || searchQuery.text==='allrows' ||
        searchQuery.text==='userneedle'&&i===0 || searchQuery.text==='assistantneedle'&&searchQuery.searchScope!=='user'&&i===1 ||
        searchQuery.text==='toolneedle'&&searchQuery.searchScope==='all'&&i===2);
      const ordered=matches.filter(row=>row.starred).concat(matches.filter(row=>!row.starred));
      send({type:'sessionHub.sidebar.state',search:{...searchQuery},searchOpen,density:window.sidebarDensity,status:'',groups:[{scope:'current',label:'Current Project',total:matches.length,sessions:ordered.slice(0,limit)},{scope:'unscoped',label:'Unassigned',total:0,sessions:[]},{scope:'other',label:'Other Projects',total:0,sessions:[]}]});
    }
    window.sidebarDensity='comfortable'; window.publishSidebar=()=>publish();
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
  check("comfortable rows: full-width title, time beneath it, hover-revealed star on the time line", await evaluate(`(() => {
    const card=document.querySelector('.session-card'), title=card.querySelector('.session-title'), time=card.querySelector('.session-time'), star=card.querySelector('.star-button');
    const a=title.getBoundingClientRect(), b=time.getBoundingClientRect(), c=star.getBoundingClientRect(), h=card.getBoundingClientRect().height;
    return document.body.dataset.density==='comfortable' && h>=44 && h<=56 && b.top>=a.bottom && c.left>=b.left && Math.abs(a.right-c.right)<1 &&
      time.textContent==='3 minutes ago' && star.getAttribute('aria-pressed')==='false' && getComputedStyle(star).opacity==='0';
  })()`));
  await evaluate(`window.sidebarDensity='compact';window.publishSidebar()`);
  await wait(`document.body.dataset.density==='compact'`);
  check("compact setting switches to one 24px line with a short time label", await evaluate(`(() => {
    const card=document.querySelector('.session-card'), title=card.querySelector('.session-title'), time=card.querySelector('.session-time'), star=card.querySelector('.star-button');
    const a=title.getBoundingClientRect(), b=time.getBoundingClientRect(), c=star.getBoundingClientRect();
    return card.getBoundingClientRect().height===24 && a.right<=b.left && b.right<=c.left && time.textContent==='3m' && card.title.includes('3 minutes ago');
  })()`));
  await evaluate(`window.sidebarDensity='comfortable';window.publishSidebar()`);
  await wait(`document.body.dataset.density==='comfortable'`);
  for (const theme of ["light", "dark"]) {
    for (const harness of ["pi", "claude-code", "codex", "opencode", "crush", "jcode"]) {
      const source = fs.readFileSync(path.join(media, "harness", theme, harness + ".svg"), "utf8");
      check(`${theme} ${harness}: self-contained SVG artwork fits its original viewBox and loads at 16px`, await evaluate(`(async () => {
        const doc=new DOMParser().parseFromString(${JSON.stringify(source)},'image/svg+xml');
        if(doc.querySelector('parsererror, script, foreignObject, image, use, style')) return false;
        const svg=doc.documentElement;
        if(svg.localName!=='svg' || Array.from(svg.querySelectorAll('*')).concat(svg).some(node=>Array.from(node.attributes).some(attr=>/^on/i.test(attr.name) || /href$/i.test(attr.name) || /url\\(\\s*[^#]/i.test(attr.value)))) return false;
        svg.style.cssText='position:absolute;width:16px;height:16px;visibility:hidden';document.body.append(svg);
        const box=svg.getBBox(), view=svg.viewBox.baseVal;
        const fits=view.width>0 && view.height>0 && box.width>0 && box.height>0 && box.x>=view.x-0.1 && box.y>=view.y-0.1 && box.x+box.width<=view.x+view.width+0.1 && box.y+box.height<=view.y+view.height+0.1;
        svg.remove();
        const image=new Image(16,16);
        const loaded=await new Promise(resolve=>{image.onload=()=>resolve(image.naturalWidth>0 && image.naturalHeight>0);image.onerror=()=>resolve(false);image.src=${JSON.stringify(origin + "/harness/" + theme + "/" + harness + ".svg")};});
        return fits && loaded;
      })()`));
    }
  }
  check("session text remains literal and cannot inject HTML or scripts", await evaluate(`!window.injected && document.querySelector('.session-title').textContent.includes('<img') && !document.querySelector('.session-card img[src="x"]')`));
  for (const width of [220, 320, 480]) {
    await cdp("Emulation.setDeviceMetricsOverride", { width, height: 700, deviceScaleFactor: 1, mobile: false });
    check(`${width}px sidebar: title spans the row, star stays inside, no horizontal overflow`, await evaluate(`(() => {
      const card=document.querySelector('.session-card'), title=card.querySelector('.session-title'), star=card.querySelector('.star-button');
      const a=title.getBoundingClientRect(), b=card.getBoundingClientRect(), c=star.getBoundingClientRect();
      return a.width>40 && Math.abs(a.right-c.right)<1 && c.right<=b.right && b.height<=56 &&
        document.documentElement.scrollWidth<=innerWidth && getComputedStyle(title).textOverflow==='ellipsis';
    })()`));
  }
  for (const theme of ["vscode-light", "vscode-dark", "vscode-high-contrast", "vscode-high-contrast-light"]) {
    await evaluate(`document.body.className=${JSON.stringify(theme)}`);
    check(`${theme}: icon aligns to the title's text top, star centers on the time line, time aligns with the title`, await evaluate(`(() => {
      const card=document.querySelector('.session-card'), mid=el=>{const r=el.getBoundingClientRect();return r.top+r.height/2;};
      const icon=Array.from(card.querySelectorAll('.harness-icon')).filter(img=>getComputedStyle(img).display!=='none');
      const title=card.querySelector('.session-title'), time=card.querySelector('.session-time');
      return icon.length===1 && Number.isFinite(parseFloat(card.querySelector('.harness-icon-slot').style.getPropertyValue('--harness-icon-top'))) && Math.abs(mid(card.querySelector('.star-button'))-mid(time))<0.6 &&
        Math.abs(time.getBoundingClientRect().left-title.getBoundingClientRect().left)<0.5;
    })()`));
  }
  for (const density of ["comfortable", "compact"]) {
    await evaluate(`window.sidebarDensity=${JSON.stringify(density)};window.publishSidebar()`);
    for (const theme of ["vscode-light", "vscode-dark", "vscode-high-contrast", "vscode-high-contrast-light"]) {
      await evaluate(`document.body.className=${JSON.stringify(theme)}`);
      await wait(`Array.from(document.querySelectorAll('.session-card')).slice(0,6).every(card=>Array.from(card.querySelectorAll('.harness-icon')).filter(img=>getComputedStyle(img).display!=='none').every(img=>img.complete && img.naturalWidth>0))`);
      check(`${density} ${theme}: six brands share an icon slot, title inset and a 1px optical offset from the measured text top`, await evaluate(`(() => {
        const cards=Array.from(document.querySelectorAll('.session-card')).slice(0,6);
        const titles=cards.map(card=>card.querySelector('.session-title').getBoundingClientRect());
        return new Set(cards.map(card=>card.querySelector('.harness-icon-slot').dataset.harness)).size===6 && cards.every((card,i)=>{
          const slot=card.querySelector('.harness-icon-slot'), r=slot.getBoundingClientRect(), title=titles[i];
          const icons=Array.from(slot.querySelectorAll('.harness-icon')).filter(img=>getComputedStyle(img).display!=='none');
          if(icons.length!==1) return false;
          const icon=icons[0].getBoundingClientRect(), expected=['pi','opencode'].includes(slot.dataset.harness)?14:16;
          const inkTop=parseFloat(slot.style.getPropertyValue('--harness-icon-top'));
          return Number.isFinite(inkTop) && r.width===16 && r.height===20 && icon.width===expected && icon.height===expected &&
            Math.abs(r.left+r.width/2-icon.left-icon.width/2)<0.1 &&
            parseFloat(getComputedStyle(slot).getPropertyValue('--harness-icon-optical-y'))===1 &&
            Math.abs(icon.top-r.top-inkTop)<0.1 &&
            Math.abs(title.left-titles[0].left)<0.1 &&
            (document.body.dataset.density!=='comfortable' || Math.abs(card.querySelector('.session-time').getBoundingClientRect().left-title.left)<0.1);
        });
      })()`));
    }
  }
  // Compare painted pixels, not DOM boxes or the implementation's font metrics.
  // This catches the em-box/font-ink mismatch seen in real VS Code screenshots.
  let pixelCheck = 0;
  await cdp("Emulation.setDeviceMetricsOverride", { width: 320, height: 700, deviceScaleFactor: 1, mobile: false });
  for (const pixelRatio of [1, 1.25, 1.5, 2]) {
    await cdp("Emulation.setDeviceMetricsOverride", { width: 320, height: 700, deviceScaleFactor: pixelRatio, mobile: false });
    for (const density of ["comfortable", "compact"]) {
      for (const fontSize of [11, 13, 16]) {
      await evaluate(`(async () => {window.sidebarDensity=${JSON.stringify(density)};window.publishSidebar();document.body.className='vscode-dark';document.body.style.setProperty('--vscode-font-size',${JSON.stringify(fontSize + "px")});document.body.style.setProperty('--vscode-sideBar-background','#252526');document.body.style.setProperty('--vscode-sideBar-foreground','#cccccc');Array.from(document.querySelectorAll('.session-title')).slice(0,6).forEach((title,i)=>{title.textContent=['Demo示例任务已完成','lowercase only','UPPER CASE','字体顶部对齐','Áccent title','示例标题 Demo'][i];});window.scrollTo(0,0);window.dispatchEvent(new Event('resize'));await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))})()`);
      const shot = await cdp("Page.captureScreenshot", { format: "png" });
      alignmentScreenshot = Buffer.from(shot.data, "base64");
      const offsets = await evaluate(`(async () => {
        const image=new Image();await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=reject;image.src=${JSON.stringify(origin + "/alignment-check-") }+${pixelCheck++}+'.png';});
        const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;
        const context=canvas.getContext('2d');context.drawImage(image,0,0);
        const {data,width,height}=context.getImageData(0,0,canvas.width,canvas.height);
        const scale=window.devicePixelRatio;
        const firstInkY=rect=>{
          for(let y=Math.max(0,Math.floor(rect.top*scale));y<Math.min(height,Math.ceil(rect.bottom*scale));y++){
            for(let x=Math.max(0,Math.ceil(rect.left*scale));x<Math.min(width,Math.floor(rect.right*scale));x++){
              const i=(y*width+x)*4;
              if(Math.max(Math.abs(data[i]-37),Math.abs(data[i+1]-37),Math.abs(data[i+2]-38))>48) return y;
            }
          }
          return null;
        };
        return Array.from(document.querySelectorAll('.session-card')).slice(0,6).map(card=>{
          const icon=Array.from(card.querySelectorAll('.harness-icon')).find(img=>getComputedStyle(img).display!=='none');
          const iconY=firstInkY(icon.getBoundingClientRect()), textY=firstInkY(card.querySelector('.session-title').getBoundingClientRect());
          return {harness:card.querySelector('.harness-icon-slot').dataset.harness,iconY,textY};
        });
      })()`);
      check(`${density} ${fontSize}px DPR ${pixelRatio}: screenshot ink tops retain the 1 CSS px optical offset within 1 CSS px raster tolerance for six marks and mixed/CJK/Latin/accent titles: ${JSON.stringify(offsets)}`,
        offsets.every(({iconY,textY})=>iconY!==null && textY!==null && Math.abs(iconY-textY-pixelRatio)<=Math.max(1,pixelRatio)));
      }
    }
  }
  await cdp("Emulation.setDeviceMetricsOverride", { width: 320, height: 700, deviceScaleFactor: 1, mobile: false });
  await evaluate(`document.body.style.removeProperty('--vscode-font-size');document.body.style.removeProperty('--vscode-sideBar-background');document.body.style.removeProperty('--vscode-sideBar-foreground');window.sidebarDensity='comfortable';window.publishSidebar()`);
  if (process.env.SIDEBAR_ICON_SCREENSHOT) {
    await cdp("Emulation.setDeviceMetricsOverride", { width: 320, height: 400, deviceScaleFactor: 2, mobile: false });
    await evaluate(`(async () => {document.body.className='vscode-dark';Array.from(document.querySelectorAll('.session-card')).slice(0,6).forEach(card=>{card.querySelector('.session-title').textContent='Demo示例任务已完成 · '+card.querySelector('.harness-icon-slot').dataset.harness;});window.scrollTo(0,0);window.dispatchEvent(new Event('resize'));await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))})()`);
    const shot = await cdp("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 22, width: 320, height: 324, scale: 1 } });
    fs.writeFileSync(process.env.SIDEBAR_ICON_SCREENSHOT, Buffer.from(shot.data, "base64"));
    await cdp("Emulation.setDeviceMetricsOverride", { width: 320, height: 700, deviceScaleFactor: 1, mobile: false });
    await evaluate(`window.publishSidebar()`);
  }
  await evaluate(`document.querySelector('.star-button').click()`);
  await wait(`document.querySelector('.session-card').classList.contains('is-starred') && !document.querySelector('.star-button').disabled`);
  check("star click highlights the card without opening the conversation", await evaluate(`document.querySelector('.star-button').getAttribute('aria-pressed')==='true' && getComputedStyle(document.querySelector('.star-button svg')).fill!=='none' && getComputedStyle(document.querySelector('.star-button')).opacity==='1' && !window.requests.some(r=>r.action==='open')`));
  for (const theme of ["vscode-light", "vscode-dark", "vscode-high-contrast", "vscode-high-contrast-light"]) {
    await evaluate(`document.body.className=${JSON.stringify(theme)}`);
    check(`${theme}: starred rows keep a visible, colored star while normal rows hide theirs`, await evaluate(`(() => {
      const cards=document.querySelectorAll('.session-card'), a=getComputedStyle(cards[0].querySelector('.star-button')), b=getComputedStyle(cards[1].querySelector('.star-button'));
      return a.color!==b.color && a.opacity==='1' && b.opacity==='0';
    })()`));
  }
  await evaluate(`document.body.style.setProperty('--vscode-sessionHub-starredForeground','#ff00ff')`);
  check("VS Code custom star color also controls the starred row", await evaluate(`getComputedStyle(document.querySelector('.star-button')).color==='rgb(255, 0, 255)'`));
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
  await evaluate(`window.openCount=window.requests.filter(r=>r.action==='open').length;document.querySelector('.session-time').click()`);
  await wait(`window.requests.filter(r=>r.action==='open').length===window.openCount+1 && !document.querySelector('.session-title').disabled`);
  check("time label and blank area open the conversation exactly once", await evaluate(`window.requests.at(-1).uid==='pi:row-0'`));
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
