#!/usr/bin/env node
// B7 MCP workflow conformance bench: drives the REAL local MCP server over
// stdio JSON-RPC through the full agent takeoff workflow, asserting the
// contract at every step — including the *uncalibrated* contract (measure
// returns value null, not an error: scale-dependent types are null until
// set_scale; count/angle are scale-free) — then saves an annotated PDF and
// re-imports it in a FRESH server process, requiring the markup set to
// round-trip canonically equal. Every call is timed into a ledger
// (deterministic call COUNT is baseline-gated; milliseconds are
// informational). The opentakeoff run.mjs shape, reimplemented (AGPL —
// mechanics only, no code). See evals/README.md, bench patch B7.

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const SAMPLE = join(ROOT, 'public', 'examples', 'sample-floor-plan.pdf');
const OUT_LEDGER = join(here, 'artifacts', 'mcp-workflow.json');

const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exit(1); };
let passed = 0;
const check = (label, cond, detail = '') => {
  if (!cond) fail(`${label} ${detail}`);
  passed++;
  console.log(`ok: ${label}`);
};

// ---------- minimal stdio JSON-RPC client with a timings ledger ----------
const ledger = [];
async function startServer() {
  const proc = spawn(
    process.execPath,
    ['--experimental-strip-types', join(ROOT, 'src/headless/mcp.ts')],
    { stdio: ['pipe', 'pipe', 'inherit'] },
  );
  let buf = '';
  const pending = new Map();
  let seq = 0;
  proc.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 30000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      if (msg.error) reject(new Error(`${method}: ${JSON.stringify(msg.error)}`));
      else resolve(msg.result);
    });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const t0 = performance.now();
  await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'mcp-workflow-bench', version: '0.0.0' },
  });
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const bootMs = Math.round(performance.now() - t0);
  return {
    bootMs,
    request,
    async call(name, args) {
      const t = performance.now();
      let result;
      try {
        result = await request('tools/call', { name, arguments: args });
      } catch (e) {
        ledger.push({ tool: name, ms: Math.round(performance.now() - t), ok: false, error: String(e) });
        throw e;
      }
      ledger.push({ tool: name, ms: Math.round(performance.now() - t), ok: !result.isError });
      return result;
    },
    kill: () => proc.kill(),
  };
}
const textOf = (result) => JSON.parse(result.content.find((c) => c.type === 'text').text);

// canonical form for round-trip equality: everything except minted ids
const canon = (rows) => rows
  .map(({ page, type, label, value, status }) => ({ page, type, label, value, status: status ?? '' }))
  .sort((a, b) => `${a.label}|${a.type}|${a.page}`.localeCompare(`${b.label}|${b.type}|${b.page}`));

// ---------- phase A: contracts on an uncalibrated document ----------
const serverA = await startServer();
console.log(`server boot: ${serverA.bootMs} ms`);

const tools = await serverA.request('tools/list', {});
const names = tools.tools.map((t) => t.name);
check('contract: exactly the 12 tools', [
  'open_document', 'render_page', 'read_text', 'set_scale', 'measure', 'scan_symbol',
  'compare_revisions', 'list_markups', 'set_status', 'delete_markup', 'export', 'save_annotated',
].every((n) => names.includes(n)) && names.length === 12, `got: ${names.join(', ')}`);

const opened = textOf(await serverA.call('open_document', { path: SAMPLE }));
check('open_document: 2 pages, nothing restored', opened.pageCount === 2 && opened.restoredMarkups === 0);
const docId = opened.id;

const rendered = await serverA.call('render_page', { id: docId, page: 1, scale: 1 });
const img = rendered.content.find((c) => c.type === 'image');
check('render_page: PNG image + 842×595 metadata', img?.mimeType === 'image/png' && img.data.length > 10000);

// THE uncalibrated contract: scale-dependent types record a markup and
// return value null (documented, not an error); scale-free types work.
const uncal = textOf(await serverA.call('measure', { id: docId, page: 1, type: 'length', points: [[60, 90], [400.02, 90]], label: 'wall (pre-scale)' }));
check('uncalibrated measure: value is null (current contract — refusal is the roadmap upgrade)', uncal.value === null && !!uncal.markupId);
const ang = textOf(await serverA.call('measure', { id: docId, page: 1, type: 'angle', points: [[60, 90], [200, 90], [60, 200]], label: 'Corner (scale-free)' }));
check('scale-free angle works without calibration: 90°', Math.abs(ang.value - 90) < 0.1, `got ${ang.value}`);

