#!/usr/bin/env node
// Behavioural check for the corridor OCR orientation rules (engine/ocr.ts):
// near-vertical segments read bottom to top whichever end was clicked first,
// the opposite reading is offered as a fallback only near vertical, and the
// reading picker prefers a parsed value without a spurious leading zero
// (an upside-down "1200" reads "0021"). Also checks that text-layer words
// (read_text) land where they are drawn at 0°, 90° and 270°.

import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import { corridorAngles, pickCorridorReading, roomLabelPoints, wordsFromTextItem } from '../src/engine/ocr.ts';
import { openPdf } from '../src/headless/pdfjs-node.ts';

let failed = false;
const check = (label, cond, detail = '') => {
  if (!cond) {
    console.error(`FAIL: ${label} ${detail}`);
    failed = true;
  } else console.log(`ok: ${label}`);
};
const deg = (rads) => rads.map((r) => Math.round((r * 180) / Math.PI));

// raster space, y down
const cases = [
  ['horizontal, left to right', { x: 0, y: 0 }, { x: 100, y: 0 }, [0]],
  ['horizontal, right to left', { x: 100, y: 0 }, { x: 0, y: 0 }, [0]],
  ['vertical, top to bottom', { x: 0, y: 0 }, { x: 0, y: 100 }, [-90, 90]],
  ['vertical, bottom to top', { x: 0, y: 100 }, { x: 0, y: 0 }, [-90, 90]],
  ['vertical with sub-pixel jitter right', { x: 0, y: 0 }, { x: 0.3, y: 100 }, [-90, 90]],
  ['vertical with sub-pixel jitter left', { x: 0.3, y: 0 }, { x: 0, y: 100 }, [-90, 90]],
  ['85° (inside the fold band)', { x: 0, y: 0 }, { x: 8.75, y: 100 }, [-95, 85]],
  ['75° (outside the fold band, still ambiguous)', { x: 0, y: 0 }, { x: 26.79, y: 100 }, [75, 255]],
  ['60° (not ambiguous)', { x: 0, y: 0 }, { x: 57.74, y: 100 }, [60]],
  ['45° down-right', { x: 0, y: 0 }, { x: 100, y: 100 }, [45]],
  ['45° up-right', { x: 0, y: 100 }, { x: 100, y: 0 }, [-45]],
];
for (const [label, a, b, want] of cases) {
  const got = deg(corridorAngles(a, b));
  check(`angles: ${label}`, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

// readings near a vertical segment in PDF space (x = 100, y 0..200)
const a = { x: 100, y: 0 };
const b = { x: 100, y: 200 };
const word = (text, conf) => ({ text, conf, xPt: 110, yPt: 100, wPt: 8, hPt: 30 });
check('picker: upright beats leading-zero misread', pickCorridorReading([[word('0021', 92)], [word('1200', 70)]], a, b) === 1);
check('picker: a parse beats no parse', pickCorridorReading([[word('ZI', 95)], [word('3600', 60)]], a, b) === 1);
check('picker: higher confidence breaks ties', pickCorridorReading([[word('3600', 60)], [word('3900', 85)]], a, b) === 1);
check('picker: decimal metres keep their zero', pickCorridorReading([[word('0.45', 80)], [word('54.0', 60)]], a, b) === 0);

// text-layer words land where they are drawn, at any rotation
{
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 400]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const size = 10;
  const drawn = [
    { text: 'AB 3600', x: 100, y: 50, rot: 0 },
    { text: 'CD 4200', x: 300, y: 100, rot: 90 },
    { text: 'EF 1500', x: 500, y: 300, rot: 270 },
  ];
  for (const d of drawn) page.drawText(d.text, { x: d.x, y: d.y, size, font, rotate: degrees(d.rot) });
  const pdf = await openPdf(await doc.save());
  const tc = await (await pdf.getPage(1)).getTextContent();
  const words = tc.items.flatMap((it) => wordsFromTextItem(it.str ?? '', it.transform, it.width, it.height));
  for (const d of drawn) {
    // expected centre of the second word: start + baseline·(advance to its middle) + up·(size/2)
    const second = d.text.split(' ')[1];
    const along = font.widthOfTextAtSize(d.text.slice(0, d.text.indexOf(second)), size) + font.widthOfTextAtSize(second, size) / 2;
    const r = (d.rot * Math.PI) / 180;
    const ex = d.x + Math.cos(r) * along - Math.sin(r) * (size / 2);
    const ey = d.y + Math.sin(r) * along + Math.cos(r) * (size / 2);
    const w = words.find((x) => x.text === second);
    const err = w ? Math.hypot(w.xPt - ex, w.yPt - ey) : Infinity;
    check(`text layer: "${second}" at ${d.rot}° placed within 1.5 pt`, err < 1.5, `got (${w?.xPt.toFixed(1)}, ${w?.yPt.toFixed(1)}), want (${ex.toFixed(1)}, ${ey.toFixed(1)})`);
    check(`text layer: "${second}" reports angle ${d.rot}°`, w && ((w.angleDeg - d.rot) % 360 + 360) % 360 < 0.5, `got ${w?.angleDeg}`);
  }
}

// room labels: names count, annotation words and dimensions do not
{
  const item = (str) => ({ str, transform: [8, 0, 0, 8, 100, 100], width: str.length * 5, height: 8 });
  const names = ['BED 1', 'KITCHEN', 'WC', 'Living Room'];
  const notNames = ['DN', 'UP', 'FFL 10.500', 'RL 12.3', '1200mm', '2.4 m', 'TYP.', 'SCALE 1:100', '3600', 'NTS'];
  const kept = (s) => roomLabelPoints([item(s)]).length === 1;
  check('room labels: names kept', names.every(kept), JSON.stringify(names.filter((s) => !kept(s))));
  check('room labels: annotations and dimensions dropped', notNames.every((s) => !kept(s)), JSON.stringify(notNames.filter(kept)));
}

if (failed) process.exit(1);
console.log('PASS: corridor orientation rules');
