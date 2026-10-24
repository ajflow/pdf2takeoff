#!/usr/bin/env node
// Guard: what `npm pack` would ship stays exactly the runnable package —
// the compiled Node entry (dist-node/), the bin shim, the licence and the
// README. Fails CI when a packed path falls outside that set, when a .ts
// source sneaks in (the installed package must not need type stripping), or
// when the unpacked size exceeds 15 MB. Also proves the compiled entry runs
// by taking `info` through bin/pdf2takeoff.js.

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const MAX_UNPACKED_BYTES = 15 * 1024 * 1024;
// every path the tarball may contain (top level; paths under dist-node/ and
// bin/ carry the folder prefix)
const ALLOWED = new Set(['bin/', 'dist-node/', 'README.md', 'LICENSE', 'NOTICE', 'package.json']);
// package.json is rewritten by npm (files map etc.) but must stay the real one
const ALLOWED_PREFIXES = ['bin/', 'dist-node/'];

const errors = [];

// 1. the compiled entry, exactly as prepack builds it
const build = spawnSync('npm', ['run', 'build:node'], { cwd: root, stdio: 'inherit' });
if (build.status !== 0) {
  console.error('pack guard: npm run build:node failed');
  process.exit(1);
}

// 2. the tarball contents (prepack runs build:node again; harmless)
const pack = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8' });
if (pack.status !== 0) {
  console.error('pack guard: npm pack --dry-run failed');
  process.stderr.write(pack.stderr);
  process.exit(1);
}
const [tarball] = JSON.parse(pack.stdout);
const files = tarball.files.map((f) => f.path);
for (const path of files) {
  const ok = ALLOWED.has(path) || ALLOWED_PREFIXES.some((p) => path.startsWith(p));
  if (!ok) errors.push(`packed path outside bin/, dist-node/, README.md, LICENSE, NOTICE, package.json: ${path}`);
  if (path.endsWith('.ts') || path.endsWith('.mts') || path.endsWith('.cts')) errors.push(`TypeScript source packed: ${path}`);
}
if (tarball.unpackedSize > MAX_UNPACKED_BYTES) {
  errors.push(`unpacked size ${(tarball.unpackedSize / 1024 / 1024).toFixed(1)} MB exceeds the ${MAX_UNPACKED_BYTES / 1024 / 1024} MB budget`);
}

// 3. the compiled path actually runs, through the bin, like an installed user would
const info = spawnSync(process.execPath, ['bin/pdf2takeoff.js', 'info', 'public/examples/sample-floor-plan.pdf'], {
  cwd: root,
  encoding: 'utf8',
});
if (info.status !== 0) {
  errors.push(`bin/pdf2takeoff.js info failed (exit ${info.status}): ${info.stderr.slice(0, 400)}`);
} else {
  let parsed;
  try {
    parsed = JSON.parse(info.stdout);
  } catch {
    parsed = null;
  }
  if (!parsed || parsed.pageCount !== 2) errors.push(`info on the compiled entry did not report 2 pages: ${info.stdout.slice(0, 200)}`);
}

if (errors.length) {
  console.error('pack guard violations:');
  for (const e of errors) console.error('  ' + e);
  process.exit(1);
}
console.log(
  `pack guard OK: ${files.length} files, ` +
    `${(tarball.size / 1024).toFixed(0)} KB packed, ${(tarball.unpackedSize / 1024 / 1024).toFixed(1)} MB unpacked, ` +
    'compiled entry runs via the bin',
);
