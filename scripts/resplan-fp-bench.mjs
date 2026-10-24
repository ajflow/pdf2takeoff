#!/usr/bin/env node
// ResPlan-FP (fpvec-lab, MIT code / CC BY 4.0 data): run the click-free raster
// engine over the benchmark's clean_band_v1 renders and emit predictions in
// the benchmark's wall-first JSON, then score them with its own scorer
// (`python -m baselines.score`).
//
//   node --experimental-strip-types scripts/resplan-fp-bench.mjs \
//     --bench bench/resplan-fp/.cache/fpvec-lab --out bench/resplan-fp/results
//
// Setup (see bench/resplan-fp/README.md): clone fpvec-lab into .cache and
// download the HF data, venv with numpy/shapely/scipy.
//
// What the engine submits, honestly: wall centrelines skeletonised from the
// detector's wall mask (src/engine/openings.ts, default settings), openings
// from its gap classifier (doors and windows only — unclassified gaps
// ("passages") are not submitted, and double-leaf door gaps are deduped to
// one opening), rooms from countEnclosedSpaces' enclosed regions submitted
// as explicit polygons (--rooms spaces, the val winner) or left to the
// scorer's walls-only convention (rooms read as the faces of the predicted
// wall graph, --rooms faces, the convention of every walls-only row in the
// benchmark paper). No vision model, no GPU, no clicks, no network: the
// deterministic floor of the engine, first pass.
//
// Coordinate frame: the benchmark renders are 256 x 256 px images with GT in
// a 1024 longer-edge frame, y down in both, so native image px map to frame
// units by a single per-plan factor (frame / longer image edge). The engine
// sees the untouched native pixels (image-node.ts renders at RASTER_SCALE).
//
// Harness-side conversion parameters (picked on the first 200 plans of the
// 1000-plan val split only, never on test — see
// docs/research/benchmarks/resplan-fp.md):
//   --bridge-gap <px>  native-px collinear gap under which two wall
//                      centreline fragments are re-joined. The benchmark
//                      draws every opening as a white gap in the wall band
//                      while GT walls run straight through, so fragments
//                      either side of a gap are one GT wall. 24 won on wall
//                      F1 over 40 and 64.
//   --rooms faces|spaces  how rooms are submitted. spaces (the val winner,
//                      room F1 0.067 vs 0.002) submits countEnclosedSpaces'
//                      regions as explicit rectangles; faces leaves rooms to
//                      the scorer's walls-only convention (faces of the
//                      predicted wall graph), which needs the wall mask to
//                      close rooms — it does not on this benchmark.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { openAny } from '../src/headless/image-node.ts';
import { renderRasterNode } from '../src/headless/raster-node.ts';
import { detectOpenings, countEnclosedSpaces } from '../src/engine/openings.ts';
import { RASTER_SCALE } from '../src/engine/ports.ts';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
const has = (name) => args.includes(`--${name}`);
const benchDir = resolve(arg('bench', join(__dirname, '..', 'bench', 'resplan-fp', '.cache', 'fpvec-lab')));
const outDir = resolve(arg('out', join(__dirname, '..', 'bench', 'resplan-fp', 'results')));
const split = arg('split', 'test');
const limit = Number(arg('limit', Infinity));
const bridgeGap = Number(arg('bridge-gap', 24)); // native px; picked on val
const roomsMode = arg('rooms', 'spaces'); // faces | spaces; picked on val
const tols = arg('tol', '0.05 0.015').split(/\s+/).map(Number);
const python = resolve(arg('python', join(__dirname, '..', 'bench', 'resplan-fp', '.cache', 'venv', 'bin', 'python')));

// data dir: --bench may be the fpvec-lab clone root or the data dir itself
const dataDir = existsSync(join(benchDir, `${split}.jsonl`))
  ? benchDir
  : join(benchDir, 'data', 'resplan-fp');
