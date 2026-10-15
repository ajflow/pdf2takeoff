// Generates an N-sheet "tender-like" PDF for performance soak testing:
//   node scripts/make-soak.mjs [--pages 86] [--seed 7] [--out public/examples/soak-86.pdf]
// Every sheet varies (walls, fixture counts, grids, notes) so paging through
// the set exercises real rendering work, not 86 copies of one page.
// Output is gitignored: it is a test artifact, not a shipped sample.

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const PAGES = Number(flag('pages', 86));
const SEED = Number(flag('seed', 7));
const OUT = flag('out', join(__dirname, '..', 'public', 'examples', `soak-${PAGES}.pdf`));

// mulberry32 — deterministic variation per seed
let s = SEED >>> 0;
const rnd = () => {
  s |= 0;
  s = (s + 0x6d2b79f5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const A4L = [842, 595];
const PT_PER_M = 28.3465;
const ink = rgb(0.13, 0.15, 0.2);
const mid = rgb(0.35, 0.38, 0.44);
const grid = rgb(0.88, 0.9, 0.93);
const accent = rgb(0.15, 0.39, 0.92);
const m = (v) => v * PT_PER_M;

const pdf = await PDFDocument.create();
const font = await pdf.embedFont(StandardFonts.Helvetica);
const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

const DISCIPLINES = ['ARCH', 'STR', 'ELEC', 'MECH', 'HYD', 'FIRE'];
let sheetNo = 0;

for (let p = 0; p < PAGES; p++) {
  const page = pdf.addPage(A4L);
  sheetNo++;
  const disc = DISCIPLINES[Math.floor(rnd() * DISCIPLINES.length)];
  const scale = [100, 100, 100, 50, 200][Math.floor(rnd() * 5)];
  const ptPerM = 2834.65 / scale;

  // plan box geometry
  const planW = 8 + Math.floor(rnd() * 8); // metres
  const planH = 6 + Math.floor(rnd() * 5);
  const x0 = 60;
  const y0 = 90;
  const w = planW * ptPerM;
  const h = planH * ptPerM;

  // grid at 1 m
  const gStep = scale > 100 ? 2 : 1;
  for (let i = 0; i <= planW; i += gStep) {
    page.drawLine({ start: { x: x0 + i * ptPerM, y: y0 }, end: { x: x0 + i * ptPerM, y: y0 + h }, thickness: 0.4, color: grid });
  }
  for (let j = 0; j <= planH; j += gStep) {
    page.drawLine({ start: { x: x0, y: y0 + j * ptPerM }, end: { x: x0 + w, y: y0 + j * ptPerM }, thickness: 0.4, color: grid });
  }

  // walls + internal partitions
  page.drawRectangle({ x: x0, y: y0, width: w, height: h, borderColor: ink, borderWidth: 2.4 });
  const partitions = 1 + Math.floor(rnd() * 4);
  for (let k = 0; k < partitions; k++) {
    const px = x0 + (2 + Math.floor(rnd() * (planW - 4))) * ptPerM;
    const py0 = y0 + rnd() * h * 0.2;
    page.drawLine({ start: { x: px, y: py0 }, end: { x: px, y: y0 + h }, thickness: 1.4, color: ink });
    // door arc
    page.drawCircle({ x: px, y: py0, size: 0.9 * ptPerM, borderColor: mid, borderWidth: 0.6, opacity: 0 });
  }

  // fixtures: downlights (circles) and GPOs (small squares), density scales with area
  const nFix = Math.floor(planW * planH * (0.15 + rnd() * 0.25));
  for (let f = 0; f < nFix; f++) {
    const fx = x0 + (1 + rnd() * (planW - 2)) * ptPerM;
    const fy = y0 + (1 + rnd() * (planH - 2)) * ptPerM;
    if (rnd() < 0.6) {
      page.drawCircle({ x: fx, y: fy, size: 7, color: rgb(1, 1, 1), borderColor: ink, borderWidth: 1 });
      page.drawText('D', { x: fx - 2.1, y: fy - 2.6, size: 6.5, font: bold, color: ink });
    } else {
      page.drawRectangle({ x: fx - 4, y: fy - 4, width: 8, height: 8, color: rgb(1, 1, 1), borderColor: mid, borderWidth: 0.9 });
      page.drawText('G', { x: fx - 2, y: fy - 2.4, size: 5.5, font, color: mid });
    }
  }

  // room label + notes column (text stress)
  page.drawText(`LEVEL ${1 + Math.floor(p / 20)} · ${disc}-${String(sheetNo).padStart(3, '0')}`, {
    x: x0 + 6, y: y0 + h - 16, size: 10, font: bold, color: mid,
  });
  const noteLines = 4 + Math.floor(rnd() * 8);
  for (let n = 0; n < noteLines; n++) {
    page.drawText(`NOTE ${n + 1}: REFER DETAIL ${disc}/${sheetNo}/${n} FOR SETOUT AND COORDINATION WITH SERVICES.`, {
      x: 60, y: 40 + n * 9, size: 6.5, font, color: mid,
    });
  }

  // dimension line along the bottom
  const dimY = y0 - 18;
  page.drawLine({ start: { x: x0, y: dimY }, end: { x: x0 + w, y: dimY }, thickness: 0.8, color: mid });
  for (const x of [x0, x0 + w]) {
    page.drawLine({ start: { x: x - 4, y: dimY + 4 }, end: { x: x + 4, y: dimY - 4 }, thickness: 0.8, color: mid });
  }
  page.drawText(`${planW}.00 m`, { x: x0 + w / 2 - 16, y: dimY + 5, size: 9, font: bold, color: ink });

  // title block
  page.drawRectangle({ x: 600, y: 36, width: 222, height: 64, borderColor: ink, borderWidth: 1 });
  page.drawText(`SOAK TEST SET · SHEET ${sheetNo} OF ${PAGES}`, { x: 610, y: 82, size: 8.5, font: bold, color: ink });
  page.drawText(`SCALE 1:${scale} @ A4 · ${disc} DISCIPLINE`, { x: 610, y: 68, size: 7.5, font, color: mid });
  page.drawText(`FIXTURES THIS SHEET: ${nFix}`, { x: 610, y: 54, size: 7.5, font, color: mid });
  page.drawText('generated · not for construction', { x: 610, y: 42, size: 7, font, color: accent });
}

const bytes = await pdf.save();
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, bytes);
console.log(`wrote ${OUT} (${(bytes.length / 1024).toFixed(0)} KB, ${PAGES} sheets, seed ${SEED})`);
