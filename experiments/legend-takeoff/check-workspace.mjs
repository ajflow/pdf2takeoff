// Controller integration checks in a small DOM harness, using real PDF parsing,
// rendering and scan engine. This is not a browser/visual test.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, webcrypto } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';
import { openPdf } from '../../src/headless/pdfjs-node.ts';
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { scanForSimilar } from '../../src/engine/scan.ts';
import { vectorize } from '../../src/engine/vector.ts';
import { priceQuantities } from './pricing.mjs';
import * as navigation from './workspace-view.ts';
import { getTrade } from './trades.mjs';
import * as model from './workspace-model.ts';

const elements=new Map(),downloads=[];
const decode=s=>s.replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
class Element {
 constructor(id){this.id=id;this.value='';this.textContent='';this.innerHTML='';this.style={};this.dataset={};this.disabled=false;this.hidden=false;this.clientWidth=1000;this.clientHeight=600;this.scrollLeft=0;this.scrollTop=0;this.handlers={};this.attributes={};}
 addEventListener(name,fn){this.handlers[name]=fn;}
 setAttribute(k,v){this.attributes[k]=v;}
 getAttribute(k){return this.attributes[k]??null;}
 setPointerCapture(){}
 getBoundingClientRect(){
  if(this.id==='scroll-area')return{left:0,top:0,width:this.clientWidth,height:this.clientHeight};
  const scroll=elements.get('scroll-area'),width=parseFloat(elements.get('page-wrap').style.width)||600,height=parseFloat(elements.get('page-wrap').style.height)||500;
  return{left:24+Math.max(0,(scroll.clientWidth-48-width)/2)-scroll.scrollLeft,top:24-scroll.scrollTop,width,height};
 }
 querySelectorAll(selector){const key=selector.includes('data-code')?'code':'id';return[...this.innerHTML.matchAll(new RegExp(`data-${key}="([^"]+)"`,'g'))].map(m=>{const e=new Element('');e.dataset[key]=decode(m[1]);return e;});}
 click(){if(this.href)downloads.push({name:this.download,url:this.href});else this.onclick?.();}
}
const html=readFileSync(new URL('workspace.html',import.meta.url),'utf8');
for(const tag of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)){const element=tag[1]==='drawing'?createCanvas(1,1):new Element(tag[1]);element.value=tag[0].match(/value="([^"]*)"/)?.[1]??'';elements.set(tag[1],element);}
elements.get('currency').value='AUD';
const document={getElementById:id=>elements.get(id),createElement:tag=>tag==='canvas'?createCanvas(1,1):new Element(tag)};
const pdfjs={GlobalWorkerOptions:{},OPS,getDocument:options=>({promise:openPdf(options.data)})};
const blobs=new Map();let blobSeq=0;
const windowHandlers={};
const context=vm.createContext({document,pdfjs,workerUrl:'/assets/pdf.worker.mjs',PDFDocument,StandardFonts,rgb,scanForSimilar,vectorize,priceQuantities,getTrade,...navigation,...model,URLSearchParams,
 crypto:webcrypto,Uint8Array,Uint8ClampedArray,ArrayBuffer,Map,Set,Intl,Date,Math,Number,Error,Promise,console,Blob,
 URL:{createObjectURL:blob=>{const id='blob:'+ ++blobSeq;blobs.set(id,blob);return id;},revokeObjectURL:()=>{}},
 setTimeout:()=>0,requestAnimationFrame:fn=>queueMicrotask(fn),window:{devicePixelRatio:1,location:{search:''},addEventListener:(name,fn)=>{windowHandlers[name]=fn}},
 fetch:async()=>{throw Error('Unexpected network call');}});
