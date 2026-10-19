const W = 300, H = 200;
const px = new Uint8ClampedArray(W * H * 4).fill(255);
const ink1 = (x, y) => { x = Math.round(x); y = Math.round(y); if (x<0||y<0||x>=W||y>=H) return; const i = (y*W+x)*4; px[i]=px[i+1]=px[i+2]=0; };
for (let x = 20; x <= 150; x++) { ink1(x, 20); ink1(x, 180); }
for (let y = 20; y <= 180; y++) { if (y < 90 || y > 114) ink1(20, y); ink1(150, y); }
const raster = { width: W, height: H, data: px, toPdf: (x,y)=>({x, y: H-y}), toRaster: (x,y)=>({x, y: H-y}) };
const dyn = await import('../src/engine/dynamicfill.ts');
const r = dyn.dynamicFill(raster, { x: 85, y: H - 100 });
console.log('grafted:', 'error' in r ? r.error : `ok pts=${r.points.length} gapPx=${r.gapPx}`);
