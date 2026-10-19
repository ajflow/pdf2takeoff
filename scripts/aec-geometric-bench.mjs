#!/usr/bin/env node
// AEC-Geometric-Bench (KamaiEnterprises, MIT): run the click-free raster
// engine over the fifteen released sheets and emit the benchmark's
// prediction JSONs, then score them with the bench's own scorer.
//
//   node --experimental-strip-types scripts/aec-geometric-bench.mjs \
//     --bench /path/to/aec-geometric-bench --out bench/aec-geometric-bench/results
//
// What the engine submits, honestly: walls and enclosed areas from the
// raster opening detector (src/engine/openings.ts — wall-mask closing,
// threshold-gap scanning, enclosed-space counting), doors and windows from
// its gap classifier. Fixtures (sinks, toilets, bathtubs, showers, cooktops)
// have no click-free detector, so they are simply not submitted — the
// benchmark's protocol scores everything reported, and absence costs recall
// only. All doors are submitted as 'Single Swing Door' (the engine counts
// leaves and does not pair double doors). No vision model, no clicks, no
// network: this is the deterministic floor of the engine, first pass.
//
// Coordinates: the bench scores in the manifest's pixel frame (300 dpi);
// each PDF is rendered at exactly that scale, so engine raster pixels map
// one-to-one onto the scoring frame.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { PDFDocument } from 'pdf-lib';
import { openPdf } from '../src/headless/pdfjs-node.ts';
import { renderRasterNode } from '../src/headless/raster-node.ts';
import { detectOpenings, countEnclosedSpaces } from '../src/engine/openings.ts';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
const benchDir = resolve(arg('bench', join(__dirname, '..', 'bench', 'aec-geometric-bench', 'external')));
const outDir = resolve(arg('out', join(__dirname, '..', 'bench', 'aec-geometric-bench', 'results')));
const python = process.env.PDF2TAKEOFF_PYTHON || 'python3';

if (!existsSync(join(benchDir, 'dataset', 'manifest.json'))) {
  console.error(`no dataset/manifest.json under ${benchDir} — clone github.com/KamaiEnterprises/aec-geometric-bench (MIT) and pass --bench <dir>`);
  process.exit(2);
}
const manifest = JSON.parse(readFileSync(join(benchDir, 'dataset', 'manifest.json'), 'utf8'));
mkdirSync(outDir, { recursive: true });

/** Wall mask as merged run-length rectangles (exact reconstruction when the scorer rasterizes the union). */
function maskRectangles(mask, mw, mh, s, kx, ky) {
  const rects = [];
  for (let y = 0; y < mh; y++) {
    const row = y * mw;
    let x = 0;
    while (x < mw) {
      if (!mask[row + x]) { x++; continue; }
      const x0 = x;
      while (x < mw && mask[row + x]) x++;
      const x1 = x; // exclusive
      // extend downward while the same span stays solid
      let y1 = y + 1;
      while (y1 < mh) {
        let solid = true;
        for (let i = x0; i < x1; i++) if (!mask[y1 * mw + i]) { solid = false; break; }
        if (!solid) break;
        y1++;
        for (let i = x0; i < x1; i++) mask[(y1 - 1) * mw + i] = 0; // consumed: never re-emits
      }
      rects.push([x0 * s * kx, y * s * ky, x1 * s * kx, y1 * s * ky]);
    }
  }
  return rects.map(([x0, y0, x1, y1]) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
}

const failures = [];
let t0 = Date.now();
for (const sheet of manifest.sheets) {
  const id = sheet.sheet;
  const tSheet = Date.now();
  const bytes = new Uint8Array(readFileSync(join(benchDir, 'dataset', sheet.pdf)));
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPage(0);
  const { width: ptW } = page.getSize();
  const scale = sheet.width / ptW;
  let pred = { sheet: id, objects: [], areas: [], walls: [] };
  try {
    const pdf = await openPdf(bytes);
    const raster = await renderRasterNode(pdf, 1, scale);
    const kx = sheet.width / raster.width;
    const ky = sheet.height / raster.height;
    // the anchor pins the detector config its 0.519 wall-F1 first pass ran
    // with: the base closing ladder and no closing guards. The defaults
    // since grew an extended ladder (hatched residential scans) whose guards
    // trade wall recall on these large commercial sheets for count sanity;
    // pinning keeps the anchor's time series comparable run over run.
    const anchor = { closeRadii: [0, 1, 2, 3], closeCellFactor: 1e9, closeCellAdd: 1e9, closeGrowthLimit: 1e9, spaceKernelFraction: 0.5 };
    const res = detectOpenings(raster, anchor);
    const spaces = countEnclosedSpaces(raster, anchor, res);
    const box = (b) => [b.x0 * kx, b.y0 * ky, b.x1 * kx, b.y1 * ky];
    pred.objects = [
      ...res.doors.map((d) => ({ class: 'Single Swing Door', bbox: box(d.px) })),
      ...res.windows.map((w) => ({ class: 'Window', bbox: box(w.px) })),
    ];
    pred.areas = spaces.spaces.map((sp) => [
      [sp.x0 * kx, sp.y0 * ky], [sp.x1 * kx, sp.y0 * ky], [sp.x1 * kx, sp.y1 * ky], [sp.x0 * kx, sp.y1 * ky],
    ]);
    const { mask, width: mw, scale: s } = res.walls;
    const mh = mask.length / mw;
    pred.walls = maskRectangles(mask, mw, mh, s, kx, ky);
  } catch (err) {
    failures.push(`${id}: ${err instanceof Error ? err.message : String(err)}`);
  }
  writeFileSync(join(outDir, `${id}.json`), JSON.stringify(pred));
  const secs = ((Date.now() - tSheet) / 1000).toFixed(1);
  console.log(`${id}: ${pred.objects.length} objects (${pred.objects.filter((o) => o.class === 'Window').length} windows), ${pred.areas.length} areas, ${pred.walls.length} wall rects, ${secs} s${failures.some((f) => f.startsWith(id)) ? ' [ENGINE ERROR -> empty prediction]' : ''}`);
}
console.log(`\n${((Date.now() - t0) / 1000).toFixed(0)} s total${failures.length ? `\nfailures:\n${failures.join('\n')}` : ''}`);

// score with the bench's own scorer
const scored = spawnSync(python, [join(benchDir, 'scoring', 'score.py'), '--pred', outDir], { encoding: 'utf8' });
if (scored.status !== 0) {
  console.error(scored.stderr || scored.stdout);
  process.exit(1);
}
console.log(scored.stdout);
writeFileSync(join(outDir, 'score.txt'), scored.stdout);
