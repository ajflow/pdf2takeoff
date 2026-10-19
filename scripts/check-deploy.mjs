#!/usr/bin/env node
// Guard: keep the Cloudflare Pages deployment inside the free tier. Fails CI
// when the built site would break a Pages free limit, or when something
// billable (server-side code / bindings / committed model binaries) sneaks
// into the repo. The limits and the stay-static rule live in
// docs/hosting-cost-controls.md — update both together, on purpose.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Cloudflare Pages free plan: 20,000 files per site, 25 MiB per asset,
// 500 builds/month. Static requests and bandwidth are unlimited.
const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const errors = [];
const dist = join(root, 'dist');
if (!existsSync(dist)) {
  console.error('deploy guard: dist/ not found — run `npm run build` first');
  process.exit(1);
}

const files = walk(dist);
if (files.length > MAX_FILES) {
  errors.push(`dist/ has ${files.length} files (Pages free limit: ${MAX_FILES})`);
}

let total = 0;
let biggest = ['', 0];
for (const file of files) {
  const size = statSync(file).size;
  total += size;
  if (size > biggest[1]) biggest = [relative(dist, file), size];
  if (size > MAX_FILE_BYTES) {
    errors.push(
      `${relative(root, file)} is ${(size / 1024 / 1024).toFixed(1)} MiB (Pages limit: 25 MiB per asset)`,
    );
  }
  if (file.endsWith('.onnx')) {
    errors.push(
      `${relative(root, file)}: model binaries ship from the model branch, not Pages (point the manifest's "model" at its raw.githubusercontent.com URL — see public/models/README.md)`,
    );
  }
}

// Server-side Cloudflare resources are the billable path. Adding any of these
// is a deliberate architecture decision (see docs/hosting-cost-controls.md),
// not something that should land quietly in a feature PR.
for (const dir of ['functions', 'public/functions']) {
  if (existsSync(join(root, dir))) {
    errors.push(`${dir}/ exists — Pages Functions are metered; see docs/hosting-cost-controls.md`);
  }
}
for (const name of ['wrangler.toml', 'wrangler.json', 'wrangler.jsonc']) {
  if (existsSync(join(root, name))) {
    errors.push(`${name} exists — Workers/R2/D1/KV bindings are metered; see docs/hosting-cost-controls.md`);
  }
}

const modelsDir = join(root, 'public', 'models');
if (existsSync(modelsDir)) {
  for (const file of walk(modelsDir)) {
    if (file.endsWith('.onnx')) {
      errors.push(
        `${relative(root, file)} is gitignored for a reason: it would ship in every deploy — models live on the model branch`,
      );
    }
  }
}

if (errors.length) {
  console.error('deploy guard violations:');
  for (const e of errors) console.error('  ' + e);
  process.exit(1);
}
console.log(
  `deploy guard OK: ${files.length} files, ${(total / 1024 / 1024).toFixed(1)} MiB total, ` +
    `largest ${biggest[0]} (${(biggest[1] / 1024 / 1024).toFixed(1)} MiB) — inside Pages free limits`,
);
