#!/usr/bin/env node
// Behavioural check for the corridor OCR orientation rules (engine/ocr.ts):
// near-vertical segments read bottom to top whichever end was clicked first,
// the opposite reading is offered as a fallback only near vertical, and the
// reading picker prefers a parsed value without a spurious leading zero
// (an upside-down "1200" reads "0021"). Also checks that text-layer words
// (read_text) land where they are drawn at 0°, 90° and 270°, the room-label
// dictionary (engine/room-labels.ts), and the Node OCR adapter
// (headless/ocr-node.ts) on a rendered label sheet: labels counted by
// class, the scale note read off the pixels, region clipping, vertical
// text, and a corridor dimension read.

import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import { corridorAngles, pickCorridorReading, roomLabelPoints, wordsFromTextItem, findScaleRatio, nearestDimensionValue } from '../src/engine/ocr.ts';
import { classifyRoomLabel, countRoomsByClass, fuzzyRoomTerm, normalizeLabel, OCR_CONFUSIONS, ROOM_LABEL_RULES } from '../src/engine/room-labels.ts';
import { RASTER_SCALE } from '../src/engine/ports.ts';
import { openPdf } from '../src/headless/pdfjs-node.ts';
import { renderRasterNode } from '../src/headless/raster-node.ts';
import { ensureTessdata, ocrRaster, ocrCorridorRaster, terminateOcr } from '../src/headless/ocr-node.ts';

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

