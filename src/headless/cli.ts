// pdf2takeoff CLI — headless takeoff on Node. Local-only: no network calls
// and no telemetry, except ai-count, which sends one rendered page to the AI
// provider you name, with your own key. Deterministic JSON on stdout; errors
// on stderr with exit 1.

import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, statSync, mkdirSync, readdirSync } from 'node:fs';
import { openPdf } from './pdfjs-node.ts';
import { openAny, imageToPdf, sniffImage, imageKindByExt } from './image-node.ts';
import { renderRasterNode } from './raster-node.ts';
import { readMarkups, renderPagePng, scanDocAt, scanDocAllPages, compareDocs, compareFolders } from './ops.ts';
import { ocrRaster, terminateOcr } from './ocr-node.ts';
import { RASTER_SCALE } from '../engine/ports.ts';
import { findScaleRatio } from '../engine/ocr.ts';
import { countRoomsByClass } from '../engine/room-labels.ts';
import { basename, join } from 'node:path';
import { parseMarkups, type AnnotationLike } from '../engine/read.ts';
import { buildAnnotatedPdf } from '../engine/annotate.ts';
import { buildMatrix, toDelimited, xlsxBytes, groupsOf } from '../engine/export.ts';
import { nextId, defaultLabel } from '../engine/geometry.ts';
import { countItems, COUNT_PRESETS, presetById, proposalMarkups } from '../engine/inventory.ts';
import { PROVIDER_PRESETS, presetConfig, type ProviderConfig } from '../ai/providers.ts';
import { runInventory } from '../ai/run.ts';
import type { DisplayUnit } from '../engine/units.ts';
import type { Calibration, Markup } from '../engine/types.ts';
import { parseSpec, parseScaleSpec, parseRunSpec } from './spec.ts';
import { PDFDocument } from 'pdf-lib';

