// ScaledDrawingBench reference solver: pdf2takeoff's deterministic path, no
// model. For every question it reads the sheet the way the product does and
// answers from engine results only:
//   scale          findScaleRatio over the text layer (vector) or OCR words
//                  (raster); else the graphic scale bar or printed dimensions
//                  measured against their drawn length (scale.ts dimension
//                  votes + consensus);
//   area/perimeter Dynamic Fill (dynamicfill.ts) at the room label, with
//                  label, scale and vector doorway-bridge hints, as the app;
//   length         vector-layer wall geometry (vector.ts), or ink-run
//                  measurement on the page raster where there is no vector
//                  layer (the automated equivalent of clicking a wall's ends);
//   count          the scan tiers (vector match, else tier-1 CV) from one
//                  click on the legend symbol, legend instance excluded;
//   dimension_read the printed value nearest the named side of the room;
//   compare        the revision-diff path (ops.compareDocs, revdiff.ts) on
//                  vector pairs; pixel diff plus re-scans on raster pairs.
// Anything it cannot derive is answered "unanswerable", never guessed. The
// solver reads only a question's id, type, text and unit, never its answer
// or provenance.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { openPdf } from '../../src/headless/pdfjs-node.ts';
import { renderRasterNode } from '../../src/headless/raster-node.ts';
import { RASTER_SCALE } from '../../src/engine/ports.ts';
import { dynamicFill } from '../../src/engine/dynamicfill.ts';
import { scanDocAt, vectorDocPage, compareDocs } from '../../src/headless/ops.ts';
import { cvScan } from '../../src/engine/scan-cv.ts';
import { doorBridgesFor } from '../../src/engine/fill-vector.ts';
import { findScaleRatio, roomLabelPoints, wordsFromTextItem } from '../../src/engine/ocr.ts';
import { scaleVotesFromWords, scaleConsensus, dimensionVote } from '../../src/engine/scale.ts';
import { vectorDiff, textDiff } from '../../src/engine/revdiff.ts';
import { diffMask, maskRegions } from '../../src/engine/diff.ts';
import { metersPerPtForRatio, METERS_PER_PT } from '../../src/engine/units.ts';
import { polyArea, polyPerimeter } from './draw.mjs';
import { pageRgbaEngine, pageRgbaDecode, turnRgba, rasterPageOf, inkMask, longestRuns, bands, followInk } from './raster.mjs';
import { ocrWords, uprightScore, terminateOcr } from './ocr-node.mjs';
import { LEGEND_OFFSET_PT, CLASSES, pointInPoly, segHitsRect } from './sheet.mjs';

const UNANS = 'unanswerable';
const FT = 0.3048;
const PLURAL_TO_CLASS = [
  [/downlights?/i, 'downlight'],
  [/gpos?\b/i, 'gpo'],
  [/switch(es)?/i, 'switch'],
  [/smoke detectors?/i, 'smoke detector'],
  [/diffusers?/i, 'diffuser'],
];

