/// <reference types="vite/client" />
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from 'pdfjs-dist';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { vectorize } from '../../src/engine/vector.ts';
import { scanForSimilar } from '../../src/engine/scan.ts';
import type { RasterPage } from '../../src/engine/ports.ts';
import type { Pt } from '../../src/engine/types.ts';
import { anchoredScroll, clampZoom, fitScale, pageAnchor, type XY } from './workspace-view.ts';
import { getTrade } from './trades.mjs';
import { priceQuantities } from './pricing.mjs';
import { contains, hitId, includedHits, quantities, replaceScan, type Bounds, type SheetState, type SymbolEntry, type EvidenceHit } from './workspace-model.ts';
pdfjs.GlobalWorkerOptions.workerSrc=workerUrl;
const $=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
const button=(id:string)=>$<HTMLButtonElement>(id), input=(id:string)=>$<HTMLInputElement>(id);
const scrollArea=$('scroll-area');
let activeTrade=getTrade(new URLSearchParams(window.location.search).get('trade'));
function applyTradeLabels(){
 $<HTMLSelectElement>('trade-select').value=activeTrade.id;
 $('trade-badge').textContent=activeTrade.name.toUpperCase()+' / REAL PDF';
 $('trade-heading').textContent=activeTrade.name.toUpperCase()+' / CURRENT PAGE';
 input('code').value=activeTrade.items[0].code;input('description').value=activeTrade.items[0].description;
 $('trade-note').textContent='Suggested codes only. '+activeTrade.outside+' are outside this counting workspace.';
}
applyTradeLabels();
const canvas=$<HTMLCanvasElement>('drawing'),overlay=$<SVGSVGElement & HTMLElement>('overlay');
let doc:PDFDocumentProxy|null=null,bytes:Uint8Array|null=null,documentHash='',fileName='',pageNum=1,page:PDFPageProxy|null=null,viewport:PageViewport|null=null,zoom=1,busy=false,mode='review',selected:string|null=null,currentCode=activeTrade.items[0].code;
let sheets:Record<number,SheetState>={},rates:Record<string,{material:string;labour:string;source:string}>={};
let drag:Pt|null=null,preview:Bounds|null=null,sequence=0;
let spaceDown=false,zooming=false,fitMode:'page'|'width'|null='page';
let panStart:{screen:XY;scroll:XY;pointerId:number}|null=null;
const touches=new Map<number,XY>();
let pinch:{distance:number;zoom:number;anchor:XY}|null=null;
let zoomRequest:{target:number;anchor:XY;screen:XY}|null=null;
const escape=(s:unknown)=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
function makeEntry(code:string,description=''):SymbolEntry{return{code,description,exemplar:null,assessed:false,provider:null,note:'Not scanned',hits:[],truncated:false};}
const sheet=()=>sheets[pageNum]??(sheets[pageNum]={exclusions:[],entries:activeTrade.items.map(i=>makeEntry(i.code,i.description))});
function entry():SymbolEntry{let e=sheet().entries.find(e=>e.code===currentCode);if(!e){e={code:currentCode,description:'',exemplar:null,assessed:false,provider:null,note:'Not scanned',hits:[],truncated:false};sheet().entries.push(e);}return e;}
function say(text:string,error=false){$('status').textContent=text;$('status').dataset.error=String(error);}
function setBusy(value:boolean){busy=value;syncControls();}
function syncControls(){const ready=!!doc&&!busy;for(const id of ['mode-pan','mode-review','mode-exclude','mode-example','mode-manual','select-type','zoom-in','zoom-out','fit','fit-width','save-json','save-csv','save-pdf'])button(id).disabled=!ready;button('prev').disabled=!ready||pageNum<=1;button('next').disabled=!ready||pageNum>=(doc?.numPages??0);input('page-number').disabled=!ready;button('undo-exclusion').disabled=!ready||!sheet().exclusions.length;button('scan').disabled=!ready||!page||!entry().exemplar||!sheet().exclusions.length;$<HTMLSelectElement>('type-select').disabled=!ready;for(const id of ['pdf-input','empty-input'])input(id).disabled=busy;button('sample').disabled=busy;$<HTMLSelectElement>('trade-select').disabled=busy;input('zoom-percent').disabled=!ready;button('zoom-legend').disabled=!ready||!sheet().exclusions.length;button('zoom-selection').disabled=!ready||!(selected||entry().exemplar);}
function setMode(next:string){mode=next;overlay.dataset.mode=mode;for(const m of ['pan','review','exclude','example','manual'])button('mode-'+m).setAttribute('aria-pressed',String(m===mode));if(next==='pan')say('Drag the drawing to move around. Pinch or Ctrl/⌘ + wheel zooms around the pointer.');if(next==='exclude')say('Drag a rectangle around the entire legend. Add more exclusions for repeated legends or schedules.');if(next==='example')say('Click the centre of the symbol example inside your legend.');if(next==='manual')say('Click a missed installation to add one manually confirmed item for '+currentCode+'.');}
function view(p:Pt):Pt{const [x,y]=viewport!.convertToViewportPoint(p.x,p.y);return {x,y};}
function eventPoint(event:PointerEvent):Pt{const r=overlay.getBoundingClientRect();const x=(event.clientX-r.left)*viewport!.width/r.width,y=(event.clientY-r.top)*viewport!.height/r.height;const [px,py]=viewport!.convertToPdfPoint(x,y);return{x:px,y:py};}
function svgRect(b:Bounds,temporary=false){const corners=[view({x:b.x0,y:b.y0}),view({x:b.x1,y:b.y1})];return `<rect x="${Math.min(corners[0].x,corners[1].x)}" y="${Math.min(corners[0].y,corners[1].y)}" width="${Math.abs(corners[1].x-corners[0].x)}" height="${Math.abs(corners[1].y-corners[0].y)}" fill="${temporary?'#e7774120':'#7d965b20'}" stroke="${temporary?'#e77741':'#768b50'}" stroke-width="1" stroke-dasharray="4 3"/>`;}
function drawOverlay(){if(!viewport)return;const hits=includedHits(sheet());overlay.innerHTML=sheet().exclusions.map(b=>svgRect(b)).join('')+(preview?svgRect(preview,true):'')+sheet().entries.filter(e=>e.exemplar).map(e=>{const p=view(e.exemplar!);return `<path d="M${p.x-9},${p.y}h18M${p.x},${p.y-9}v18" stroke="#217d6e" stroke-width="2"/>`;}).join('')+hits.map((h,i)=>{const p=view(h),colour=h.decision==='rejected'?'#b0523f':h.decision==='unresolved'?'#c98b22':h.manual||h.decision==='confirmed'?'#24846b':'#247aa2';return `<g><circle data-hit="${escape(h.id)}" cx="${p.x}" cy="${p.y}" r="${selected===h.id?12:10}" fill="${colour}20" stroke="${colour}" stroke-width="${selected===h.id?2.5:1.3}" ${h.decision==='rejected'?'stroke-dasharray="3 2"':''}/><text x="${p.x+11}" y="${p.y-10}" fill="${colour}" font-size="9" pointer-events="none">${i+1}</text></g>`;}).join('');}
function money(cents:number){return new Intl.NumberFormat('en-AU',{style:'currency',currency:$<HTMLSelectElement>('currency').value}).format(cents/100);}
function updatePricing(){const estimate=priceQuantities(quantities(sheet()),rates);$('price-lines').innerHTML=estimate.lines.map(l=>`<div><span>${escape(l.code)} · ${l.quantity??'unassessed'}</span><span>${l.totalCents===null?'Not priced':money(l.totalCents)}</span></div>`).join('');$('price-total').textContent=`${estimate.complete?'Draft subtotal':'Partial priced subtotal'}: ${money(estimate.pricedSubtotalCents)}`;$('price-note').textContent=estimate.complete?'Current page supported quantities priced. Check evidence and scope before using this draft.':'Incomplete: some types need rates or assessment, or have unresolved items. These gaps are excluded from the subtotal.';}
function update(){const e=entry(),hits=includedHits(sheet());input('code').value=e.code;input('description').value=e.description;const r=rates[currentCode];input('material').value=r?.material??'';input('labour').value=r?.labour??'';input('rate-source').value=r?.source??'';$<HTMLSelectElement>('type-select').innerHTML=sheet().entries.map(t=>`<option value="${escape(t.code)}" ${t.code===currentCode?'selected':''}>${escape(t.code)}</option>`).join('');$('exemplar-note').textContent=e.exemplar?`Example: (${e.exemplar.x.toFixed(1)}, ${e.exemplar.y.toFixed(1)}) PDF points · page ${pageNum}`:'No example selected. Mark the legend, then choose Pick example.';$('quantities').innerHTML=quantities(sheet()).map(q=>`<tr><td><button data-code="${escape(q.code)}">${escape(q.code)}</button></td><td>${q.supported??'Not assessed'}</td><td>${q.unresolved??'Unknown'}</td></tr>`).join('');$('quantities').querySelectorAll<HTMLButtonElement>('[data-code]').forEach(b=>b.onclick=()=>{currentCode=b.dataset.code!;selected=null;update();});$('method-note').textContent=`${e.provider?'Method: '+e.provider+' · ':''}${e.note}${e.truncated?' · INCOMPLETE: provider truncated results.':''} Current page only.`;
 const hit=hits.find(h=>h.id===selected);$('hit-detail').innerHTML=hit?`<strong>${escape(hit.code)} · hit ${hits.indexOf(hit)+1}</strong><br>Page ${hit.page} · (${hit.x.toFixed(1)}, ${hit.y.toFixed(1)}) PDF pt<br>${escape(hit.method)} · ${escape(hit.decision)}<br><span class="fine">${escape(hit.id.slice(-70))}</span>`:'Select a numbered hit to inspect or correct it.';for(const id of ['confirm','flag','reject'])button(id).disabled=!hit||busy;$('hit-list').innerHTML=hits.map((h,i)=>`<button data-id="${escape(h.id)}">${i+1} · ${escape(h.code)} · ${escape(h.decision)}</button>`).join('');$('hit-list').querySelectorAll<HTMLButtonElement>('[data-id]').forEach(b=>b.onclick=()=>selectHit(b.dataset.id!));drawOverlay();updatePricing();syncControls();}