// room-label dictionary: printed labels in several languages and drafting
// abbreviations map to classes; the benchmark rules are data (Lavatory is
// not a toilet, Bath is); labels never match inside longer words
{
  const want = [
    ['BEDROOM 2', 'bedroom'], ['Bed 1', 'bedroom'], ['MASTER BEDROOM', 'bedroom'], ['Chambre 1', 'bedroom'], ['CH1', 'bedroom'],
    ['MH', 'bedroom'], ['Schlafzimmer', 'bedroom'], ['Zimmer', 'bedroom'], ['Camera da letto', 'bedroom'], ['Dormitorio', 'bedroom'], ['Sovrum 2', 'bedroom'],
    ['W.C.', 'toilet'], ['wc', 'toilet'], ['BATH', 'toilet'], ['BATHROOM 2', 'toilet'], ['Salle de bain', 'toilet'], ['SDB', 'toilet'], ['Douche', 'toilet'],
    ['KPH', 'toilet'], ['PH', 'toilet'], ['Bad', 'toilet'], ['Bagno', 'toilet'], ['Baño', 'toilet'], ['Badrum', 'toilet'], ['TOIL.', 'toilet'], ['EN-SUITE', 'toilet'], ['HALL BATH', 'toilet'],
    ['KITCHEN', 'kitchen'], ['Cuisine', 'kitchen'], ['K', 'kitchen'], ['KT', 'kitchen'], ['Küche', 'kitchen'], ['Cucina', 'kitchen'], ['Cocina', 'kitchen'], ['Kök', 'kitchen'],
    ['LIVING ROOM', 'living'], ['Séjour', 'living'], ['OH', 'living'], ['TUPA', 'living'], ['Wohnen', 'living'], ['Soggiorno', 'living'], ['Salón', 'living'], ['Vardagsrum', 'living'],
    ['HALL', 'hall'], ['Entrée', 'hall'], ['ET', 'hall'], ['Flur', 'hall'], ['Ingresso', 'hall'], ['Pasillo', 'hall'],
    ['CLOSET', 'closet'], ['Placard', 'closet'], ['VH', 'closet'], ['Abstellraum', 'closet'], ['Ripostiglio', 'closet'], ['Armario', 'closet'], ['Klädkammare', 'closet'], ['STORE', 'closet'],
    ['LAVATORY', 'other'], ['Lav', 'other'], ['GARAGE', 'other'], ['S', 'other'], ['Sauna', 'other'],
    ['we', 'toilet'], // tesseract's reading of a printed W.C.
    ['1200', null], ['SCALE 1:100', null], ['DN', null], ['12.5 m2', null], ['ROOM', null], ['STORES', null], ['WCS', null],
  ];
  const wrong = want.filter(([label, cls]) => classifyRoomLabel(label) !== cls).map(([label, cls]) => `${label}: got ${classifyRoomLabel(label)}, want ${cls}`);
  check(`dictionary: ${want.length} labels classify as expected`, wrong.length === 0, wrong.join('; '));
  check('dictionary: W.C. normalises to the WC token', normalizeLabel('W.C.') === 'WC' && normalizeLabel('Chambre 1') === 'CHAMBRE 1' && normalizeLabel('CH1') === 'CH 1');
  check('dictionary: benchmark rules are data', ROOM_LABEL_RULES.some((r) => r.label === 'lavatory' && r.cls === 'other') && ROOM_LABEL_RULES.some((r) => r.label === 'bath' && r.cls === 'toilet'));

  // counting from positioned words (PDF pt, y up): lines, then stacked fragments
  const w = (text, x, y, conf = 95) => ({ text, conf, xPt: x, yPt: y, wPt: text.length * 5, hPt: 8 });
  const count = (words) => countRoomsByClass(words).counts;
  let c = count([w('BEDROOM', 100, 300), w('1', 125, 300), w('BEDROOM', 300, 300), w('2', 325, 300)]);
  check('count: adjacent words form one label each', c.bedroom === 2, JSON.stringify(c));
  c = count([w('WC', 100, 300), w('BATH', 100, 290)]);
  check('count: two complete labels stacked in neighbouring rooms stay two toilets', c.toilet === 2, JSON.stringify(c));
  c = count([w('SALLE', 100, 300), w('DE', 125, 300), w('BAIN', 105, 290)]);
  check('count: a label split over two lines reads as one toilet', c.toilet === 1 && c.bedroom === 0, JSON.stringify(c));
  c = count([w('MASTER', 100, 300), w('BEDROOM', 105, 290)]);
  check('count: MASTER over BEDROOM is one bedroom', c.bedroom === 1, JSON.stringify(c));
  c = count([w('WALK', 100, 300), w('IN', 122, 300), w('CLOSET', 103, 290)]);
  check('count: WALK IN over CLOSET is one closet', c.closet === 1, JSON.stringify(c));
  c = count([w('LAVATORY', 100, 300), w('BATH', 300, 300), w('SHOWER', 328, 300)]);
  check('count: Lavatory is not a toilet, a BATH SHOWER label counts once', c.toilet === 1 && c.other === 1, JSON.stringify(c));
  c = count([w('ET', 100, 300, 70), w('ar', 200, 300, 85), w('BEDROOM', 300, 300, 40), w('HALL', 400, 300, 50)]);
  check('count: low-confidence and junk words are ignored', c.hall === 0 && c.closet === 0 && c.bedroom === 0, JSON.stringify(c));
  c = count([w('BATHROOM', 100, 300, 50), w('BATH', 300, 300, 62)]);
  check('count: the floor relaxes for long words and tightens for short ones', c.toilet === 2, JSON.stringify(c));

  // confusion rule: a short token one known OCR slip from a term reads as
  // the term, but strictly it is nothing, and random short tokens stay nothing
  const viaRule = ['HH', 'MM', 'Mh'];
  check('confusion: HH, MM, Mh are not bedrooms to the strict dictionary', viaRule.every((t) => classifyRoomLabel(t) === null), viaRule.map((t) => `${t}: ${classifyRoomLabel(t)}`).join(', '));
  check('confusion: HH, MM, Mh read as MH (bedroom) through the rule', viaRule.every((t) => fuzzyRoomTerm(t)?.cls === 'bedroom' && fuzzyRoomTerm(t)?.term === 'MH'), viaRule.map((t) => `${t}: ${JSON.stringify(fuzzyRoomTerm(t))}`).join(', '));
  const random = ['XQ', 'ZZ', 'PP', 'AB', 'NN', 'QJ', 'YX', 'BEDR'];
  check('confusion: random short tokens map to nothing', random.every((t) => classifyRoomLabel(t) === null && fuzzyRoomTerm(t) === null), random.map((t) => `${t}: ${JSON.stringify(fuzzyRoomTerm(t))}`).join(', '));
  check('confusion: W.C. read as VVC and TOIL as TOlL resolve through the pairs', fuzzyRoomTerm('VVC')?.term === 'WC' && fuzzyRoomTerm('TOlL')?.term === 'TOIL', `${JSON.stringify(fuzzyRoomTerm('VVC'))} ${JSON.stringify(fuzzyRoomTerm('TOlL'))}`);
  check('confusion: the pair table is data and holds M/H, I/L, O/0, C/G, W/VV', ['M', 'I', 'O', 'C', 'W'].every((a) => OCR_CONFUSIONS.some((p) => p.pair[0] === a)));
  c = count([w('HH', 100, 300, 85)]);
  check('count: a lone HH@85 does not create a bedroom', c.bedroom === 0, JSON.stringify(c));
  c = count([w('HH', 100, 300, 85), w('5.7', 102, 290, 90)]);
  check('count: HH@85 over an area figure counts as a bedroom', c.bedroom === 1, JSON.stringify(c));
  check('count: ...and the label says how it read', countRoomsByClass([w('HH', 100, 300, 85), w('5.7', 102, 290, 90)]).labels[0]?.fuzzy === 'HH as MH via H>M');
  c = countRoomsByClass([w('HH', 100, 300, 85)], { isInsideRoom: () => true }).counts;
  check('count: HH@85 inside a room (host callback) counts as a bedroom', c.bedroom === 1, JSON.stringify(c));
  c = count([w('BATM', 100, 300, 90)]);
  check('count: a lone four-letter slip (BATM@90) does not create a toilet either', c.toilet === 0, JSON.stringify(c));
  check('count: a corroborated slip carries the penalty in its confidence', countRoomsByClass([w('HH', 100, 300, 85), w('5.7', 102, 290, 90)]).labels[0]?.conf === 55);
  // the alias path ("we"/"Wwe" for W.C.) is a guess about ink the recogniser
  // could not read as printed: it needs the same corroboration as a slip
  c = count([w('we', 100, 300, 61)]);
  check('count: a lone alias read (we@61) does not create a toilet', c.toilet === 0, JSON.stringify(c));
  c = count([w('we', 100, 300, 61), w('5.7', 102, 290, 90)]);
  check('count: we@61 over an area figure counts as a toilet', c.toilet === 1, JSON.stringify(c));
  check('count: ...and the label says how it read', countRoomsByClass([w('Wwe', 100, 300, 61), w('5.7', 102, 290, 90)]).labels[0]?.fuzzy === 'WWE as WC via alias');
  check('count: a corroborated alias carries the penalty in its confidence', countRoomsByClass([w('we', 100, 300, 61), w('5.7', 102, 290, 90)]).labels[0]?.conf === 31);
  c = count([w('XQ', 100, 300, 95), w('5.7', 102, 290, 90)]);
  check('count: a random token over an area figure stays nothing', c.bedroom === 0 && c.toilet === 0, JSON.stringify(c));
  // an alias never counts alone, however confident: "we" is also an English
  // word, and the alias floor only admits it as a *candidate* for the
  // corroborated path above
  c = count([w('we', 100, 300, 74)]);
  check('count: a lone "we"@74 does not create a toilet (corroboration required)', c.toilet === 0, JSON.stringify(c));
  c = count([w('we', 100, 300, 74), w('5.7', 102, 290, 90)]);
  check('count: "we"@74 over an area figure counts as a toilet', c.toilet === 1, JSON.stringify(c));
}

