// ScaledDrawingBench set generation: design every sheet from one seed, write
// the vector half as born-digital PDFs, rasterise the other half at 150 dpi
// through the Node raster adapter, degrade it with one scan recipe per sheet
// and re-embed it as a JPEG image PDF, then write questions.jsonl,
// answers.csv, manifest.json and report.md.

import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { PDFDocument } from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';
import { rngHelpers, rasterFromRGBA, degradeSheet } from './draw.mjs';
import { designSheet, drawSheet, buildGeometry } from './sheet.mjs';
import { openPdf } from '../../src/headless/pdfjs-node.ts';
import { renderRasterNode } from '../../src/headless/raster-node.ts';

export const BENCH_VERSION = '0.1';
export const RASTER_DPI = 150;

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * The stack that rendered the raster half. The raster sheets are JPEG images
 * produced by pdf.js + @napi-rs/canvas (and OCR runs tesseract.js), whose
 * pixel output shifts a little across versions and platforms — the raster
 * half's bytes and scores are comparable only within an identical stamp,
 * which is why it travels with the manifest (the vector half is pure
 * geometry and regenerates identically everywhere).
 */
export function environmentStamp() {
  const pkg = (name) => {
    try {
      return JSON.parse(readFileSync(join(__dirname, '..', '..', 'node_modules', name, 'package.json'), 'utf8')).version;
    } catch {
      return 'unknown';
    }
  };
  return {
    node: process.version,
    packages: {
      'pdfjs-dist': pkg('pdfjs-dist'),
      '@napi-rs/canvas': pkg('@napi-rs/canvas'),
      'tesseract.js': pkg('tesseract.js'),
    },
  };
}

export const LICENCE = {
  code: 'Apache-2.0 (the generator, scorer and reference solver, like the rest of pdf2takeoff)',
  data: 'CC BY 4.0 (the generated sheets, questions and answer key)',
  attribution: 'ScaledDrawingBench, pdf2takeoff contributors, https://github.com/ajflow/pdf2takeoff',
};

/** Design every sheet of a set. Deterministic in (seed, count, shares). */
export function designSet(seed, count, shares = {}) {
  const R = rngHelpers(seed);
  // an NTS sheet makes about three quarters of its questions unanswerable, so
  // 6.5 percent of sheets gives the 5 percent unanswerable share by design
  const opts = { vectorCount: Math.ceil(count / 2), ntsShare: 0.065, rotatedShare: 0.2, revBShare: 0.1, ...shares };
  const specs = [];
  for (let i = 0; i < count; i++) {
    const spec = designSheet(R, i, opts);
    spec.seedTag = `${seed}-${String(i + 1).padStart(3, '0')}`;
    specs.push(spec);
  }
  return specs;
}

