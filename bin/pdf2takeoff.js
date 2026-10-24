#!/usr/bin/env node
// pdf2takeoff CLI shim. Prefers the compiled entry (dist-node/): an installed
// package can't run the TypeScript sources (Node refuses to strip types under
// node_modules), so npm installs ship the tsc build. A development checkout
// without a build still runs the sources via Node's native type stripping
// (Node >= 22.6; no bundler, no build step).
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const compiled = join(here, '..', 'dist-node', 'headless', 'cli.js');

if (existsSync(compiled)) {
  const { run } = await import(pathToFileURL(compiled).href);
  await run(argv);
} else {
  const entry = join(here, '..', 'src', 'headless', 'cli.ts');
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', entry, ...argv],
    { stdio: 'inherit' },
  );
  process.exit(result.status ?? 1);
}
