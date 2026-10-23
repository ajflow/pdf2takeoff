#!/usr/bin/env node
// Runs the engine check scripts concurrently, capped at the machine's
// parallelism, and prints each script's output whole, in the order given on
// the command line (the same order typecheck:engine used to run them in).
// Exits 1 when any script fails, naming it.

import { spawn } from 'node:child_process';
import os from 'node:os';

const scripts = process.argv.slice(2);
if (!scripts.length) {
  console.error('usage: node scripts/run-checks.mjs <scripts/check-*.mjs> ...');
  process.exit(2);
}

// each script runs the way typecheck:engine ran it
const runOne = (script) =>
  new Promise((resolve) => {
    const t0 = performance.now();
    const p = spawn(process.execPath, ['--experimental-strip-types', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = Buffer.alloc(0);
    let err = Buffer.alloc(0);
    p.stdout.on('data', (c) => { out = Buffer.concat([out, c]); });
    p.stderr.on('data', (c) => { err = Buffer.concat([err, c]); });
    p.on('close', (code) => resolve({ script, code, out, err, ms: performance.now() - t0 }));
  });

// one worker per core at most; each takes the next script off the list
const results = new Array(scripts.length);
let next = 0;
const limit = Math.min(os.availableParallelism(), scripts.length);
await Promise.all(
  Array.from({ length: limit }, async () => {
    while (next < scripts.length) {
      const i = next++;
      results[i] = await runOne(scripts[i]);
    }
  }),
);

const failed = [];
for (const r of results) {
  if (r.out.length) process.stdout.write(r.out);
  if (r.err.length) process.stderr.write(r.err);
  if (r.code !== 0) failed.push(`${r.script} (exit ${r.code}, ${(r.ms / 1000).toFixed(1)}s)`);
}
if (failed.length) {
  console.error(`FAIL: ${failed.length} of ${scripts.length} check script(s): ${failed.join(', ')}`);
  process.exit(1);
}
console.log(`PASS: ${scripts.length} check scripts`);
