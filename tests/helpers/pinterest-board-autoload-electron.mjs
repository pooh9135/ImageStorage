import { app, BrowserWindow } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { showPinterestBoardExporter } from "../../browser-extension/src/pinterest-board-export.js";

const output = process.argv.find(value => value.startsWith("--board-file-test-dir="))?.split("=").slice(1).join("=");
const group = process.argv.find(value => value.startsWith("--board-autoload-group="))?.split("=")[1];
if (!output || !["export", "guard"].includes(group)) throw new Error("Isolated output and test group required");
app.setPath("userData", path.join(output, "profile")); app.disableHardwareAcceleration();
let window;
const cases = [], failures = [];
async function evaluate(source) { return window.webContents.executeJavaScript(`(async()=>{${source}})()`); }
async function check(name, source) {
  await evaluate(`const assert=(value,message)=>{if(!value)throw new Error(message)};${source}`);
  cases.push(name);
}
try {
  await app.whenReady();
  window = new BrowserWindow({ show: false, width: 1100, height: 800, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  window.webContents.setWindowOpenHandler(() => { throw new Error("No extra windows"); });
  const bytes = await sharp({ create: { width: 150, height: 200, channels: 4, background: "#647482" } }).png().toBuffer();
  await window.webContents.session.protocol.handle("https", request => {
    const url = new URL(request.url);
    if (url.hostname === "i.pinimg.com") return new Response(bytes, { headers: { "content-type": "image/png" } });
    if (url.hostname !== "www.pinterest.com") { failures.push(request.url); return new Response("No API access", { status: 403 }); }
    return new Response('<!doctype html><html><head><title>a | Pinterest</title><style>body{margin:20px;background:#171717;color:#eee}img{width:150px;height:200px}.pin{display:inline-block;position:relative;width:150px;height:200px}.pin a{position:absolute;inset:0}main{width:520px}</style></head><body><h1>a</h1><main></main></body></html>', { headers: { "content-type": "text/html; charset=utf-8" } });
  });
  await window.loadURL("https://www.pinterest.com/tester/a/");
  await evaluate(`globalThis.__show=${showPinterestBoardExporter.toString()};globalThis.__roots=[];const attach=Element.prototype.attachShadow;Element.prototype.attachShadow=function(options){const root=attach.call(this,options);if(this.id==='imagestorage-board-exporter')__roots.push(root);return root};globalThis.__root=()=>__roots.at(-1);globalThis.__exports=[];const click=HTMLAnchorElement.prototype.click;HTMLAnchorElement.prototype.click=function(){if(this.download){__exports.push(this.href);return}return click.call(this)};globalThis.__pin=index=>'<div class="pin"><img alt="Pin '+index+'" src="https://i.pinimg.com/236x/aa/bb/cc/'+index.toString(16).padStart(32,'0')+'.png"><a href="/pin/'+index+'/"></a></div>';globalThis.__reset=html=>{globalThis.__imageStorageBoardExporter?.close();document.querySelector('main').innerHTML=html;__exports.length=0};globalThis.__wait=async condition=>{for(let attempt=0;attempt<360;attempt++){if(condition())return;await new Promise(resolve=>setTimeout(resolve,100))}throw new Error('Collector did not settle: '+__root().querySelector('.status').textContent)};`);
  if (group === "export") {
    await check("one export click loads a zero-height virtual feed through its real scroll container", `
      __reset('<span data-test-id="board-pin-count">ピン：５件</span><div id="scroll" style="height:300px;overflow-y:auto"><div id="feed" data-test-id="board-feed" style="height:0;position:relative"><div style="height:1500px"></div></div></div>');const scroller=document.getElementById('scroll'),feed=document.getElementById('feed');feed.insertAdjacentHTML('beforeend',__pin(1));let loaded=1;scroller.addEventListener('scroll',()=>{const desired=Math.min(5,1+Math.floor(scroller.scrollTop/250));while(loaded<desired){feed.insertAdjacentHTML('beforeend',__pin(++loaded))}});__show({boardUrl:location.href});__root().querySelector('.export').click();assert(__exports.length===0,'Unloaded Pins were silently omitted by immediate export');assert(__root().querySelector('.export').disabled,'Export was not locked during full collection');__root().querySelector('.export').click();await __wait(()=>__exports.length===1);const data=await(await fetch(__exports[0])).json();assert(loaded===5&&data.pins.length===5,'Export did not load every Pin');assert(data.capture.complete===true&&data.capture.expectedCount===5,'Japanese board count was not verified');assert(scroller.scrollTop>1000,'Collector used the zero-height feed as its end');assert(__exports.length===1,'Repeated clicks produced duplicate files');
    `);
    await check("a loader outside the feed is awaited before one-click export", `
      __reset('<span data-test-id="board-pin-count">3 Pins</span><div id="scroll" style="height:300px;overflow-y:auto"><div id="feed" data-test-id="board-feed" style="height:1100px">'+__pin(1)+__pin(2)+'</div><div id="loader" role="progressbar" style="height:20px">Loading</div></div>');const scroller=document.getElementById('scroll'),feed=document.getElementById('feed');let scheduled=false;scroller.addEventListener('scroll',()=>{if(!scheduled&&scroller.scrollTop>650){scheduled=true;setTimeout(()=>{feed.insertAdjacentHTML('beforeend',__pin(3));document.getElementById('loader').remove()},6500)}});__show({boardUrl:location.href});__root().querySelector('.export').click();await __wait(()=>__exports.length===1);const data=await(await fetch(__exports[0])).json();assert(scheduled&&data.pins.length===3,'Delayed last Pin was omitted');assert(data.capture.complete===true,'External loader did not finish');
    `);
    await check("a board with no initially rendered Pins can begin full export", `
      __reset('<span data-test-id="board-pin-count">2 Pins</span><div id="scroll" style="height:300px;overflow-y:auto"><div id="feed" data-test-id="board-feed" style="height:850px"></div></div>');setTimeout(()=>document.getElementById('feed').insertAdjacentHTML('beforeend',__pin(1)+__pin(2)),1100);__show({boardUrl:location.href});assert(!__root().querySelector('.export').disabled,'Full export cannot start while initial Pins are loading');__root().querySelector('.export').click();await __wait(()=>__exports.length===1);const data=await(await fetch(__exports[0])).json();assert(data.pins.length===2&&data.capture.complete===true,'Initial loading was not awaited');
    `);
  } else {
    await check("stopping an export cancels the pending file without discarding collected Pins", `
      __reset('<span data-test-id="board-pin-count">50 Pins</span><div style="height:300px;overflow-y:auto"><div data-test-id="board-feed" style="height:4000px">'+__pin(1)+'</div></div>');__show({boardUrl:location.href});__root().querySelector('.export').click();assert(__exports.length===0,'Partial file downloaded before cancellation');await new Promise(resolve=>setTimeout(resolve,800));__root().querySelector('.auto').click();await new Promise(resolve=>setTimeout(resolve,1800));assert(__exports.length===0,'Stopped export still wrote a file');assert(__root().querySelector('.count').textContent.startsWith('1枚'),'Cancellation erased Pins');
    `);
    await check("known count mismatches never silently produce a partial full-board file", `
      __reset('<span data-test-id="board-pin-count">2 Pins</span><div data-test-id="board-feed">'+__pin(1)+'</div><h2>More ideas</h2><div data-test-id="related-pins">'+__pin(99)+'</div>');__show({boardUrl:location.href});__root().querySelector('.export').click();await __wait(()=>!__root().querySelector('.export').disabled);assert(__exports.length===0,'Count mismatch silently wrote a partial file');assert(__root().querySelector('.status').textContent.includes('一致していません'),'Missing clear incomplete-board report');assert(__root().querySelector('.count').textContent.startsWith('1枚'),'Recommendation entered full-board collection');__root().querySelector('.partial-export').click();const data=await(await fetch(__exports[0])).json();assert(data.pins.length===1&&data.capture.complete===false,'Explicit partial export was not marked incomplete');
    `);
    await check("closing during one-click export leaves no late file or collection panel", `
      __reset('<div style="height:300px;overflow-y:auto"><div data-test-id="board-feed" style="height:3000px">'+__pin(1)+'</div></div>');__show({boardUrl:location.href});__root().querySelector('.export').click();__root().querySelector('.close').click();await new Promise(resolve=>setTimeout(resolve,1600));assert(__exports.length===0&&!document.getElementById('imagestorage-board-exporter'),'Closed export left a late download or panel');
    `);
    await check("a verified scan cannot write a full-board file after navigation", `
      __reset('<span data-test-id="board-pin-count">1 Pin</span><div data-test-id="board-feed">'+__pin(1)+'</div>');__show({boardUrl:location.href});__root().querySelector('.export').click();await __wait(()=>__exports.length===1);__exports.length=0;history.pushState({},'', '/tester/another/');__root().querySelector('.export').click();await new Promise(resolve=>setTimeout(resolve,700));assert(__exports.length===0,'Navigation reused a previous board scan');assert(__root().querySelector('.status').textContent.includes('開き直して'),'Navigation did not explain how to resume');
    `);
  }
  await evaluate("globalThis.__imageStorageBoardExporter?.close()");
  if (failures.length) throw new Error("Unexpected API/network use");
  await fs.writeFile(path.join(output, "result.json"), JSON.stringify({ ok: true, group, cases, apiRequests: failures.length, visibleWindows: BrowserWindow.getAllWindows().filter(win => win.isVisible()).length }, null, 2)); window.destroy(); app.exit(0);
} catch (error) { await fs.writeFile(path.join(output, "result.json"), JSON.stringify({ ok: false, group, cases, error: String(error.stack || error), apiRequests: failures.length }, null, 2)); window?.destroy(); app.exit(1); }