const HELP = `pdf2takeoff — free, open-source PDF takeoff (Apache-2.0)

Every <file.pdf> below also takes an image (PNG, JPG, TIFF, WebP, GIF, BMP,
AVIF or SVG): it opens as width/3 x height/3 points per page (scale 3 renders
the native pixels; a multi-page TIFF gives a page each), and commands that
write a PDF wrap the image into one.

Usage:
  pdf2takeoff info <file.pdf>
      Pages, page sizes, and annotation counts as JSON.
  pdf2takeoff set <folder> -o current-issue.pdf
      Slip-sheet: walk the folder, keep the newest file per sheet name
      (PDF or image, paired by file stem, by modified time), merge into
      one sorted multi-sheet PDF.
  pdf2takeoff compare <a> <b> [--png out.png] [--png-dir dir] [--threshold 24]
      Two PDFs (or images): per-sheet change fractions and changed regions.
      Two folders: batch compare, sheets paired by file stem across the
      revision sets (a PNG scan pairs with the PDF of the same sheet), with
      added/removed sheets listed. --png writes the overlay of the first
      changed sheet; --png-dir (folder mode) writes an overlay per changed
      pair.
  pdf2takeoff scan <file.pdf> --page N --at x,y [--all-pages] [--model dir]
      Click-point auto-count: every match on the page as JSON (vector match,
      then the trained ONNX detector when a model is present, else tier-1 CV).
      --at is in PDF points; run "info" first to see page sizes.
      --all-pages scans every sheet and returns a per-page schedule.
      --model names a folder with symbols.json + symbols.onnx; without it the
      PDF2TAKEOFF_MODEL_DIR environment variable, then public/models/, is used.
  pdf2takeoff export <file.pdf> [--scale 1:100] [--unit m] [--format csv|tsv|xlsx] [-o out]
      Read pdf2takeoff annotations back out as a quantities table.
      csv/tsv print to stdout without -o; xlsx requires -o.
  pdf2takeoff annotate <file.pdf> --spec takeoff.yaml [-o out.pdf] [--keep-existing]
      Write spec-defined markups into the PDF as standard annotations.
      Replaces pdf2takeoff markups already in the file (re-runs stay
      idempotent); --keep-existing keeps them and adds the spec's.
  pdf2takeoff run <takeoff.yaml> [--prev previous-summary.json]
      Takeoff-as-code: calibrate, scan-count every symbol type in the spec,
      write the exports (csv / xlsx / annotated-pdf / summary JSON).
      --prev diffs quantities against a previous run — the revision loop.
  pdf2takeoff ocr <file.pdf> --page N [--region x,y,w,h] [--rotate 90] [--threshold 190]
      OCR the rendered page (scans have no text layer): words with positions
      in PDF points, the scale note read, and room labels counted by class,
      as JSON. --region clips to a rectangle (PDF points, bottom-left origin);
      --rotate adds a reading of text running bottom to top; --threshold
      binarises soft scans. First use fetches the English language pack
      (about 3 MB) into ~/.cache/pdf2takeoff/tessdata; set PDF2TAKEOFF_TESSDATA
      to a folder holding eng.traineddata to run fully offline.
  pdf2takeoff ai-count <file.pdf> --model MODEL [--provider NAME] [--page N]
      [--preset aecv|schedule] [--items] [-o out.pdf]
      Ask a vision model you choose to inventory one sheet: doors, Windows
      and spaces come back as flagged proposals, counted under --preset.
      --provider openrouter (default; one key, any model), openai, gemini,
      zai, ollama, lmstudio — any other OpenAI-compatible server through
      --base-url. Keys come from environment variables only (the provider's
      OPENROUTER_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY / ZAI_API_KEY, or
      PDF2TAKEOFF_AI_KEY for any of them); ollama and lmstudio are local and
      need no key. --items lists the proposals; -o writes them into the PDF
      for review. Accuracy depends on the model — review before trusting.
  pdf2takeoff mcp
      Start the MCP server on stdio (for AI agents; see specs/headless-engine.md).

Everything runs locally; drawings never leave the machine (OCR fetches only
its language pack, once) — except ai-count, which sends the page you choose
to the provider you choose (or nowhere, with --provider ollama or lmstudio).
`;

export { openPdf, renderRasterNode };

// every file argument also takes an image: one page of W/3 x H/3 points
// (see image-node.ts); commands that write a PDF get the image wrapped as one
async function readMarkupsFromPdf(file: string): Promise<{ doc: Awaited<ReturnType<typeof openPdf>>; markups: Markup[] }> {
  const { doc } = await openAny(file);
  return { doc, markups: await readMarkups(doc) };
}

/** PDF or a readable image by extension (the file walkers of set and compare). */
function isDrawingFile(name: string): boolean {
  return name.toLowerCase().endsWith('.pdf') || imageKindByExt(name) !== null;
}

/** The sheet name a file stands for: its basename without the extension. */
function sheetStem(name: string): string {
  return basename(name).replace(/\.(pdf|png|jpe?g|webp|gif|bmp|avif|svg|tiff?|dxf)$/i, '');
}

async function cmdInfo(file: string): Promise<unknown> {
  const { doc } = await openAny(file);
  const markups = await readMarkups(doc);
  let other = 0;
  const pages: { page: number; widthPt: number; heightPt: number }[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const annots = await page.getAnnotations({ intent: 'display' });
    const parsed = parseMarkups(annots as unknown as AnnotationLike[], p, 0).length;
    other += annots.length - parsed;
    pages.push({ page: p, widthPt: Math.round(vp.width), heightPt: Math.round(vp.height) });
  }
  return {
    file,
    pageCount: doc.numPages,
    pages,
    annotations: { pdf2takeoff: markups.length, other },
  };
}

