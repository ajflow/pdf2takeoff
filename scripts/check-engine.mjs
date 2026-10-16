#!/usr/bin/env node
// Guard: src/engine must stay environment-agnostic. Fails CI when an engine
// file imports renderer/bundler/DOM specifics or reaches outside engine/.
// (Type-checking with the no-DOM lib in src/engine/tsconfig.json is the
// first gate; this is the second.)

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'engine');

const FORBIDDEN = [
  [/\bfrom\s+['"][^'"]*pdfjs/, 'pdfjs import'],
  [/\bfrom\s+['"][^'"]*onnxruntime/, 'onnxruntime import'],
  [/\bfrom\s+['"]\.\.\//, 'import outside engine/'],
  [/import\.meta/, 'import.meta (bundler-specific)'],
  [/\bdocument\b/, 'DOM document'],
  [/\bwindow\b/, 'DOM window'],
  [/\bImageData\b/, 'DOM ImageData type'],
  [/HTMLCanvasElement|HTMLElement|HTMLImageElement|HTMLInputElement|CanvasRenderingContext2D|SVGSVGElement/, 'DOM element type'],
  [/\bindexedDB\b/, 'IndexedDB'],
  [/\bnavigator\b/, 'DOM navigator'],
  [/\bfetch\s*\(/, 'network fetch'],
  [/\bURL\b/, 'URL (DOM/Node global)'],
];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const violations = [];
for (const file of walk(root)) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const [pattern, why] of FORBIDDEN) {
      if (pattern.test(line)) {
        violations.push(`${file.replace(root + '/', '')}:${i + 1} ${why}: ${line.trim()}`);
      }
    }
  });
}

if (violations.length) {
  console.error('engine purity violations:');
  for (const v of violations) console.error('  ' + v);
  process.exit(1);
}
console.log('engine purity OK: no DOM/bundler/renderer imports under src/engine');
