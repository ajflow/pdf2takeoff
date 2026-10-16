#!/usr/bin/env node
// Golden raster check (H2): render a page with the Node raster adapter at a
// fixed scale and write a PNG. Compare against the browser's render of the
// same page (same pdf.js version, same scale) — see specs/headless-engine.md
// for the recorded tolerance numbers and the in-browser comparison recipe.

import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const args = process.argv.slice(2);
if (args.length < 2 || args.length > 3) {
  console.error('usage: node scripts/golden-raster.mjs <file.pdf> <out.png> [page=1]');
  process.exit(1);
}
const [pdf, out, pageArg] = args;
const page = parseInt(pageArg ?? '1', 10);
const SCALE = 3;

// renderRasterNode is exported from the CLI entry; run it through type
// stripping like the bin shim does
const script = `
import { readFileSync, writeFileSync } from 'node:fs';
import { openPdf, renderRasterNode } from '${join(root, 'src/headless/cli.ts')}';
import { createCanvas } from '@napi-rs/canvas';
const doc = await openPdf(new Uint8Array(readFileSync('${pdf}')));
const r = await renderRasterNode(doc, ${page}, ${SCALE});
const cnv = createCanvas(r.width, r.height);
const ctx = cnv.getContext('2d');
const img = ctx.createImageData(r.width, r.height);
img.data.set(r.data);
ctx.putImageData(img, 0, 0);
writeFileSync('${out}', cnv.toBuffer('image/png'));
console.log(JSON.stringify({ width: r.width, height: r.height, scale: ${SCALE} }));
`;
const result = spawnSync(
  process.execPath,
  ['--experimental-strip-types', '--input-type=module', '-e', script],
  { cwd: root, encoding: 'utf8' },
);
const stdout = result.stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop();
if (result.status !== 0 || !stdout) {
  console.error('render failed:', result.stderr);
  process.exit(1);
}
console.log(stdout, '→', out);
