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

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument } from 'pdf-lib';
import { sniffInput, buildDocument, imageDpi, parseImagePages, paperFactor, PAPER_KEY, unsupportedMessage } from '../src/engine/inputs.ts';
import { nodeTranscoder, openAny } from '../src/headless/image-node.ts';
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

if (failed) process.exit(1);
console.log('PASS: input files (recognising kinds, one PDF from images and PDFs, scan resolution, headless openAny)');