/** Printed dimension text to metres: "4200" (mm) or 12'-6" (feet-inches, OCR-tolerant). */
export function parseDim(text) {
  const s = text.trim();
  let m = s.match(/^(\d{3,5})$/);
  if (m) return { metres: parseInt(m[1], 10) / 1000, unit: 'mm', value: parseInt(m[1], 10) };
  m = s.match(/^(\d{1,3})['’´`]\s*-?\s*(\d{1,2})(?:["”″]|''|'')?$/);
  if (m) {
    const ft = parseInt(m[1], 10) + parseInt(m[2], 10) / 12;
    return { metres: ft * FT, unit: 'ft', value: ft };
  }
  return null;
}

function fromMetres(v, unit) {
  switch (unit) {
    case 'm':
      return v;
    case 'ft':
      return v / FT;
    case 'm2':
      return v;
    case 'ft2':
      return v / (FT * FT);
    default:
      return v;
  }
}

function round(v, d = 3) {
  const k = 10 ** d;
  return Math.round(v * k) / k;
}

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

const norm = (s) => s.toUpperCase().replace(/\s+/g, ' ').trim();

// ---------- sheet context ----------

/** Group OCR words into lines and phrases (1 to 3 consecutive words) for label lookup. */
function phrasesFromWords(words) {
  const sorted = [...words].sort((a, b) => b.yPt - a.yPt || a.xPt - b.xPt);
  const lines = [];
  for (const w of sorted) {
    const line = lines.find((l) => Math.abs(l.y - w.yPt) < 0.6 * Math.max(l.h, w.hPt) && w.xPt - w.wPt / 2 - l.right < 1.6 * Math.max(l.h, w.hPt) && w.xPt > l.right - 2);
    if (line) {
      line.words.push(w);
      line.right = w.xPt + w.wPt / 2;
      line.y = (line.y * (line.words.length - 1) + w.yPt) / line.words.length;
    } else lines.push({ words: [w], y: w.yPt, h: w.hPt, right: w.xPt + w.wPt / 2 });
  }
  const phrases = [];
  for (const l of lines) {
    l.words.sort((a, b) => a.xPt - b.xPt);
    for (let i = 0; i < l.words.length; i++) {
      for (let n = 1; n <= 3 && i + n <= l.words.length; n++) {
        const ws = l.words.slice(i, i + n);
        phrases.push({
          text: norm(ws.map((w) => w.text).join(' ')),
          x: ws.reduce((s, w) => s + w.xPt, 0) / n,
          y: ws.reduce((s, w) => s + w.yPt, 0) / n,
          startX: ws[0].xPt - ws[0].wPt / 2,
          conf: Math.min(...ws.map((w) => w.conf)),
        });
      }
    }
  }
  return { lines, phrases };
}

function findPhrase(ctx, name) {
  const target = norm(name);
  const exact = ctx.phrases.filter((p) => p.text === target);
  if (exact.length) return exact.sort((a, b) => b.conf - a.conf)[0];
  const squashed = target.replace(/ /g, '');
  const near = ctx.phrases
    .map((p) => ({ p, d: Math.min(levenshtein(p.text, target), levenshtein(p.text.replace(/ /g, ''), squashed)) }))
    .filter(({ p, d }) => d <= (target.length >= 5 ? 1 : 0) && Math.abs(p.text.length - target.length) <= 1)
    .sort((a, b) => a.d - b.d || b.p.conf - a.p.conf);
  return near.length ? near[0].p : null;
}

/** Walls in a vector page: filled, straight paths at least 30 pt long and up to 30 pt thick (plus every filled rectangle, for collinear stubs). */
function wallsFromVec(vec) {
  const walls = [];
  const filled = [];
  vec.paths.forEach((p, i) => {
    const seg = vec.segs[p.segs[0]];
    if (!seg || !seg.filled || p.curve) return;
    const w = p.x1 - p.x0;
    const h = p.y1 - p.y0;
    const rect = { x0: p.x0, y0: p.y0, x1: p.x1, y1: p.y1, w, h, path: i };
    filled.push(rect);
    if (Math.max(w, h) < 30 || Math.min(w, h) < 0.9 || Math.min(w, h) > 30) return;
    walls.push(rect);
  });
  walls.filled = filled;
  return walls;
}

async function textLayerOf(pdf) {
  const tc = await (await pdf.getPage(1)).getTextContent();
  const items = tc.items;
  const words = items.flatMap((it) => wordsFromTextItem(it.str ?? '', it.transform, it.width, it.height));
  return { items, words };
}

async function openSheet(setDir, entry, opts) {
  const bytes = new Uint8Array(readFileSync(join(setDir, entry.file)));
  const pdf = await openPdf(bytes);
  const { items, words: textWords } = await textLayerOf(pdf);
  const vec = await vectorDocPage(pdf, 1).catch(() => null);
  const isVector = textWords.length > 0 && !!vec && vec.segs.length > 20;
  // OCR cache entries are keyed by the file's content, so sets sharing sheet ids never collide
  const cacheKey = `${entry.id}-${createHash('sha1').update(bytes).digest('hex').slice(0, 12)}`;
  // the solver gets only the sheet's identity — never the manifest's
  // answer-adjacent fields (ratio, symbols, rooms, legend), so no future
  // edit can accidentally solve from the ground truth
  const sheet = { id: entry.id, revB: entry.revB };
  const ctx = { id: entry.id, bytes, pdf, isVector, notes: [], fills: new Map(), scans: new Map(), opts, setDir, sheet, cacheKey };
  if (isVector) {
    ctx.words = textWords;
    ctx.items = items;
    ctx.vec = vec;
    ctx.walls = wallsFromVec(vec);
    ctx.labelPoints = roomLabelPoints(items);
    // one phrase per text item (a label is drawn as one item) plus word-level phrases
    const itemPhrases = items.flatMap((it) => {
      const ws = wordsFromTextItem(it.str ?? '', it.transform, it.width, it.height);
      if (!ws.length) return [];
      return [{ text: norm(it.str), x: ws.reduce((s, w) => s + w.xPt, 0) / ws.length, y: ws.reduce((s, w) => s + w.yPt, 0) / ws.length, startX: ws[0].xPt - ws[0].wPt / 2, conf: 100 }];
    });
    ctx.phrases = itemPhrases;
    let rasterPromise = null;
    ctx.raster = () => (rasterPromise ??= renderRasterNode(pdf, 1, RASTER_SCALE));
    ctx.scan = (pt) => scanDocAt(pdf, 1, pt);
    ctx.rasterSource = 'engine';
  } else {
    const mode = opts.rasterMode ?? 'engine';
    let rgba = mode === 'engine' ? await pageRgbaEngine(bytes) : await pageRgbaDecode(bytes);
    ctx.rasterSource = rgba.source;
    let best = null;
    if (opts.ocr !== false) {
      const words0 = await ocrWords(rgba, RASTER_SCALE, `${cacheKey}-${rgba.source}-0`, opts);
      best = { turns: 0, words: words0, score: uprightScore(words0) };
      const weak = !words0.some((w) => /^(SCALE|LEGEND|PLAN|SHEET)$/i.test(w.text));
      if (weak) {
        for (const turns of [1, 3]) {
          const turned = turnRgba(rgba, turns);
          const ws = await ocrWords(turned, RASTER_SCALE, `${cacheKey}-${rgba.source}-${turns}`, opts);
          const score = uprightScore(ws);
          if (score > best.score) best = { turns, words: ws, score };
        }
      }
      if (best.turns) {
        rgba = turnRgba(rgba, best.turns);
        ctx.notes.push(`${entry.id}: scan read sideways, turned ${best.turns * 90} degrees`);
      }
    }
    ctx.turns = best?.turns ?? 0;
    ctx.rgba = rgba;
    ctx.page = rasterPageOf(rgba);
    ctx.words = best?.words ?? [];
    const { phrases, lines } = phrasesFromWords(ctx.words);
    ctx.phrases = phrases;
    ctx.labelPoints = lines
      .filter((l) => (l.words.map((w) => w.text).join('').match(/[A-Za-z]/g) ?? []).length >= 2 && !/^\d/.test(l.words[0].text))
      .map((l) => ({ x: l.words.reduce((s, w) => s + w.xPt, 0) / l.words.length, y: l.y }));
    ctx.raster = async () => ctx.page;
    ctx.scan = async (pt) => cvScan(ctx.page, pt);
    let inkP = null;
    ctx.ink = () => (inkP ??= inkMask(rgba));
  }
  return ctx;
}

// ---------- scale ----------

/**
 * A graphic scale bar: numbered ticks on one baseline ("0 5 10") with a unit
 * word below. Three or more ticks that agree on one value-per-point (a
 * least-squares line through them, small residuals) give the scale from the
 * fitted slope — a stray number from a dimension string nearby cannot fake
 * the run, and the fit averages out tick-placement noise. A misread "0"
 * (OCR often sees "O" or "[J") simply drops out of the run. The old
 * farthest-pair reading remains as the fallback when only two ticks
 * survive.
 */
function readScaleBar(ctx) {
  const words = ctx.words;
  const units = words.filter((w) => /^(METRES|METERS|FEET)$/i.test(w.text));
  let best = null;
  for (const unit of units) {
    const ticks = words
      .filter((w) => /^[0O]$|^\d{1,3}$/.test(w.text) && Math.abs(w.xPt - unit.xPt) < 220 && w.yPt > unit.yPt + 4 && w.yPt < unit.yPt + 40)
      .map((w) => ({ w, v: /^[0O]$/.test(w.text) ? 0 : parseInt(w.text, 10) }))
      .sort((a, b) => a.w.xPt - b.w.xPt);
    // the longest run of >= 3 ticks whose values rise linearly with x
    const mPerUnit = /FEET/i.test(unit.text) ? FT : 1;
    for (let lo = 0; lo < ticks.length; lo++) {
      for (let hi = lo + 2; hi < ticks.length; hi++) {
        const run = ticks.slice(lo, hi + 1);
        const sameRow = run.every((t, k) => k === 0 || Math.abs(t.w.yPt - run[0].w.yPt) <= 0.7 * Math.max(t.w.hPt, run[0].w.hPt));
        if (!sameRow) continue;
        const xs = run.map((t) => t.w.xPt);
        const vs = run.map((t) => t.v);
        const fit = leastSquares(xs, vs);
        if (!fit) continue;
        const resid = Math.max(...run.map((t, k) => Math.abs(vs[k] - (fit.a + fit.b * xs[k]))));
        if (fit.b <= 0 || resid > 0.25 + 0.02 * Math.max(...vs)) continue;
        const dist = xs[xs.length - 1] - xs[0];
        const ratio = (fit.b * mPerUnit) / METERS_PER_PT;
        if (ratio < 5 || ratio > 5000) continue;
        if (!best || run.length > best.run || (run.length === best.run && dist > best.dist)) {
          best = { ratio, dist, run: run.length, source: `graphic scale bar ${run.length} ticks ${vs.join(' ')} ${unit.text.toLowerCase()}, ${fit.b.toFixed(4)} per pt` };
        }
      }
    }
    // fallback: the two farthest plausible ticks (the pre-fit reading)
    for (const a of ticks) {
      for (const b of ticks) {
        if (b.v <= a.v || b.w.xPt <= a.w.xPt + 10 || Math.abs(a.w.yPt - b.w.yPt) > 0.7 * Math.max(a.w.hPt, b.w.hPt)) continue;
        const dist = b.w.xPt - a.w.xPt;
        const ratio = ((b.v - a.v) * mPerUnit) / (dist * METERS_PER_PT);
        if (ratio < 5 || ratio > 5000) continue;
        if (!best || (best.run <= 2 && dist > best.dist)) best = { ratio, dist, run: 2, source: `graphic scale bar ${a.v} to ${b.v} ${unit.text.toLowerCase()} over ${dist.toFixed(1)} pt` };
      }
    }
  }
  return best ? { ratio: best.ratio, source: best.source } : null;
}

/** Least-squares y = a + b x over equal-length arrays; null when x has no spread. */
function leastSquares(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  if (den <= 1e-9) return null;
  const b = num / den;
  return { a: my - b * mx, b };
}

/** Length (pt) of the dimension line a printed value labels, from the vector layer or the ink. */
function dimensionLinePt(ctx, w) {
  if (ctx.isVector) {
    const vertical = Math.abs(((w.angleDeg ?? 0) + 360) % 180 - 90) < 5;
    let best = null;
    for (const s of ctx.vec.segs) {
      if (!s.stroked || s.filled || s.curve || s.lineWidth > 0.8) continue;
      const len = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
      if (len < 12) continue;
      if (!vertical) {
        if (Math.abs(s.y1 - s.y2) > 0.3) continue;
        const off = w.yPt - s.y1;
        if (off < 1 || off > 14) continue;
        if (w.xPt < Math.min(s.x1, s.x2) - 2 || w.xPt > Math.max(s.x1, s.x2) + 2) continue;
        if (!best || off < best.off) best = { off, len };
      } else {
        if (Math.abs(s.x1 - s.x2) > 0.3) continue;
        const off = s.x1 - w.xPt;
        if (off < 1 || off > 14) continue;
        if (w.yPt < Math.min(s.y1, s.y2) - 2 || w.yPt > Math.max(s.y1, s.y2) + 2) continue;
        if (!best || off < best.off) best = { off, len };
      }
    }
    return best?.len ?? null;
  }
  // raster: the longest horizontal ink run through the word's x, 1 to 14 pt below the text
  const ink = ctx.ink();
  const { width: W, height: H } = ctx.rgba;
  const S = RASTER_SCALE;
  const c = ctx.page.toRaster(w.xPt, w.yPt);
  const xc = Math.round(c.x);
  let best = 0;
  for (let y = Math.round(c.y + 1 * S); y <= Math.min(H - 1, Math.round(c.y + 14 * S)); y++) {
    const row = y * W;
    const run = (dir) => {
      let x = xc;
      let gap = 0;
      let last = xc;
      while (x >= 0 && x < W) {
        if (ink[row + x]) {
          last = x;
          gap = 0;
        } else if (++gap > 2) break;
        x += dir;
      }
      return last;
    };
    if (!ink[row + xc] && !ink[row + xc + 1] && !ink[row + xc - 1]) continue;
    const len = run(1) - run(-1) + 1;
    if (len > best) best = len;
  }
  return best >= 12 * S ? best / S : null;
}

function scaleFromDimensions(ctx) {
  const votes = [];
  for (const w of ctx.words) {
    const d = parseDim(w.text);
    if (!d) continue;
    const len = dimensionLinePt(ctx, w);
    if (!len) continue;
    const v = dimensionVote(len, d.metres, `printed ${w.text}`);
    if (v) votes.push(v);
  }
  // one printed value is never enough: a stray number over a long line (an
  // OCR'd date fragment above the sheet frame) would vote for nonsense
  if (votes.length < 2) return null;
  const c = scaleConsensus(votes);
  const total = votes.reduce((s, v) => s + v.weight, 0);
  if (c.ratio === undefined || c.ratio < 5 || c.ratio > 5000 || c.support < 2) return null;
  if (c.status === 'agreed' || (c.status === 'conflict' && c.support >= 0.6 * total)) {
    return { ratio: c.ratio, source: `${votes.length} printed dimension${votes.length === 1 ? '' : 's'} measured against their drawn length (${c.status})` };
  }
  return null;
}

/**
 * The scale note's right side ('= 1'-0"') is the smallest print in the title
 * block and the first thing a degraded scan destroys, while the 'SCALE:'
 * keyword itself usually survives at full-page resolution. Re-read the strip
 * beside (and under) the keyword at 4x — a few square centimetres of paper —
 * and parse the recovered tokens with the keyword context restored.
 */
async function rereadScaleNote(ctx) {
  const anchor = ctx.words.find((w) => /^SCALE:?$/i.test(w.text) && w.conf >= 60);
  if (!anchor) return null;
  const { ocrRaster } = await import('../../src/headless/ocr-node.ts');
  const raster = await ctx.raster();
  const regions = [
    { x0: anchor.xPt + anchor.wPt / 2 + 1, y0: anchor.yPt - 6, x1: anchor.xPt + anchor.wPt / 2 + 130, y1: anchor.yPt + 9, where: 'beside' },
    { x0: anchor.xPt - 24, y0: anchor.yPt + 4, x1: anchor.xPt + 126, y1: anchor.yPt + 22, where: 'below' },
  ];
  for (const r of regions) {
    if (r.x1 <= r.x0 || r.y1 <= r.y0) continue;
    let words;
    try {
      words = await ocrRaster(raster, { region: r, upsample: 4 });
    } catch {
      return null;
    }
    if (!words.length) continue;
    const synth = [{ text: 'SCALE:', conf: 95, xPt: anchor.xPt, yPt: anchor.yPt, wPt: anchor.wPt, hPt: anchor.hPt }, ...words];
    const hit = findScaleRatio(synth, `OCR re-read ${r.where} the keyword at 4x`);
    if (hit && hit.ratio >= 5 && hit.ratio <= 5000) return { ...hit, source: `${hit.source} (re-read ${r.where} 'SCALE:' at 4x)` };
  }
  return null;
}

async function solveScale(ctx) {
  if (ctx.scale !== undefined) return ctx.scale;
  const origin = ctx.isVector ? 'text layer' : 'OCR';
  const { nts } = scaleVotesFromWords(ctx.words, origin);
  let hit = findScaleRatio(ctx.words, origin);
  if (!hit) hit = readScaleBar(ctx);
  if (!hit && !ctx.isVector) hit = await rereadScaleNote(ctx);
  if (!hit) hit = scaleFromDimensions(ctx);
  ctx.scale = hit ? { ...hit, nts } : { ratio: null, nts };
  ctx.mpp = hit ? metersPerPtForRatio(hit.ratio) : undefined;
  return ctx.scale;
}

// ---------- rooms ----------

async function fillRoom(ctx, name) {
  if (ctx.fills.has(name)) return ctx.fills.get(name);
  let result = null;
  const label = findPhrase(ctx, name);
  if (label) {
    const raster = await ctx.raster();
    const hints = { labels: ctx.labelPoints, ...(ctx.mpp ? { metersPerPt: ctx.mpp } : {}), ...(ctx.isVector ? { bridges: doorBridgesFor(ctx.vec, ctx.mpp) } : {}) };
    // click on open floor just below the label (an estimator clicks beside the
    // name, not on its glyphs); the fill must come back around the label
    let lastError = null;
    for (const [dx, dy] of [[0, -10], [0, 10], [-20, -10], [20, -10], [-20, 10], [20, 10]]) {
      const r = dynamicFill(raster, { x: label.x + dx, y: label.y + dy }, undefined, hints);
      if ('error' in r) {
        lastError = r.error;
        continue;
      }
      if (!pointInPoly({ x: label.x, y: label.y }, r.points)) {
        lastError = 'fill does not enclose the label';
        continue;
      }
      // a room is metres across; a glyph's counter or a speck ring is not
      const minPt2 = ctx.mpp ? Math.max(400, 1 / (ctx.mpp * ctx.mpp)) : 400;
      if (polyArea(r.points) < minPt2) {
        lastError = 'fill is smaller than any room';
        continue;
      }
      result = { points: r.points, label, click: { x: label.x + dx, y: label.y + dy } };
      break;
    }
    if (!result) ctx.notes.push(`${ctx.id}: fill at ${name}: ${String(lastError).replace(/\u2014/g, ',')}`);
  } else ctx.notes.push(`${ctx.id}: label "${name}" not found`);
  ctx.fills.set(name, result);
  return result;
}

const bboxOf = (pts) => ({ x0: Math.min(...pts.map((p) => p.x)), x1: Math.max(...pts.map((p) => p.x)), y0: Math.min(...pts.map((p) => p.y)), y1: Math.max(...pts.map((p) => p.y)) });

// ---------- lengths ----------

function lengthVector(ctx, which) {
  const walls = ctx.walls;
  if (!walls.length) return null;
  if (which.kind === 'north') {
    const horiz = walls.filter((w) => w.w > w.h && w.w >= 60);
    if (!horiz.length) return null;
    const top = horiz.sort((a, b) => b.y1 - a.y1 || b.w - a.w)[0];
    return top.w;
  }
  if (which.kind === 'east') {
    const vert = walls.filter((w) => w.h > w.w && w.h >= 60);
    if (!vert.length) return null;
    const right = vert.sort((a, b) => b.x1 - a.x1 || b.h - a.h)[0];
    return right.h;
  }
  const A = findPhrase(ctx, which.rooms[0]);
  const B = findPhrase(ctx, which.rooms[1]);
  if (!A || !B) return null;
  // rays between the labels, a few points apart, so a door opening at label height is not mistaken for no wall
  let crossed = [];
  for (const dy of [0, -4, 4]) {
    crossed = walls.filter((w) => w.h > w.w && segHitsRect({ x: A.x, y: A.y + dy }, { x: B.x, y: B.y + dy }, w));
    if (crossed.length) break;
  }
  if (!crossed.length) return null;
  const first = crossed.sort((a, b) => Math.abs((a.x0 + a.x1) / 2 - A.x) - Math.abs((b.x0 + b.x1) / 2 - A.x))[0];
  const xc = (first.x0 + first.x1) / 2;
  // every piece of the partition, door stubs included: same centreline and thickness
  const collinear = walls.filled.filter((w) => Math.abs((w.x0 + w.x1) / 2 - xc) < 0.5 && Math.abs(w.w - first.w) < 0.5);
  return Math.max(...collinear.map((w) => w.y1)) - Math.min(...collinear.map((w) => w.y0));
}

function lengthRaster(ctx, which) {
  const ink = ctx.ink();
  const { width: W, height: H } = ctx.rgba;
  const S = RASTER_SCALE;
  ctx.runs ??= longestRuns(ink, W, H);
  const { rowLen, rowStart, colLen, colStart } = ctx.runs;
  const margin = Math.round(25 * S);
  const rowBands = bands(rowLen, rowStart, 0.2 * W, 4, margin);
  const colBands = bands(colLen, colStart, 0.2 * H, 4, margin);
  if (which.kind === 'north') {
    if (!rowBands.length) return null;
    return rowBands[0].len / S; // topmost band in raster rows is the north wall
  }
  if (which.kind === 'east') {
    if (!colBands.length) return null;
    return colBands[colBands.length - 1].len / S;
  }
  const A = findPhrase(ctx, which.rooms[0]);
  const B = findPhrase(ctx, which.rooms[1]);
  if (!A || !B) return null;
  const a = ctx.page.toRaster(A.x, A.y);
  const b = ctx.page.toRaster(B.x, B.y);
  const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y));
  // walk the ray between the labels; the first ink crossing at least 3 px
  // thick whose column of ink runs for a room's height is the partition
  // (specks and symbol strokes are thin or short)
  const maxGap = Math.round((ctx.mpp ? 1.3 / ctx.mpp : 20) * S);
  const minExtent = (ctx.mpp ? Math.max(60, 2 / ctx.mpp) : 60) * S;
  const tePt = rowBands.length ? (rowBands[0].b - rowBands[0].a) / S : 0;
  let enter = -1;
  for (let k = 0; k <= n; k++) {
    const x = Math.round(a.x + ((b.x - a.x) * k) / n);
    const y = Math.round(a.y + ((b.y - a.y) * k) / n);
    const on = x >= 0 && y >= 0 && x < W && y < H && ink[y * W + x];
    if (on && enter < 0) enter = k;
    if (!on && enter >= 0) {
      if (k - enter >= 3) {
        const mid = (enter + k) / 2;
        const cx = Math.round(a.x + ((b.x - a.x) * mid) / n);
        const cy = Math.round(a.y + ((b.y - a.y) * mid) / n);
        const top = followInk(ink, W, H, cx, cy, 0, -1, maxGap);
        const bottom = followInk(ink, W, H, cx, cy, 0, 1, maxGap);
        if (bottom.y - top.y + 1 >= minExtent) return (bottom.y - top.y + 1) / S - tePt;
      }
      enter = -1;
    }
  }
  return null;
}

