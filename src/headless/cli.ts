// pdf2takeoff CLI — headless takeoff on Node. Local-only: no network calls,
// no telemetry. Deterministic JSON on stdout; errors on stderr with exit 1.

import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { openPdf } from './pdfjs-node.ts';
import { renderRasterNode } from './raster-node.ts';
import { readMarkups, scanDocAt, compareDocs, compareFolders } from './ops.ts';
import { statSync, mkdirSync } from 'node:fs';
import { parseMarkups, type AnnotationLike } from '../engine/read.ts';
import { buildAnnotatedPdf } from '../engine/annotate.ts';
import { buildMatrix, toDelimited, xlsxBytes } from '../engine/export.ts';
import { nextId, defaultLabel } from '../engine/geometry.ts';
import type { DisplayUnit } from '../engine/units.ts';
import type { Calibration, Markup } from '../engine/types.ts';
import { parseSpec, parseScaleSpec } from './spec.ts';

const HELP = `pdf2takeoff — free, open-source PDF takeoff (Apache-2.0)

Usage:
  pdf2takeoff info <file.pdf>
      Pages, page sizes, and annotation counts as JSON.
  pdf2takeoff compare <a> <b> [--png out.png] [--png-dir dir] [--threshold 24]
      Two PDFs: per-sheet change fractions and changed regions.
      Two folders: batch compare — sheets paired by filename across the
      revision sets, with added/removed sheets listed. --png writes the
      overlay of the first changed sheet; --png-dir (folder mode) writes
      an overlay per changed pair.
  pdf2takeoff scan <file.pdf> --page N --at x,y
      Click-point auto-count (tier-1 CV): every match on the page as JSON.
      --at is in PDF points; run "info" first to see page sizes.
  pdf2takeoff export <file.pdf> [--scale 1:100] [--unit m] [--format csv|tsv|xlsx] [-o out]
      Read pdf2takeoff annotations back out as a quantities table.
      csv/tsv print to stdout without -o; xlsx requires -o.
  pdf2takeoff annotate <file.pdf> --spec takeoff.yaml [-o out.pdf]
      Write spec-defined markups into the PDF as standard annotations.
  pdf2takeoff mcp
      Start the MCP server on stdio (for AI agents; see specs/headless-engine.md).

Everything runs locally; drawings never leave the machine.
`;

export { openPdf, renderRasterNode };

function readPdf(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path));
}

async function readMarkupsFromPdf(file: string): Promise<{ doc: Awaited<ReturnType<typeof openPdf>>; markups: Markup[] }> {
  const doc = await openPdf(readPdf(file));
  return { doc, markups: await readMarkups(doc) };
}

async function cmdInfo(file: string): Promise<unknown> {
  const doc = await openPdf(readPdf(file));
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

async function cmdScan(file: string, pageArg: string, atArg: string): Promise<unknown> {
  const page = parseInt(pageArg, 10);
  if (!Number.isInteger(page) || page < 1) throw new Error('--page must be a positive integer');
  const xy = atArg.split(',').map((v) => parseFloat(v));
  if (xy.length !== 2 || !xy.every((v) => Number.isFinite(v))) {
    throw new Error('--at must be "x,y" in PDF points');
  }
  const doc = await openPdf(readPdf(file));
  const result = await scanDocAt(doc, page, { x: xy[0], y: xy[1] });
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
  const docA = await openPdf(readPdf(fileA));
  const docB = await openPdf(readPdf(fileB));
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
    writeFileSync(out, xlsxBytes(matrix));
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

async function cmdAnnotate(file: string, specPath: string, outOverride: string | undefined): Promise<unknown> {
  const spec = parseSpec(readFileSync(specPath, 'utf8'), specPath);
  const output = outOverride ?? spec.output;
  if (!output) throw new Error('no output path: pass -o out.pdf or set "output" in the spec');

  const calibrations = new Map<number, Calibration>();
  if (spec.scale) {
    const metersPerPt = parseScaleSpec(spec.scale);
    const doc = await openPdf(readPdf(file));
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

  const bytes = await buildAnnotatedPdf({
    bytes: readPdf(file),
    markups,
    calibrations,
    displayUnit: (spec.unit ?? 'm') as DisplayUnit,
  });
  writeFileSync(output, bytes);
  return { output, markups: markups.length, scale: spec.scale ?? null };
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
        options: { page: { type: 'string', default: '1' }, at: { type: 'string' } },
      });
      if (positionals.length !== 1 || !values.at) throw new Error('usage: pdf2takeoff scan <file.pdf> --page N --at x,y');
      process.stdout.write(JSON.stringify(await cmdScan(positionals[0], values.page, values.at), null, 2) + '\n');
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
        options: { spec: { type: 'string' }, o: { type: 'string' } },
      });
      if (positionals.length !== 1 || !values.spec) throw new Error('usage: pdf2takeoff annotate <file.pdf> --spec takeoff.yaml [-o out.pdf]');
      process.stdout.write(JSON.stringify(await cmdAnnotate(positionals[0], values.spec, values.o), null, 2) + '\n');
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

// direct invocation (node --experimental-strip-types src/headless/cli.ts …)
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void run(process.argv.slice(2));
}