async function cmdScan(file: string, pageArg: string, atArg: string, allPages: boolean, modelDir?: string): Promise<unknown> {
  const page = parseInt(pageArg, 10);
  if (!Number.isInteger(page) || page < 1) throw new Error('--page must be a positive integer');
  const xy = atArg.split(',').map((v) => parseFloat(v));
  if (xy.length !== 2 || !xy.every((v) => Number.isFinite(v))) {
    throw new Error('--at must be "x,y" in PDF points');
  }
  const { doc } = await openAny(file);
  if (allPages) {
    const schedule = await scanDocAllPages(doc, { x: xy[0], y: xy[1] }, { modelDir });
    return { file, ...schedule };
  }
  const result = await scanDocAt(doc, page, { x: xy[0], y: xy[1] }, { modelDir });
  if ('error' in result) throw new Error(result.error);
  return {
    file,
    page,
    provider: result.provider,
    count: result.hits.length,
    hits: result.hits.map((h) => ({
      x: Math.round(h.x * 100) / 100,
      y: Math.round(h.y * 100) / 100,
      ...(h.label !== undefined ? { label: h.label } : {}),
    })),
  };
}

/** OCR a rendered page: words in PDF points, the scale note found, room labels by class. */
async function cmdOcr(file: string, pageArg: string, regionArg: string | undefined, rotateArg: string | undefined, thresholdArg: string | undefined): Promise<unknown> {
  const page = parseInt(pageArg, 10);
  if (!Number.isInteger(page) || page < 1) throw new Error('--page must be a positive integer');
  let region: { x0: number; y0: number; x1: number; y1: number } | undefined;
  if (regionArg) {
    const v = regionArg.split(',').map((s) => parseFloat(s));
    if (v.length !== 4 || !v.every((n) => Number.isFinite(n)) || v[2] <= 0 || v[3] <= 0) {
      throw new Error('--region must be "x,y,w,h" in PDF points (bottom-left origin)');
    }
    region = { x0: v[0], y0: v[1], x1: v[0] + v[2], y1: v[1] + v[3] };
  }
  const rotations = rotateArg ? rotateArg.split(',').map((s) => parseFloat(s)) : undefined;
  if (rotations && !rotations.every((n) => Number.isFinite(n))) throw new Error('--rotate must be degrees, e.g. 90 or 90,270');
  const threshold = thresholdArg ? parseFloat(thresholdArg) : undefined;
  if (threshold !== undefined && !(threshold > 0 && threshold < 255)) throw new Error('--threshold must be 1..254');
  const { doc } = await openAny(file);
  if (page > doc.numPages) throw new Error(`page ${page} out of range (1..${doc.numPages})`);
  const raster = await renderRasterNode(doc, page, RASTER_SCALE);
  const words = await ocrRaster(raster, { region, rotations, threshold });
  const scale = findScaleRatio(words, 'OCR');
  const rooms = countRoomsByClass(words);
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    file,
    page,
    source: 'ocr',
    wordCount: words.length,
    words: words.map((w) => ({ text: w.text, conf: Math.round(w.conf), xPt: r2(w.xPt), yPt: r2(w.yPt), wPt: r2(w.wPt), hPt: r2(w.hPt) })),
    scaleRatio: scale ? { ratio: scale.ratio, source: scale.source } : null,
    rooms: rooms.counts,
    roomLabels: rooms.labels.map((l) => ({ ...l, xPt: r2(l.xPt), yPt: r2(l.yPt) })),
  };
}

/** One rendered page through a user-chosen vision model — the only command
 *  that talks to the network. The model's inventory lands as flagged item
 *  proposals replacing this page's unconfirmed ones, recounted under the
 *  chosen preset; -o writes them into a PDF for human review. */