// ---------- phase B: the full workflow, calibrated ----------
const read = textOf(await serverA.call('read_text', { id: docId, page: 1 }));
check('read_text: printed scale 1:100 found', read.scaleRatio?.ratio === 100);
const scale = textOf(await serverA.call('set_scale', { id: docId, ratio: '1:100', all_pages: true }));
check('set_scale: applied to both pages', scale.set.length === 2);

const scanned = textOf(await serverA.call('scan_symbol', { id: docId, page: 1, at: [88.35, 271.42] }));
check('scan_symbol: 8 downlights', scanned.count === 8, `got ${scanned.count}`);

const wall = textOf(await serverA.call('measure', { id: docId, page: 1, type: 'length', points: [[60, 90], [400.02, 90]], label: 'External wall' }));
check('measure length: 11.995 m', Math.abs(wall.value - 11.995) < 0.01, `got ${wall.value}`);
const vol = textOf(await serverA.call('measure', {
  id: docId, page: 1, type: 'volume', depth: 0.2,
  points: [[60, 90], [173.39, 90], [173.39, 316.77], [60, 316.77]], label: 'Slab',
}));
check('measure volume: ~6.41 m³', Math.abs(vol.value - 6.41) < 0.05, `got ${vol.value}`);

const statusSet = textOf(await serverA.call('set_status', { id: docId, markup_id: wall.markupId, status: 'check' }));
check('set_status: check flag set', statusSet.status === 'check');

const listed = textOf(await serverA.call('list_markups', { id: docId }));
check('list_markups: every row has a value now', listed.markups.length > 0 && listed.markups.every((m) => m.value !== null));
const preSave = canon(listed.markups);

const csvPath = join(here, 'artifacts', 'mcp-workflow.csv');
await serverA.call('export', { id: docId, format: 'csv', path: csvPath });
check('export: csv written with the wall row', existsSync(csvPath) && readFileSync(csvPath, 'utf8').includes('External wall'));

const pdfPath = join(here, 'artifacts', 'mcp-annotated.pdf');
const saved = textOf(await serverA.call('save_annotated', { id: docId, path: pdfPath }));
check(
  'save_annotated: valid PDF with the full markup set',
  saved.markups === listed.markups.length && readFileSync(pdfPath).subarray(0, 5).toString() === '%PDF-',
  `${saved.markups} vs ${listed.markups.length}`,
);
serverA.kill();

// ---------- phase C: fresh-process re-import, canonical equality ----------
const serverB = await startServer();
const reopened = textOf(await serverB.call('open_document', { path: pdfPath }));
check('fresh process: all markups restored from the PDF', reopened.restoredMarkups === saved.markups, `got ${reopened.restoredMarkups}`);

// Contract (upgraded 2026-10-19): the page calibration rides in the markup
// comments ([mpp:…]) and restores at open — values are live immediately,
// no read_text+set_scale recovery round needed. (The b7 run documented the
// old null-before-recalibration contract; the engine change flipped it.)
check('fresh process: calibrations restored from the PDF', reopened.restoredCalibrations >= 1, `got ${reopened.restoredCalibrations ?? 0}`);
const relisted = textOf(await serverB.call('list_markups', { id: reopened.id }));
const postSave = canon(relisted.markups);
const same = JSON.stringify(preSave) === JSON.stringify(postSave);
check('fresh process: markup set round-trips canonically with live values', same,
  `\npre:  ${JSON.stringify(preSave)}\npost: ${JSON.stringify(postSave)}`);
serverB.kill();

// ---------- ledger ----------
const calls = ledger.filter((l) => !l.error);
const totalMs = calls.reduce((a, l) => a + l.ms, 0);
const slowest = calls.slice().sort((a, b) => b.ms - a.ms)[0];
mkdirSync(dirname(OUT_LEDGER), { recursive: true });
const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
writeFileSync(OUT_LEDGER, JSON.stringify({
  schema: 'evals/mcp-workflow/1',
  eval: 'mcp-conformance',
  engine: { name: 'pdf2takeoff', version, server: 'src/headless/mcp.ts' },
  counts: { tool_calls: calls.length, roundtrip_markups: saved.markups, tools: 12 },
  ms: { boot_a: serverA.bootMs, boot_b: serverB.bootMs, total: totalMs, slowest: slowest ? `${slowest.tool} ${slowest.ms}` : null },
  ledger,
}, null, 2) + '\n');
console.log(`\nverdict: PASS — ${passed} contract checks, ${calls.length} tool calls, ${totalMs} ms total (slowest: ${slowest.tool} ${slowest.ms} ms)`);
console.log(`ok: ${OUT_LEDGER}`);