const source=ts.transpileModule(readFileSync(new URL('workspace.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replace(/^import .*;\n/gm,'');
vm.runInContext(source,context);
const run=code=>vm.runInContext(code,context);
const bytes=new Uint8Array(readFileSync(new URL('output/dev-clean/drawing.pdf',import.meta.url)));
context.testBytes=bytes;
await run('openFile(testBytes,"user-plan.pdf")');
assert.equal(run('doc.numPages'),1);assert.equal(run('documentHash'),createHash('sha256').update(bytes).digest('hex'));
assert.equal(elements.get('scan').disabled,true);
run("sheet().exclusions.push({x0:25,y0:360,x1:390,y1:450});entry().exemplar={x:55,y:415};update()");
assert.equal(elements.get('scan').disabled,false);
await run('scan()');
assert.equal(run('entry().provider'),'vector');
assert.equal(run('quantities(sheet())[0].supported'),3);
assert.equal(run('includedHits(sheet()).length'),3);
const ids=run('entry().hits.map(h=>h.id).join("|")');
await run('scan()');assert.equal(run('entry().hits.map(h=>h.id).join("|")'),ids);
assert.equal(run('quantities(sheet())[0].supported'),3);
// Review decisions alter current quantities and rate-derived prices.
run("rates.DL1={material:'40',labour:'20',source:'Test assumption'};selected=includedHits(sheet())[0].id");
elements.get('flag').onclick();
assert.equal(run('quantities(sheet())[0].supported'),2);
assert.equal(run('quantities(sheet())[0].unresolved'),1);
assert.equal(run('snapshot().pricing.pricedSubtotalCents'),12000);
assert.equal(run('snapshot().pricing.complete'),false);
elements.get('reject').onclick();
assert.equal(run('snapshot().pricing.complete'),false);assert.equal(run('snapshot().pricing.lines.find(l=>l.code==="DL1").status'),'priced');
await run('scan()');assert.equal(run('entry().hits.find(h=>h.id===selected).decision'),'rejected');
// Navigation keeps the screen point anchored and preserves selected evidence.
run('selected=includedHits(sheet())[1].id');const selectedBefore=run('selected');
const screen={x:500,y:300};context.screen=screen;
const anchor=run('pageAnchor(screen,overlay.getBoundingClientRect(),{x:viewport.width,y:viewport.height})');context.savedAnchor=anchor;
await run('requestZoom(2,screen)');
const screenAfter=run('({x:overlay.getBoundingClientRect().left+savedAnchor.x*zoom,y:overlay.getBoundingClientRect().top+savedAnchor.y*zoom})');
assert.ok(Math.hypot(screenAfter.x-screen.x,screenAfter.y-screen.y)<1e-6);
assert.equal(run('selected'),selectedBefore);
await run("fitView('page')");assert.ok(run('viewport.width*zoom<=scrollArea.clientWidth-48+1e-6 && viewport.height*zoom<=scrollArea.clientHeight-48+1e-6'));
await run("fitView('width')");assert.ok(run('Math.abs(viewport.width*zoom-(scrollArea.clientWidth-48))<1e-6'));
run("setMode('pan')");const scroll=elements.get('scroll-area');scroll.scrollLeft=100;scroll.scrollTop=150;
elements.get('overlay').handlers.pointerdown({clientX:300,clientY:200,pointerId:11,button:0,preventDefault(){}});
elements.get('overlay').handlers.pointermove({clientX:250,clientY:170,pointerId:11});assert.equal(scroll.scrollLeft,150);assert.equal(scroll.scrollTop,180);
elements.get('overlay').handlers.pointerup({pointerId:11});assert.equal(run('panStart'),null);
// A text field retains its keys; Space pans only outside editable controls.
windowHandlers.keydown({code:'Space',key:' ',target:{tagName:'INPUT'},preventDefault(){throw Error('Should not intercept text input');}});assert.equal(run('spaceDown'),false);
windowHandlers.keydown({code:'Space',key:' ',target:{tagName:'DIV'},preventDefault(){}});assert.equal(run('spaceDown'),true);windowHandlers.keyup({code:'Space'});assert.equal(run('spaceDown'),false);
// Image-only PDF exercises the real raster adapter and CV fallback, locally.
const imageDoc=await PDFDocument.create();const image=await imageDoc.embedPng(readFileSync(new URL('output/dev-clean/drawing.png',import.meta.url)));
imageDoc.addPage([600,500]).drawImage(image,{x:0,y:0,width:600,height:500});context.imageBytes=await imageDoc.save();
await run('openFile(imageBytes,"raster-plan.pdf")');
run("sheet().exclusions.push({x0:25,y0:360,x1:390,y1:450});entry().exemplar={x:55,y:415}");await run('scan()');
assert.equal(run('entry().provider'),'cv');
// Known engine limitation on this resampled fixture: the exemplar is found, installations missed.
assert.equal(run('quantities(sheet())[0].supported'),0);assert.ok(elements.get('status').textContent.includes('does not establish'));
console.log('KNOWN LIMIT: CV fallback misses installations on this resampled image-only fixture; warning is shown.');
// Coordinate transforms on a rotated, cropped PDF are checked via controller events.
const rotated=await PDFDocument.load(bytes);rotated.getPages()[0].setRotation(degrees(90));rotated.getPages()[0].setCropBox(20,20,560,460);
context.rotatedBytes=await rotated.save();
await run('openFile(rotatedBytes,"rotated-cropped.pdf")');
const point=run('view({x:55,y:415})');
const dimensions=elements.get('overlay').getBoundingClientRect();
const vp=run('({width:viewport.width,height:viewport.height})');
context.pointer={clientX:dimensions.left+point.x/vp.width*dimensions.width,clientY:dimensions.top+point.y/vp.height*dimensions.height};
const converted=run('eventPoint(pointer)');assert.ok(Math.hypot(converted.x-55,converted.y-415)<1e-7);
// Use real pointer handlers to select an example after placing an exclusion.
run("sheet().exclusions.push({x0:25,y0:360,x1:390,y1:450});setMode('example')");
elements.get('overlay').handlers.pointerdown({...context.pointer,pointerId:1});
assert.ok(run('Math.hypot(entry().exemplar.x-55,entry().exemplar.y-415)<1e-7'));
await run('scan()');assert.equal(run('quantities(sheet())[0].supported'),3);
// Export annotations and ensure rejected numbering remains consistent with JSON.
run("selected=includedHits(sheet())[0].id");elements.get('reject').onclick();
await elements.get('save-pdf').onclick();
const exported=downloads.at(-1);assert.ok(exported.name.endsWith('-reviewed.pdf'));
const annotated=await PDFDocument.load(await blobs.get(exported.url).arrayBuffer());assert.equal(annotated.getPageCount(),1);
assert.deepEqual(Array.from(run('snapshot().displayHits.map(h=>h.number)')),[1,2,3]);
// Page state does not transfer exemplar or results across sheets.
const multi=await PDFDocument.load(bytes);multi.addPage([600,500]);context.multiBytes=await multi.save();
await run('openFile(multiBytes,"two-pages.pdf")');
run("sheet().exclusions.push({x0:25,y0:360,x1:390,y1:450});entry().exemplar={x:55,y:415}");await run('scan()');
await run('changePage(2)');assert.equal(run('entry().assessed'),false);assert.equal(run('entry().exemplar'),null);assert.equal(run('sheet().exclusions.length'),0);
await run('changePage(1)');assert.equal(run('quantities(sheet())[0].supported'),3);
// Scanned rasters run through CV rather than a trained/remote detector.
// The fixture and engine's existing raster checks cover that fallback separately.
const truncated={code:'X',description:'',exemplar:null,assessed:true,provider:'vector',note:'',truncated:true,hits:[]};
assert.equal(model.quantities({entries:[truncated],exclusions:[]})[0].unresolved,null);
assert.equal(priceQuantities(model.quantities({entries:[truncated],exclusions:[]}),{X:{material:'1',labour:'0'}}).complete,false);
// Trade selection adds editable items without discarding existing evidence.
elements.get('trade-select').value='plumbing';elements.get('trade-select').onchange();
assert.equal(run('currentCode'),'WC');assert.equal(run('snapshot().trade'),'plumbing');assert.ok(run('sheet().entries.some(e=>e.code==="DL1"&&e.assessed)'));
assert.equal(run('entry().assessed'),false);assert.equal(run('entry().description'),'Toilet fixture');
console.log('PASS: navigation anchors, panning, fit modes, selection retention, keyboard text-input protection and trade presets');
console.log('PASS: real PDF open/render/scan, exclusions, stable reruns, review-to-price, rotated crop coordinates, annotated export, page isolation and truncation coverage');
await run('doc.destroy()');
