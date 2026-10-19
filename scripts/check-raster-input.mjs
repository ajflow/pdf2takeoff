#!/usr/bin/env node
// Behavioural check for raster input in the headless engine:
//   1. an image-only PDF (embedded PNG XObject) renders through pdf.js +
//      @napi-rs/canvas without crashing and with ink on the page. This used
//      to segfault (exit 139): pdfjs-dist pins its own nested @napi-rs/canvas
//      and drew the image's temporary canvas from that second skia instance.
//   2. a PNG / JPG opened directly (image-node.ts) presents as a page of
//      W/3 x H/3 points whose RASTER_SCALE render is the native pixels, with
//      the same toPdf/toRaster convention as the pdf.js viewport, and the
//      public scan path (openAny + scanDocAt, and the CLI) finds symbols on it.
//   3. the rest of the CLI takes images too: compare of two PNGs (and of two
//      folders pairing PNGs with PDFs by stem), annotate of a PNG writing a
//      real PDF with the markups embedded, set of a folder holding a PNG.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument } from 'pdf-lib';
import { openPdf } from '../src/headless/pdfjs-node.ts';
import { renderRasterNode } from '../src/headless/raster-node.ts';
import { openAny, openImage, sniffImage, imageKindByExt } from '../src/headless/image-node.ts';
import { scanDocAt, readMarkups } from '../src/headless/ops.ts';
import { RASTER_SCALE } from '../src/engine/ports.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let failed = false;
const check = (label, cond, detail = '') => {
  if (!cond) {
    console.error(`FAIL: ${label} ${detail}`);
    failed = true;
  } else console.log(`ok: ${label}`);
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const darkPx = (r) => {
  let n = 0;
  for (let i = 0; i < r.data.length; i += 4) if (r.data[i] < 128) n++;
  return n;
};

// a 240 x 160 px "sheet" with two identical 20 x 20 black squares (each well
// under the page-area/16 cap the CV scan puts on a teachable component)
const W = 240;
const H = 160;
const SQ = 20;
const CLICK = { x: 50, y: 50 }; // native px inside the first square
const src = createCanvas(W, H);
const sctx = src.getContext('2d');
sctx.fillStyle = '#fff';
sctx.fillRect(0, 0, W, H);
sctx.fillStyle = '#000';
sctx.fillRect(40, 40, SQ, SQ);
sctx.fillRect(160, 40, SQ, SQ);
const png = new Uint8Array(src.toBuffer('image/png'));
const jpg = new Uint8Array(src.toBuffer('image/jpeg'));
const SQUARES_PX = 2 * SQ * SQ;

// --- 1. image-only PDF through pdf.js -------------------------------------
{
  const pdf = await PDFDocument.create();
  const img = await pdf.embedPng(png);
  const page = pdf.addPage([W / RASTER_SCALE, H / RASTER_SCALE]);
  page.drawImage(img, { x: 0, y: 0, width: W / RASTER_SCALE, height: H / RASTER_SCALE });
  const doc = await openPdf(await pdf.save());
  const r3 = await renderRasterNode(doc, 1, RASTER_SCALE);
  check('image-only PDF renders at RASTER_SCALE to the native pixel size', r3.width === W && r3.height === H, `${r3.width}x${r3.height}`);
  check('image-only PDF render has the squares inked', near(darkPx(r3), SQUARES_PX, SQUARES_PX * 0.05), `dark=${darkPx(r3)}`);
  const r2 = await renderRasterNode(doc, 1, 2);
  check('image-only PDF renders at a non-native scale (resampled image path)', near(darkPx(r2), SQUARES_PX * (4 / 9), SQUARES_PX * 0.25), `dark=${darkPx(r2)}`);
  const hit = await scanDocAt(doc, 1, { x: CLICK.x / RASTER_SCALE, y: (H - CLICK.y) / RASTER_SCALE });
  check('scan on an image-only PDF finds both squares', !('error' in hit) && hit.hits.length === 2, JSON.stringify(hit));
}

// --- 2. PNG / JPG opened directly -----------------------------------------
check('sniff: PNG magic', sniffImage(png) === 'png');
check('sniff: JPEG magic', sniffImage(jpg) === 'jpeg');
check('sniff: PDF is not an image', sniffImage(new TextEncoder().encode('%PDF-1.7')) === null);
check('extension: .jpeg / .PNG / .pdf', imageKindByExt('a.jpeg') === 'jpeg' && imageKindByExt('B.PNG') === 'png' && imageKindByExt('c.pdf') === null);

const dir = mkdtempSync(join(tmpdir(), 'p2t-raster-'));
try {
  const pngPath = join(dir, 'plan.png');
  const jpgPath = join(dir, 'plan.jpg');
  const oddPath = join(dir, 'plan.dat'); // image by magic bytes only
  writeFileSync(pngPath, png);
  writeFileSync(jpgPath, jpg);
  writeFileSync(oddPath, png);

  const { doc, kind, bytes } = await openAny(pngPath);
  check('openAny: PNG opens as an image document', kind === 'image' && doc.numPages === 1);
  check('openAny: image bytes come back as a PDF wrapper', bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46);
  const page = await doc.getPage(1);
  const vp1 = page.getViewport({ scale: 1 });
  check('image page is W/3 x H/3 points', near(vp1.width, W / RASTER_SCALE, 1e-9) && near(vp1.height, H / RASTER_SCALE, 1e-9), `${vp1.width}x${vp1.height}`);

  const r = await renderRasterNode(doc, 1, RASTER_SCALE);
  check('image render at RASTER_SCALE is the native pixels', r.width === W && r.height === H, `${r.width}x${r.height}`);
  check('image render keeps the ink', near(darkPx(r), SQUARES_PX, SQUARES_PX * 0.02), `dark=${darkPx(r)}`);
  // convention: raster (x, y) -> PDF (x/3, (H - y)/3), y flipped
  const p = r.toPdf(CLICK.x, CLICK.y);
  check('toPdf flips y and divides by RASTER_SCALE', near(p.x, CLICK.x / 3, 1e-9) && near(p.y, (H - CLICK.y) / 3, 1e-9), JSON.stringify(p));
  const back = r.toRaster(p.x, p.y);
  check('toRaster inverts toPdf', near(back.x, CLICK.x, 1e-9) && near(back.y, CLICK.y, 1e-9), JSON.stringify(back));

  // the pdf.js viewport of the same image wrapped as a PDF must agree
  const wrapped = await openPdf(bytes);
  const wvp = (await wrapped.getPage(1)).getViewport({ scale: RASTER_SCALE });
  const [wx, wy] = wvp.convertToPdfPoint(CLICK.x, CLICK.y);
  check('image convention matches the pdf.js viewport of the wrapped PDF', near(wx, p.x, 1e-6) && near(wy, p.y, 1e-6), `pdf.js ${wx},${wy} vs ${p.x},${p.y}`);
  check('wrapped PDF page size equals the image page size', near(wvp.width, W, 1e-6) && near(wvp.height, H, 1e-6), `${wvp.width}x${wvp.height}`);

  const hit = await scanDocAt(doc, 1, { x: CLICK.x / RASTER_SCALE, y: (H - CLICK.y) / RASTER_SCALE });
  check('scan on a PNG finds both squares (CV tier, no vectors)', !('error' in hit) && hit.hits.length === 2 && hit.provider === 'cv', JSON.stringify(hit));

  const jdoc = await openAny(jpgPath);
  const jr = await renderRasterNode(jdoc.doc, 1, RASTER_SCALE);
  check('JPG opens and renders', jdoc.kind === 'image' && jr.width === W && near(darkPx(jr), SQUARES_PX, SQUARES_PX * 0.1), `dark=${darkPx(jr)}`);
  const odd = await openAny(oddPath);
  check('image detected by magic bytes without an image extension', odd.kind === 'image');
  check('page 2 of an image is out of range', await doc.getPage(2).then(() => false, () => true));
  check('openImage rejects non-image bytes', await openImage(new TextEncoder().encode('%PDF-1.7 nope')).then(() => false, () => true));

  // the public CLI path: scan + info on the PNG file
  const cli = join(root, 'src', 'headless', 'cli.ts');
  const run = (...args) => spawnSync(process.execPath, ['--experimental-strip-types', cli, ...args], { encoding: 'utf8' });
  const scan = run('scan', pngPath, '--page', '1', '--at', `${CLICK.x / RASTER_SCALE},${(H - CLICK.y) / RASTER_SCALE}`);
  let scanJson = null;
  try { scanJson = JSON.parse(scan.stdout); } catch { /* reported below */ }
  check('CLI scan accepts a PNG and counts both squares', scan.status === 0 && scanJson?.count === 2, `status=${scan.status} stderr=${scan.stderr.trim()} stdout=${scan.stdout.slice(0, 200)}`);
  const info = run('info', pngPath);
  let infoJson = null;
  try { infoJson = JSON.parse(info.stdout); } catch { /* reported below */ }
  check('CLI info accepts a PNG', info.status === 0 && infoJson?.pageCount === 1 && infoJson?.pages?.[0]?.widthPt === Math.round(W / RASTER_SCALE), `status=${info.status} stderr=${info.stderr.trim()}`);

  // --- 3. compare / annotate / set on images ------------------------------
  const parse = (r) => { try { return JSON.parse(r.stdout); } catch { return null; } };
  // revision B: the same sheet with a third square added
  sctx.fillRect(100, 100, SQ, SQ);
  const pngB = new Uint8Array(src.toBuffer('image/png'));
  const pngBPath = join(dir, 'plan-b.png');
  writeFileSync(pngBPath, pngB);
  const same = run('compare', pngPath, pngPath);
  const sameJson = parse(same);
  check('CLI compare of a PNG with itself: one sheet, unchanged', same.status === 0 && sameJson?.comparedSheets === 1 && sameJson?.summary?.changed === 0, `status=${same.status} stderr=${same.stderr.trim()} stdout=${same.stdout.slice(0, 200)}`);
  const overlay = join(dir, 'overlay.png');
  const diff = run('compare', pngPath, pngBPath, '--png', overlay);
  const diffJson = parse(diff);
  const region = diffJson?.sheets?.[0]?.regions?.[0];
  check('CLI compare of two PNGs flags the changed sheet', diff.status === 0 && diffJson?.summary?.changed === 1 && diffJson?.changedSheets?.[0] === 1, `status=${diff.status} stderr=${diff.stderr.trim()} stdout=${diff.stdout.slice(0, 200)}`);
  // the added square is at native px 100..120; compare regions are in points from the top-left corner, so 33..40 both ways
  check('CLI compare of two PNGs locates the added square in points', !!region && Math.abs(region.xPt - 100 / RASTER_SCALE) <= 2 && Math.abs(region.yPt - 100 / RASTER_SCALE) <= 2 && Math.abs(region.wPt - SQ / RASTER_SCALE) <= 2, JSON.stringify(region));
  check('CLI compare of two PNGs writes the overlay PNG', existsSync(overlay) && sniffImage(new Uint8Array(readFileSync(overlay))) === 'png');

  // folders: a.pdf-only revision A against a PNG revision B of the same sheet, paired by stem
  const folderA = join(dir, 'revA');
  const folderB = join(dir, 'revB');
  mkdirSync(folderA);
  mkdirSync(folderB);
  writeFileSync(join(folderA, 'A-101.pdf'), bytes); // the wrapper PDF of the PNG
  writeFileSync(join(folderB, 'A-101.png'), pngB);
  writeFileSync(join(folderB, 'A-102.jpg'), jpg);
  const folders = run('compare', folderA, folderB);
  const foldersJson = parse(folders);
  check('CLI folder compare pairs a PDF with a PNG of the same stem and lists the extra JPG', folders.status === 0 && foldersJson?.pairs?.length === 1 && foldersJson.pairs[0].sheet === 'A-101' && foldersJson.pairs[0].summary.changed === 1 && JSON.stringify(foldersJson.addedInB) === '["A-102"]', `status=${folders.status} stderr=${folders.stderr.trim()} stdout=${folders.stdout.slice(0, 300)}`);

  // annotate: a count markup on the first square and a length across the sheet, written into a real PDF
  const specPath = join(dir, 'takeoff.yaml');
  const outPdf = join(dir, 'marked.pdf');
  writeFileSync(specPath, `scale: "1:100"\nunit: m\nmarkups:\n  - type: count\n    label: Square\n    points: [[${50 / RASTER_SCALE}, ${(H - 50) / RASTER_SCALE}]]\n  - type: length\n    label: Width\n    points: [[10, 10], [70, 10]]\n`);
  const ann = run('annotate', pngPath, '--spec', specPath, '-o', outPdf);
  const annJson = parse(ann);
  check('CLI annotate accepts a PNG and reports the markups written', ann.status === 0 && annJson?.markups === 2 && annJson?.output === outPdf, `status=${ann.status} stderr=${ann.stderr.trim()} stdout=${ann.stdout.slice(0, 200)}`);
  const outBytes = ann.status === 0 ? new Uint8Array(readFileSync(outPdf)) : new Uint8Array();
  check('annotated output is a real PDF', outBytes[0] === 0x25 && outBytes[1] === 0x50 && outBytes[2] === 0x44 && outBytes[3] === 0x46);
  if (outBytes.length) {
    const outDoc = await openPdf(outBytes);
    const back = await readMarkups(outDoc);
    const vp = (await outDoc.getPage(1)).getViewport({ scale: RASTER_SCALE });
    check('annotated PDF keeps the image page size and reads both markups back', outDoc.numPages === 1 && near(vp.width, W, 1e-6) && back.length === 2 && back.some((m) => m.type === 'count' && m.label === 'Square') && back.some((m) => m.type === 'length'), `${vp.width}x${vp.height} ${JSON.stringify(back.map((m) => [m.type, m.label]))}`);
    const r = await renderRasterNode(outDoc, 1, RASTER_SCALE);
    check('annotated PDF still carries the image pixels', darkPx(r) >= SQUARES_PX * 0.9, `dark=${darkPx(r)}`);
  }

  // set: a folder holding a PDF and a PNG of different sheets, merged into one sorted PDF
  const setDir = join(dir, 'tender');
  mkdirSync(setDir);
  writeFileSync(join(setDir, 'S-201.png'), pngB);
  writeFileSync(join(setDir, 'A-101.pdf'), bytes);
  const setOut = join(dir, 'current-issue.pdf');
  const set = run('set', setDir, '-o', setOut);
  const setJson = parse(set);
  check('CLI set merges a PNG sheet with the PDFs, sorted by stem', set.status === 0 && setJson?.sheets === 2 && setJson?.sheetsDetail?.[0]?.sheet === 'A-101' && setJson?.sheetsDetail?.[1]?.sheet === 'S-201', `status=${set.status} stderr=${set.stderr.trim()} stdout=${set.stdout.slice(0, 300)}`);
  if (set.status === 0) {
    const merged = await openPdf(new Uint8Array(readFileSync(setOut)));
    const r2 = await renderRasterNode(merged, 2, RASTER_SCALE);
    check('set output: the PNG sheet is page 2 with its pixels', merged.numPages === 2 && r2.width === W && darkPx(r2) >= SQUARES_PX * 1.4, `pages=${merged.numPages} dark=${darkPx(r2)}`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failed) process.exit(1);
console.log('PASS: raster input (image-only PDF render, direct PNG/JPG input, compare / annotate / set on images)');