// ---------- counts ----------

async function classHits(ctx, cls) {
  if (ctx.scans.has(cls)) return ctx.scans.get(cls);
  let out = null;
  const label = findPhrase(ctx, cls.toUpperCase());
  if (label) {
    const click = { x: label.startX - LEGEND_OFFSET_PT, y: label.y };
    const r = await ctx.scan(click);
    if ('error' in r) ctx.notes.push(`${ctx.id}: scan ${cls}: ${r.error}`);
    else out = { hits: r.hits.filter((h) => Math.hypot(h.x - click.x, h.y - click.y) > 25), provider: r.provider, click };
  } else ctx.notes.push(`${ctx.id}: legend entry "${cls}" not found`);
  ctx.scans.set(cls, out);
  return out;
}

// ---------- compare ----------

function subPage(vec, pred) {
  const keep = new Set();
  vec.paths.forEach((p, i) => {
    if (pred(p, i)) for (let s = p.segs[0]; s < p.segs[1]; s++) keep.add(s);
  });
  return { segs: vec.segs.filter((_, i) => keep.has(i)), paths: [], forms: 0, layers: 0 };
}

async function compareVector(ctx, revBFile) {
  const bytesB = new Uint8Array(readFileSync(join(ctx.setDir, revBFile)));
  const docB = await openPdf(bytesB);
  const cmp = await compareDocs(ctx.pdf, docB);
  const changes = new Set();
  const pixelNote = `compareDocs: ${cmp.sheets[0]?.changedFraction ?? 0} of pixels changed${cmp.changedSheets.length ? '' : ' (below the changed-sheet threshold)'}`;
  const vb = await vectorDocPage(docB, 1);
  const isWall = (vec) => (p) => {
    const seg = vec.segs[p.segs[0]];
    return seg && seg.filled && !p.curve && Math.max(p.x1 - p.x0, p.y1 - p.y0) >= 30;
  };
  const isSmall = (p) => Math.max(p.x1 - p.x0, p.y1 - p.y0) <= 30;
  const wallsDiff = vectorDiff(subPage(ctx.vec, isWall(ctx.vec)), subPage(vb, isWall(vb)));
  const symDiff = vectorDiff(subPage(ctx.vec, isSmall), subPage(vb, isSmall));
  if (wallsDiff.moved.some((m) => Math.hypot(m.dxPt, m.dyPt) >= 3)) changes.add('wall moved');
  const doorPt = ctx.mpp ? 0.9 / ctx.mpp : null;
  // a wall that moved and changed shape (a door added to it in the same
  // revision) has no identical cluster to match, and its old and new pieces
  // cluster with the partitions that meet them; so compare the wall
  // rectangles themselves: a rectangle gone from A whose thickness and extent
  // reappear in B a short way off, parallel, is a moved wall
  const key = (r) => `${Math.round(r.x0 * 4)},${Math.round(r.y0 * 4)},${Math.round(r.x1 * 4)},${Math.round(r.y1 * 4)}`;
  const rectsB = wallsFromVec(vb);
  const keysA = new Set(ctx.walls.filled.map(key));
  const keysB = new Set(rectsB.filled.map(key));
  const gone = ctx.walls.filled.filter((r) => !keysB.has(key(r)) && Math.max(r.w, r.h) >= 30);
  const fresh = rectsB.filled.filter((r) => !keysA.has(key(r)));
  for (const r of gone) {
    const horizontal = r.w >= r.h;
    const thick = horizontal ? r.h : r.w;
    const parallel = fresh.filter((a) => {
      if ((a.w >= a.h) !== horizontal || Math.abs((horizontal ? a.h : a.w) - thick) > 0.5) return false;
      const offset = horizontal ? Math.abs((a.y0 + a.y1) / 2 - (r.y0 + r.y1) / 2) : Math.abs((a.x0 + a.x1) / 2 - (r.x0 + r.x1) / 2);
      const overlap = horizontal ? Math.min(a.x1, r.x1) - Math.max(a.x0, r.x0) : Math.min(a.y1, r.y1) - Math.max(a.y0, r.y0);
      return offset >= 2 && offset <= (ctx.mpp ? 1.5 / ctx.mpp : 100) && overlap > 0;
    });
    const total = parallel.reduce((s, a) => s + Math.max(a.w, a.h), 0);
    const len = Math.max(r.w, r.h);
    if (total >= 0.5 * len && total <= 2 * len) changes.add('wall moved');
    // a door cut into this wall (moved or not): its new pieces, in line with
    // each other at the old or the new place, leave a door-sized gap
    const inLine = rectsB.filled.filter((a) => {
      if ((a.w >= a.h) !== horizontal || Math.abs((horizontal ? a.h : a.w) - thick) > 0.5) return false;
      const offset = horizontal ? Math.abs((a.y0 + a.y1) / 2 - (r.y0 + r.y1) / 2) : Math.abs((a.x0 + a.x1) / 2 - (r.x0 + r.x1) / 2);
      const overlap = horizontal ? Math.min(a.x1, r.x1) - Math.max(a.x0, r.x0) : Math.min(a.y1, r.y1) - Math.max(a.y0, r.y0);
      return offset <= (ctx.mpp ? 1.5 / ctx.mpp : 100) && overlap > 0 && !keysA.has(key(a));
    });
    const spans = inLine.map((a) => (horizontal ? [a.x0, a.x1] : [a.y0, a.y1])).sort((p, q) => p[0] - q[0]);
    for (let i = 1; i < spans.length; i++) {
      const gap = spans[i][0] - spans[i - 1][1];
      const doorish = doorPt ? gap >= 0.5 * doorPt && gap <= 1.4 * doorPt : gap >= 8 && gap <= 60;
      // the gap must lie inside the old wall's extent: a door that already existed in A is not new
      const lo = horizontal ? r.x0 : r.y0;
      const hi = horizontal ? r.x1 : r.y1;
      if (doorish && spans[i - 1][1] > lo && spans[i][0] < hi) changes.add('door added');
    }
  }
  for (const r of wallsDiff.regions.filter((r) => r.kind === 'removed' && Math.max(r.wPt, r.hPt) >= 20)) {
    const horizontal = r.wPt >= r.hPt;
    const inside = wallsDiff.regions.filter((a) => a.kind === 'added' && a.xPt >= r.xPt - 2 && a.yPt >= r.yPt - 2 && a.xPt + a.wPt <= r.xPt + r.wPt + 2 && a.yPt + a.hPt <= r.yPt + r.hPt + 2);
    if (inside.length < 2) continue;
    const spans = inside.map((a) => (horizontal ? [a.xPt, a.xPt + a.wPt] : [a.yPt, a.yPt + a.hPt])).sort((p, q) => p[0] - q[0]);
    for (let i = 1; i < spans.length; i++) {
      const gap = spans[i][0] - spans[i - 1][1];
      const ok = doorPt ? gap >= 0.5 * doorPt && gap <= 1.4 * doorPt : gap >= 8 && gap <= 60;
      if (ok) changes.add('door added');
    }
  }
  const legendClasses = CLASSES.filter((c) => findPhrase(ctx, c.toUpperCase()));
  const hitsByClass = [];
  for (const c of legendClasses) {
    const h = await classHits(ctx, c);
    if (h) hitsByClass.push({ c, hits: h.hits });
  }
  for (const r of symDiff.regions.filter((r) => r.kind === 'removed' && Math.max(r.wPt, r.hPt) <= 30)) {
    const cx = r.xPt + r.wPt / 2;
    const cy = r.yPt + r.hPt / 2;
    for (const { c, hits } of hitsByClass) if (hits.some((h) => Math.hypot(h.x - cx, h.y - cy) <= 8)) changes.add(`${c} removed`);
  }
  const { words: wordsB } = await textLayerOf(docB);
  const td = textDiff(ctx.words, wordsB);
  if (td.changed.some((c) => parseDim(c.from) && parseDim(c.to) && c.from !== c.to)) changes.add('dimension changed');
  // a re-centred value moves with its dimension line, so it can read as removed plus added nearby
  for (const r of td.removed) {
    const dr = parseDim(r.text);
    if (!dr) continue;
    if (td.added.some((a) => parseDim(a.text) && a.text !== r.text && Math.hypot(a.atPt[0] - r.atPt[0], a.atPt[1] - r.atPt[1]) <= 40)) changes.add('dimension changed');
  }
  return { changes: [...changes].sort(), note: `${pixelNote}; vector diff: ${wallsDiff.moved.length} moved, ${wallsDiff.regions.length} wall regions, ${symDiff.regions.length} symbol regions, ${td.changed.length} text changes` };
}