/** Rasterise a vector PDF at RASTER_DPI, degrade it and wrap it as a JPEG image PDF. */
async function rasterisePdf(bytes, recipe, R, quality) {
  const pdf = await openPdf(bytes);
  const r = await renderRasterNode(pdf, 1, RASTER_DPI / 72);
  const gray = rasterFromRGBA(r.width, r.height, r.data);
  degradeSheet(gray, [], R, { recipe, skew: () => R.pick([-1, 1]) * R.rand(1, 2) });
  const cnv = createCanvas(gray.w, gray.h);
  const ctx = cnv.getContext('2d');
  const img = ctx.createImageData(gray.w, gray.h);
  for (let i = 0, p = 0; i < gray.px.length; i++, p += 4) {
    img.data[p] = img.data[p + 1] = img.data[p + 2] = gray.px[i];
    img.data[p + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const jpg = cnv.toBuffer('image/jpeg', quality);
  const doc = await PDFDocument.create();
  doc.setCreationDate(new Date('2026-10-18T00:00:00Z'));
  doc.setModificationDate(new Date('2026-10-18T00:00:00Z'));
  doc.setProducer('ScaledDrawingBench generator (scanned-sheet simulation)');
  const wPt = (gray.w * 72) / RASTER_DPI;
  const hPt = (gray.h * 72) / RASTER_DPI;
  const page = doc.addPage([wPt, hPt]);
  const im = await doc.embedJpg(jpg);
  page.drawImage(im, { x: 0, y: 0, width: wPt, height: hPt });
  return { bytes: await doc.save({ useObjectStreams: false }), px: [gray.w, gray.h] };
}

export async function generateSet(opts) {
  const { out, seed, count } = opts;
  const t0 = performance.now();
  const specs = designSet(seed, count, opts.shares);
  const sheetsDir = join(out, 'sheets');
  mkdirSync(sheetsDir, { recursive: true });
  const manifestSheets = [];
  const questions = [];
  const log = opts.log ?? (() => {});

  // vector half first (every sheet is designed and drawn as vector; the raster half is converted below)
  const rasterSpecs = [];
  for (const spec of specs) {
    const bytes = await drawSheet(spec, 'A');
    const file = `${spec.id}.pdf`;
    const entry = {
      id: spec.id, file: `sheets/${file}`, page: 1, kind: spec.kind, size: spec.sheet.label, widthPt: Math.round(spec.sheet.w), heightPt: Math.round(spec.sheet.h),
      rotated: spec.rotated, notation: spec.notation, units: spec.units, ratio: spec.ratio, nts: spec.nts, rooms: spec.geo.rooms.length, symbols: spec.geo.symbols.length,
      legend: spec.legend, revB: spec.revB ? `sheets/${spec.id}-revB.pdf` : null, recipe: spec.recipe, questions: spec.questions.length,
    };
    if (spec.kind === 'vector') {
      writeFileSync(join(sheetsDir, file), bytes);
      if (spec.revB) writeFileSync(join(sheetsDir, `${spec.id}-revB.pdf`), await drawSheet(spec, 'B'));
    } else {
      rasterSpecs.push({ spec, bytes, entry });
    }
    manifestSheets.push(entry);
    questions.push(...spec.questions);
    log(`designed ${spec.id} (${spec.kind}, ${spec.notation}, ${spec.sheet.label}${spec.rotated ? ', rotated' : ''}, ${spec.geo.rooms.length} rooms)`);
  }

  // raster half last: rasterise, degrade, re-embed
  const recipes = {};
  for (const { spec, bytes, entry } of rasterSpecs) {
    const RD = rngHelpers(seed * 7919 + spec.index + 1); // own stream: questions never depend on the raster pass
    const a = await rasterisePdf(bytes, spec.recipe, RD, opts.jpegQuality ?? 82);
    writeFileSync(join(sheetsDir, `${spec.id}.pdf`), a.bytes);
    entry.imagePx = a.px;
    entry.dpi = RASTER_DPI;
    if (spec.revB) {
      const b = await rasterisePdf(await drawSheet(spec, 'B'), spec.recipe, RD, opts.jpegQuality ?? 82);
      writeFileSync(join(sheetsDir, `${spec.id}-revB.pdf`), b.bytes);
    }
    recipes[spec.recipe] = (recipes[spec.recipe] ?? 0) + 1;
    log(`rasterised ${spec.id} (${spec.recipe}, ${a.px.join('x')} px)`);
  }

  // answer key and manifest
  writeFileSync(join(out, 'questions.jsonl'), questions.map((q) => JSON.stringify(q)).join('\n') + '\n');
  const csv = ['id,sheet,page,type,answer,unit,tolerance'];
  for (const q of questions) {
    const a = Array.isArray(q.answer) ? q.answer.join('|') : String(q.answer);
    csv.push([q.id, q.sheet, q.page, q.type, `"${a}"`, q.unit, q.tolerance ?? ''].join(','));
  }
  writeFileSync(join(out, 'answers.csv'), csv.join('\n') + '\n');
  const unanswerable = questions.filter((q) => q.answer === 'unanswerable').length;
  const manifest = {
    benchmark: 'ScaledDrawingBench',
    version: BENCH_VERSION,
    seed,
    count,
    generator: 'scripts/scaled-drawing-bench.mjs generate',
    environment: environmentStamp(),
    licence: LICENCE,
    conventions: {
      area: 'between the inside faces of the walls (net floor area)',
      externalWallLength: 'along the outside face',
      partitionLength: 'centreline, between the centrelines of the bounding external walls, door openings included',
      doors: 'plain openings in the wall, no leaf or swing drawn',
      symbols: 'paper-size symbols (9 pt); the legend instance is not counted',
      rasterHalf: `rendered at ${RASTER_DPI} dpi, one degradation recipe per sheet, embedded as a JPEG image PDF (no text layer)`,
    },
    halves: { vector: manifestSheets.filter((s) => s.kind === 'vector').length, raster: manifestSheets.filter((s) => s.kind === 'raster').length },
    recipes,
    questions: { total: questions.length, unanswerable, byType: countBy(questions, (q) => q.type) },
    sheets: manifestSheets,
  };
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  // verify the raster half renders back through the engine (in a child, since a crash is a segfault)
  let verification = 'skipped';
  if (rasterSpecs.length && !opts.noVerify) {
    verification = verifyRasterHalf(out, manifest);
  }
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  const report = [
    `# ScaledDrawingBench v${BENCH_VERSION} generation report`,
    '',
    `Seed ${seed}, ${count} sheets (${manifest.halves.vector} vector, ${manifest.halves.raster} raster), ${questions.length} questions (${unanswerable} unanswerable by design, ${((100 * unanswerable) / questions.length).toFixed(1)} percent), ${secs} s.`,
    '',
    `Notations: ${Object.entries(countBy(manifestSheets, (s) => s.notation)).map(([k, v]) => `${k} ${v}`).join(', ')}.`,
    `Sheet sizes: ${Object.entries(countBy(manifestSheets, (s) => s.size)).map(([k, v]) => `${k} ${v}`).join(', ')}; rotated ${manifestSheets.filter((s) => s.rotated).length}; with revision B ${manifestSheets.filter((s) => s.revB).length}.`,
    `Raster recipes: ${Object.entries(recipes).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}.`,
    `Questions by type: ${Object.entries(manifest.questions.byType).map(([k, v]) => `${k} ${v}`).join(', ')}.`,
    '',
    `Raster half: ${verification}.`,
    '',
    `Licence: code ${LICENCE.code}; data ${LICENCE.data}.`,
    '',
  ].join('\n');
  writeFileSync(join(out, 'report.md'), report);
  return { manifest, questions, report, specs };
}

function verifyRasterHalf(out, manifest) {
  const script = join(import.meta.dirname, 'tmp-verify-raster.mjs');
  const files = manifest.sheets.filter((s) => s.kind === 'raster').map((s) => join(out, s.file));
  const code = [
    "import { readFileSync } from 'node:fs';",
    `import { openPdf } from '${join(import.meta.dirname, '..', '..', 'src', 'headless', 'pdfjs-node.ts').replace(/\\/g, '/')}';`,
    `import { renderRasterNode } from '${join(import.meta.dirname, '..', '..', 'src', 'headless', 'raster-node.ts').replace(/\\/g, '/')}';`,
    'let n = 0;',
    'for (const f of process.argv.slice(2)) {',
    '  const pdf = await openPdf(new Uint8Array(readFileSync(f)));',
    '  const r = await renderRasterNode(pdf, 1, 0.5);',
    '  if (r.width > 10 && r.height > 10) n++;',
    '}',
    "console.log('rendered ' + n);",
  ].join('\n');
  writeFileSync(script, code);
  try {
    const res = spawnSync(process.execPath, ['--experimental-strip-types', script, ...files], { encoding: 'utf8', timeout: 600000 });
    if (res.status === 0 && /rendered (\d+)/.test(res.stdout)) return `verified, ${files.length} image PDFs render back through the engine (${res.stdout.match(/rendered (\d+)/)[1]} rendered)`;
    return `generated, unverified (rendering the image PDFs back through the engine exited with ${res.status ?? res.signal}; see WP1, the image XObject render crash)`;
  } finally {
    try {
      unlinkSync(script);
    } catch {
      // best effort
    }
  }
}

function countBy(list, key) {
  const out = {};
  for (const x of list) {
    const k = key(x);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

/** Read a generated set back: manifest plus questions. */
export function loadSet(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const questions = readFileSync(join(dir, 'questions.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { manifest, questions };
}

export { buildGeometry, basename, existsSync };
