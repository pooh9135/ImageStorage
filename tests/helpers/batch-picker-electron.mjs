import { app, BrowserWindow } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { collectPageImages } from "../../browser-extension/src/batch-collector.js";
import { showBatchPicker } from "../../browser-extension/src/batch-picker.js";

const output = process.argv.find(value => value.startsWith("--batch-test-dir="))?.slice("--batch-test-dir=".length);
if (!output) throw new Error("Disposable output required");
app.setPath("userData", path.join(output, "profile")); app.disableHardwareAcceleration();
let window;
const cases = [];
async function evaluate(source) { return window.webContents.executeJavaScript(`(async()=>{${source}})()`); }
async function check(name, source) { await evaluate(`const assert=(value,message)=>{if(!value)throw new Error(message)};${source}`); cases.push(name); }
try {
  await app.whenReady();
  window = new BrowserWindow({ show: false, width: 980, height: 780, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  window.webContents.setWindowOpenHandler(() => { throw new Error("No new windows allowed"); });
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: /^https?:/.test(details.url) }));
  const images = [];
  for (const background of ["#38566e", "#81554c", "#658361"]) images.push("data:image/png;base64," + (await sharp({ create: { width: 220, height: 280, channels: 4, background } }).png().toBuffer()).toString("base64"));
  await window.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(`<!doctype html><html><head><base href="https://www.pinterest.com/"><style>body{background:#151515;color:white;min-height:2000px;margin:20px;font:16px sans-serif}button{background:yellow!important;color:red!important;font-size:48px!important}.card{display:inline-block;position:relative;width:180px;height:230px}img{width:180px;height:230px}.overlay{position:absolute;inset:0}</style></head><body><button id="page-button">Page button</button><br><a href="/pin/1/"><img id="first" src="${images[0]}"></a><div class="card"><img id="second" src="${images[1]}"><a class="overlay" href="/pin/2/"> </a></div><a href="/pin/1/"><img src="${images[0]}"></a><img src="${images[0]}" style="display:none"><img src="${images[1]}" style="width:32px;height:32px"><img src="https://example.test/not-loaded.png"></body></html>`));
  await evaluate(`await Promise.all([...document.images].map(image=>image.complete?null:new Promise(resolve=>{image.onload=resolve;image.onerror=resolve})));globalThis.__collect=${collectPageImages.toString()};globalThis.__show=${showBatchPicker.toString()};globalThis.__images=${JSON.stringify(images)};globalThis.__roots=[];const attach=Element.prototype.attachShadow;Element.prototype.attachShadow=function(options){const root=attach.call(this,options);if(this.id==='imagestorage-batch-picker')__roots.push(root);return root};globalThis.__root=()=>__roots.at(-1);`);
  await check("loaded image discovery ignores icons, hidden images and duplicate variants", `
    const collection=__collect();assert(collection.images.length===2,'Unexpected image candidates');assert(collection.images[0].sourceUrl==='https://www.pinterest.com/pin/1/','Wrong direct image source');assert(collection.images[1].sourceUrl==='https://www.pinterest.com/pin/2/','Overlay source was not resolved');
  `);
  await check("newly loaded offscreen images are collected without scrolling or fetching", `
    const card=document.createElement('a');card.href='/pin/3/';card.style='position:absolute;top:1400px';const image=document.createElement('img');image.src=__images[2];card.append(image);document.body.append(card);await image.decode();const before=scrollY;assert(__collect().images.length===3,'Loaded image missing');assert(scrollY===before,'Discovery scrolled the page');
  `);
  await evaluate(`
    globalThis.__record={id:'batch-id',running:false,stopRequested:false,boardId:'',images:__collect().images.map((image,index)=>({...image,id:'image-'+index,status:'idle',error:''}))};
    globalThis.__state={ready:true,session:'session',activeId:'a',boards:[{id:'a',name:'現在のリスト'},{id:'b',name:'保存先',groupName:'資料'}]};globalThis.__requests=[];
    globalThis.chrome={runtime:{sendMessage:async message=>{__requests.push(message);if(message.action==='batch:start'){__record.running=true;__record.boardId=message.boardId;for(const image of __record.images)if(message.selected.includes(image.id))image.status='queued'}if(message.action==='batch:stop'){__record.stopRequested=true;__record.running=false;for(const image of __record.images)if(image.status==='queued')image.status='cancelled'}return {ok:true,batch:structuredClone(__record),state:structuredClone(__state)}}}};
    __show({id:'batch-id',token:'secret'});await new Promise(resolve=>setTimeout(resolve,50));
  `);
  await check("the same-page picker isolates its styling and leaves the page controls intact", `
    const panel=__root().querySelector('.panel');assert(getComputedStyle(panel).borderRadius==='4px','Incorrect corner radius');assert(getComputedStyle(__root().querySelector('.save')).backgroundColor==='rgb(12, 12, 12)','Host CSS leaked into save button');assert(getComputedStyle(document.getElementById('page-button')).backgroundColor==='rgb(255, 255, 0)','Page styles changed');assert(__root().querySelectorAll('.image').length===3,'Gallery did not render');assert(__requests.every(request=>request.action==='batch:status'),'Opening the gallery sent a save');
  `);
  await check("select all and clear affect only explicit selections", `
    const previews=[...__root().querySelectorAll('.image img')];globalThis.__previews=previews;const all=__root().querySelector('.all'),clear=__root().querySelector('.clear');all.click();assert(__root().querySelectorAll('input:checked').length===3,'Select all failed');assert(__root().querySelector('.selection > span').textContent==='3枚中 3枚を選択','Image count is missing');clear.click();assert(__root().querySelector('.save').disabled,'Empty selection can be saved');assert(previews.every((image,index)=>image===__root().querySelectorAll('.image img')[index]),'Selection recreated thumbnails');
  `);
  // Trusted pointer clicks exercise shadow DOM labels and checkbox behavior.
  const point = await evaluate(`const rect=__root().querySelectorAll('.image')[1].getBoundingClientRect();return {x:Math.round(rect.left+rect.width/2),y:Math.round(rect.top+rect.height/2)}`);
  window.webContents.sendInputEvent({ type: "mouseMove", ...point });
  window.webContents.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 1 }); window.webContents.sendInputEvent({ type: "mouseUp", ...point, button: "left", clickCount: 1 });
  await evaluate(`for(let attempt=0;attempt<25&&!__root().querySelector('input[data-image-id="image-1"]').checked;attempt++)await new Promise(resolve=>setTimeout(resolve,20));`);
  await check("clicking a preview selects that image without opening its link", `
    assert(__root().querySelectorAll('input:checked').length===1,'Preview click did not toggle its checkbox');assert(__root().querySelector('input[data-image-id="image-1"]').checked,'Wrong preview selected');
  `);
  await check("saving carries only the selected IDs and chosen list, and blocks repeated clicks", `
    __root().querySelector('select').value='b';const save=__root().querySelector('.save');save.click();save.click();await new Promise(resolve=>setTimeout(resolve,50));const starts=__requests.filter(request=>request.action==='batch:start');assert(starts.length===1,'Repeated save');assert(starts[0].selected.join(',')==='image-1'&&starts[0].boardId==='b','Wrong images or destination');assert(save.disabled,'Save button active during batch');assert(!__root().querySelector('.stop').hidden,'No stop control');
  `);
  await check("stop retains unprocessed selections so they can be resumed", `
    __root().querySelector('.stop').click();await new Promise(resolve=>setTimeout(resolve,50));assert(__requests.some(request=>request.action==='batch:stop'),'Stop not sent');assert(__root().querySelector('input[data-image-id="image-1"]').checked,'Unsent image selection lost');assert(!__root().querySelector('.save').disabled,'Unsent selection cannot resume');
  `);
  await check("saved, existing and unknown results are labelled and cannot be reselected", `
    __record.images[0].status='saved';__record.images[1].status='existing';__record.images[2].status='unknown';__record.images[2].error='結果を本体で確認';await new Promise(resolve=>setTimeout(resolve,800));assert([...__root().querySelectorAll('input')].every(input=>input.disabled),'Completed or unknown result can be selected');assert(__root().querySelector('.status').textContent.includes('成功 1枚・保存済み 1枚'),'Results summary missing');assert(__previews.every((image,index)=>image===__root().querySelectorAll('.image img')[index]),'Progress recreated thumbnails');
  `);
  await window.webContents.capturePage(undefined, { stayHidden: true }); await evaluate("await new Promise(resolve=>setTimeout(resolve,100))");
  await fs.writeFile(path.join(output, "batch-picker.png"), (await window.webContents.capturePage(undefined, { stayHidden: true })).toPNG());
  await check("the panel stays within the viewport after resize", `
    window.dispatchEvent(new Event('resize'));const box=document.getElementById('imagestorage-batch-picker').getBoundingClientRect();assert(box.left>=0&&box.top>=0&&box.right<=innerWidth&&box.bottom<=innerHeight,'Panel outside viewport');
  `);
  await check("closing cancels unprocessed work and removes the panel", `
    __root().querySelector('.close').click();await new Promise(resolve=>setTimeout(resolve,20));assert(!document.getElementById('imagestorage-batch-picker'),'Picker did not close');assert(__requests.at(-1).action==='batch:stop','Closing did not stop queued work');
  `);
  const chooserHtml = await fs.readFile(new URL("../../browser-extension/src/chooser.html", import.meta.url), "utf8");
  const chooserCode = await fs.readFile(new URL("../../browser-extension/src/chooser.js", import.meta.url), "utf8");
  const chooserMarkup = chooserHtml.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  async function mountChooser(available) {
    await evaluate(`document.body.innerHTML=${JSON.stringify(chooserMarkup)};globalThis.chrome.runtime.sendMessage=async message=>message.action==='board:available'?{ok:true,available:${available}}:message.action==='batch:open'?{ok:false,error:'このページでは利用できません'}:message.action==='pending'?{ok:true,image:null}:{ok:true,state:__state};`);
    await evaluate(chooserCode);
  }
  await mountChooser(false);
  await check("toolbar errors leave batch opening available for another attempt", `
    assert(document.getElementById('export-board').hidden,'Export shown outside the board');const button=document.getElementById('open-batch');button.click();await new Promise(resolve=>setTimeout(resolve,30));assert(!button.disabled,'Failed action permanently disabled the toolbar button');assert(document.getElementById('status').textContent.includes('利用できません'),'No actionable page error');
  `);
  await mountChooser(true);
  await check("the toolbar offers export on a confirmed board", `assert(!document.getElementById('export-board').hidden,'Board export is hidden');`);
  await fs.writeFile(path.join(output, "result.json"), JSON.stringify({ ok: true, cases }, null, 2)); window.destroy(); app.exit(0);
} catch (error) { await fs.writeFile(path.join(output, "result.json"), JSON.stringify({ ok: false, cases, error: String(error.stack || error) }, null, 2)); window?.destroy(); app.exit(1); }