function selectHit(id:string){selected=id;const hit=includedHits(sheet()).find(h=>h.id===id);if(hit)currentCode=hit.code;update();}
async function paint(fit=false){if(!doc)return;setBusy(true);const seq=++sequence;try{page=await doc.getPage(pageNum);viewport=page.getViewport({scale:1});if(fit){fitMode=fitMode??'page';zoom=fitScale({x:viewport.width,y:viewport.height},{x:scrollArea.clientWidth,y:scrollArea.clientHeight||600},fitMode);}const vp=page.getViewport({scale:zoom});const ratio=Math.min(window.devicePixelRatio||1,2);const renderScale=Math.min(zoom*ratio,Math.sqrt(25_000_000/(viewport.width*viewport.height)));const rv=page.getViewport({scale:renderScale});canvas.width=Math.floor(rv.width);canvas.height=Math.floor(rv.height);const wrap=$('page-wrap');wrap.hidden=false;wrap.style.width=vp.width+'px';wrap.style.height=vp.height+'px';overlay.setAttribute('viewBox',`0 0 ${viewport.width} ${viewport.height}`);const ctx=canvas.getContext('2d')!;await page.render({canvas,canvasContext:ctx,viewport:rv}).promise;if(seq!==sequence)return;$('empty').hidden=true;input('page-number').value=String(pageNum);input('page-number').max=String(doc.numPages);$('page-total').textContent='/ '+doc.numPages;input('zoom-percent').value=String(Math.round(zoom*100));entry();update();}catch(error){page=null;viewport=null;$('page-wrap').hidden=true;throw error;}finally{setBusy(false);}}
async function openFile(data:Uint8Array,name:string){if(busy)return;setBusy(true);say('Opening PDF on this device…');let candidate:PDFDocumentProxy|null=null;let installed=false;try{candidate=await pdfjs.getDocument({data:data.slice(),useSystemFonts:true,cMapUrl:'/pdf-resources/cmaps/',cMapPacked:true,standardFontDataUrl:'/pdf-resources/standard_fonts/',wasmUrl:'/pdf-resources/wasm/'}).promise;await candidate.getPage(1);const digest=await crypto.subtle.digest('SHA-256',data.slice().buffer);const hash=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');if(doc)await doc.destroy();doc=candidate;candidate=null;installed=true;bytes=data;documentHash=hash;fileName=name;pageNum=1;sheets={};rates={};currentCode=activeTrade.items[0].code;selected=null;panStart=null;pinch=null;touches.clear();fitMode='page';$('file-title').textContent=name;await paint(true);scrollArea.scrollTop=0;scrollArea.scrollLeft=0;setMode('exclude');say('Drawing open. Drag a rectangle around the legend to exclude its examples from installation counts.');}catch(error){if(candidate)await candidate.destroy();if(installed){await doc?.destroy();doc=null;page=null;viewport=null;bytes=null;documentHash='';sheets={};rates={};$('page-wrap').hidden=true;$('empty').hidden=false;$('file-title').textContent='No drawing open';$('quantities').innerHTML='<tr><td colspan="3">No drawing assessed.</td></tr>';$('price-total').textContent='Partial priced subtotal: —';}say('Could not open PDF: '+errorMessage(error)+'. Try an unencrypted PDF.',true);}finally{setBusy(false);input('pdf-input').value='';input('empty-input').value='';}}
function errorMessage(error:unknown){return error instanceof Error?error.message:String(error);}
async function raster(scale:number):Promise<RasterPage>{const p=page!,vp=p.getViewport({scale});if(vp.width*vp.height>25_000_000)throw Error('Raster fallback exceeds the 25-megapixel limit on this sheet. Try a smaller digital PDF or count manually');const c=document.createElement('canvas');c.width=Math.max(1,Math.floor(vp.width));c.height=Math.max(1,Math.floor(vp.height));const ctx=c.getContext('2d',{willReadFrequently:true})!;await p.render({canvas:c,canvasContext:ctx,viewport:vp}).promise;return{width:c.width,height:c.height,data:ctx.getImageData(0,0,c.width,c.height).data,toPdf:(x,y)=>{const [px,py]=vp.convertToPdfPoint(x,y);return{x:px,y:py};},toRaster:(x,y)=>{const [px,py]=vp.convertToViewportPoint(x,y);return{x:px,y:py};}};}
async function scan(){if(!doc||!page||busy||!entry().exemplar)return;const e=entry();setBusy(true);say('Scanning this page with your selected example…');await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));try{const result=await scanForSimilar(pageNum,e.exemplar!,{detector:async()=>null,renderRaster:async(_n,scale)=>raster(scale),vector:async()=>{const layers=await doc!.getOptionalContentConfig();return vectorize(await page!.getOperatorList(),pdfjs.OPS,{isVisible:g=>layers.isVisible(g as never)});},warn:message=>console.warn('Legend:',message)});if('error'in result)throw Error(result.error);e.provider=result.provider;e.note=result.note??'Scan completed';e.truncated=!!result.truncated;replaceScan(e,result.hits,documentHash,pageNum);let conflicts=0;for(const h of e.hits){if(sheet().exclusions.some(b=>contains(h,b)))continue;for(const other of includedHits(sheet()).filter(q=>q.code!==e.code&&q.decision!=='rejected')){if(Math.hypot(h.x-other.x,h.y-other.y)<=3){h.decision='unresolved';other.decision='unresolved';conflicts++;}}}setMode('review');update();const count=quantities(sheet()).find(q=>q.code===e.code)!.supported;say(`${e.code}: ${count} supported detections · ${result.provider}. Legend regions excluded.${conflicts?' Overlapping types flagged uncertain.':''}${e.truncated?' Results were truncated; this is an incomplete count.':''} ${count===0?'No installed matches were found. This does not establish that the drawing contains no equipment. Try another example or add missed items manually.':'Review matches and check for missed items.'}`,count===0);}catch(error){say('Scan failed: '+errorMessage(error)+'. Previous results, if any, are retained; no new quantity was added.',true);}finally{setBusy(false);update();}}
function download(name:string,data:BlobPart,type:string){const url=URL.createObjectURL(new Blob([data],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function snapshot(){return{schemaVersion:1,kind:'real-pdf-takeoff',source:{fileName,sha256:documentHash},page:pageNum,coordinateFrame:'pdf-points-bottom-left',createdAt:new Date().toISOString(),cloudCalls:0,currency:$<HTMLSelectElement>('currency').value,scope:'current-page-supported-quantities',trade:activeTrade.id,exclusions:['unresolved hits','unassessed quantities','tax','markup','cabling','accessories','other job costs'],sheet:sheet(),displayHits:includedHits(sheet()).map((h,i)=>({...h,number:i+1})),quantities:quantities(sheet()),rates,pricing:priceQuantities(quantities(sheet()),rates)};}
for(const id of ['pdf-input','empty-input'])input(id).onchange=async()=>{const f=input(id).files?.[0];if(!f)return;try{await openFile(new Uint8Array(await f.arrayBuffer()),f.name);}catch(error){say(errorMessage(error),true);}};
button('sample').onclick=async()=>{if(busy)return;try{activeTrade=getTrade('electrical');applyTradeLabels();const r=await fetch('output/dev-clean/drawing.pdf');if(!r.ok)throw Error('Sample not available');await openFile(new Uint8Array(await r.arrayBuffer()),'sample-electrical.pdf');}catch(error){say(errorMessage(error),true);}};
for(const m of ['pan','review','exclude','example','manual'])button('mode-'+m).onclick=()=>{if(!busy)setMode(m);};
button('undo-exclusion').onclick=()=>{sheet().exclusions.pop();update();say('Last exclusion removed. Quantities recalculated; inspect any newly included legend hits.');};
overlay.addEventListener('pointerdown',(event:PointerEvent)=>{if((busy&&!zooming)||!viewport||!doc)return;
 if(event.pointerType==='touch'&&(mode==='pan'||mode==='review')){
  touches.set(event.pointerId,{x:event.clientX,y:event.clientY});overlay.setPointerCapture(event.pointerId);
  if(touches.size===2){const [a,b]=[...touches.values()];const centre={x:(a.x+b.x)/2,y:(a.y+b.y)/2};pinch={distance:Math.max(1,Math.hypot(a.x-b.x,a.y-b.y)),zoom,anchor:pageAnchor(centre,overlay.getBoundingClientRect(),{x:viewport.width,y:viewport.height})};panStart=null;drag=null;preview=null;overlay.dataset.panning='true';return;}
 }
 if(mode==='pan'||spaceDown||event.button===1){event.preventDefault();panStart={screen:{x:event.clientX,y:event.clientY},scroll:{x:scrollArea.scrollLeft,y:scrollArea.scrollTop},pointerId:event.pointerId};overlay.setPointerCapture(event.pointerId);overlay.dataset.panning='true';return;}
 if(mode==='review'){const id=(event.target as SVGElement).getAttribute('data-hit');if(id)selectHit(id);return;}const point=eventPoint(event);if(mode==='exclude'){drag=point;overlay.setPointerCapture(event.pointerId);}else if(mode==='example'){entry().exemplar=point;setMode('review');update();say('Example selected for '+currentCode+'. Choose Find matching symbols.');}else if(mode==='manual'){if(sheet().exclusions.some(b=>contains(point,b))){say('That point is in an exclusion region. Choose an installed item outside the legend.',true);return;}if(includedHits(sheet()).some(h=>Math.hypot(h.x-point.x,h.y-point.y)<=3&&h.decision!=='rejected')){say('A detection already exists at this location. Review that hit instead.',true);return;}const e=entry();const hit:EvidenceHit={...point,id:hitId(documentHash,pageNum,currentCode,point),code:currentCode,page:pageNum,method:'manual',decision:'confirmed',manual:true};e.hits=e.hits.filter(h=>h.id!==hit.id);e.hits.push(hit);e.assessed=true;if(!e.provider)e.note='Manual count: completeness has not been independently checked';selected=hit.id;update();say('Manually confirmed item added for '+currentCode+'.');}});
overlay.addEventListener('pointermove',(event:PointerEvent)=>{if(touches.has(event.pointerId))touches.set(event.pointerId,{x:event.clientX,y:event.clientY});
 if(pinch&&touches.size===2){const [a,b]=[...touches.values()];void requestZoom(pinch.zoom*Math.hypot(a.x-b.x,a.y-b.y)/pinch.distance,{x:(a.x+b.x)/2,y:(a.y+b.y)/2},pinch.anchor);return;}
 if(panStart&&panStart.pointerId===event.pointerId){scrollArea.scrollLeft=panStart.scroll.x-(event.clientX-panStart.screen.x);scrollArea.scrollTop=panStart.scroll.y-(event.clientY-panStart.screen.y);return;}
 if(!drag||!viewport)return;const point=eventPoint(event);preview={x0:Math.min(drag.x,point.x),y0:Math.min(drag.y,point.y),x1:Math.max(drag.x,point.x),y1:Math.max(drag.y,point.y)};drawOverlay();});
overlay.addEventListener('pointerup',(event:PointerEvent)=>{touches.delete(event.pointerId);if(pinch){if(touches.size<2)pinch=null;panStart=null;overlay.dataset.panning='false';return;}
 if(panStart){panStart=null;overlay.dataset.panning='false';return;}
 if(!drag)return;const p=eventPoint(event);const b={x0:Math.min(drag.x,p.x),y0:Math.min(drag.y,p.y),x1:Math.max(drag.x,p.x),y1:Math.max(drag.y,p.y)};drag=null;preview=null;if(b.x1-b.x0<3||b.y1-b.y0<3){drawOverlay();say('Drag a larger rectangle around the legend.',true);return;}sheet().exclusions.push(b);setMode('review');update();say('Exclusion saved. Pick an example for '+currentCode+' inside the legend.');});
overlay.addEventListener('pointercancel',()=>{drag=null;preview=null;panStart=null;pinch=null;touches.clear();overlay.dataset.panning='false';drawOverlay();});
button('select-type').onclick=()=>{const code=input('code').value.trim();if(!code){say('Enter an equipment code.',true);return;}currentCode=code;entry().description=input('description').value.trim();selected=null;update();say('Selected '+code+'. Pick its example on this page.');};
$<HTMLSelectElement>('type-select').onchange=()=>{currentCode=$<HTMLSelectElement>('type-select').value;selected=null;update();};
input('description').onchange=()=>{if(input('code').value.trim()===currentCode)entry().description=input('description').value.trim();};
button('scan').onclick=scan;
for(const [id,decision] of [['confirm','confirmed'],['flag','unresolved'],['reject','rejected']] as const)button(id).onclick=()=>{const h=sheet().entries.flatMap(e=>e.hits).find(h=>h.id===selected);if(!h)return;h.decision=decision;update();say('Review decision recorded. Current-page quantities and prices recalculated.');};
async function changePage(number:number){if(!doc||busy)return;if(!Number.isInteger(number)||number<1||number>doc.numPages){input('page-number').value=String(pageNum);return;}pageNum=number;selected=null;panStart=null;pinch=null;touches.clear();setMode('review');try{await paint(true);scrollArea.scrollTop=0;scrollArea.scrollLeft=0;}catch(error){say('Could not render page: '+errorMessage(error),true);return;}say('Page '+pageNum+'. Each page needs its own legend exclusions and example; results are not transferred across pages.');}
button('prev').onclick=()=>void changePage(pageNum-1);button('next').onclick=()=>void changePage(pageNum+1);input('page-number').onchange=()=>void changePage(Number(input('page-number').value));
function screenCentre():XY {const box=scrollArea.getBoundingClientRect();return{x:box.left+scrollArea.clientWidth/2,y:box.top+(scrollArea.clientHeight||600)/2};}
async function requestZoom(target:number,screen=screenCentre(),anchor?:XY):Promise<void>{
 if(!doc||!viewport||(busy&&!zooming)||!Number.isFinite(target))return;
 const box=overlay.getBoundingClientRect();
 zoomRequest={target:clampZoom(target),screen,anchor:anchor??pageAnchor(screen,box,{x:viewport.width,y:viewport.height})};
 fitMode=null;
 if(zooming)return;
 zooming=true;
 try{while(zoomRequest){const request=zoomRequest;zoomRequest=null;zoom=request.target;await paint();
  const position=anchoredScroll({x:scrollArea.scrollLeft,y:scrollArea.scrollTop},overlay.getBoundingClientRect(),request.anchor,zoom,request.screen);
  scrollArea.scrollLeft=position.x;scrollArea.scrollTop=position.y;
 }}catch(error){zoomRequest=null;say('Could not change drawing zoom: '+errorMessage(error),true);}finally{zooming=false;syncControls();}
}
async function fitView(mode:'page'|'width'){
 if(!doc||!viewport||busy)return;fitMode=mode;
 try{await paint(true);scrollArea.scrollTop=0;scrollArea.scrollLeft=Math.max(0,(viewport.width*zoom-scrollArea.clientWidth+48)/2);say(mode==='page'?'Entire page fitted to the drawing area.':'Page width fitted. Scroll vertically to explore the drawing.');}catch(error){say('Could not fit drawing: '+errorMessage(error),true);}
}
async function zoomTo(bounds:Bounds){
 if(!viewport||busy)return;const a=view({x:bounds.x0,y:bounds.y0}),b=view({x:bounds.x1,y:bounds.y1});
 const centre={x:(a.x+b.x)/2,y:(a.y+b.y)/2};
 const target=fitScale({x:Math.max(50,Math.abs(b.x-a.x)),y:Math.max(50,Math.abs(b.y-a.y))},{x:scrollArea.clientWidth,y:scrollArea.clientHeight||600},'page',100);
 await requestZoom(target,screenCentre(),centre);
}
for(const [id,factor] of [['zoom-in',1.3],['zoom-out',1/1.3]] as const)button(id).onclick=()=>void requestZoom((zoomRequest?.target??zoom)*factor);
button('fit').onclick=()=>void fitView('page');button('fit-width').onclick=()=>void fitView('width');
input('zoom-percent').onchange=()=>{const value=Number(input('zoom-percent').value);if(value>0)void requestZoom(value/100);else input('zoom-percent').value=String(Math.round(zoom*100));};
button('zoom-legend').onclick=()=>{const bounds=sheet().exclusions.at(-1);if(bounds)void zoomTo(bounds);};
button('zoom-selection').onclick=()=>{const point=includedHits(sheet()).find(h=>h.id===selected)??entry().exemplar;if(point)void zoomTo({x0:point.x-35,y0:point.y-35,x1:point.x+35,y1:point.y+35});};
scrollArea.addEventListener('wheel',(event:WheelEvent)=>{
 if(!event.ctrlKey&&!event.metaKey)return;event.preventDefault();if(!viewport||(!zooming&&busy))return;
 const delta=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?(scrollArea.clientHeight||600):1);
 void requestZoom((zoomRequest?.target??zoom)*Math.exp(-Math.max(-350,Math.min(350,delta))*.002),{x:event.clientX,y:event.clientY});
},{passive:false});
function typing(event:KeyboardEvent){const target=event.target as HTMLElement|null;return!!target&&(target.isContentEditable||['INPUT','TEXTAREA','SELECT','BUTTON'].includes(target.tagName));}
window.addEventListener('keydown',event=>{
 if(typing(event)||event.ctrlKey||event.metaKey||event.altKey)return;
 if(event.code==='Space'){event.preventDefault();spaceDown=true;overlay.dataset.space='true';return;}
 if(!doc||busy)return;
 if(['+','=','-','0','f','F','h','H','Escape'].includes(event.key))event.preventDefault();
 if(event.key==='+'||event.key==='=')void requestZoom(zoom*1.3);
 if(event.key==='-')void requestZoom(zoom/1.3);
 if(event.key==='0')void fitView('page');
 if(event.key.toLowerCase()==='f')void fitView('width');
 if(event.key.toLowerCase()==='h')setMode('pan');
 if(event.key==='Escape'){setMode('review');drag=null;preview=null;panStart=null;pinch=null;touches.clear();overlay.dataset.panning='false';drawOverlay();}
});
window.addEventListener('keyup',event=>{if(event.code==='Space'){spaceDown=false;overlay.dataset.space='false';}});
window.addEventListener('blur',()=>{spaceDown=false;panStart=null;pinch=null;touches.clear();overlay.dataset.space='false';overlay.dataset.panning='false';});
for(const id of ['material','labour','rate-source'])input(id).oninput=()=>{rates[currentCode]={material:input('material').value,labour:input('labour').value,source:input('rate-source').value};updatePricing();};$<HTMLSelectElement>('currency').onchange=updatePricing;
button('save-json').onclick=()=>download(fileName.replace(/\.pdf$/i,'')+`-p${pageNum}-evidence.json`,JSON.stringify(snapshot(),null,2),'application/json');
button('save-csv').onclick=()=>{const draft=snapshot();const quote=(value:unknown)=>{let text=String(value??'');if(/^[=+\-@\t\r]/.test(text))text="'"+text;return '"'+text.replace(/"/g,'""')+'"';};const cols=['document','sha256','page','currency','code','quantity','unresolved','materialPerUnit','labourPerUnit','lineSubtotal','status','rateSource'];const csv=cols.join(',')+'\n'+draft.pricing.lines.map(l=>[fileName,documentHash,pageNum,draft.currency,l.code,l.quantity,l.unresolved,l.materialCents===null?'':(l.materialCents/100).toFixed(2),l.labourCents===null?'':(l.labourCents/100).toFixed(2),l.totalCents===null?'':(l.totalCents/100).toFixed(2),l.status,l.source].map(quote).join(',')).join('\n');download(`takeoff-p${pageNum}.csv`,csv,'text/csv');};
button('save-pdf').onclick=async()=>{if(!bytes||busy)return;setBusy(true);say('Preparing an annotated copy on this device…');try{const pdf=await PDFDocument.load(bytes.slice()),p=pdf.getPages()[pageNum-1],font=await pdf.embedFont(StandardFonts.Helvetica);includedHits(sheet()).forEach((h,i)=>{if(h.decision==='rejected')return;const colour=h.decision==='unresolved'?rgb(.8,.5,.1):rgb(.05,.45,.6);p.drawCircle({x:h.x,y:h.y,size:10,borderWidth:1,borderColor:colour});p.drawText(String(i+1),{x:h.x+11,y:h.y+10,size:9,font,color:colour});});download(fileName.replace(/\.pdf$/i,'')+`-p${pageNum}-reviewed.pdf`,new Uint8Array(await pdf.save()),'application/pdf');say('Annotated copy exported for this page. Numbers match displayHits in the JSON export; rejected hits are not marked.');}catch(error){say('PDF export failed: '+errorMessage(error),true);}finally{setBusy(false);}};
window.addEventListener('beforeunload',event=>{if(doc&&Object.values(sheets).some(s=>s.entries.some(e=>e.assessed))){event.preventDefault();}});

$<HTMLSelectElement>('trade-select').onchange=()=>{
 activeTrade=getTrade($<HTMLSelectElement>('trade-select').value);applyTradeLabels();
 if(!doc){input('code').value=activeTrade.items[0].code;input('description').value=activeTrade.items[0].description;return;}
 for(const item of activeTrade.items)if(!sheet().entries.some(e=>e.code===item.code))sheet().entries.push(makeEntry(item.code,item.description));
 currentCode=activeTrade.items[0].code;selected=null;update();say(activeTrade.name+' presets added. Existing types and results were retained. Select an example from your drawing.');
};