async function cmdAiCount(
  file: string,
  o: {
    model: string;
    provider: string;
    baseUrl?: string;
    page: string;
    preset: string;
    structured: string;
    maxSide: string;
    maxTokens: string;
    timeout: string;
    items: boolean;
    out?: string;
  },
): Promise<unknown> {
  const presetDef = presetById(o.preset);
  if (!presetDef) throw new Error(`unknown counting preset "${o.preset}" — available: ${COUNT_PRESETS.map((p) => p.id).join(', ')}`);
  const providerPreset = PROVIDER_PRESETS[o.provider];
  if (!providerPreset) throw new Error(`unknown provider "${o.provider}" — available: ${Object.keys(PROVIDER_PRESETS).join(', ')}`);
  if (!['auto', 'json_schema', 'json_object', 'none'].includes(o.structured)) {
    throw new Error('--structured must be auto, json_schema, json_object or none');
  }
  const page = parseInt(o.page, 10);
  if (!Number.isInteger(page) || page < 1) throw new Error('--page must be a positive integer');
  const maxSide = parseFloat(o.maxSide);
  if (!Number.isFinite(maxSide) || maxSide <= 0) throw new Error('--max-side must be a positive number of pixels');
  const maxTokens = parseInt(o.maxTokens, 10);
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) throw new Error('--max-tokens must be a positive integer');
  const timeoutS = parseFloat(o.timeout);
  if (!Number.isFinite(timeoutS) || timeoutS <= 0) throw new Error('--timeout must be a positive number of seconds');

  const { doc, bytes } = await openAny(file);
  if (page > doc.numPages) throw new Error(`page ${page} out of range (1..${doc.numPages})`);
  const vp = (await doc.getPage(page)).getViewport({ scale: 1 });
  // the key never travels as an argument: env only
  const apiKey = process.env.PDF2TAKEOFF_AI_KEY || (providerPreset.keyEnv ? process.env[providerPreset.keyEnv] : undefined);
  if (!apiKey && !providerPreset.local && !o.baseUrl) {
    throw new Error(`no API key: set ${providerPreset.keyEnv} (or PDF2TAKEOFF_AI_KEY)`);
  }

  // fit the sheet into max-side, capped at the renderer's scale limit
  const scale = Math.min(4, maxSide / Math.max(vp.width, vp.height));
  const { png, widthPx, heightPx } = await renderPagePng(doc, page, scale);
  const run = await runInventory(
    presetConfig(o.provider, {
      model: o.model,
      apiKey,
      baseUrl: o.baseUrl,
      structured: o.structured as ProviderConfig['structured'],
      timeoutMs: timeoutS * 1000,
    }),
    { base64: png.toString('base64'), mime: 'image/png' },
    { widthPt: vp.width, heightPt: vp.height },
    { maxTokens },
  );

  // the model's proposals replace this page's unconfirmed ones, like a
  // propose_items replace:true round trip; confirmed items stay
  const existing = await readMarkups(doc);
  const kept = existing.filter((m) => !(m.page === page && m.item && m.status === 'check'));
  const proposals = proposalMarkups(run.items, page, 'model', () => nextId('ai'));
  const all = [...kept, ...proposals];
  const counted = countItems(
    all.filter((m) => m.page === page),
    presetDef,
  );
  if (o.out) {
    writeFileSync(o.out, await buildAnnotatedPdf({ bytes, markups: all, calibrations: new Map(), displayUnit: 'm' }));
  }
  return {
    file,
    page,
    provider: o.provider,
    model: run.result.model,
    structured: run.result.structured,
    latencyMs: run.result.latencyMs,
    usage: run.result.usage,
    preset: o.preset,
    counts: counted.counts,
    unconfirmed: counted.unconfirmed,
    items: run.items.length,
    byKind: {
      Door: run.items.filter((i) => i.kind === 'Door').length,
      Window: run.items.filter((i) => i.kind === 'Window').length,
      Space: run.items.filter((i) => i.kind === 'Space').length,
    },
    modelCounts: run.inventory.counts,
    imagePx: [widthPx, heightPx],
    ...(o.items ? { proposals: run.items } : {}),
    ...(o.out ? { output: o.out } : {}),
  };
}

