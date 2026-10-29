#!/usr/bin/env node
// Runs the browser suites against the built site: serves dist/ with
// `vite preview` on a free port, runs each suite in turn, then stops the
// server. `npm run test:e2e` builds first. Pass suite names to run some:
// node e2e/run.mjs app template. Screenshots land in $E2E_SHOTS (default
// a p2t-e2e folder in the temp dir).

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SUITES = ['app', 'template', 'nudge'];
const pick = process.argv.slice(2);
const suites = pick.length ? SUITES.filter((s) => pick.includes(s)) : SUITES;
const shots = process.env.E2E_SHOTS || join(tmpdir(), 'p2t-e2e');
if (!existsSync('dist/index.html')) {
  console.error('dist/ is missing: run `npm run build` (or `npm run test:e2e`) first');
  process.exit(1);
}

const port = await new Promise((r) => {
  const s = createServer().listen(0, () => {
    const p = s.address().port;
    s.close(() => r(p));
  });
});
const url = `http://localhost:${port}/`;
const server = spawn('npx', ['vite', 'preview', '--port', String(port), '--strictPort'], { stdio: 'ignore', detached: true });
const stop = () => {
  try {
    process.kill(-server.pid, 'SIGKILL');
  } catch {}
};
process.on('exit', stop);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130));

let up = false;
for (let i = 0; i < 120 && !up; i++) {
  try {
    up = (await fetch(url)).ok;
  } catch {}
  if (!up) await new Promise((r) => setTimeout(r, 250));
}
if (!up) {
  console.error(`vite preview did not come up on ${url}`);
  process.exit(1);
}

const failed = [];
for (const s of suites) {
  console.log(`\n== ${s}`);
  const code = await new Promise((r) => spawn(process.execPath, [`e2e/${s}.mjs`, url, join(shots, s)], { stdio: 'inherit' }).on('exit', r));
  if (code !== 0) failed.push(s);
}
console.log(failed.length ? `\nFAIL: ${failed.join(', ')} (screenshots in ${shots})` : `\nPASS: ${suites.length} browser suites`);
process.exit(failed.length ? 1 : 0);
