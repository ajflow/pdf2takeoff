#!/usr/bin/env node
// Behavioural check for input files (src/engine/inputs.ts and the headless
// openAny that uses it):
//   1. every kind is recognised by its bytes, with the extension as fallback
//   2. buildDocument: a single PDF comes back byte for byte; an image is one
//      page of W/3 x H/3 points; the same input always gives the same bytes;
//      a mixed set keeps its order; rotated JPEGs and non-PNG/JPEG images go
//      through the transcoder; unreadable kinds say what to do
//   3. stated scan resolutions are read (PNG pHYs, JPEG JFIF and EXIF), the
//      untrustworthy ones (72, 96, 144 dpi) are ignored, and the paper entry
//      survives pdf.js's metadata read, so paperFactor can convert ratios
//   4. the headless openAny opens WebP, GIF, BMP, AVIF and SVG files
//   5. TIFF: a Group 4 scan passes through untouched (single strip or many)
//      and renders black on white at its stated 300 dpi; a colour LZW scan
//      is decoded; a multi-page TIFF gives a page each
//   7. DXF: a vector page at a standard scale set from its units (mm here,
//      1:50 on an A3-sized sheet), lines, bulged polylines and blocks drawn
//      where they belong, text as real text, frozen layers and paper space
//      left out, Scan finding all 8 inserts of a block; unitless and metre
//      drawings, and a binary DXF's message
//   8. HEIC photos decode with libheif where the platform can't (Node)
//   6. scanned-PDF codecs pdf.js decodes with WebAssembly (CCITT fax via the
//      Group 4 page above, and JPEG 2000 here) render: without the wasm they
//      came out blank

import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';
import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument } from 'pdf-lib';
import { sniffInput, buildDocument, imageDpi, parseImagePages, paperFactor, PAPER_KEY, unsupportedMessage } from '../src/engine/inputs.ts';
import { nodeTranscoder, openAny } from '../src/headless/image-node.ts';
import { scanDocAt } from '../src/headless/ops.ts';
import { parseScales, SCALE_KEY } from '../src/engine/inputs.ts';
import { openPdf } from '../src/headless/pdfjs-node.ts';
import { renderRasterNode } from '../src/headless/raster-node.ts';

let failed = false;
const check = (label, cond, detail = '') => {
  if (!cond) {
    console.error(`FAIL: ${label} ${detail}`);
    failed = true;
  } else console.log(`ok: ${label}`);
};
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

// --- fixtures -----------------------------------------------------------------