async function cmdCompare(fileA: string, fileB: string, png: string | undefined, pngDir: string | undefined, threshold: number): Promise<unknown> {
  // directory pair -> batch compare across the two revision folders
  const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };
  if (isDir(fileA) || isDir(fileB)) {
    if (!isDir(fileA) || !isDir(fileB)) {
      throw new Error('folder compare needs two directories (got one file, one folder)');
    }
    if (pngDir) mkdirSync(pngDir, { recursive: true });
    return await compareFolders(fileA, fileB, { pngDir, threshold });
  }
  const { doc: docA } = await openAny(fileA);
  const { doc: docB } = await openAny(fileB);
  const result = await compareDocs(docA, docB, { png, threshold });
  return {
    a: fileA,
    b: fileB,
    sheetCountA: docA.numPages,
    sheetCountB: docB.numPages,
    ...result,
  };
}

async function cmdExport(
  file: string,
  scale: string | undefined,
  unit: string,
  format: 'csv' | 'tsv' | 'xlsx',
  out: string | undefined,
): Promise<void> {
  const { doc, markups } = await readMarkupsFromPdf(file);
  if (markups.length === 0) {
    throw new Error(`no pdf2takeoff annotations found in ${file} (annotate it first, or open it in the web app)`);
  }
  const calibrations = new Map<number, Calibration>();
  if (scale) {
    const metersPerPt = parseScaleSpec(scale);
    for (let p = 1; p <= doc.numPages; p++) calibrations.set(p, { metersPerPt, source: `cli scale ${scale}` });
  } else {
    process.stderr.write('note: no --scale given; values will be blank until calibrated\n');
  }
  const matrix = buildMatrix({
    markups,
    calibrations,
    displayUnit: unit as DisplayUnit,
  });

  if (format === 'xlsx') {
    if (!out) throw new Error('--format xlsx requires -o <file.xlsx>');
    writeFileSync(out, await xlsxBytes(matrix));
    process.stderr.write(`wrote ${out} (${markups.length} markups)\n`);
    return;
  }
  const text = toDelimited(matrix, format === 'csv' ? ',' : '\t');
  if (out) {
    // UTF-8 BOM so Excel opens the units correctly
    writeFileSync(out, '\ufeff' + text);
    process.stderr.write(`wrote ${out} (${markups.length} markups)\n`);
  } else {
    process.stdout.write(text + '\n');
  }
}

async function cmdAnnotate(file: string, specPath: string, outOverride: string | undefined, keepExisting = false): Promise<unknown> {
  const spec = parseSpec(readFileSync(specPath, 'utf8'), specPath);
  const output = outOverride ?? spec.output;
  if (!output) throw new Error('no output path: pass -o out.pdf or set "output" in the spec');

  // an image comes back wrapped as a one-page PDF, so the writer has real PDF bytes
  const { doc, bytes: source } = await openAny(file);
  const calibrations = new Map<number, Calibration>();
  if (spec.scale) {
    const metersPerPt = parseScaleSpec(spec.scale);
    for (let p = 1; p <= doc.numPages; p++) calibrations.set(p, { metersPerPt, source: `spec scale ${spec.scale}` });
  }

  const markups: Markup[] = spec.markups.map((m) => ({
    id: nextId('cli'),
    page: m.page ?? 1,
    type: m.type,
    label: m.label ?? defaultLabel(m.type),
    points: m.points.map(([x, y]) => ({ x, y })),
    createdAt: Date.now(),
  }));
  // the writer replaces our earlier annotations, so carry them over to keep them
  const existing = keepExisting ? await readMarkups(doc) : [];

  const bytes = await buildAnnotatedPdf({
    bytes: source,
    markups: [...existing, ...markups],
    calibrations,
    displayUnit: (spec.unit ?? 'm') as DisplayUnit,
  });
  writeFileSync(output, bytes);
  return { output, markups: markups.length, kept: existing.length, scale: spec.scale ?? null };
}