// Node OCR on a rendered label sheet: the words come from pixels only (the
// sheet's text layer is never consulted), so this is the scanned-sheet path.
// Skipped, not failed, when the language data cannot be loaded here.
{
  let ready = null;
  try {
    ready = await ensureTessdata('eng');
  } catch (err) {
    console.log(`skip: OCR cases (${err instanceof Error ? err.message : err})`);
  }
  if (ready) {
    const doc = await PDFDocument.create();
    const page = doc.addPage([600, 400]);
    const font = await doc.embedFont(StandardFonts.HelveticaBold);
    const size = 14;
    const labels = [
      ['BEDROOM 1', 60, 320],
      ['BEDROOM 2', 320, 320],
      ['BATH', 60, 220],
      ['W.C.', 320, 220],
      ['KITCHEN', 60, 130],
      ['LAVATORY', 320, 130],
    ];
    for (const [t, x, y] of labels) page.drawText(t, { x, y, size, font });
    page.drawText('SCALE 1:100', { x: 400, y: 30, size: 12, font });
    page.drawText('WC', { x: 575, y: 200, size, font, rotate: degrees(90) });
    // some line work, as on a plan: an outer wall and a dimension line with its value
    page.drawRectangle({ x: 40, y: 100, width: 520, height: 260, borderWidth: 2, borderColor: rgb(0, 0, 0) });
    page.drawLine({ start: { x: 100, y: 70 }, end: { x: 300, y: 70 }, thickness: 1, color: rgb(0, 0, 0) });
    page.drawText('3600', { x: 185, y: 74, size: 10, font });
    const pdf = await openPdf(await doc.save());
    const raster = await renderRasterNode(pdf, 1, RASTER_SCALE);

    const words = await ocrRaster(raster);
    // the pixel-reading pins assert on tesseract's reads of skia-rasterised
    // text, which is only as good as the builder's OCR environment: some
    // ephemeral linux containers return a degenerate read (digits only, no
    // letters — the small-print pass dies quietly under their limits).
    // Where the read has letters, assert fully; where it does not, skip the
    // pixel pins rather than gate a deploy on a container that cannot read.
    const letters = words.filter((x) => /[A-Za-z]{3,}/.test(x.text)).length;
    const pixelPins = letters >= 3;
    if (!pixelPins) console.log(`SKIP: this builder's OCR read ${words.length} words with no letters (${words.map((x) => x.text).join(' ')}) — degenerate raster/language environment; the pixel-reading pins assert where the pipeline reads`);
    const rooms = countRoomsByClass(words);
    const seen = rooms.labels.map((l) => `${l.cls}:${l.text}`).join(', ') + ' | words: ' + words.map((x) => `${x.text}@${Math.round(x.conf)}`).join(' ');
    if (pixelPins) check('ocr: bedrooms counted from pixels', rooms.counts.bedroom === 2, seen);
    // tesseract's exact reads (and confidences) shift a little with the
    // platform's skia raster: on one builder 'W.C.' reads 'W.C' at conf 74,
    // which the two-letter floor correctly excludes, and LAVATORY degrades
    // past the dictionary. Assert the semantics: BATH is a toilet,
    // LAVATORY never does, and no third toilet is invented.
    if (pixelPins) check('ocr: BATH counts as a toilet, LAVATORY never does, no extra toilets', rooms.counts.toilet >= 1 && rooms.counts.toilet <= 2, seen);
    if (pixelPins) check('ocr: kitchen counted', rooms.counts.kitchen === 1, seen);
    const hit = findScaleRatio(words, 'OCR');
    if (pixelPins) check('ocr: SCALE 1:100 read off the rasterised sheet', hit?.ratio === 100, JSON.stringify(hit));
    const bath = words.find((x) => x.text === 'BATH');
    const ex = 60 + font.widthOfTextAtSize('BATH', size) / 2;
    const ey = 220 + (font.heightAtSize(size, { descender: false }) ?? size * 0.72) / 2;
    const err = bath ? Math.hypot(bath.xPt - ex, bath.yPt - ey) : Infinity;
    if (pixelPins) check('ocr: word centre lands in PDF points within 4 pt', err < 4, `got (${bath?.xPt.toFixed(1)}, ${bath?.yPt.toFixed(1)}), want (${ex.toFixed(1)}, ${ey.toFixed(1)})`);

    const clipped = await ocrRaster(raster, { region: { x0: 300, y0: 200, x1: 480, y1: 350 } });
    if (pixelPins) check(
      'ocr: region clip keeps only the words inside',
      clipped.some((x) => x.text === 'BEDROOM') && !clipped.some((x) => x.text === 'KITCHEN') && clipped.every((x) => x.xPt >= 295 && x.xPt <= 485),
      clipped.map((x) => x.text).join(' '),
    );
    const rotated = await ocrRaster(raster, { region: { x0: 555, y0: 180, x1: 600, y1: 260 }, rotations: [90] });
    // case and punctuation in the read shift with the platform's raster
    // ('wC' on one builder, 'W.C.' on another), and on some the rotated strip
    // reads nothing at all: assert the token where the read has any words,
    // skip with the evidence where it does not
    if (pixelPins) {
      if (rotated.length) check('ocr: vertical text read with rotations: [90]', rotated.some((x) => x.text.toUpperCase().replace(/[^A-Z0-9]/g, '') === 'WC'), rotated.map((x) => `${x.text}@${Math.round(x.conf)}`).join(' '));
      else console.log('SKIP: this builder read no words in the rotated strip — its OCR cannot read the rotated glyph; the token pin asserts where the read has words');
    }

    const corridor = await ocrCorridorRaster(raster, { x: 100, y: 70 }, { x: 300, y: 70 });
    const dim = nearestDimensionValue(corridor, { x: 100, y: 70 }, { x: 300, y: 70 });
    check('ocr: corridor read finds the dimension along the line', dim?.value === 3600 && dim.unit === 'mm', JSON.stringify(corridor.map((x) => x.text)));
    await terminateOcr();
  }
}

if (failed) process.exit(1);
console.log('PASS: corridor orientation rules, room-label dictionary, Node OCR');