async function compareRaster(ctx, revBFile) {
  const bytesB = new Uint8Array(readFileSync(join(ctx.setDir, revBFile)));
  let rgbaB = ctx.rasterSource === 'engine' ? await pageRgbaEngine(bytesB) : await pageRgbaDecode(bytesB);
  if (ctx.turns) rgbaB = turnRgba(rgbaB, ctx.turns);
  if (rgbaB.width !== ctx.rgba.width || rgbaB.height !== ctx.rgba.height) return { changes: [], note: 'revision B page size differs' };
  const S = RASTER_SCALE;
  const { mask, changedPx } = diffMask(ctx.rgba, rgbaB, { threshold: 24 });
  const W = ctx.rgba.width;
  const H = ctx.rgba.height;
  const regions = maskRegions(mask, W, H, 16 * S, 400);
  const inkA = ctx.ink();
  const inkB = inkMask(rgbaB);
  const count = (ink, r) => {
    let n = 0;
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) n += ink[y * W + x];
    return n;
  };
  const typed = regions.map((r) => {
    const a = count(inkA, r);
    const b = count(inkB, r);
    return { ...r, a, b, removed: a > 1.5 * b + 10, added: b > 1.5 * a + 10, long: Math.max(r.w, r.h) / S, short: Math.min(r.w, r.h) / S, horizontal: r.w >= r.h };
  });
  const changes = new Set();
  const mToPt = (m) => (ctx.mpp ? m / ctx.mpp : null);
  const longWall = mToPt(1.5) ?? 60;
  const removedLong = typed.filter((r) => r.removed && r.long >= longWall && r.short <= 20);
  const addedLong = typed.filter((r) => r.added && r.long >= longWall && r.short <= 20);
  for (const r of removedLong) {
    const near = addedLong.find((a) => a.horizontal === r.horizontal && Math.abs(a.long - r.long) <= 0.5 * r.long && Math.hypot((a.x + a.w / 2 - r.x - r.w / 2) / S, (a.y + a.h / 2 - r.y - r.h / 2) / S) <= (mToPt(1.5) ?? 100));
    if (near) changes.add('wall moved');
  }
  const doorPt = mToPt(0.9) ?? 25;
  for (const r of typed.filter((r) => r.removed && r.long >= 0.5 * doorPt && r.long <= 1.6 * doorPt && r.short <= 20)) {
    // a door opening sits inside a wall that continues on both sides in B
    const probe = (dx, dy) => {
      const cx = Math.round(r.x + r.w / 2 + dx);
      const cy = Math.round(r.y + r.h / 2 + dy);
      return cx >= 0 && cy >= 0 && cx < W && cy < H && inkB[cy * W + cx];
    };
    const reach = Math.round(r.long * S * 0.5 + 4 * S);
    const both = r.horizontal ? probe(-reach, 0) && probe(reach, 0) : probe(0, -reach) && probe(0, reach);
    if (both) changes.add('door added');
  }
  const pageB = rasterPageOf(rgbaB);
  for (const c of CLASSES) {
    const hA = await classHits(ctx, c);
    if (!hA) continue;
    const rB = cvScan(pageB, hA.click);
    if ('error' in rB) continue;
    const nB = rB.hits.filter((h) => Math.hypot(h.x - hA.click.x, h.y - hA.click.y) > 25).length;
    if (nB < hA.hits.length) changes.add(`${c} removed`);
  }
  if (ctx.opts.ocr !== false) {
    const wordsB = await ocrWords(rgbaB, S, `${ctx.id}-revB-${createHash('sha1').update(bytesB).digest('hex').slice(0, 12)}-${rgbaB.source}-${ctx.turns}`, ctx.opts);
    const dimsOf = (ws) => ws.map((w) => parseDim(w.text)).filter(Boolean).map((d) => `${d.unit}:${d.value}`).sort();
    const da = dimsOf(ctx.words);
    const db = dimsOf(wordsB);
    if (da.length && db.length && da.join('|') !== db.join('|')) changes.add('dimension changed');
  }
  return { changes: [...changes].sort(), note: `pixel diff ${(100 * changedPx) / (W * H)}% changed, ${regions.length} regions` };
}