/** Execute a takeoff spec: calibrate, scan-count each symbol type, write exports. */
async function cmdRun(specPath: string, prevPath: string | undefined): Promise<unknown> {
  const spec = parseRunSpec(readFileSync(specPath, 'utf8'), specPath);
  // PDF, or an image wrapped as a one-page PDF for the annotated-pdf export
  const { doc, bytes } = await openAny(spec.source);
  const calibrations = new Map<number, Calibration>();
  if (spec.scale) {
    const metersPerPt = parseScaleSpec(spec.scale);
    for (let p = 1; p <= doc.numPages; p++) calibrations.set(p, { metersPerPt, source: `spec scale ${spec.scale}` });
  }
  const markups: Markup[] = [];

  for (const c of spec.counts) {
    const page = c.page ?? 1;
    const result = await scanDocAt(doc, page, { x: c.at[0], y: c.at[1] });
    if ('error' in result) {
      throw new Error(`counts "${c.label}": ${result.error} (tune its at: point — run scan --json once to find the symbol)`);
    }
    if (result.hits.length === 0) throw new Error(`counts "${c.label}": the scan found no symbols`);
    for (const hit of result.hits) {
      markups.push({
        id: nextId('run'),
        page,
        type: 'count',
        label: c.label,
        points: [{ x: hit.x, y: hit.y }],
        createdAt: Date.now(),
      });
    }
  }

  const unit = (spec.unit ?? 'm') as DisplayUnit;
  const matrix = buildMatrix({ markups, calibrations, displayUnit: unit });
  const totals = groupsOf(markups).map((g) => ({
    label: g.label,
    type: g.type,
    items: g.items.length,
  }));

  const summary: Record<string, unknown> = {
    spec: specPath,
    source: spec.source,
    scale: spec.scale ?? null,
    ranAt: new Date().toISOString(),
    totals,
    counts: spec.counts.map((c) => ({
      label: c.label,
      page: c.page ?? 1,
      found: markups.filter((m) => m.label === c.label).length,
    })),
  };

  // --prev: quantity diff against a previous run's summary
  if (prevPath) {
    const prev = JSON.parse(readFileSync(prevPath, 'utf8')) as { totals?: { label: string; type: string; items: number }[] };
    const key = (x: { label: string; type: string }) => `${x.type}|${x.label}`;
    const prevMap = new Map((prev.totals ?? []).map((x) => [key(x), x.items]));
    const nowMap = new Map(totals.map((x) => [key(x), x.items]));
    const diff: { label: string; type: string; before: number | null; after: number | null; delta: number }[] = [];
    for (const k of new Set([...prevMap.keys(), ...nowMap.keys()])) {
      const before = prevMap.get(k) ?? null;
      const after = nowMap.get(k) ?? null;
      if (before === after) continue;
      const [type, label] = k.split('|');
      diff.push({ label, type, before, after, delta: (after ?? 0) - (before ?? 0) });
    }
    diff.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    summary.diff = diff;
  }

  for (const e of spec.exports) {
    if (e.format === 'csv') writeFileSync(e.out, '\ufeff' + toDelimited(matrix, ','));
    else if (e.format === 'xlsx') writeFileSync(e.out, await xlsxBytes(matrix));
    else if (e.format === 'annotated-pdf') {
      writeFileSync(e.out, await buildAnnotatedPdf({ bytes, markups, calibrations, displayUnit: unit }));
    } else if (e.format === 'summary') {
      writeFileSync(e.out, JSON.stringify(summary, null, 2) + '\n');
    }
  }

  return summary;
}