function drawing(w, h) {
  const c = createCanvas(w, h);
  const x = c.getContext('2d');
  x.fillStyle = '#fff';
  x.fillRect(0, 0, w, h);
  x.strokeStyle = '#000';
  x.lineWidth = 3;
  x.strokeRect(10, 10, w - 20, h - 20);
  return c;
}
const canvas = drawing(150, 90);
const png = new Uint8Array(await canvas.encode('png'));
const jpg = new Uint8Array(await canvas.encode('jpeg'));
const webp = new Uint8Array(await canvas.encode('webp'));
const avif = new Uint8Array(await canvas.encode('avif'));
const gif = new Uint8Array(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
const bmp = new Uint8Array(54 + 16);
{
  const v = new DataView(bmp.buffer);
  bmp[0] = 0x42;
  bmp[1] = 0x4d;
  v.setUint32(2, 70, true);
  v.setUint32(10, 54, true);
  v.setUint32(14, 40, true);
  v.setInt32(18, 2, true);
  v.setInt32(22, 2, true);
  v.setUint16(26, 1, true);
  v.setUint16(28, 24, true);
  v.setUint32(34, 16, true);
  bmp.fill(0xff, 54);
}
const enc = (s) => new TextEncoder().encode(s);
const svg = enc('<?xml version="1.0"?>\n<!-- plan -->\n<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200" viewBox="0 0 300 200"><rect x="20" y="20" width="260" height="160" fill="none" stroke="#000" stroke-width="4"/></svg>');

/** Insert a pHYs chunk (pixels per metre) after IHDR. */
function withPhys(pngBytes, dpi) {
  const ppm = Math.round(dpi / 0.0254);
  const data = new Uint8Array(9);
  const v = new DataView(data.buffer);
  v.setUint32(0, ppm);
  v.setUint32(4, ppm);
  data[8] = 1;
  const type = enc('pHYs');
  const chunk = new Uint8Array(12 + 9);
  const cv = new DataView(chunk.buffer);
  cv.setUint32(0, 9);
  chunk.set(type, 4);
  chunk.set(data, 8);
  cv.setUint32(17, crc32(Buffer.concat([Buffer.from(type), Buffer.from(data)])));
  const ihdrEnd = 8 + 12 + 13;
  return new Uint8Array([...pngBytes.subarray(0, ihdrEnd), ...chunk, ...pngBytes.subarray(ihdrEnd)]);
}

/** Set the JFIF density of a JPEG (units 1 = dpi). */
function withJfif(jpgBytes, dpi) {
  const out = jpgBytes.slice();
  if (!(out[2] === 0xff && out[3] === 0xe0)) throw new Error('fixture JPEG has no JFIF segment first');
  const s = 6; // FF D8, FF E0, two length bytes, then "JFIF\0", version (2), units, X and Y density
  out[s + 7] = 1;
  out[s + 8] = dpi >> 8;
  out[s + 9] = dpi & 0xff;
  out[s + 10] = dpi >> 8;
  out[s + 11] = dpi & 0xff;
  return out;
}

/** A JPEG with an EXIF segment carrying orientation and a 300 dpi resolution (big-endian TIFF). */
function withExif(jpgBytes, orientation, dpi) {
  const tiff = new Uint8Array(8 + 2 + 3 * 12 + 4 + 8);
  const v = new DataView(tiff.buffer);
  tiff.set(enc('MM'), 0);
  v.setUint16(2, 42);
  v.setUint32(4, 8);
  v.setUint16(8, 3);
  const entry = (i, tag, type, count, value) => {
    const o = 10 + i * 12;
    v.setUint16(o, tag);
    v.setUint16(o + 2, type);
    v.setUint32(o + 4, count);
    if (type === 3) v.setUint16(o + 8, value);
    else v.setUint32(o + 8, value);
  };
  const ratAt = 10 + 3 * 12 + 4;
  entry(0, 0x0112, 3, 1, orientation);
  entry(1, 0x011a, 5, 1, ratAt);
  entry(2, 0x0128, 3, 1, 2);
  v.setUint32(ratAt, dpi);
  v.setUint32(ratAt + 4, 1);
  const payload = new Uint8Array([...enc('Exif\0\0'), ...tiff]);
  const seg = new Uint8Array(4 + payload.length);
  seg[0] = 0xff;
  seg[1] = 0xe1;
  seg[2] = (payload.length + 2) >> 8;
  seg[3] = (payload.length + 2) & 0xff;
  seg.set(payload, 4);
  return new Uint8Array([0xff, 0xd8, ...seg, ...jpgBytes.subarray(2)]);
}

async function twoPagePdf() {
  const doc = await PDFDocument.create();
  doc.addPage([200, 100]);
  doc.addPage([300, 150]);
  return doc.save();
}

// --- 1. recognising files ---------------------------------------------------------

const pdf = await twoPagePdf();
const ftyp = (brand, ...compat) => {
  const b = new Uint8Array(16 + 4 * compat.length);
  new DataView(b.buffer).setUint32(0, b.length);
  b.set(enc('ftyp'), 4);
  b.set(enc(brand), 8);
  compat.forEach((c, i) => b.set(enc(c), 16 + 4 * i));
  return b;
};
const cases = [
  ['PDF', pdf, 'pdf'],
  ['PDF after junk bytes', new Uint8Array([...enc('\n\n  junk\n'), ...pdf]), 'pdf'],
  ['PNG', png, 'png'],
  ['JPEG', jpg, 'jpeg'],
  ['WebP', webp, 'webp'],
  ['AVIF', avif, 'avif'],
  ['GIF', gif, 'gif'],
  ['BMP', bmp, 'bmp'],
  ['SVG with XML declaration and comment', svg, 'svg'],
  ['bare SVG', enc('<svg viewBox="0 0 10 10"></svg>'), 'svg'],
  ['TIFF little-endian', enc('II*\0\x08\0\0\0'), 'tiff'],
  ['TIFF big-endian', enc('MM\0*\0\0\0\x08'), 'tiff'],
  ['HEIC', ftyp('heic', 'mif1', 'heic'), 'heic'],
  ['AVIF by compatible brand', ftyp('mif1', 'avif', 'mif1'), 'avif'],
  ['DWG', enc('AC1032\0\0\0\0'), 'dwg'],
  ['DXF text', enc('  0\r\nSECTION\r\n  2\r\nHEADER\r\n'), 'dxf'],
];
for (const [label, bytes, want] of cases) check(`sniff: ${label}`, sniffInput(bytes, 'x.bin') === want, `got ${sniffInput(bytes, 'x.bin')}`);
check('sniff: bytes beat the extension', sniffInput(png, 'plan.pdf') === 'png');
check('sniff: extension fallback (.tif, .HEIC, .dxf)', sniffInput(enc('?'), 'a.tif') === 'tiff' && sniffInput(enc('?'), 'b.HEIC') === 'heic' && sniffInput(enc('?'), 'c.dxf') === 'dxf');
check('sniff: unknown stays unknown', sniffInput(enc('hello'), 'notes.docx') === 'unknown');
check('sniff: "BM" text is not a BMP', sniffInput(enc('BM is not a bitmap header'), '') === 'unknown');

// --- 2. building one PDF -----------------------------------------------------------

let transcodes = 0;
const counting = async (bytes, kind) => {
  transcodes++;
  return nodeTranscoder(bytes, kind);
};

const single = await buildDocument([{ bytes: pdf, name: 'a.pdf' }], counting);
check('build: a single PDF comes back byte for byte', single.bytes === pdf || same(single.bytes, pdf));

const one = await buildDocument([{ bytes: png, name: 'plan.png' }], counting);
const oneDoc = await PDFDocument.load(one.bytes);
const [pw, ph] = [oneDoc.getPage(0).getWidth(), oneDoc.getPage(0).getHeight()];
check('build: PNG is one page of W/3 x H/3 points', oneDoc.getPageCount() === 1 && near(pw, 50) && near(ph, 30), `${pw} x ${ph}`);
check('build: PNG embeds without the transcoder', transcodes === 0);
const again = await buildDocument([{ bytes: png, name: 'renamed.png' }], counting);
check('build: same image, same bytes (sessions key on a hash)', same(one.bytes, again.bytes));
check('build: no dates or producer written', !new TextDecoder('latin1').decode(one.bytes).includes('CreationDate'));

transcodes = 0;
const set = await buildDocument(
  [
    { bytes: png, name: '01.png' },
    { bytes: pdf, name: '02.pdf' },
    { bytes: webp, name: '03.webp' },
  ],
  counting,
);
const setDoc = await PDFDocument.load(set.bytes);
const sizes = setDoc.getPages().map((p) => `${Math.round(p.getWidth())}x${Math.round(p.getHeight())}`);
check('build: mixed set keeps its order (image, 2 PDF pages, image)', sizes.join(' ') === '50x30 200x100 300x150 50x30', sizes.join(' '));
check('build: mixed set marks pages 1 and 4 as images', [...set.imagePages.keys()].join(',') === '1,4');
check('build: WebP goes through the transcoder', transcodes === 1, `transcodes ${transcodes}`);

transcodes = 0;
await buildDocument([{ bytes: withExif(jpg, 6, 300), name: 'photo.jpg' }], counting);
check('build: a rotated JPEG (EXIF orientation 6) is transcoded upright', transcodes === 1);
transcodes = 0;
await buildDocument([{ bytes: withExif(jpg, 1, 300), name: 'scan.jpg' }], counting);
check('build: an upright JPEG embeds as it is', transcodes === 0);

for (const [label, bytes] of [
  ['GIF', gif],
  ['BMP', bmp],
  ['AVIF', avif],
]) {
  const b = await buildDocument([{ bytes, name: `x.${label.toLowerCase()}` }], nodeTranscoder);
  check(`build: ${label} becomes one page`, (await PDFDocument.load(b.bytes)).getPageCount() === 1);
}
const svgDoc = await PDFDocument.load((await buildDocument([{ bytes: svg, name: 'plan.svg' }], nodeTranscoder)).bytes);
check('build: SVG is drawn with a 4,000 px long side', near(svgDoc.getPage(0).getWidth(), 4000 / 3, 0.5), `${svgDoc.getPage(0).getWidth()}`);

let dwgError = '';
await buildDocument([{ bytes: enc('AC1032\0\0'), name: 'house.dwg' }], nodeTranscoder).catch((e) => (dwgError = e.message));
check('build: a DWG is refused with what to do', dwgError === unsupportedMessage('dwg', 'house.dwg') && /export the sheet as a PDF/.test(dwgError), dwgError);

// --- 3. scan resolution and the paper entry -------------------------------------

check('dpi: PNG pHYs 300', imageDpi(withPhys(png, 300), 'png') === 300);
check('dpi: PNG pHYs 72 and 144 are ignored', imageDpi(withPhys(png, 72), 'png') === 0 && imageDpi(withPhys(png, 144), 'png') === 0);
check('dpi: PNG without pHYs is unknown', imageDpi(png, 'png') === 0);
check('dpi: JPEG JFIF 400', imageDpi(withJfif(jpg, 400), 'jpeg') === 400);
check('dpi: JPEG JFIF 96 is ignored', imageDpi(withJfif(jpg, 96), 'jpeg') === 0);
check('dpi: JPEG EXIF 300 (big-endian)', imageDpi(withExif(jpg, 1, 300), 'jpeg') === 300);

const scanned = await buildDocument(
  [
    { bytes: withPhys(png, 300), name: 'scan.png' },
    { bytes: pdf, name: 'b.pdf' },
    { bytes: png, name: 'screenshot.png' },
  ],
  nodeTranscoder,
);
const meta = await (await openPdf(scanned.bytes)).getMetadata();
const custom = meta.info?.Custom?.[PAPER_KEY];
const pages = parseImagePages(custom);
check('paper: pdf.js reads the entry back', pages.get(1) === 300 && pages.get(4) === 0 && !pages.has(2), `custom ${JSON.stringify(custom)}`);
check('paper: factor 1 on a PDF page', paperFactor(pages, 2) === 1);
check('paper: factor 0.72 on a 300 dpi image page', near(paperFactor(pages, 1), 0.72));
check('paper: unknown on an image page without a resolution', paperFactor(pages, 4) === null);
check('paper: garbage entry parses to nothing', parseImagePages('{not json').size === 0 && parseImagePages(undefined).size === 0);

// --- 4. headless openAny on the new kinds ----------------------------------------

const dir = mkdtempSync(join(tmpdir(), 'p2t-inputs-'));
try {
  for (const [ext, bytes, w] of [
    ['webp', webp, 50],
    ['gif', gif, 1 / 3],
    ['bmp', bmp, 2 / 3],
    ['avif', avif, 50],
    ['svg', svg, 4000 / 3],
  ]) {
    const file = join(dir, `sheet.${ext}`);
    writeFileSync(file, bytes);
    const { doc, kind } = await openAny(file);
    const vp = (await doc.getPage(1)).getViewport({ scale: 1 });
    check(`openAny: .${ext} opens as one image page`, kind === 'image' && doc.numPages === 1 && near(vp.width, w, 0.5), `${kind} ${vp.width}`);
  }
  const webpFile = join(dir, 'sheet.webp');
  const { doc } = await openAny(webpFile);
  const raster = await renderRasterNode(doc, 1, 3);
  let ink = 0;
  for (let i = 0; i < raster.data.length; i += 4) if (raster.data[i] < 128) ink++;
  check('openAny: a WebP renders its line work at scale 3', raster.width === 150 && ink > 500, `${raster.width} px, ${ink} dark`);
  const dwgFile = join(dir, 'house.dwg');
  writeFileSync(dwgFile, enc('AC1032\0\0'));
  let err = '';
  await openAny(dwgFile).catch((e) => (err = e.message));
  check('openAny: a DWG says what to do', /export the sheet as a PDF/.test(err), err);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// --- 5. TIFF ------------------------------------------------------------------------

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'scans');
const tif = (name) => new Uint8Array(readFileSync(join(fixtures, name)));
const px = (r, x, y) => {
  const i = (y * r.width + x) * 4;
  return [r.data[i], r.data[i + 1], r.data[i + 2]];
};
const dark = (r, x, y) => px(r, x, y)[0] < 100;
const inkCount = (r) => {
  let n = 0;
  for (let i = 0; i < r.data.length; i += 4) if (r.data[i] < 100) n++;
  return n;
};

const g4 = tif('plan-g4-300dpi.tif');
check('tiff: sniffed by its bytes', sniffInput(g4, 'scan.bin') === 'tiff');
const g4doc = await buildDocument([{ bytes: g4, name: 'scan.tif' }], nodeTranscoder);
const g4pdf = await PDFDocument.load(g4doc.bytes);
check('tiff G4: one page of W/3 x H/3 points', g4pdf.getPageCount() === 1 && near(g4pdf.getPage(0).getWidth(), 100) && near(g4pdf.getPage(0).getHeight(), 60));
check('tiff G4: its 300 dpi is the paper size', g4doc.imagePages.get(1) === 300);
check('tiff G4: passes through as a CCITTFaxDecode stream, not decoded', new TextDecoder('latin1').decode(g4doc.bytes).includes('/CCITTFaxDecode') && g4doc.bytes.length < 4000, `${g4doc.bytes.length} bytes`);
const g4r = await renderRasterNode(await openPdf(g4doc.bytes), 1, 3);
check('tiff G4: renders black lines on white (frame, wall) at native size', g4r.width === 300 && dark(g4r, 14, 90) && dark(g4r, 151, 60) && !dark(g4r, 75, 90) && !dark(g4r, 230, 150), `${g4r.width}px frame ${px(g4r, 14, 90)} wall ${px(g4r, 151, 60)} room ${px(g4r, 75, 90)}`);
const stripsDoc = await buildDocument([{ bytes: tif('plan-g4-strips.tif'), name: 'strips.tif' }], nodeTranscoder);
const stripsR = await renderRasterNode(await openPdf(stripsDoc.bytes), 1, 3);
check('tiff G4 in 23 strips: renders the same as one strip', Math.abs(inkCount(stripsR) - inkCount(g4r)) <= inkCount(g4r) * 0.01, `${inkCount(stripsR)} vs ${inkCount(g4r)}`);

const lzwDoc = await buildDocument([{ bytes: tif('plan-lzw-rgb.tif'), name: 'colour.tif' }], nodeTranscoder);
const lzwR = await renderRasterNode(await openPdf(lzwDoc.bytes), 1, 3);
const red = px(lzwR, 120, 80);
check('tiff LZW colour: decoded, frame dark and the red line red', lzwDoc.imagePages.get(1) === 200 && dark(lzwR, 11, 80) && red[0] > 180 && red[1] < 90, `red ${red}`);

const setDoc3 = await buildDocument([{ bytes: tif('set-3-pages.tif'), name: 'set.tif' }], nodeTranscoder);
const set3 = await PDFDocument.load(setDoc3.bytes);
check('tiff multi-page: a page each, no resolution stated', set3.getPageCount() === 3 && [...setDoc3.imagePages].map(([p, d]) => `${p}:${d}`).join(',') === '1:0,2:0,3:0' && near(set3.getPage(2).getWidth(), 80));
const tdir = mkdtempSync(join(tmpdir(), 'p2t-tiff-'));
try {
  const f = join(tdir, 'set.tiff');
  writeFileSync(f, tif('set-3-pages.tif'));
  const { doc, kind } = await openAny(f);
  check('openAny: a multi-page .tiff opens with all its pages', kind === 'image' && doc.numPages === 3);
} finally {
  rmSync(tdir, { recursive: true, force: true });
}

// --- 6. a scanned PDF with a JPEG 2000 image ---------------------------------------

{
  const jp2 = tif('plan.jp2');
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([40, 80 / 3]);
  const name = page.node.newXObject('Im', doc.context.register(doc.context.stream(jp2, { Type: 'XObject', Subtype: 'Image', Width: 120, Height: 80, Filter: 'JPXDecode' })));
  const { pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject } = await import('pdf-lib');
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(40, 0, 0, 80 / 3, 0, 0), drawObject(name), popGraphicsState());
  const r = await renderRasterNode(await openPdf(await doc.save()), 1, 3);
  check('scanned PDF: a JPEG 2000 image renders (frame dark, inside white)', dark(r, 7, 40) && dark(r, 61, 20) && !dark(r, 30, 40), `frame ${px(r, 7, 40)} inside ${px(r, 30, 40)}`);
}

