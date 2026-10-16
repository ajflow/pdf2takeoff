#!/usr/bin/env node
// pdf2takeoff CLI shim — runs the TypeScript entry directly via Node's
// native type stripping (Node >= 22.6; no bundler, no build step).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const entry = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'headless', 'cli.ts');
const result = spawnSync(
  process.execPath,
  ['--experimental-strip-types', entry, ...process.argv.slice(2)],
  { stdio: 'inherit' },
);
process.exit(result.status ?? 1);