if (!existsSync(join(dataDir, `${split}.jsonl`))) {
  console.error(`no ${split}.jsonl under ${dataDir} — clone github.com/Cyprinus12138/fpvec-lab into bench/resplan-fp/.cache and run scripts/download_data.py (see bench/resplan-fp/README.md), or pass --bench <dir>`);
  process.exit(2);
}
const rows = readFileSync(join(dataDir, `${split}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).slice(0, limit);
mkdirSync(outDir, { recursive: true });

const r2 = (v) => Math.round(v * 100) / 100;

// --- wall centrelines from the detector's wall mask --------------------------
// Zhang-Suen thinning to the centreline, then trace: nodes are skeleton
// pixels with degree != 2, paths run between them, each path is simplified
// with Douglas-Peucker, collinear paths through a junction are merged, short
// free ends are pruned, and collinear fragments a gap apart are bridged (the
// benchmark cuts every opening out of the band; GT walls run through).

function zhangSuenThin(mask, w, h) {
  const img = Uint8Array.from(mask);
  const stash = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (let step = 0; step < 2; step++) {
      stash.length = 0;
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          if (!img[i]) continue;
          const p2 = img[i - w], p3 = img[i - w + 1], p4 = img[i + 1], p5 = img[i + w + 1];
          const p6 = img[i + w], p7 = img[i + w - 1], p8 = img[i - 1], p9 = img[i - w - 1];
          const b = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (b < 2 || b > 6) continue;
          let a = 0;
          const seq = [p2, p3, p4, p5, p6, p7, p8, p9];
          for (let k = 0; k < 8; k++) if (seq[k] === 0 && seq[(k + 1) % 8] === 1) a++;
          if (a !== 1) continue;
          if (step === 0 ? (p2 * p4 * p6 !== 0 || p4 * p6 * p8 !== 0) : (p2 * p4 * p8 !== 0 || p2 * p6 * p8 !== 0)) continue;
          stash.push(i);
        }
      }
      if (stash.length) {
        changed = true;
        for (const i of stash) img[i] = 0;
      }
    }
  }
  return img;
}

function tracePaths(sk, w, h) {
  const NB = [-1, -w - 1, -w, -w + 1, 1, w + 1, w, w - 1];
  const deg = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    if (!sk[i]) continue;
    let d = 0;
    for (const n of NB) if (sk[i + n]) d++;
    deg[i] = d;
  }
  const isNode = (i) => sk[i] && (deg[i] === 1 || deg[i] >= 3);
  const used = new Uint8Array(w * h); // skeleton pixels already consumed by a path
  const paths = [];
  const walk = (start, from) => {
    const pts = [start];
    let prev = from;
    let cur = from;
    used[from] = 1;
    for (;;) {
      if (cur !== from && isNode(cur)) { pts.push(cur); return pts; }
      let next = -1;
      for (const n of NB) {
        const j = cur + n;
        if (sk[j] && j !== prev && !used[j]) { next = j; break; }
      }
      if (next < 0) { pts.push(cur); return pts; }
      used[cur] = 1;
      pts.push(cur);
      prev = cur;
      cur = next;
    }
  };
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    if (!isNode(i) || used[i]) continue;
    for (const n of NB) {
      const j = i + n;
      if (sk[j] && !used[j]) paths.push(walk(i, j));
    }
    used[i] = 1;
  }
  // closed loops: whatever is left has degree 2 everywhere
  for (let i = 0; i < sk.length; i++) {
    if (!sk[i] || used[i]) continue;
    const pts = walk(i, i);
    if (pts.length > 3) paths.push(pts);
  }
  return paths;
}

function dpSimplify(pts, eps) {
  // pts: [{x, y}]; keeps ends, splits at the farthest point above eps
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    const ax = pts[a].x, ay = pts[a].y, bx = pts[b].x, by = pts[b].y;
    const dx = bx - ax, dy = by - ay;
    const L2 = dx * dx + dy * dy || 1e-9;
    let best = -1, bestD = 0;
    for (let i = a + 1; i < b; i++) {
      const t = ((pts[i].x - ax) * dx + (pts[i].y - ay) * dy) / L2;
      const cx = ax + dx * Math.max(0, Math.min(1, t));
      const cy = ay + dy * Math.max(0, Math.min(1, t));
      const d = Math.hypot(pts[i].x - cx, pts[i].y - cy);
      if (d > bestD) { bestD = d; best = i; }
    }
    if (bestD > eps) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

function wallSegments(mask, mw, mh, scale, tPx) {
  const sk = zhangSuenThin(mask, mw, mh);
  const paths = tracePaths(sk, mw, mh);
  // paths -> polylines -> simplified polylines (native px)
  const polylines = paths
    .map((p) => p.map((i) => ({ x: (i % mw) / scale, y: Math.floor(i / mw) / scale })))
    .map((p) => dpSimplify(p, 1.5));
  let segs = polylines
    .filter((p) => p.length >= 2)
    .map((p) => {
      const out = [];
      for (let i = 0; i < p.length - 1; i++) out.push({ x0: p[i].x, y0: p[i].y, x1: p[i + 1].x, y1: p[i + 1].y });
      return out;
    })
    .flat();
  const SNAP = 2.0; // native px endpoint snap (GT weld tolerance is ~3.1 px)
  const ANG = Math.cos(Math.PI * 15 / 180); // the scorer's own angle gate
  const near = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) <= SNAP;
  const cosAng = (s) => {
    const dx = s.x1 - s.x0, dy = s.y1 - s.y0;
    const L = Math.hypot(dx, dy) || 1e-9;
    return [dx / L, dy / L];
  };
  const mergeEnds = (a, b, which) => {
    // a's end `which` meets one of b's ends; collinear pairs become one
    // segment running between the two far endpoints
    const aEnd = which === 0 ? { x: a.x0, y: a.y0 } : { x: a.x1, y: a.y1 };
    const bEnds = [{ x: b.x0, y: b.y0 }, { x: b.x1, y: b.y1 }];
    for (let wb = 0; wb < 2; wb++) {
      if (!near(aEnd, bEnds[wb])) continue;
      const [aux, auy] = cosAng(a);
      const [bux, buy] = cosAng(b);
      if (Math.abs(aux * bux + auy * buy) < ANG) continue;
      const aFarPt = which === 0 ? { x: a.x1, y: a.y1 } : { x: a.x0, y: a.y0 };
      const bFar = bEnds[1 - wb];
      return { x0: aFarPt.x, y0: aFarPt.y, x1: bFar.x, y1: bFar.y };
    }
    return null;
  };
  // merge collinear segments meeting at a shared endpoint, to fixpoint
  let merged = true;
  while (merged) {
    merged = false;
    outer:
    for (let i = 0; i < segs.length; i++) {
      for (let j = i + 1; j < segs.length; j++) {
        for (const which of [0, 1]) {
          const m = mergeEnds(segs[i], segs[j], which);
          if (m) {
            segs.splice(j, 1);
            segs[i] = m;
            merged = true;
            break outer;
          }
        }
      }
    }
  }
  // prune skeleton nubs: a very short segment with at least one endpoint
  // nothing else touches, iterated. Nubs are 1-3 px; real walls at 256 px
  // run 6.6 px at the GT 1st percentile, so the bar sits below that.
  const spurMin = Math.max(3, 0.6 * tPx);
  let pruned = true;
  while (pruned) {
    pruned = false;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      const len = Math.hypot(s.x1 - s.x0, s.y1 - s.y0);
      if (len >= spurMin) continue;
      const ends = [{ x: s.x0, y: s.y0 }, { x: s.x1, y: s.y1 }];
      const touches = (e) => segs.some((o, j) => j !== i &&
        (Math.hypot(o.x0 - e.x, o.y0 - e.y) <= SNAP || Math.hypot(o.x1 - e.x, o.y1 - e.y) <= SNAP));
      if (ends.some((e) => !touches(e))) {
        segs.splice(i, 1);
        pruned = true;
        break;
      }
    }
  }
  // bridge collinear fragments across an opening-sized gap, to fixpoint
  let bridged = true;
  while (bridged) {
    bridged = false;
    outer2:
    for (let i = 0; i < segs.length; i++) {
      for (let j = i + 1; j < segs.length; j++) {
        const a = segs[i], b = segs[j];
        const [aux, auy] = cosAng(a);
        const [bux, buy] = cosAng(b);
        if (Math.abs(aux * bux + auy * buy) < ANG) continue;
        // perpendicular offset of b's ends from a's line
        const off = (p) => Math.abs((p.x - a.x0) * -auy + (p.y - a.y0) * aux);
        const aEnds = [{ x: a.x0, y: a.y0 }, { x: a.x1, y: a.y1 }];
        const bEnds = [{ x: b.x0, y: b.y0 }, { x: b.x1, y: b.y1 }];
        if (Math.max(...bEnds.map(off)) > 2.0) continue;
        const along = (p) => (p.x - a.x0) * aux + (p.y - a.y0) * auy;
        const aLo = Math.min(0, along(aEnds[1]));
        const aHi = Math.max(0, along(aEnds[1]));
        const bLo = Math.min(...bEnds.map(along));
        const bHi = Math.max(...bEnds.map(along));
        const gap = Math.max(bLo - aHi, aLo - bHi);
        if (gap > bridgeGap) continue;
        // merged: the farthest-apart endpoint pair
        let p0 = aEnds[0], p1 = bEnds[0], bestD = -1;
        for (const pa of aEnds) for (const pb of bEnds) {
          const d = Math.hypot(pa.x - pb.x, pa.y - pb.y);
          if (d > bestD) { bestD = d; p0 = pa; p1 = pb; }
        }
        segs[i] = { x0: p0.x, y0: p0.y, x1: p1.x, y1: p1.y };
        segs.splice(j, 1);
        bridged = true;
        break outer2;
      }
    }
  }
  // axis snap: a segment whose endpoints sit within 3 native px of an
  // axis-aligned line is drawn as an axis band at 256 px (sub-pixel lean, so
  // the image carries no slope information); visibly diagonal walls keep
  // their slope. Junction-scale diagonal stubs (short 45-degree artifacts
  // where the skeleton turns a corner or wraps a gap cap) are dropped: real
  // diagonal walls are longer.
  segs = segs.filter((s) => {
    const dx = Math.abs(s.x1 - s.x0), dy = Math.abs(s.y1 - s.y0);
    if (dy > dx && dx <= 3) { s.x1 = s.x0; return true; }
    if (dx > dy && dy <= 3) { s.y1 = s.y0; return true; }
    return Math.hypot(dx, dy) >= 12; // off-axis: keep only wall-scale segments
  });
  // snap near-coincident endpoints to their cluster centroid (3 native px =
  // 12 frame units, inside the scorer's 12.3-unit weld): junctions whose
  // branch pixels sit a few pixels apart otherwise fail to close faces
  {
    const pts = [];
    for (const s of segs) pts.push({ x: s.x0, y: s.y0 }, { x: s.x1, y: s.y1 });
    const cid = new Int32Array(pts.length).fill(-1);
    const centroids = [];
    for (let i = 0; i < pts.length; i++) {
      if (cid[i] >= 0) continue;
      const members = [i];
      cid[i] = centroids.length;
      for (let j = i + 1; j < pts.length; j++) {
        if (cid[j] < 0 && Math.hypot(pts[j].x - pts[i].x, pts[j].y - pts[i].y) <= SNAP) {
          cid[j] = centroids.length;
          members.push(j);
        }
      }
      let cx = 0, cy = 0;
      for (const m of members) { cx += pts[m].x; cy += pts[m].y; }
      centroids.push({ x: cx / members.length, y: cy / members.length });
    }
    segs.forEach((s, i) => {
      s.x0 = centroids[cid[2 * i]].x; s.y0 = centroids[cid[2 * i]].y;
      s.x1 = centroids[cid[2 * i + 1]].x; s.y1 = centroids[cid[2 * i + 1]].y;
    });
  }
  segs = segs.filter((s) => Math.hypot(s.x1 - s.x0, s.y1 - s.y0) >= 3);
  segs.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0 || a.x1 - b.x1 || a.y1 - b.y1);
  return segs;
}

const failures = [];
const t0 = Date.now();
const perPlan = [];
let nPred = 0;
const predsPath = join(outDir, `preds_${split}.jsonl`);
{
  let out = '';
  for (const row of rows) {
    const tPlan = Date.now();
    const id = row.id;
    const frame = Number(row.frame || 1024);
    let pred = null;
    let counts = null;
    try {
      const { doc } = await openAny(join(dataDir, row.image));
      const raster = await renderRasterNode(doc, 1, RASTER_SCALE);
      const res = detectOpenings(raster);
      const spaces = countEnclosedSpaces(raster, {}, res);
      const k = frame / Math.max(raster.width, raster.height); // image px -> frame units
      const s = res.walls.scale; // the detector may have worked upsampled
      const tPx = res.walls.thicknessPx / s; // native px
      const mw = res.walls.width, mh = res.walls.height;
      const segs = wallSegments(res.walls.mask, mw, mh, s, tPx);
      const walls = [];
      for (const g of segs) {
        walls.push({
          id: `w${walls.length + 1}`,
          start: [r2(g.x0 * k), r2(g.y0 * k)],
          end: [r2(g.x1 * k), r2(g.y1 * k)],
          thickness: r2(Math.max(1, res.walls.thicknessPx) * k),
          type: 'interior',
          openings: [],
        });
      }
      // openings: doors (double-leaf gaps are pushed once per leaf -> dedupe
      // by gap box) and windows, each attached to the nearest predicted wall
      const segDist = (p, g) => {
        const dx = g.x1 - g.x0, dy = g.y1 - g.y0;
        const L2 = dx * dx + dy * dy || 1e-9;
        const t = Math.max(0, Math.min(1, ((p.x - g.x0) * dx + (p.y - g.y0) * dy) / L2));
        return Math.hypot(p.x - (g.x0 + dx * t), p.y - (g.y0 + dy * t));
      };
      const attach = (cx, cy, halfW) => {
        let best = -1, bestD = Infinity;
        for (let i = 0; i < segs.length; i++) {
          const d = segDist({ x: cx, y: cy }, segs[i]);
          if (d < bestD) { bestD = d; best = i; }
        }
        return bestD <= Math.max(halfW, tPx) ? walls[best] : null;
      };
      const seenGap = new Set();
      let nDrop = 0;
      const addOpening = (o, kind) => {
        const key = `${o.px.x0},${o.px.y0},${o.px.x1},${o.px.y1}`;
        if (seenGap.has(key)) return;
        seenGap.add(key);
        const cx = ((o.px.x0 + o.px.x1 + 1) / 2) / s;
        const cy = ((o.px.y0 + o.px.y1 + 1) / 2) / s;
        const w = (o.widthPx / s) * k;
        const host = attach(cx, cy, o.widthPx / s / 2);
        if (!host) { nDrop++; return; }
        host.openings.push({ type: kind, center: [r2(cx * k), r2(cy * k)], width: r2(w) });
      };
      for (const d of res.doors) addOpening(d, 'door');
      for (const w of res.windows) addOpening(w, 'window');
      pred = { walls };
      if (roomsMode === 'spaces') {
        pred.rooms = spaces.spaces.map((sp) => ({
          label: '',
          walls: [],
          polygon: [
            [r2(sp.x0 * k), r2(sp.y0 * k)], [r2(sp.x1 * k), r2(sp.y0 * k)],
            [r2(sp.x1 * k), r2(sp.y1 * k)], [r2(sp.x0 * k), r2(sp.y1 * k)],
          ],
        }));
      }
      counts = {
        zeroWall: walls.length === 0,
        walls: walls.length,
        rooms: pred.rooms ? pred.rooms.length : null,
        doors: walls.reduce((a, w) => a + w.openings.filter((o) => o.type === 'door').length, 0),
        windows: walls.reduce((a, w) => a + w.openings.filter((o) => o.type === 'window').length, 0),
        passages: res.passages.length,
        spaces: spaces.count,
        openingsDropped: nDrop,
        gt: { walls: row.n_walls, rooms: row.n_rooms, openings: row.n_openings },
      };
      nPred++;
    } catch (err) {
      failures.push(`${id}: ${err instanceof Error ? err.message : String(err)}`);
      pred = null; // scores zero, per the benchmark's protocol
    }
    out += JSON.stringify({ id, pred }) + '\n';
    perPlan.push(counts);
    if (perPlan.length % 100 === 0) console.log(`  ${perPlan.length}/${rows.length} plans, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
  writeFileSync(predsPath, out);
}

const summary = {
  split, plans: rows.length, predicted: nPred, bridgeGapPx: bridgeGap, roomsMode,
  seconds: (Date.now() - t0) / 1000,
  totals: {
    zeroWall: perPlan.reduce((a, c) => a + (c?.zeroWall ? 1 : 0), 0),
    walls: perPlan.reduce((a, c) => a + (c?.walls || 0), 0),
    rooms: perPlan.reduce((a, c) => a + (c?.rooms || 0), 0),
    doors: perPlan.reduce((a, c) => a + (c?.doors || 0), 0),
    windows: perPlan.reduce((a, c) => a + (c?.windows || 0), 0),
    gtWalls: perPlan.reduce((a, c) => a + (c?.gt?.walls || 0), 0),
    gtRooms: perPlan.reduce((a, c) => a + (c?.gt?.rooms || 0), 0),
    gtOpenings: perPlan.reduce((a, c) => a + (c?.gt?.openings || 0), 0),
  },
  failures,
};
writeFileSync(join(outDir, `run_${split}.json`), JSON.stringify(summary, null, 1));
console.log(`${split}: ${nPred}/${rows.length} plans in ${summary.seconds.toFixed(0)} s (${(summary.seconds / rows.length).toFixed(2)} s/plan) -> ${predsPath}`);
console.log(`totals: walls ${summary.totals.walls} (gt ${summary.totals.gtWalls}), doors ${summary.totals.doors}, windows ${summary.totals.windows}, rooms ${summary.totals.rooms} (gt ${summary.totals.gtRooms}), zero-wall plans ${summary.totals.zeroWall}${failures.length ? `\nfailures:\n${failures.join('\n')}` : ''}`);

if (has('no-score')) process.exit(0);

// --- score with the benchmark's own scorer -----------------------------------
// baselines.score needs the fpvec-lab package on sys.path; -I keeps the venv
// clean of env/site interference, so a tiny runner injects the path itself.
const pkgRoot = existsSync(join(benchDir, 'baselines', 'score.py')) ? benchDir : dirname(dataDir);
const runnerPath = join(dirname(python), '..', 'run_score.py');
writeFileSync(runnerPath, `import sys
sys.path.insert(0, sys.argv[1])
from baselines.score import main
sys.argv = ["baselines.score"] + sys.argv[2:]
main()
`);
const runScore = (label, extra) => {
  const r = spawnSync(python, ['-I', runnerPath, pkgRoot, '--bench', dataDir, '--split', split,
    '--preds', predsPath, '--tol', ...tols.map(String), ...extra], { encoding: 'utf8', maxBuffer: 1 << 24 });
  if (r.status !== 0) {
    console.error(`scorer failed (${label}):\n${r.stderr || r.stdout}`);
    process.exit(1);
  }
  const parsed = JSON.parse(r.stdout);
  writeFileSync(join(outDir, label), JSON.stringify(parsed, null, 1));
  console.log(`\n${label}:\n${r.stdout}`);
  return parsed;
};
runScore(`score_${split}.json`, []);
const idsPath = join(dataDir, 'baselines', 'llm_subset_ids.json');
if (existsSync(idsPath)) runScore(`score_${split}_llm200.json`, ['--ids', idsPath]);