// ---------- question dispatch ----------

async function answerQuestion(ctx, q) {
  const text = q.question;
  const scale = await solveScale(ctx);
  const needScale = ['scale', 'length', 'area', 'perimeter'].includes(q.type);
  if (needScale && !scale.ratio) return { answer: UNANS, note: scale.nts ? 'sheet says NTS' : 'no scale found' };
  switch (q.type) {
    case 'scale':
      return { answer: round(scale.ratio, 2), note: scale.source };
    case 'length': {
      let which;
      let m;
      if ((m = text.match(/partition wall between (.+?) and (.+?) on sheet/i))) which = { kind: 'partition', rooms: [m[1], m[2]] };
      else if (/north external wall/i.test(text)) which = { kind: 'north' };
      else if (/east external wall/i.test(text)) which = { kind: 'east' };
      else return { answer: UNANS, note: 'unrecognised length question' };
      const pt = ctx.isVector ? lengthVector(ctx, which) : lengthRaster(ctx, which);
      if (!pt) return { answer: UNANS, note: `${which.kind} wall not found` };
      return { answer: round(fromMetres(pt * ctx.mpp, q.unit)), note: `${which.kind}: ${pt.toFixed(1)} pt via ${ctx.isVector ? 'vector layer' : 'ink runs'}` };
    }
    case 'area':
    case 'perimeter': {
      const m = text.match(/(?:floor area of|perimeter of) (.+?) on sheet/i);
      if (!m) return { answer: UNANS, note: 'unrecognised room question' };
      const fill = await fillRoom(ctx, m[1]);
      if (!fill) return { answer: UNANS, note: 'room not filled' };
      const v = q.type === 'area' ? polyArea(fill.points) * ctx.mpp * ctx.mpp : polyPerimeter(fill.points) * ctx.mpp;
      return { answer: round(fromMetres(v, q.unit)), note: `Dynamic Fill, ${fill.points.length} vertices` };
    }
    case 'count': {
      const cls = PLURAL_TO_CLASS.find(([re]) => re.test(text))?.[1];
      if (!cls) return { answer: UNANS, note: 'unrecognised symbol class' };
      const hits = await classHits(ctx, cls);
      if (!hits) return { answer: UNANS, note: 'legend symbol not found or scan failed' };
      const m = text.match(/are in (.+?) on sheet/i);
      if (!m) return { answer: hits.hits.length, note: `${hits.provider} scan from the legend` };
      const fill = await fillRoom(ctx, m[1]);
      if (!fill) return { answer: UNANS, note: 'room not filled' };
      return { answer: hits.hits.filter((h) => pointInPoly(h, fill.points)).length, note: `${hits.provider} scan, hits inside the filled room` };
    }
    case 'dimension_read': {
      const m = text.match(/string (directly below \(south of\)|to the left of \(west of\)) (.+?) on sheet/i);
      if (!m) return { answer: UNANS, note: 'unrecognised dimension question' };
      const south = /south/.test(m[1]);
      const wantMm = /millimetres/i.test(text);
      const fill = await fillRoom(ctx, m[2]);
      let box;
      if (fill) box = bboxOf(fill.points);
      else {
        const label = findPhrase(ctx, m[2]);
        if (!label) return { answer: UNANS, note: 'room not found' };
        box = { x0: label.x - 40, x1: label.x + 40, y0: label.y - 40, y1: label.y + 40 };
      }
      const cands = ctx.words
        .map((w) => ({ w, d: parseDim(w.text) }))
        .filter(({ w, d }) => d && (south ? w.xPt >= box.x0 - 5 && w.xPt <= box.x1 + 5 && w.yPt < box.y0 - 3 && w.yPt > box.y0 - 70 : w.yPt >= box.y0 - 5 && w.yPt <= box.y1 + 5 && w.xPt < box.x0 - 3 && w.xPt > box.x0 - 70))
        .sort((p, r) => (south ? r.w.yPt - p.w.yPt : r.w.xPt - p.w.xPt));
      if (!cands.length) return { answer: UNANS, note: 'no printed dimension on that side' };
      const d = cands[0].d;
      const value = wantMm ? (d.unit === 'mm' ? d.value : Math.round(d.metres * 1000)) : d.unit === 'ft' ? d.value : d.metres / FT;
      return { answer: round(value, 4), note: `read "${cands[0].w.text}"` };
    }
    case 'compare': {
      const revB = ctx.sheet.revB;
      if (!revB || !existsSync(join(ctx.setDir, revB))) return { answer: UNANS, note: 'no revision B file' };
      const r = ctx.isVector ? await compareVector(ctx, revB) : await compareRaster(ctx, revB);
      return { answer: r.changes, note: r.note };
    }
    default:
      return { answer: UNANS, note: 'unknown question type' };
  }
}

