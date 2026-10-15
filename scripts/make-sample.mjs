// Generates the demo drawings in public/examples/:
//   sample-floor-plan.pdf        — revision A
//   sample-floor-plan-rev-b.pdf  — revision B (wall moved, lights reduced, window added)
// Used for trying the takeoff tools and the overlay compare. Run: npm run sample

import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'public', 'examples');

const A4L = [842, 595];
// 1:100 — 1 m real = 10 mm paper = 28.3465 pt
const PT_PER_M = 28.3465;

const ink = rgb(0.13, 0.15, 0.2);
const mid = rgb(0.35, 0.38, 0.44);
const grid = rgb(0.88, 0.9, 0.93);
const accent = rgb(0.15, 0.39, 0.92);

const m = (v) => v * PT_PER_M;

const PLAN = { x0: 60, y0: 90, w: 12, h: 8 }; // metres

async function buildRevision(rev) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage(A4L);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const { x0, y0 } = PLAN;
  const planW = m(PLAN.w);
  const planH = m(PLAN.h);

  // ---- faint 1 m grid ----
  for (let i = 0; i <= 12; i++) {
    page.drawLine({ start: { x: x0 + m(i), y: y0 }, end: { x: x0 + m(i), y: y0 + planH }, thickness: 0.4, color: grid });
  }
  for (let j = 0; j <= 8; j++) {
    page.drawLine({ start: { x: x0, y: y0 + m(j) }, end: { x: x0 + planW, y: y0 + m(j) }, thickness: 0.4, color: grid });
  }

  // ---- walls ----
  page.drawRectangle({ x: x0, y: y0, width: planW, height: planH, borderColor: ink, borderWidth: 2.6 });
  const wallX = x0 + m(rev.wallAt);
  page.drawLine({ start: { x: wallX, y: y0 + m(1) }, end: { x: wallX, y: y0 + planH }, thickness: 1.6, color: ink });
  page.drawCircle({
    x: wallX, y: y0 + m(1), size: m(1),
    borderColor: mid, borderWidth: 0.7, borderDashArray: [3, 3], opacity: 0,
  });

  // rev B adds a window on the right wall
  if (rev.window) {
    const [wy0, wy1] = rev.window;
    page.drawRectangle({
      x: x0 + planW - 1.3, y: y0 + m(wy0), width: 2.6, height: m(wy1 - wy0),
      color: rgb(1, 1, 1), borderColor: accent, borderWidth: 1.2,
    });
    page.drawText('W1', { x: x0 + planW - 18, y: y0 + m((wy0 + wy1) / 2) + 2, size: 7, font, color: accent });
  }

  // ---- room labels ----
  page.drawText('OFFICE', { x: x0 + m(rev.wallAt) / 2 - 24, y: y0 + planH / 2 + 4, size: 12, font: bold, color: mid });
  page.drawText('MEETING', { x: x0 + m(rev.wallAt) + m(PLAN.w - rev.wallAt) / 2 - 32, y: y0 + planH / 2 + 4, size: 12, font: bold, color: mid });

  // ---- downlights ----
  for (const [cx, cy] of rev.downlights) {
    page.drawCircle({ x: x0 + m(cx), y: y0 + m(cy), size: 7, color: rgb(1, 1, 1), borderColor: ink, borderWidth: 1.1 });
    page.drawText('D', { x: x0 + m(cx) - 2.1, y: y0 + m(cy) - 2.6, size: 6.5, font: bold, color: ink });
  }
  page.drawText(`DL-100 downlights (${rev.downlights.length} no.)`, {
    x: x0 + planW - 150, y: y0 + planH - 14, size: 7, font, color: mid,
  });

  // ---- dimension lines ----
  const dimY = y0 - 18;
  const tick = 5;
  page.drawLine({ start: { x: x0, y: dimY }, end: { x: x0 + planW, y: dimY }, thickness: 0.9, color: mid });
  for (const x of [x0, x0 + planW]) {
    page.drawLine({ start: { x: x - tick, y: dimY + tick }, end: { x: x + tick, y: dimY - tick }, thickness: 0.9, color: mid });
    page.drawLine({ start: { x, y: dimY - tick }, end: { x, y: y0 }, thickness: 0.5, color: grid });
  }
  page.drawText('12.00 m', { x: x0 + planW / 2 - 18, y: dimY + 6, size: 9.5, font: bold, color: ink });

  const dimX = x0 + planW + 24;
  page.drawLine({ start: { x: dimX, y: y0 }, end: { x: dimX, y: y0 + planH }, thickness: 0.9, color: mid });
  for (const y of [y0, y0 + planH]) {
    page.drawLine({ start: { x: dimX - tick, y: y + tick }, end: { x: dimX + tick, y: y - tick }, thickness: 0.9, color: mid });
  }
  page.drawText('8.00 m', { x: dimX + 8, y: y0 + planH / 2 - 3, size: 9.5, font: bold, color: ink, rotate: degrees(90) });

  const dimY2 = dimY - 16;
  page.drawLine({ start: { x: x0, y: dimY2 }, end: { x: x0 + m(rev.wallAt), y: dimY2 }, thickness: 0.7, color: mid });
  for (const x of [x0, x0 + m(rev.wallAt)]) {
    page.drawLine({ start: { x: x - tick, y: dimY2 + tick }, end: { x: x + tick, y: dimY2 - tick }, thickness: 0.7, color: mid });
  }
  page.drawText(`${rev.wallAt.toFixed(2)} m`, { x: x0 + m(rev.wallAt) / 2 - 16, y: dimY2 - 12, size: 8, font, color: mid });

  // ---- title block ----
  const tb = { x: 600, y: 36, w: 222, h: 64 };
  page.drawRectangle({ ...tb, width: tb.w, height: tb.h, borderColor: ink, borderWidth: 1 });
  page.drawLine({ start: { x: tb.x, y: tb.y + 22 }, end: { x: tb.x + tb.w, y: tb.y + 22 }, thickness: 0.8, color: ink });
  page.drawText(`SAMPLE FLOOR PLAN — ${rev.name}`, { x: tb.x + 10, y: tb.y + 46, size: 9, font: bold, color: ink });
  page.drawText('SCALE 1:100 @ A4 · DIMENSIONS IN METRES', { x: tb.x + 10, y: tb.y + 32, size: 7.5, font, color: mid });
  page.drawText('pdf2takeoff.com — open-source PDF takeoff', { x: tb.x + 10, y: tb.y + 8, size: 7.5, font, color: accent });

  // north arrow + scale bar
  page.drawCircle({ x: 770, y: 500, size: 14, borderColor: mid, borderWidth: 1 });
  page.drawLine({ start: { x: 770, y: 492 }, end: { x: 770, y: 508 }, thickness: 1.4, color: ink });
  page.drawText('N', { x: 766.5, y: 516, size: 8, font: bold, color: mid });

  const sbX = 620, sbY = 520;
  for (let i = 0; i < 5; i++) {
    page.drawRectangle({
      x: sbX + m(i), y: sbY, width: m(1), height: 6,
      color: i % 2 === 0 ? ink : rgb(1, 1, 1), borderColor: ink, borderWidth: 0.6,
    });
  }
  page.drawText('0', { x: sbX - 2, y: sbY + 9, size: 7, font, color: mid });
  page.drawText('5 m', { x: sbX + m(5) - 6, y: sbY + 9, size: 7, font, color: mid });

  // ---- sheet 2: the same plan at 1:50 (per-page scale story) ----
  const p2 = pdf.addPage(A4L);
  const M2 = 56.693; // pt per metre at 1:50
  const x2 = (842 - PLAN.w * M2) / 2;
  const y2 = 72;
  const w2 = PLAN.w * M2;
  const h2 = PLAN.h * M2;

  for (let i = 0; i <= PLAN.w; i += 2) {
    p2.drawLine({ start: { x: x2 + m2(i), y: y2 }, end: { x: x2 + m2(i), y: y2 + h2 }, thickness: 0.4, color: grid });
  }
  for (let j = 0; j <= PLAN.h; j += 2) {
    p2.drawLine({ start: { x: x2, y: y2 + m2(j) }, end: { x: x2 + w2, y: y2 + m2(j) }, thickness: 0.4, color: grid });
  }
  p2.drawRectangle({ x: x2, y: y2, width: w2, height: h2, borderColor: ink, borderWidth: 3.2 });
  p2.drawLine({
    start: { x: x2 + m2(rev.wallAt), y: y2 + M2 },
    end: { x: x2 + m2(rev.wallAt), y: y2 + h2 },
    thickness: 2, color: ink,
  });
  if (rev.window) {
    const [wy0, wy1] = rev.window;
    p2.drawRectangle({
      x: x2 + w2 - 2.2, y: y2 + m2(wy0), width: 4.4, height: m2(wy1 - wy0),
      color: rgb(1, 1, 1), borderColor: accent, borderWidth: 1.6,
    });
  }
  p2.drawText('OFFICE', { x: x2 + m2(rev.wallAt / 2) - 26, y: y2 + h2 / 2 + 4, size: 14, font: bold, color: mid });
  p2.drawText('MEETING', { x: x2 + m2(rev.wallAt + (PLAN.w - rev.wallAt) / 2) - 36, y: y2 + h2 / 2 + 4, size: 14, font: bold, color: mid });
  for (const [cx, cy] of rev.downlights.slice(0, 4)) {
    p2.drawCircle({ x: x2 + m2(cx), y: y2 + m2(cy), size: 10, color: rgb(1, 1, 1), borderColor: ink, borderWidth: 1.4 });
    p2.drawText('D', { x: x2 + m2(cx) - 3, y: y2 + m2(cy) - 3.6, size: 9, font: bold, color: ink });
  }
  // dimension at 1:50
  const d2y = y2 - 20;
  p2.drawLine({ start: { x: x2, y: d2y }, end: { x: x2 + w2, y: d2y }, thickness: 1, color: mid });
  for (const x of [x2, x2 + w2]) {
    p2.drawLine({ start: { x: x - 6, y: d2y + 6 }, end: { x: x + 6, y: d2y - 6 }, thickness: 1, color: mid });
  }
  p2.drawText('12.00 m', { x: x2 + w2 / 2 - 22, y: d2y + 8, size: 11, font: bold, color: ink });
  p2.drawText('SHEET 2 OF 2 · SCALE 1:50 · DIMENSIONS IN METRES', {
    x: 60, y: 24, size: 8.5, font: bold, color: mid,
  });
  p2.drawText(`SAMPLE FLOOR PLAN — ${rev.name}`, { x: 60, y: 36, size: 9.5, font: bold, color: ink });

  return pdf.save();
}

const m2 = (v) => v * 56.693;

const downlightsA = [
  [1, 6.4], [2, 6.4], [3, 6.4],
  [1.8, 4.4], [2.6, 4.4],
  [1, 2.2], [2, 2.2], [3, 2.2],
];
const downlightsB = [
  [1, 6.4], [3, 6.4],
  [2.6, 4.4],
  [1, 2.2], [3, 2.2],
];

const revisions = [
  { name: 'REV A', file: 'sample-floor-plan.pdf', wallAt: 4, downlights: downlightsA, window: null },
  { name: 'REV B', file: 'sample-floor-plan-rev-b.pdf', wallAt: 5, downlights: downlightsB, window: [5.5, 7] },
];

mkdirSync(OUT_DIR, { recursive: true });
for (const rev of revisions) {
  const bytes = await buildRevision(rev);
  const out = join(OUT_DIR, rev.file);
  writeFileSync(out, bytes);
  console.log(`wrote ${out} (${bytes.length} bytes)`);
}