// --- 7. DXF ------------------------------------------------------------------------

const dxf = (body, units = 4) =>
  enc(
    [
      '  0', 'SECTION', '  2', 'HEADER', '  9', '$INSUNITS', ' 70', String(units), '  0', 'ENDSEC',
      '  0', 'SECTION', '  2', 'TABLES', '  0', 'TABLE', '  2', 'LAYER',
      '  0', 'LAYER', '  2', 'FROZEN', ' 70', '1', ' 62', '7',
      '  0', 'ENDTAB', '  0', 'ENDSEC',
      '  0', 'SECTION', '  2', 'BLOCKS',
      '  0', 'BLOCK', '  8', '0', '  2', 'DL', ' 70', '0', ' 10', '0', ' 20', '0',
      '  0', 'CIRCLE', '  8', '0', ' 10', '0', ' 20', '0', ' 40', '150',
      '  0', 'LINE', '  8', '0', ' 10', '-100', ' 20', '0', ' 11', '100', ' 21', '0',
      '  0', 'ENDBLK', '  0', 'ENDSEC',
      '  0', 'SECTION', '  2', 'ENTITIES', ...body, '  0', 'ENDSEC', '  0', 'EOF',
    ].join('\r\n'),
  );
const lights = [[1000, 1500], [2000, 1500], [3000, 1500], [1000, 4000], [3000, 4000], [1000, 6500], [2000, 6500], [3000, 6500]];
const plan = [
  '  0', 'LWPOLYLINE', '  8', 'WALLS', ' 90', '4', ' 70', '1', ' 10', '0', ' 20', '0', ' 10', '12000', ' 20', '0', ' 10', '12000', ' 20', '8000', ' 10', '0', ' 20', '8000',
  '  0', 'LINE', '  8', 'WALLS', ' 10', '4000', ' 20', '0', ' 11', '4000', ' 21', '6000',
  '  0', 'ARC', '  8', 'DOORS', ' 10', '4000', ' 20', '6000', ' 40', '900', ' 50', '270', ' 51', '360',
  // a bulged polyline: a half circle from (6000, 7000) to (8000, 7000) through (7000, 6000)
  '  0', 'LWPOLYLINE', '  8', 'WALLS', ' 90', '2', ' 70', '0', ' 10', '6000', ' 20', '7000', ' 42', '1', ' 10', '8000', ' 20', '7000',
  ...lights.flatMap(([x, y]) => ['  0', 'INSERT', '  8', 'LIGHTS', '  2', 'DL', ' 10', String(x), ' 20', String(y)]),
  '  0', 'TEXT', '  8', 'TEXT', ' 10', '1500', ' 20', '2800', ' 40', '250', '  1', 'OFFICE',
  '  0', 'MTEXT', '  8', 'TEXT', ' 10', '8000', ' 20', '4000', ' 40', '250', ' 71', '5', '  1', 'MEETING\\Proom',
  // a solid hatch (a column) and a pattern hatch: a ring of line edges around a polyline island
  '  0', 'HATCH', '  8', 'HATCH', '  2', 'SOLID', ' 70', '1', ' 71', '0', ' 91', '1',
  ' 92', '2', ' 72', '0', ' 73', '1', ' 93', '4', ' 10', '11000', ' 20', '7400', ' 10', '11300', ' 20', '7400', ' 10', '11300', ' 20', '7700', ' 10', '11000', ' 20', '7700', ' 97', '0',
  ' 75', '0', ' 76', '1', ' 98', '0',
  '  0', 'HATCH', '  8', 'HATCH', '  2', 'ANSI31', ' 70', '0', ' 71', '0', ' 91', '2',
  ' 92', '1', ' 93', '4',
  ' 72', '1', ' 10', '5000', ' 20', '1000', ' 11', '7000', ' 21', '1000',
  ' 72', '1', ' 10', '7000', ' 20', '1000', ' 11', '7000', ' 21', '3000',
  ' 72', '1', ' 10', '7000', ' 20', '3000', ' 11', '5000', ' 21', '3000',
  ' 72', '1', ' 10', '5000', ' 20', '3000', ' 11', '5000', ' 21', '1000', ' 97', '0',
  ' 92', '2', ' 72', '0', ' 73', '1', ' 93', '4', ' 10', '5500', ' 20', '1500', ' 10', '6500', ' 20', '1500', ' 10', '6500', ' 20', '2500', ' 10', '5500', ' 20', '2500', ' 97', '0',
  ' 75', '0', ' 76', '1', ' 52', '0', ' 41', '1', ' 78', '1', ' 53', '45', ' 43', '0', ' 44', '0', ' 45', '-2.24', ' 46', '2.24', ' 79', '0', ' 98', '0',
  // an MTEXT note in a 2,000 mm box: it wraps
  '  0', 'MTEXT', '  8', 'TEXT', ' 10', '8000', ' 20', '2400', ' 40', '200', ' 41', '2000', ' 71', '1', '  1', 'SEE NOTES FOR THE DOWNLIGHT SCHEDULE',
  // left out: a frozen layer and paper space (either would widen the page if drawn)
  '  0', 'LINE', '  8', 'FROZEN', ' 10', '0', ' 20', '0', ' 11', '50000', ' 21', '0',
  '  0', 'LINE', '  8', 'WALLS', ' 67', '1', ' 10', '0', ' 20', '0', ' 11', '0', ' 21', '90000',
];
const planDxf = dxf(plan);
check('dxf: sniffed by its text', sniffInput(planDxf, 'plan.bin') === 'dxf');
const dxfDoc = await buildDocument([{ bytes: planDxf, name: 'plan.dxf' }], nodeTranscoder);
const sc = dxfDoc.scales.get(1);
check('dxf: laid out at 1:50 from its millimetres (12 m fits an A3 sheet)', sc && sc.ratio === 50 && sc.unit === 'mm' && !sc.assumed, JSON.stringify(sc));
const dxfPdf = await PDFDocument.load(dxfDoc.bytes);
const k50 = (0.001 / 50) * (72 / 0.0254); // pt per mm at 1:50
const pageW = dxfPdf.getPage(0).getWidth();
const pageH = dxfPdf.getPage(0).getHeight();
check('dxf: the page is the drawing (with a 4% margin) at 1:50; frozen and paper-space lines left out', near(pageW, 12960 * k50, 0.05) && near(pageH, 8960 * k50, 0.05), `${pageW} x ${pageH}`);
const dxfOpened = await openPdf(dxfDoc.bytes);
const dmeta = await dxfOpened.getMetadata();
check('dxf: the scale rides in the PDF and pdf.js reads it back', parseScales(dmeta.info?.Custom?.[SCALE_KEY]).get(1)?.ratio === 50);
const dr = await renderRasterNode(dxfOpened, 1, 3);
const toPx = (x, y) => [Math.round((x + 480) * k50 * 3), Math.round((pageH - (y + 480) * k50) * 3)];
const inkNear = (r, [cx, cy]) => {
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (dark(r, cx + dx, cy + dy)) return true;
  return false;
};
check('dxf: walls, the bulged arc and a block insert draw where they belong', inkNear(dr, toPx(0, 4000)) && inkNear(dr, toPx(4000, 3000)) && inkNear(dr, toPx(7000, 6000)) && inkNear(dr, toPx(2000, 1650)) && !inkNear(dr, toPx(7000, 7000)), `wall ${inkNear(dr, toPx(0, 4000))} arc ${inkNear(dr, toPx(7000, 6000))} light ${inkNear(dr, toPx(2000, 1650))}`);
const grey = (r, at) => px(r, ...at)[0];
check('dxf: a solid hatch fills mid grey, a pattern hatch a light tone around its island (left white)', Math.abs(grey(dr, toPx(11150, 7550)) - 140) < 25 && Math.abs(grey(dr, toPx(5200, 2000)) - 219) < 20 && grey(dr, toPx(6000, 2000)) > 245, `column ${grey(dr, toPx(11150, 7550))} ring ${grey(dr, toPx(5200, 2000))} island ${grey(dr, toPx(6000, 2000))}`);
const items = (await (await dxfOpened.getPage(1)).getTextContent()).items;
const note = items.filter((i) => /SEE|NOTES|DOWNLIGHT|SCHEDULE/.test(i.str));
check('dxf: an MTEXT note wraps to its 2,000 mm box', note.length >= 2 && note.every((i) => i.width <= 2000 * k50 * 1.03), note.map((i) => `${i.str}@${i.width.toFixed(1)}`).join(' | '));
const words = items.map((i) => i.str).join(' ');
check('dxf: TEXT and MTEXT become real text (no OCR needed)', /OFFICE/.test(words) && /MEETING/.test(words) && /room/.test(words), words);
const blockScan = await scanDocAt(dxfOpened, 1, { x: (2000 + 480) * k50 + 150 * k50, y: (1500 + 480) * k50 });
check('dxf: Scan finds all 8 inserts of the light block', 'hits' in blockScan && blockScan.hits.length === 8, JSON.stringify('hits' in blockScan ? { n: blockScan.hits.length, provider: blockScan.provider } : blockScan));
const unitless = await buildDocument([{ bytes: dxf(plan, 0), name: 'old.dxf' }], nodeTranscoder);
check('dxf: no units stated, a 12000-wide drawing reads as millimetres (flagged as assumed)', unitless.scales.get(1)?.unit === 'mm' && unitless.scales.get(1)?.assumed === true);
const metres = await buildDocument([{ bytes: dxf(['  0', 'LWPOLYLINE', '  8', 'W', ' 90', '4', ' 70', '1', ' 10', '0', ' 20', '0', ' 10', '30', ' 20', '0', ' 10', '30', ' 20', '20', ' 10', '0', ' 20', '20'], 6), name: 'site.dxf' }], nodeTranscoder);
check('dxf: a 30 m building drawn in metres comes out at 1:100', metres.scales.get(1)?.ratio === 100 && metres.scales.get(1)?.unit === 'm', JSON.stringify(metres.scales.get(1)));
let binErr = '';
await buildDocument([{ bytes: enc('AutoCAD Binary DXF\r\n\x1a\0'), name: 'bin.dxf' }], nodeTranscoder).catch((e) => (binErr = e.message));
check('dxf: a binary DXF says to save it as ASCII', /ASCII DXF/.test(binErr), binErr);
{
  const dd = mkdtempSync(join(tmpdir(), 'p2t-dxf-'));
  try {
    const f = join(dd, 'plan.dxf');
    writeFileSync(f, planDxf);
    const o = await openAny(f);
    check('openAny: a .dxf opens as a vector page with its scale', o.kind === 'dxf' && o.scales?.get(1)?.ratio === 50 && o.doc.numPages === 1);
  } finally {
    rmSync(dd, { recursive: true, force: true });
  }
}