/** Solve every question of one sheet. Questions are passed without their answers. */
export async function solveSheetById({ setDir, manifest, questions, sheetId, rasterMode, ocr, tessdata }) {
  const entry = manifest.sheets.find((s) => s.id === sheetId);
  if (!entry) throw new Error(`sheet ${sheetId} not in the manifest`);
  const qs = questions.filter((q) => q.sheet === sheetId).map(({ id, sheet, page, type, question, unit }) => ({ id, sheet, page, type, question, unit }));
  const ctx = await openSheet(setDir, entry, { rasterMode, ocr, tessdata });
  const answers = [];
  for (const q of qs) {
    try {
      const a = await answerQuestion(ctx, q);
      answers.push({ id: q.id, answer: a.answer, note: a.note });
    } catch (err) {
      answers.push({ id: q.id, answer: UNANS, note: `error: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  await terminateOcr();
  return { sheetId, isVector: ctx.isVector, rasterSource: ctx.rasterSource, scale: ctx.scale ?? null, answers, notes: ctx.notes };
}

/** Run the reference over a set: vector sheets in-process, raster sheets in a child each. */
export async function runReference({ setDir, manifest, questions, half = 'all', ocr = true, tessdata, log = () => {}, script }) {
  const preds = [];
  const notes = [];
  const sheets = manifest.sheets.filter((s) => half === 'all' || s.kind === half);
  let rasterMode = 'engine';
  let probed = false;
  const child = (id, mode) => {
    const argv = ['--experimental-strip-types', script, 'solve-sheet', '--set', setDir, '--sheet', id, '--raster-mode', mode, '--ocr', ocr ? 'on' : 'off', ...(tessdata ? ['--tessdata', tessdata] : [])];
    const res = spawnSync(process.execPath, argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 900000 });
    const line = (res.stdout ?? '').split('\n').find((l) => l.startsWith('@@RESULT '));
    if (res.status === 0 && line) return { ok: true, result: JSON.parse(line.slice('@@RESULT '.length)) };
    return { ok: false, status: res.status, signal: res.signal, stderr: (res.stderr ?? '').slice(-400) };
  };
  for (const s of sheets) {
    const t0 = performance.now();
    let result;
    if (s.kind === 'vector') {
      result = await solveSheetById({ setDir, manifest, questions, sheetId: s.id, rasterMode: 'engine', ocr, tessdata });
    } else {
      if (!probed) {
        probed = true;
        const probe = child(s.id, 'engine');
        if (probe.ok) result = probe.result;
        else {
          rasterMode = 'decode';
          notes.push(`engine raster path (pdf.js + napi canvas image XObject render) exited with ${probe.status ?? probe.signal} on ${s.id}; raster sheets decoded directly from the embedded image instead (WP1 crash workaround, same pixels at ${RASTER_SCALE} px/pt)`);
        }
      }
      if (!result) {
        let r = child(s.id, rasterMode);
        if (!r.ok && rasterMode === 'engine') {
          notes.push(`${s.id}: engine raster path exited with ${r.status ?? r.signal}; retried with direct image decode`);
          r = child(s.id, 'decode');
        }
        if (r.ok) result = r.result;
        else {
          notes.push(`${s.id}: solver child exited with ${r.status ?? r.signal}: ${r.stderr}`);
          result = { sheetId: s.id, answers: questions.filter((q) => q.sheet === s.id).map((q) => ({ id: q.id, answer: UNANS, note: 'solver crashed' })), notes: [] };
        }
      }
    }
    preds.push(...result.answers);
    notes.push(...(result.notes ?? []));
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    log(`${s.id} (${s.kind}${result.rasterSource && s.kind === 'raster' ? `, ${result.rasterSource}` : ''}) scale ${result.scale?.ratio ? `1:${Math.round(result.scale.ratio * 10) / 10}` : 'none'}: ${result.answers.filter((a) => a.answer !== UNANS).length}/${result.answers.length} answered in ${secs} s`);
  }
  return { preds, notes };
}
