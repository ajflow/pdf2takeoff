import type { Pt, ScanHit } from '../../src/engine/types.ts';
export type Decision = 'supported' | 'confirmed' | 'unresolved' | 'rejected';
export interface Bounds {x0:number;y0:number;x1:number;y1:number}
export interface EvidenceHit extends Pt {id:string;code:string;page:number;method:string;score?:number;decision:Decision;manual:boolean}
export interface SymbolEntry {code:string;description:string;exemplar:Pt|null;assessed:boolean;provider:string|null;note:string;hits:EvidenceHit[];truncated:boolean}
export interface SheetState {exclusions:Bounds[];entries:SymbolEntry[]}
export const contains=(p:Pt,b:Bounds)=>p.x>=b.x0&&p.x<=b.x1&&p.y>=b.y0&&p.y<=b.y1;
export const hitId=(hash:string,page:number,code:string,p:Pt)=>`${hash}:p${page}:${encodeURIComponent(code)}:${p.x.toFixed(3)},${p.y.toFixed(3)}`;
export function includedHits(sheet:SheetState){return sheet.entries.flatMap(e=>e.hits).filter(h=>!sheet.exclusions.some(b=>contains(h,b)));}
export function quantities(sheet:SheetState){const hits=includedHits(sheet);return sheet.entries.map(e=>({code:e.code,status:e.assessed?'assessed':'not-assessed',supported:e.assessed?hits.filter(h=>h.code===e.code&&['supported','confirmed'].includes(h.decision)).length:null,unresolved:e.assessed&&!e.truncated?hits.filter(h=>h.code===e.code&&h.decision==='unresolved').length:null}));}
export function replaceScan(entry:SymbolEntry,hits:ScanHit[],hash:string,page:number){
 const old=new Map(entry.hits.filter(h=>!h.manual).map(h=>[h.id,h]));
 const kept:ScanHit[]=[];
 for(const p of [...hits].filter(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)).sort((a,b)=>a.x-b.x||a.y-b.y))if(!kept.some(q=>Math.hypot(p.x-q.x,p.y-q.y)<=3))kept.push(p);
 const manual=entry.hits.filter(h=>h.manual);
 const scanned:EvidenceHit[]=kept.filter(p=>!manual.some(h=>Math.hypot(p.x-h.x,p.y-h.y)<=3)).map(p=>{const id=hitId(hash,page,entry.code,p);return {...p,id,code:entry.code,page,method:entry.provider??'unknown',decision:old.get(id)?.decision??'supported',manual:false};});
 entry.hits=[...scanned,...manual];entry.assessed=true;
}