// --- 8. HEIC (libheif where the platform can't decode it: Node here) --------------

{
  const heic = tif('plan.heic');
  check('heic: sniffed by its ftyp brand', sniffInput(heic, 'photo.bin') === 'heic');
  const built = await buildDocument([{ bytes: heic, name: 'photo.heic' }], nodeTranscoder);
  const page = (await PDFDocument.load(built.bytes)).getPage(0);
  check('heic: one page of W/3 x H/3 points', near(page.getWidth(), 100) && near(page.getHeight(), 200 / 3), `${page.getWidth()} x ${page.getHeight()}`);
  const r = await renderRasterNode(await openPdf(built.bytes), 1, 3);
  const red = px(r, 220, 80);
  check('heic: decoded upright: frame dark, room white, the red mark red', dark(r, 12, 100) && !dark(r, 80, 100) && red[0] > 180 && red[1] < 90, `frame ${px(r, 12, 100)} room ${px(r, 80, 100)} red ${red}`);
  const hdir = mkdtempSync(join(tmpdir(), 'p2t-heic-'));
  try {
    const f = join(hdir, 'site-photo.heic');
    writeFileSync(f, heic);
    const o = await openAny(f);
    check('openAny: a .heic photo opens as one image page', o.kind === 'image' && o.doc.numPages === 1);
  } finally {
    rmSync(hdir, { recursive: true, force: true });
  }
}

if (failed) process.exit(1);
console.log('PASS: input files (recognising kinds, one PDF from images and PDFs, scan resolution, headless openAny, TIFF, scanned-PDF codecs, DXF, HEIC)');
