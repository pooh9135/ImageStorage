import { app, BrowserWindow } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { showInlinePicker } from "../../browser-extension/src/inline-picker.js";
import { resolveLinkedImage } from "../../browser-extension/src/linked-image.js";

const output = process.argv.find((value) => value.startsWith("--picker-test-dir="))?.slice("--picker-test-dir=".length);
if (!output) throw new Error("A disposable test directory is required");
app.setPath("userData", path.join(output, "profile"));
app.disableHardwareAcceleration();
const cases = [];
let window;
async function evaluate(source) {
  const result = await window.webContents.executeJavaScript(`(async () => { try { return { value: await (0, eval)(${JSON.stringify(source)}) }; } catch (error) { return { error: String(error.stack || error) }; } })()`);
  if (result.error) throw new Error(result.error);
  return result.value;
}
async function check(name, source) {
  const failure = await evaluate(`(async () => { try { const assert = (value, reason) => { if (!value) throw new Error(reason); }; ${source}; return null; } catch (error) { return String(error.stack || error); } })()`);
  if (failure) throw new Error(`${name}: ${failure}`);
  cases.push(name);
}
async function screenshot(name) {
  // Wake the hidden compositor before capturing; its first snapshot can contain
  // the preceding frame even though the DOM layout has already been updated.
  try { await window.webContents.capturePage(undefined, { stayHidden: true }); } catch { /* Retry after the renderer paints. */ }
  await evaluate("new Promise(resolve=>setTimeout(resolve,100))");
  await fs.writeFile(path.join(output, name), (await window.webContents.capturePage(undefined, { stayHidden: true })).toPNG());
}
try {
  await app.whenReady();
  window = new BrowserWindow({ show: false, width: 900, height: 650, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  window.webContents.setWindowOpenHandler(() => { throw new Error("Picker must not open a window"); });
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: /^https?:/.test(details.url) }));
  await window.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(`<!doctype html><html><head><style>
    body { margin:0; background:#141414; font:16px sans-serif; color:white; min-height:1000px; }
    button { background:yellow !important; color:red !important; font-size:50px !important; }
    #target { position:absolute; left:190px; top:90px; width:230px; height:300px; }
    #outside { position:absolute; top:20px; left:20px; }
    </style></head><body><button id="outside">Page</button><img id="target" alt="Selected image"></body></html>`));
  await evaluate(`
    globalThis.__roots = [];
    const originalAttach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function(options) { const root = originalAttach.call(this, options); if (this.id === "imagestorage-save-picker") __roots.push(root); return root; };
    globalThis.__root = () => __roots.at(-1);
    globalThis.__requests = []; globalThis.__sent = []; globalThis.__uncertain = []; globalThis.__error = null; globalThis.__delay = 0;
    globalThis.__state = { ready:true, capabilities:{createBoard:true}, session:"session-one", revision:1, activeId:"a", boards:[{id:"a", name:"参考資料", groupName:"制作"}, {id:"b", name:"イラスト", groupName:""}, ...Array.from({length:14}, (_,i) => ({id:"list-"+i, name:"資料 "+(i+1), groupName:""}))] };
    globalThis.chrome = { runtime: { async sendMessage(message) {
      __requests.push(message);
      if (message.action === "inline:status") return { ok:true, state:structuredClone(__state), saved:[...__sent], uncertain:[...__uncertain] };
      if (message.action === "inline:send") { await new Promise(r => setTimeout(r, __delay)); if (__error) return __error; __sent.push(JSON.stringify([message.session,message.boardId])); return {ok:true}; }
      if (message.action === "inline:remove") { await new Promise(r => setTimeout(r, __delay)); if (__error) return __error; __sent=__sent.filter(key=>key!==JSON.stringify([message.session,message.boardId])); return {ok:true,removed:true}; }
      if (message.action === "inline:create") { await new Promise(r => setTimeout(r, __delay)); return __error || {ok:true,boardId:'created-board',name:message.name}; }
      return {ok:true};
    } } };
    globalThis.__source = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="230" height="300"><rect width="230" height="300" fill="#45535c"/><circle cx="115" cy="120" r="54" fill="#94a9ad"/></svg>');
    document.querySelector('#target').src = __source;
    globalThis.__show = ${showInlinePicker.toString()};
    globalThis.__open = async (mode) => { __show({id:"test-request", token:"test-token", imageUrl:__source, sourceUrl:"", error:"", mode}); await new Promise(r => setTimeout(r,30)); };
    document.querySelector('#outside').focus();
  `);
  await check("inline list remains inside the viewport and ignores website button styles", `
    await __open();
    assert(__root().querySelectorAll('.row').length === 16, 'All lists must render');
    const box = __root().querySelector('.panel').getBoundingClientRect();
    assert(box.left >= 8 && box.right <= innerWidth - 8 && box.top >= 8 && box.bottom <= innerHeight - 8, 'Popup out of bounds');
    assert(getComputedStyle(__root().querySelector('.row')).fontSize === '13px', 'Website font leaked');
    assert(getComputedStyle(__root().querySelector('.panel')).backgroundColor === 'rgb(38, 38, 38)', 'Wrong menu background');
    assert(__root().querySelector('.lists').scrollHeight > __root().querySelector('.lists').clientHeight, 'List must scroll');
    assert(document.querySelector('#imagestorage-save-picker').shadowRoot === null, 'Page should not read list details through open shadow DOM');
  `);
  await screenshot("inline-picker-preview.png");
  await check("search filters list and group names without leaving the page", `
    const input = __root().querySelector('input[type="search"]'); input.value = '制作'; input.dispatchEvent(new Event('input'));
    assert(__root().querySelectorAll('.row').length === 1, 'Group filter failed');
    input.value='no-match'; input.dispatchEvent(new Event('input')); assert(__root().querySelector('.empty'), 'No empty state');
    input.value=''; input.dispatchEvent(new Event('input'));
  `);
  await check("saving marks the destination, keeps the menu open, and prevents repeated clicks", `
    __delay=20;
    const row = __root().querySelector('[data-board-id="b"]'); row.click(); row.click();
    await new Promise(r=>setTimeout(r,40));
    assert(__requests.filter(r=>r.action==='inline:send').length===1, 'Duplicate send');
    assert(__root().querySelector('[data-board-id="b"]').getAttribute('aria-pressed')==='true', 'Missing confirmed check');
    assert(__root().querySelector('[data-board-id="b"]').disabled, 'Saved row should not send again');
    __root().querySelector('[data-board-id="a"]').click(); await new Promise(r=>setTimeout(r,40));
    assert(__sent.length===2, 'Second destination failed');
    assert(document.querySelectorAll('#imagestorage-save-picker').length===1, 'Menu closed after save');
  `);
  await check("list scroll does not jump after saving a destination", `
    const lists=__root().querySelector('.lists'); lists.scrollTop=140; const before=lists.scrollTop;
    __root().querySelector('[data-board-id="list-8"]').click(); await new Promise(r=>setTimeout(r,40));
    assert(lists.scrollTop===before, 'Saving reset scroll position');
  `);
  await check("uncertain results disable retries and show their explanation", `
    __error={ok:false,code:'unknown_result',error:'保存先で結果を確認してください'};
    __root().querySelector('[data-board-id="list-9"]').click(); await new Promise(r=>setTimeout(r,40));
    assert(__root().querySelector('[data-board-id="list-9"]').disabled, 'Uncertain row allowed retry');
    assert(__root().querySelector('.status').textContent.includes('結果を確認'), 'Missing unknown-result explanation');
    __error=null;
  `);
  await check("Escape closes the picker and restores keyboard focus", `
    __root().querySelector('input[type="search"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,composed:true,cancelable:true}));
    assert(!document.querySelector('#imagestorage-save-picker'), 'Escape did not close');
    assert(document.activeElement.id==='outside', 'Focus not restored');
  `);
  await check("arrow keys navigate the list and the close button dismisses it", `
    await __open();
    const input=__root().querySelector('input[type="search"]');
    input.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,composed:true,cancelable:true}));
    assert(__root().activeElement.className==='row', 'Arrow key did not focus a row');
    __root().querySelector('.close').click();
    assert(!document.querySelector('#imagestorage-save-picker'), 'Close button did not dismiss');
  `);
  await check("reopening replaces the existing picker and outside clicks dismiss it", `
    await __open(); await __open();
    assert(document.querySelectorAll('#imagestorage-save-picker').length===1, 'Duplicate picker');
    document.querySelector('#outside').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,composed:true}));
    assert(!document.querySelector('#imagestorage-save-picker'), 'Outside click did not close');
  `);
  await check("untrusted list names render as text", `
    __state.boards=[{id:'evil',name:'<img src=x onerror=alert(1)>',groupName:'<script>bad()</script>'}]; __state.revision++;
    await __open();
    assert(!__root().querySelector('.row img, .row script'), 'List name became markup');
    assert(__root().querySelector('.name').textContent.includes('<img'), 'Name was discarded');
    __imageStoragePicker.close();
  `);
  await check("disconnected mode provides reconnection inside the same menu", `
    __state.ready=false; __state.error='ImageStorageを起動してください'; await __open();
    assert(!__root().querySelector('.connect').hidden, 'No reconnect action');
    assert(__root().querySelector('.row').disabled, 'Disconnected row enabled');
    __state.ready=true; __root().querySelector('.connect').click(); await new Promise(r=>setTimeout(r,30));
    assert(__root().querySelector('.connect').hidden, 'Reconnect did not restore menu');
    __imageStoragePicker.close();
  `);
  await check("a strict website style policy does not strip the menu design", `
    const policy=document.createElement('meta'); policy.httpEquiv='Content-Security-Policy'; policy.content="style-src 'none'"; document.head.append(policy);
    await __open();
    assert(getComputedStyle(__root().querySelector('.panel')).backgroundColor==='rgb(38, 38, 38)', 'Strict CSP blocked menu styles');
    assert(getComputedStyle(__root().querySelector('.row')).fontSize==='13px', 'Strict CSP blocked row styles');
    __imageStoragePicker.close();
  `);
  window.setSize(340, 300);
  await check("a compact viewport and hundreds of lists remain usable", `
    __state.boards=Array.from({length:620},(_,i)=>({id:'list-'+i,name:'資料'+i,groupName:''})); __state.revision++;
    await __open();
    const box=__root().querySelector('.panel').getBoundingClientRect();
    assert(box.left>=8 && box.right<=innerWidth-8 && box.top>=8 && box.bottom<=innerHeight-8, 'Small viewport overflow');
    const input=__root().querySelector('input[type="search"]'); input.value='資料619'; input.dispatchEvent(new Event('input'));
    assert(__root().querySelectorAll('.row').length===1, 'Large collection filter failed');
    __root().querySelector('.row').click(); await new Promise(r=>setTimeout(r,40));
    assert(__sent.includes(JSON.stringify(['session-one','list-619'])), 'Last destination not saved');
    __imageStoragePicker.close();
  `);
  window.setSize(900, 650);
  await check("new-list form replaces search, supports Japanese composition, and saves only once", `
    await __open('create');
    const root=__root(), input=root.querySelector('.new-list-name'), button=root.querySelector('.create-submit'), form=root.querySelector('.creation');
    assert(root.activeElement===input, 'Name field not focused');
    assert(getComputedStyle(root.querySelector('footer')).display==='none', 'Search still visible');
    assert(getComputedStyle(root.querySelector('.lists')).display==='none', 'Destination picker still visible');
    assert(button.disabled, 'Blank name allowed');
    input.value='   '; input.dispatchEvent(new Event('input')); assert(button.disabled, 'Whitespace name allowed');
    input.value='日本語の参考資料'; input.dispatchEvent(new Event('input')); assert(!button.disabled, 'Valid name blocked');
    input.dispatchEvent(new CompositionEvent('compositionstart'));
    form.dispatchEvent(new Event('submit',{cancelable:true}));
    assert(!__requests.some(r=>r.action==='inline:create'), 'IME confirmation submitted the form');
    input.dispatchEvent(new CompositionEvent('compositionend'));
    form.dispatchEvent(new Event('submit',{cancelable:true})); form.dispatchEvent(new Event('submit',{cancelable:true}));
    assert(input.disabled && button.disabled, 'Pending form allowed repeated submission');
    await new Promise(r=>setTimeout(r,40));
    assert(__requests.filter(r=>r.action==='inline:create').length===1, 'Duplicate creation');
    assert(button.disabled && button.textContent==='保存しました', 'Confirmed form allowed another creation');
    assert(root.querySelector('.status').textContent.includes('日本語の参考資料'), 'Missing completion');
  `);
  await screenshot("create-list-preview.png");
  await check("cancel and an older app never submit a new-list request", `
    __imageStoragePicker.close(); const before=__requests.filter(r=>r.action==='inline:create').length;
    await __open('create'); __root().querySelector('.close').click();
    assert(__requests.filter(r=>r.action==='inline:create').length===before, 'Cancel created a list');
    __state.capabilities={}; await __open('create');
    const input=__root().querySelector('.new-list-name'); input.value='新規'; input.dispatchEvent(new Event('input'));
    assert(__root().querySelector('.create-submit').disabled, 'Old app accepted creation');
    assert(__root().querySelector('.status').textContent.includes('0.15.45'), 'Missing update instruction');
    __imageStoragePicker.close(); __state.capabilities={createBoard:true};
  `);
  await check("a failed creation allows retry while an uncertain result blocks duplicate lists", `
    await __open('create');
    const input=__root().querySelector('.new-list-name'), form=__root().querySelector('.creation'), button=__root().querySelector('.create-submit');
    input.value='新規'; input.dispatchEvent(new Event('input'));
    __error={ok:false,code:'download_failed',error:'画像を取得できませんでした'};
    form.dispatchEvent(new Event('submit',{cancelable:true})); await new Promise(r=>setTimeout(r,40));
    assert(!button.disabled && !input.disabled, 'Known failure blocked retry');
    assert(__root().querySelector('.status').textContent.includes('取得できません'), 'Missing download error');
    __error={ok:false,code:'unknown_result',error:'結果を確認してください'};
    form.dispatchEvent(new Event('submit',{cancelable:true})); await new Promise(r=>setTimeout(r,40));
    assert(button.disabled && input.disabled, 'Unknown result allowed duplicate list');
    const before=__requests.filter(r=>r.action==='inline:create').length;
    form.dispatchEvent(new Event('submit',{cancelable:true})); await new Promise(r=>setTimeout(r,40));
    assert(__requests.filter(r=>r.action==='inline:create').length===before, 'Unknown result resubmitted');
    __imageStoragePicker.close(); __error=null;
  `);
  await check("opening and cancelling offline creation never launches the app but a valid name can submit", `
    __requests.length=0; __state.ready=false;
    await __open('create');
    assert(__requests.every(r=>r.action!=='inline:status'||r.launch===false), 'Opening form launched the app');
    const input=__root().querySelector('.new-list-name'); input.value='新しい資料'; input.dispatchEvent(new Event('input'));
    assert(!__root().querySelector('.create-submit').disabled, 'Closed app disabled the save button');
    __root().querySelector('.create-submit').click(); await new Promise(r=>setTimeout(r,40));
    const request=__requests.find(r=>r.action==='inline:create');
    assert(request && request.name==='新しい資料' && request.session===undefined, 'Offline submission used a stale session');
    __imageStoragePicker.close(); __requests.length=0;
    await __open('create'); __root().querySelector('.close').click();
    assert(__requests.every(r=>!r.launch && r.action!=='inline:create'), 'Cancel launched the app');
    __state.ready=true;
  `);
  const positionSource = await fs.readFile(new URL("../../browser-extension/src/context-position.js", import.meta.url), "utf8");
  await evaluate(`globalThis.__imageStorageResolveLinkedImage = ${resolveLinkedImage.toString()}; void 0;`);
  await evaluate(positionSource);
  async function rightClick(x, y) {
    window.webContents.sendInputEvent({ type: "mouseMove", x, y });
    window.webContents.sendInputEvent({ type: "mouseDown", x, y, button: "right", clickCount: 1 });
    window.webContents.sendInputEvent({ type: "mouseUp", x, y, button: "right", clickCount: 1 });
    // Wait for native input to finish before installing the popup's outside-click listener.
    await evaluate("new Promise(r=>setTimeout(r,60))");
  }
  await rightClick(270, 150);
  await check("the new-list form opens at the trusted right-click and stays there while the image moves", `
    await new Promise(r=>setTimeout(r,30));
    const point=__imageStorageContextPosition.point;
    assert(point && point.x===270 && point.y===150, 'Trusted right-click was not captured');
    await __open('create');
    let box=__root().querySelector('.panel').getBoundingClientRect();
    assert(Math.abs(box.left-point.x)<1 && Math.abs(box.top-point.y)<1, 'Form used the image edge instead of the cursor');
    document.querySelector('#target').style.left='580px';
    window.dispatchEvent(new Event('resize')); scrollTo(0,40); await new Promise(r=>setTimeout(r,40));
    box=__root().querySelector('.panel').getBoundingClientRect();
    assert(Math.abs(box.left-point.x)<1 && Math.abs(box.top-point.y)<1, 'Form jumped after the page moved');
    document.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:25,clientY:25}));
    assert(__imageStorageContextPosition.point.x===270, 'A synthetic page event replaced the cursor');
  `);
  await screenshot("cursor-position-preview.png");
  await evaluate("__imageStoragePicker.close(); scrollTo(0,0);");
  const edge = await evaluate("({x:innerWidth-2,y:innerHeight-2})");
  await rightClick(edge.x, edge.y);
  await check("cursor placement clamps at the viewport edges instead of clipping the form", `
    await __open('create');
    const box=__root().querySelector('.panel').getBoundingClientRect();
    assert(box.left>=8 && box.top>=8 && box.right<=innerWidth-8 && box.bottom<=innerHeight-8, 'Edge placement clipped');
    assert(Math.abs(box.right-(document.documentElement.clientWidth-8))<1, 'Right edge clamp incorrect');
    __imageStoragePicker.close();
  `);
  window.webContents.setZoomFactor(1.25);
  await evaluate("new Promise(r=>setTimeout(r,50))");
  await rightClick(220, 200);
  await check("browser zoom uses the same CSS coordinates for the pointer and form", `
    await __open('create');
    const point=__imageStorageContextPosition.point, box=__root().querySelector('.panel').getBoundingClientRect();
    assert(Math.abs(box.left-point.x)<1 && Math.abs(box.top-point.y)<1, 'Zoom introduced a cursor offset: '+JSON.stringify({point,box:box.toJSON(),width:innerWidth,height:innerHeight}));
    __imageStoragePicker.close();
  `);
  window.webContents.setZoomFactor(1);
  await evaluate("new Promise(r=>setTimeout(r,50))");
  await evaluate(`
    const frame=document.createElement('iframe'); frame.id='nested-image';
    Object.assign(frame.style,{position:'absolute',left:'100px',top:'250px',width:'300px',height:'160px',border:'5px solid black',transform:'scale(1.1)',transformOrigin:'0 0'});
    document.body.append(frame);
    frame.contentWindow.eval(${JSON.stringify(positionSource)});
  `);
  await rightClick(150, 300);
  await check("frame right-clicks map through borders and scaling into the top-page popup", `
    await new Promise(r=>setTimeout(r,40));
    const point=__imageStorageContextPosition.point;
    assert(Math.abs(point.x-150)<2 && Math.abs(point.y-300)<2, 'Frame position was not translated');
    await __open('create');
    const box=__root().querySelector('.panel').getBoundingClientRect();
    assert(Math.abs(box.left-point.x)<1 && Math.abs(box.top-point.y)<1, 'Frame clipped or misplaced top-page form');
    __imageStoragePicker.close(); document.querySelector('#nested-image').remove();
  `);
  await check("an expired position falls back inside the image rather than beside it", `
    __imageStorageContextPosition.point={x:20,y:20,at:Date.now()-180000};
    document.querySelector('#target').style.left='190px';
    await __open('create');
    const box=__root().querySelector('.panel').getBoundingClientRect(), target=document.querySelector('#target').getBoundingClientRect();
    assert(Math.abs((box.left+box.width/2)-(target.left+target.width/2))<1, 'Missing cursor placed form outside the image');
    __imageStoragePicker.close();
  `);
  let leftPressed = false;
  async function mouse(type, point) {
    if (type === "mouseDown") leftPressed = true;
    if (type === "mouseUp") leftPressed = false;
    window.webContents.sendInputEvent({ type, x: Math.round(point.x), y: Math.round(point.y), modifiers: leftPressed ? ["leftButtonDown"] : [], ...(type === "mouseMove" ? {} : { button: "left", clickCount: 1 }) });
    await evaluate("new Promise(r=>setTimeout(r,20))");
  }
  async function headerPoint() {
    return evaluate("(() => { const box=__root().querySelector('header').getBoundingClientRect(); return {x:box.left+32,y:box.top+18}; })()");
  }
  async function dragHeaderTo(point) {
    const start = await headerPoint();
    await mouse("mouseMove", start); await mouse("mouseDown", start);
    await mouse("mouseMove", point); await mouse("mouseUp", point);
  }
  await evaluate(`(async () => {
    scrollTo(0,0); __requests.length=0;
    __imageStorageContextPosition.point={x:200,y:160,at:Date.now()}; await __open('create');
    const input=__root().querySelector('.new-list-name'); input.value='移動できる資料'; input.dispatchEvent(new Event('input'));
    globalThis.__beforeDrag=__root().querySelector('.panel').getBoundingClientRect().toJSON();
  })()`);
  const grab = await headerPoint();
  await mouse("mouseMove", grab); await mouse("mouseDown", grab);
  const moved = { x: grab.x + 340, y: grab.y + 90 };
  await mouse("mouseMove", moved); await mouse("mouseUp", moved);
  await check("the title drags with a captured pointer beyond the original panel and retains its position after typing and scrolling", `
    const root=__root(), box=root.querySelector('.panel').getBoundingClientRect(), input=root.querySelector('.new-list-name');
    assert(Math.abs(box.left-(__beforeDrag.left+340))<1 && Math.abs(box.top-(__beforeDrag.top+90))<1, 'Header drag did not follow the pointer: '+JSON.stringify({before:__beforeDrag,after:box.toJSON()}));
    assert(!root.querySelector('header').classList.contains('dragging'), 'Pointer release left dragging active');
    assert(root.activeElement===input && input.value==='移動できる資料', 'Dragging disturbed name editing');
    input.value+=' 2'; input.dispatchEvent(new Event('input'));
    scrollTo(0,50); window.dispatchEvent(new Event('resize')); await new Promise(r=>setTimeout(r,40));
    const after=root.querySelector('.panel').getBoundingClientRect();
    assert(after.left===box.left && after.top===box.top, 'Moved panel snapped back during rendering or page scrolling');
    assert(!__requests.some(r=>r.action==='inline:create' || r.launch), 'Moving launched the app or submitted the form');
  `);
  await screenshot("draggable-create-list-preview.png");
  await dragHeaderTo({ x: 1, y: 1 });
  await check("dragging to the top-left edge keeps the panel within reach", `
    const box=__root().querySelector('.panel').getBoundingClientRect();
    assert(box.left===8 && box.top===8, 'Top-left drag escaped the viewport');
  `);
  await dragHeaderTo(await evaluate("({x:innerWidth-1,y:innerHeight-1})"));
  await check("dragging to the bottom-right edge keeps all controls on screen", `
    const box=__root().querySelector('.panel').getBoundingClientRect();
    assert(Math.abs(box.right-(document.documentElement.clientWidth-8))<1 && Math.abs(box.bottom-(innerHeight-8))<1, 'Bottom-right drag escaped the viewport');
  `);
  window.setSize(340, 300);
  await check("a moved panel remains reachable after the browser is resized", `
    await new Promise(r=>setTimeout(r,60));
    const box=__root().querySelector('.panel').getBoundingClientRect();
    assert(box.left>=8 && box.top>=8 && box.right<=document.documentElement.clientWidth-8 && box.bottom<=innerHeight-8, 'Resize clipped the dragged panel');
  `);
  window.setSize(900, 650);
  await evaluate("new Promise(r=>setTimeout(r,60))");
  const fieldPoint = await evaluate("(() => { const box=__root().querySelector('.new-list-name').getBoundingClientRect(); globalThis.__beforeInputDrag=__root().querySelector('.panel').getBoundingClientRect().toJSON(); return {x:box.left+20,y:box.top+15}; })()");
  await mouse("mouseMove", fieldPoint); await mouse("mouseDown", fieldPoint);
  await mouse("mouseMove", { x: fieldPoint.x + 70, y: fieldPoint.y });
  await mouse("mouseUp", { x: fieldPoint.x + 70, y: fieldPoint.y });
  await check("selecting text does not move the panel and saving still works after movement", `
    const box=__root().querySelector('.panel').getBoundingClientRect();
    assert(box.left===__beforeInputDrag.left && box.top===__beforeInputDrag.top, 'Input text selection moved the panel');
    __root().querySelector('.create-submit').click(); await new Promise(r=>setTimeout(r,40));
    const requests=__requests.filter(r=>r.action==='inline:create');
    assert(requests.length===1 && requests[0].name==='移動できる資料 2', 'Moving lost the name or broke saving');
  `);
  const closePoint = await evaluate("(() => { const box=__root().querySelector('.close').getBoundingClientRect(); return {x:box.left+box.width/2,y:box.top+box.height/2}; })()");
  await mouse("mouseMove", closePoint); await mouse("mouseDown", closePoint); await mouse("mouseUp", closePoint);
  await check("the close button remains clickable and reopening starts at the new right-click", `
    assert(!document.querySelector('#imagestorage-save-picker'), 'Close button began dragging instead of closing');
    __imageStorageContextPosition.point={x:180,y:140,at:Date.now()}; await __open('create');
    const box=__root().querySelector('.panel').getBoundingClientRect();
    assert(box.left===180 && box.top===140, 'Reopening retained an old drag position');
  `);
  const cancelStart = await headerPoint();
  await mouse("mouseMove", cancelStart); await mouse("mouseDown", cancelStart);
  await mouse("mouseMove", { x: cancelStart.x + 50, y: cancelStart.y + 30 });
  await check("losing window focus ends dragging without closing the panel", `
    assert(__root().querySelector('header').classList.contains('dragging'), 'Drag never began');
    window.dispatchEvent(new Event('blur'));
    assert(!__root().querySelector('header').classList.contains('dragging'), 'Blur left pointer capture active');
    globalThis.__afterBlur=__root().querySelector('.panel').getBoundingClientRect().toJSON();
  `);
  await mouse("mouseMove", { x: cancelStart.x + 200, y: cancelStart.y + 80 });
  await mouse("mouseUp", { x: cancelStart.x + 200, y: cancelStart.y + 80 });
  await check("movement after cancellation cannot continue dragging a panel", `
    const box=__root().querySelector('.panel').getBoundingClientRect();
    assert(box.left===__afterBlur.left && box.top===__afterBlur.top, 'Cancelled drag kept moving');
    __imageStoragePicker.close();
  `);
  await evaluate(`
    scrollTo(0,0);
    globalThis.__resolveLinked=${resolveLinkedImage.toString()};
    const board=document.createElement('div'); board.id='board-fixture';
    board.innerHTML='<img id="large-image" src="https://i.pinimg.com/736x/main.jpg"><div id="pin-one"><img id="pin-one-image" src="https://i.pinimg.com/236x/01/02/03/one.jpg"><a id="pin-one-link" href="https://www.pinterest.com/pin/200/"><span id="pin-one-overlay"></span></a></div><div id="pin-two"><a id="pin-two-link" href="https://www.pinterest.com/pin/300/"><img id="pin-two-image" src="https://i.pinimg.com/236x/04/05/06/two.jpg"></a></div><a id="text-only-link" href="https://www.pinterest.com/pin/999/">Text link without an image</a>';
    document.body.append(board);
    const style=(id,values)=>Object.assign(document.getElementById(id).style,values);
    style('board-fixture',{position:'absolute',left:'20px',top:'80px',width:'800px',height:'480px',background:'#191919',zIndex:'20'});
    style('large-image',{position:'absolute',left:'0',top:'0',width:'310px',height:'430px'});
    style('pin-one',{position:'absolute',left:'340px',top:'10px',width:'180px',height:'240px'});
    style('pin-two',{position:'absolute',left:'540px',top:'10px',width:'180px',height:'240px'});
    for(const id of ['pin-one-image','pin-two-image']) style(id,{width:'180px',height:'240px',pointerEvents:'none'});
    for(const id of ['pin-one-link','pin-one-overlay','pin-two-link']) style(id,{position:'absolute',inset:'0',display:'block'});
    style('text-only-link',{position:'absolute',left:'340px',top:'300px',width:'200px',height:'30px'});
    void 0;
  `);
  await rightClick(430, 190);
  await check("hover and right-click announce only the selected card image for saved-status lookup", `
    const message=__requests.filter(r=>r.action==='context:image').at(-1);
    assert(message?.imageUrl==='https://i.pinimg.com/236x/01/02/03/one.jpg', 'Wrong membership lookup image: '+JSON.stringify(message));
    assert(message.sourceUrl==='https://www.pinterest.com/pin/200/', 'Wrong membership source');
    assert(!('token' in message) && !('boards' in message), 'Page must not receive saved-list metadata');
  `);
  await check("a trusted right-click on a Pinterest-style overlay finds its sibling image instead of the main or neighbouring image", `
    assert(__imageStorageContextPosition.target?.id==='pin-one-overlay', 'Overlay right-click target was not retained');
    const result=__resolveLinked('https://www.pinterest.com/pin/200/');
    assert(result?.imageUrl==='https://i.pinimg.com/236x/01/02/03/one.jpg', 'Wrong image behind the grid overlay: '+JSON.stringify(result));
    assert(result.sourceUrl==='https://www.pinterest.com/pin/200/', 'Wrong source pin');
  `);
  await rightClick(630, 190);
  await check("untrusted pointer events cannot query images or replace the saved-status selection", `
    const before=__requests.filter(r=>r.action==='context:image').length;
    document.getElementById('pin-one-overlay').dispatchEvent(new PointerEvent('pointerover',{bubbles:true,clientX:430,clientY:190}));
    document.getElementById('pin-one-link').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:430,clientY:190}));
    assert(__requests.filter(r=>r.action==='context:image').length===before, 'Synthetic event sent an image query');
    assert(__requests.filter(r=>r.action==='context:image').at(-1).imageUrl.endsWith('/two.jpg'), 'Old image membership retained');
  `);
  await check("linked images and repeated right-clicks use the newly selected card", `
    const result=__resolveLinked('https://www.pinterest.com/pin/300/');
    assert(result?.imageUrl==='https://i.pinimg.com/236x/04/05/06/two.jpg', 'The previous right-click image was reused');
    document.getElementById('pin-one-link').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:430,clientY:190}));
    assert(__imageStorageContextPosition.target?.id==='pin-two-link', 'Synthetic event replaced trusted image target');
  `);
  await rightClick(450, 395);
  await check("moving to a text-only link clears the previous image membership", `
    const message=__requests.filter(r=>r.action==='context:image').at(-1);
    assert(message.imageUrl==='' && message.sourceUrl==='', 'Text link retained another image status');
  `);
  await check("text links, offscreen or hidden cards, and absent links cannot substitute another visible image", `
    assert(__resolveLinked('https://www.pinterest.com/pin/999/')===null, 'Text link picked a page image');
    assert(__resolveLinked('https://www.pinterest.com/pin/not-on-this-page/')===null, 'Missing card picked a page image');
    const card=document.getElementById('pin-one'); card.style.display='none';
    assert(__resolveLinked('https://www.pinterest.com/pin/200/')===null, 'Hidden card was selected');
    card.style.display=''; card.style.left='-2000px';
    assert(__resolveLinked('https://www.pinterest.com/pin/200/')===null, 'Offscreen card was selected');
    card.style.left='340px';
  `);
  await check("a unique exact link works after extension reload even without the click recorder", `
    __imageStorageContextPosition.point=null; __imageStorageContextPosition.target=null;
    const result=__resolveLinked('https://www.pinterest.com/pin/200/');
    assert(result?.imageUrl==='https://i.pinimg.com/236x/01/02/03/one.jpg', 'Exact-link fallback failed');
  `);
  await check("duplicate links with different images require the actual clicked card rather than guessing", `
    document.getElementById('pin-two-link').href='https://www.pinterest.com/pin/200/';
    assert(__resolveLinked('https://www.pinterest.com/pin/200/')===null, 'Ambiguous cards were guessed');
  `);
  await rightClick(630, 190);
  await check("the click target disambiguates two cards linking to the same pin", `
    assert(__resolveLinked('https://www.pinterest.com/pin/200/')?.imageUrl==='https://i.pinimg.com/236x/04/05/06/two.jpg', 'The clicked duplicate was not used');
    document.getElementById('pin-two-link').href='https://www.pinterest.com/pin/300/';
  `);
  await check("empty, local and script image sources are rejected while the clicked image URL is kept intact", `
    const image=document.getElementById('pin-two-image'), original=image.src;
    for(const source of ['', 'file:///C:/private.png', 'javascript:alert(1)']) {
      image.src=source; await new Promise(r=>setTimeout(r,10));
      assert(__resolveLinked('https://www.pinterest.com/pin/300/')===null, 'Unsafe or missing source accepted: '+source);
    }
    image.src=original; await new Promise(r=>setTimeout(r,10));
    assert(__resolveLinked('https://www.pinterest.com/pin/300/')?.imageUrl===original, 'Image URL was rewritten or re-encoded');
    document.getElementById('board-fixture').remove();
  `);
  await check("a saved row can be unchecked without removing another list's copy", `
    __state={ready:true,session:'remove-test',revision:1,activeId:'a',capabilities:{createBoard:true,removeImage:true},boards:[{id:'a',name:'資料',groupName:''},{id:'b',name:'別リスト',groupName:''}]};
    __sent=['a','b'].map(id=>JSON.stringify(['remove-test',id])); __requests.length=0; __error=null; __uncertain=[]; __delay=20;
    await __open();
    const row=__root().querySelector('[data-board-id="a"]');
    assert(!row.disabled && row.getAttribute('aria-pressed')==='true' && row.title.includes('解除'), 'Saved row cannot be removed');
    row.click(); row.click(); await new Promise(r=>setTimeout(r,40));
    assert(__requests.filter(r=>r.action==='inline:remove').length===1, 'Double click repeated removal');
    assert(__root().querySelector('[data-board-id="a"]').getAttribute('aria-pressed')==='false', 'Check was not cleared');
    assert(__root().querySelector('[data-board-id="b"]').getAttribute('aria-pressed')==='true', 'Other list copy lost its check');
    assert(__root().querySelector('.status').textContent.includes('外しました'), 'No removal acknowledgement');
  `);
  await check("an unchecked row can immediately save the image again", `
    __root().querySelector('[data-board-id="a"]').click(); await new Promise(r=>setTimeout(r,40));
    assert(__requests.filter(r=>r.action==='inline:send').length===1, 'Resave not sent');
    assert(__root().querySelector('[data-board-id="a"]').getAttribute('aria-pressed')==='true', 'Resave did not restore the check');
  `);
  await check("failed removals retain the saved check and unknown outcomes block repeated actions", `
    __error={ok:false,code:'stale_list',error:'保存先を確認してください'};
    __root().querySelector('[data-board-id="a"]').click(); await new Promise(r=>setTimeout(r,40));
    assert(__root().querySelector('[data-board-id="a"]').getAttribute('aria-pressed')==='true', 'Failed removal cleared the check');
    __error={ok:false,code:'unknown_result',error:'解除結果を確認してください'};
    __root().querySelector('[data-board-id="a"]').click(); await new Promise(r=>setTimeout(r,40));
    assert(__root().querySelector('[data-board-id="a"]').disabled, 'Unknown removal allowed a retry');
    __imageStoragePicker.close();
  `);
  await fs.writeFile(path.join(output, "result.json"), JSON.stringify({ ok: true, cases }, null, 2));
  window.destroy(); app.exit(0);
} catch (error) {
  await fs.writeFile(path.join(output, "result.json"), JSON.stringify({ ok: false, cases, error: String(error.stack || error) }, null, 2));
  window?.destroy(); app.exit(1);
}