export async function run(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === undefined || cmd === 'help' || cmd === '--help' || cmd === '-h') {
      process.stdout.write(HELP);
      return;
    }
    if (cmd === 'info') {
      const { positionals } = parseArgs({ args: rest, allowPositionals: true });
      if (positionals.length !== 1) throw new Error('usage: pdf2takeoff info <file.pdf>');
      process.stdout.write(JSON.stringify(await cmdInfo(positionals[0]), null, 2) + '\n');
      return;
    }
    if (cmd === 'scan') {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { page: { type: 'string', default: '1' }, at: { type: 'string' }, 'all-pages': { type: 'boolean', default: false }, model: { type: 'string' } },
      });
      if (positionals.length !== 1 || !values.at) throw new Error('usage: pdf2takeoff scan <file.pdf> --page N --at x,y [--all-pages] [--model dir]');
      process.stdout.write(JSON.stringify(await cmdScan(positionals[0], values.page, values.at, values['all-pages'], values.model), null, 2) + '\n');
      return;
    }
    if (cmd === 'compare') {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { png: { type: 'string' }, 'png-dir': { type: 'string' }, threshold: { type: 'string', default: '24' } },
      });
      if (positionals.length !== 2) throw new Error('usage: pdf2takeoff compare <a> <b> (files or folders) [--png out.png] [--png-dir out/]');
      const threshold = parseFloat(values.threshold);
      if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 255) throw new Error('--threshold must be 1..255');
      process.stdout.write(
        JSON.stringify(await cmdCompare(positionals[0], positionals[1], values.png, values['png-dir'], threshold), null, 2) + '\n',
      );
      return;
    }
    if (cmd === 'export') {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          scale: { type: 'string' },
          unit: { type: 'string', default: 'm' },
          format: { type: 'string', default: 'csv' },
          o: { type: 'string' },
        },
      });
      if (positionals.length !== 1) throw new Error('usage: pdf2takeoff export <file.pdf> [--scale 1:100] [--format csv|tsv|xlsx] [-o out]');
      if (!['csv', 'tsv', 'xlsx'].includes(values.format)) throw new Error('--format must be csv, tsv or xlsx');
      await cmdExport(positionals[0], values.scale, values.unit, values.format as 'csv' | 'tsv' | 'xlsx', values.o);
      return;
    }
    if (cmd === 'annotate') {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { spec: { type: 'string' }, o: { type: 'string' }, 'keep-existing': { type: 'boolean' } },
      });
      if (positionals.length !== 1 || !values.spec) throw new Error('usage: pdf2takeoff annotate <file.pdf> --spec takeoff.yaml [-o out.pdf] [--keep-existing]');
      process.stdout.write(JSON.stringify(await cmdAnnotate(positionals[0], values.spec, values.o, values['keep-existing'] ?? false), null, 2) + '\n');
      return;
    }
    if (cmd === 'set') {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { o: { type: 'string' } },
      });
      if (positionals.length !== 1 || !values.o) throw new Error('usage: pdf2takeoff set <folder> -o current-issue.pdf');
      process.stdout.write(JSON.stringify(await cmdSet(positionals[0], values.o), null, 2) + '\n');
      return;
    }
    if (cmd === 'run') {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { prev: { type: 'string' } },
      });
      if (positionals.length !== 1) throw new Error('usage: pdf2takeoff run <takeoff.yaml> [--prev previous-summary.json]');
      process.stdout.write(JSON.stringify(await cmdRun(positionals[0], values.prev), null, 2) + '\n');
      return;
    }
    if (cmd === 'ocr') {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { page: { type: 'string', default: '1' }, region: { type: 'string' }, rotate: { type: 'string' }, threshold: { type: 'string' } },
      });
      if (positionals.length !== 1) throw new Error('usage: pdf2takeoff ocr <file.pdf> --page N [--region x,y,w,h] [--rotate 90] [--threshold 190]');
      try {
        process.stdout.write(JSON.stringify(await cmdOcr(positionals[0], values.page, values.region, values.rotate, values.threshold), null, 2) + '\n');
      } finally {
        await terminateOcr(); // the recogniser's worker thread would otherwise keep the process alive
      }
      return;
    }
    if (cmd === 'ai-count') {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          model: { type: 'string' },
          provider: { type: 'string', default: 'openrouter' },
          'base-url': { type: 'string' },
          page: { type: 'string', default: '1' },
          preset: { type: 'string', default: 'aecv' },
          structured: { type: 'string', default: 'auto' },
          'max-side': { type: 'string', default: '2048' },
          'max-tokens': { type: 'string', default: '16000' },
          timeout: { type: 'string', default: '300' },
          items: { type: 'boolean', default: false },
          o: { type: 'string' },
        },
      });
      if (positionals.length !== 1 || !values.model) {
        throw new Error(
          'usage: pdf2takeoff ai-count <file.pdf> --model MODEL [--provider openrouter|openai|gemini|zai|ollama|lmstudio] [--base-url URL] [--page N] [--preset aecv|schedule] [--structured auto|json_schema|json_object|none] [--max-side 2048] [--max-tokens 16000] [--timeout 300] [--items] [-o out.pdf]',
        );
      }
      process.stdout.write(
        JSON.stringify(
          await cmdAiCount(positionals[0], {
            model: values.model,
            provider: values.provider,
            baseUrl: values['base-url'],
            page: values.page,
            preset: values.preset,
            structured: values.structured,
            maxSide: values['max-side'],
            maxTokens: values['max-tokens'],
            timeout: values.timeout,
            items: values.items,
            out: values.o,
          }),
          null,
          2,
        ) + '\n',
      );
      return;
    }
    if (cmd === 'mcp') {
      const { runMcpServer } = await import('./mcp.ts');
      await runMcpServer();
      return;
    }
    throw new Error(`unknown command "${cmd}" — run "pdf2takeoff help"`);
  } catch (err) {
    process.stderr.write(`pdf2takeoff: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}

/** Slip-sheet a folder of per-sheet PDFs (and PNG / JPG scans) into one
 *  current-issue set: sheets pair by file stem, the newest file (mtime)
 *  wins, output is sorted; an image becomes a page of its pixels / 3 points. */
async function cmdSet(dir: string, out: string): Promise<unknown> {
  const byBase = new Map<string, { file: string; mtime: number }>();
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (isDrawingFile(entry.name)) {
        const mtime = statSync(full).mtimeMs;
        const key = sheetStem(entry.name);
        const prev = byBase.get(key);
        if (!prev || mtime > prev.mtime) byBase.set(key, { file: full, mtime });
      }
    }
  };
  walk(dir);
  if (byBase.size === 0) throw new Error(`no PDFs or images found under ${dir}`);
  const merged = await PDFDocument.create();
  merged.setProducer('pdf2takeoff 0.1.0');
  const sheets: { sheet: string; from: string; superseded: number }[] = [];
  for (const sheet of [...byBase.keys()].sort()) {
    const { file } = byBase.get(sheet)!;
    const raw = new Uint8Array(readFileSync(file));
    const kind = sniffImage(raw) ?? imageKindByExt(file);
    const src = await PDFDocument.load(kind ? await imageToPdf(raw, kind) : raw);
    const count = await merged.copyPages(src, src.getPageIndices());
    for (const page of count) merged.addPage(page);
    // count how many files shared this sheet name (superseded = losers)
    let dupes = 0;
    const recount = (d: string) => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const full = join(d, entry.name);
        if (entry.isDirectory()) recount(full);
        else if (isDrawingFile(entry.name) && sheetStem(entry.name) === sheet && full !== file) dupes++;
      }
    };
    recount(dir);
    sheets.push({ sheet, from: file, superseded: dupes });
  }
  writeFileSync(out, await merged.save());
  return {
    dir,
    output: out,
    sheets: sheets.length,
    supersededFiles: sheets.reduce((s, x) => s + x.superseded, 0),
    sheetsDetail: sheets,
  };
}

// direct invocation (node --experimental-strip-types src/headless/cli.ts …)
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void run(process.argv.slice(2));
}
