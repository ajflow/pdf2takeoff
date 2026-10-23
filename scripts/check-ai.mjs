#!/usr/bin/env node
// Behavioural check for the bring-your-own-model AI count stack (src/ai/):
// the tolerant inventory parser, the image-space → PDF-point mapping, the
// OpenAI-compatible adapter (mock fetch: request shape, structured-mode
// fallback, retries, errors) and the ai-count CLI end to end against a local
// HTTP server. No network access except a 127.0.0.1 server this script
// starts itself; keys used here are dummies. Exits non-zero on any failure.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INVENTORY_SCHEMA_NAME, InventoryParseError, parseInventory, toProposals } from '../src/ai/inventory.ts';
import { AECV_PRESET, SCHEDULE_PRESET, countItems } from '../src/engine/inventory.ts';
import { ProviderError, completeVision, presetConfig } from '../src/ai/providers.ts';
import { openAny } from '../src/headless/image-node.ts';
import { readMarkups } from '../src/headless/ops.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sample = join(root, 'public/examples/sample-floor-plan.pdf');

let failures = 0;
function check(label, cond, detail = '') {
  if (!cond) {
    failures += 1;
    console.error(`FAIL: ${label} ${detail}`);
    return;
  }
  console.log(`ok: ${label}`);
}

// a canned 200 chat response, and a fetch that plays a script of statuses
// (number = that status, anything else = the canned 200) and records calls
const CHAT_OK = {
  model: 'test/model',
  choices: [{ message: { content: '{"doors":[]}' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 11, completion_tokens: 22, cost: 0.0034 },
};
const response = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});
const scriptedFetch = (script) => {
  const calls = [];
  const fetch = async (url, init) => {
    const step = script[calls.length];
    calls.push({ url, init });
    return typeof step === 'number' ? response(step, 'nope') : response(200, CHAT_OK);
  };
  return { fetch, calls };
};
const req = (over = {}) => ({
  prompt: 'p',
  schema: { type: 'object' },
  schemaName: INVENTORY_SCHEMA_NAME,
  image: { base64: 'Zm9v', mime: 'image/png' },
  ...over,
});
const cfg = { baseUrl: 'http://x/v1/', apiKey: 'test-key', model: 'test/model', retryBaseMs: 1 };

// --- 1. parseInventory -------------------------------------------------------
const VALID = JSON.stringify({
  spaces: [{ label: 'Kitchen', kind: 'room', enclosed: true, bedroom_label: false, wet_kind: 'none', x: 500, y: 400 }],
  doors: [{ type: 'swing', leaves: 1, closet: false, x: 250, y: 300 }],
  windows: [{ type: 'window', group: 1, x: 100, y: 200 }],
  counts: { Door: 1, Window: 1, Space: 1, Bedroom: 0, Toilet: 0 },
});
let inv = parseInventory(VALID);
check('parseInventory: valid JSON parses', inv.doors.length === 1 && inv.spaces.length === 1 && inv.windows.length === 1, JSON.stringify(inv));

inv = parseInventory('```json\n' + VALID + '\n```');
check('parseInventory: fenced json block parses', inv.doors.length === 1);

inv = parseInventory('Here is the inventory:\n' + VALID + '\nHope that helps!');
check('parseInventory: prose around the JSON parses', inv.doors.length === 1);

inv = parseInventory(
  JSON.stringify({
    spaces: [],
    doors: [{ type: 'swing', leaves: 1, closet: false, x: 1200, y: -5 }],
    windows: [],
    counts: {},
  }),
);
check('parseInventory: coordinates clamp to 0..1000', inv.doors[0].x === 1000 && inv.doors[0].y === 0, JSON.stringify(inv.doors[0]));

let threw = null;
try {
  parseInventory('no JSON in this text at all, sorry');
} catch (e) {
  threw = e;
}
check('parseInventory: non-JSON throws InventoryParseError saying not JSON', threw instanceof InventoryParseError && /not JSON/.test(threw.message), String(threw));

threw = null;
try {
  parseInventory(JSON.stringify({ spaces: [], windows: [] }));
} catch (e) {
  threw = e;
}
check('parseInventory: missing doors throws naming "doors"', threw instanceof InventoryParseError && threw.message.includes('doors'), String(threw));

inv = parseInventory(
  JSON.stringify({
    spaces: [],
    doors: [{ type: 'revolving', leaves: 1, closet: false, x: 1, y: 1 }],
    windows: [],
    counts: {},
  }),
);
check('parseInventory: unknown door type becomes other', inv.doors[0].type === 'other', JSON.stringify(inv.doors[0]));

inv = parseInventory(
  JSON.stringify({
    spaces: [],
    doors: [],
    windows: [
      { type: 'window', x: 1, y: 1 },
      { type: 'window', x: 2, y: 2 },
    ],
    counts: {},
  }),
);
check('parseInventory: two ungrouped windows get different (negative) groups', inv.windows[0].group !== inv.windows[1].group && inv.windows[0].group < 0 && inv.windows[1].group < 0, JSON.stringify(inv.windows));

// --- 2. toProposals ----------------------------------------------------------
const proposals = toProposals(
  {
    spaces: [{ label: 'BEDROOM 1', kind: 'room', enclosed: true, bedroom_label: true, wet_kind: 'wc', x: 0, y: 0 }],
    doors: [{ type: 'double_swing', leaves: 2, closet: false, x: 1000, y: 1000 }],
    windows: [{ type: 'window', group: 3, x: 500, y: 250 }],
    counts: { Door: 0, Window: 0, Space: 0, Bedroom: 0, Toilet: 0 },
  },
  { widthPt: 600, heightPt: 400 },
);
check('toProposals: order is doors, then windows, then spaces', proposals.map((p) => p.kind).join(',') === 'Door,Window,Space');
const [doorP, winP, spaceP] = proposals;
check('toProposals: space at 0,0 lands at [0, 400] (bottom-left)', JSON.stringify(spaceP.at) === '[0,400]', JSON.stringify(spaceP.at));
check('toProposals: door at 1000,1000 lands at [600, 0] (top-right)', JSON.stringify(doorP.at) === '[600,0]', JSON.stringify(doorP.at));
check('toProposals: window at 500,250 lands at [300, 300] (centre)', JSON.stringify(winP.at) === '[300,300]', JSON.stringify(winP.at));
check('toProposals: window type window becomes glazingType unit', winP.glazingType === 'unit');
check('toProposals: group 3 becomes the string "3"', winP.group === '3');
check(
  'toProposals: space fields map to space attrs',
  spaceP.spaceKind === 'room' && spaceP.roomLabel === 'BEDROOM 1' && spaceP.enclosed === true && spaceP.bedroom === true && spaceP.wetKind === 'wc' && spaceP.label === undefined,
  JSON.stringify(spaceP),
);
check('toProposals: door fields map to door attrs', doorP.doorType === 'double_swing' && doorP.leaves === 2 && doorP.closet === false, JSON.stringify(doorP));

// --- 3. completeVision request shape -----------------------------------------
let f = scriptedFetch(['ok']);
let res = await completeVision(cfg, req(), f.fetch);
let body = JSON.parse(f.calls[0].init.body);
check('completeVision: trailing slash stripped, posts to /chat/completions', f.calls[0].url === 'http://x/v1/chat/completions', f.calls[0].url);
check('completeVision: authorization carries the bearer key', f.calls[0].init.headers.authorization === 'Bearer test-key');
check('completeVision: body carries the model', body.model === 'test/model');
check('completeVision: image rides as a png data URL', body.messages[0].content[1].image_url.url.startsWith('data:image/png;base64,'));
check(
  'completeVision: response_format json_schema, strict, named',
  body.response_format.type === 'json_schema' && body.response_format.json_schema.strict === true && body.response_format.json_schema.name === INVENTORY_SCHEMA_NAME,
  JSON.stringify(body.response_format),
);
check(
  'completeVision: text, usage and structured come back',
  res.text === '{"doors":[]}' && res.model === 'test/model' && res.structured === 'json_schema' && res.usage.inputTokens === 11 && res.usage.outputTokens === 22 && res.usage.costUsd === 0.0034,
  JSON.stringify(res),
);

// --- 4. structured-mode fallback (auto only) ---------------------------------
f = scriptedFetch([400]);
res = await completeVision({ ...cfg, structured: 'auto' }, req(), f.fetch);
check('fallback: 400 then 200 lands on json_object', res.structured === 'json_object', res.structured);
check('fallback: second call asked only for json_object', JSON.stringify(JSON.parse(f.calls[1].init.body).response_format) === JSON.stringify({ type: 'json_object' }), f.calls[1].init.body.slice(0, 200));
f = scriptedFetch([400, 400]);
res = await completeVision({ ...cfg, structured: 'auto' }, req(), f.fetch);
check('fallback: 400, 400 then 200 lands on none', res.structured === 'none' && !('response_format' in JSON.parse(f.calls[2].init.body)), res.structured);

// --- 5. errors and retries ---------------------------------------------------
f = scriptedFetch([401]);
threw = null;
try {
  await completeVision(cfg, req(), f.fetch);
} catch (e) {
  threw = e;
}
check('errors: 401 throws ProviderError after exactly 1 call', threw instanceof ProviderError && threw.status === 401 && f.calls.length === 1, `${threw} / ${f.calls.length} calls`);
check('errors: the key never reaches the error message', threw instanceof Error && !threw.message.includes('test-key'), threw?.message);

f = scriptedFetch([429]);
res = await completeVision(cfg, req(), f.fetch);
check('errors: 429 then 200 succeeds after 2 calls', res.structured === 'json_schema' && f.calls.length === 2, `${f.calls.length} calls`);

f = scriptedFetch([500, 500, 500]);
threw = null;
try {
  await completeVision({ ...cfg, retries: 2 }, req(), f.fetch);
} catch (e) {
  threw = e;
}
check('errors: 500 with retries 2 gives up after 3 calls', threw instanceof ProviderError && threw.status === 500 && f.calls.length === 3, `${threw} / ${f.calls.length} calls`);

// --- 6. content returned as a parts list -------------------------------------
const partsFetch = async () =>
  response(200, {
    model: 'm',
    choices: [{ message: { content: [{ type: 'text', text: '{"doors":' }, { type: 'text', text: '[]}' }] }, finish_reason: 'stop' }],
  });
res = await completeVision(cfg, req(), partsFetch);
check('completeVision: content parts are joined', res.text === '{"doors":[]}', res.text);

// --- 7. presets ---------------------------------------------------------------
const orCfg = presetConfig('openrouter', { model: 'm', apiKey: 'k' });
check('presets: openrouter carries HTTP-Referer and require_parameters', orCfg.headers['HTTP-Referer'] === 'https://pdf2takeoff.com' && orCfg.extraBody.provider.require_parameters === true, JSON.stringify(orCfg));
f = scriptedFetch(['ok']);
await completeVision(orCfg, req(), f.fetch);
check('presets: openrouter extraBody.provider reaches the request body', JSON.parse(f.calls[0].init.body).provider.require_parameters === true);
threw = null;
try {
  presetConfig('nope', { model: 'm' });
} catch (e) {
  threw = e;
}
check('presets: unknown preset throws naming the options', threw instanceof Error && threw.message.includes('openrouter'), String(threw));

// --- 8. end-to-end: the ai-count CLI against a local server -------------------
const INV = {
  doors: [
    { type: 'double_swing', leaves: 2, closet: false, x: 100, y: 100 },
    { type: 'sliding', leaves: 1, closet: true, x: 200, y: 100 },
  ],
  windows: [
    { type: 'window', group: 1, x: 300, y: 50 },
    { type: 'window', group: 1, x: 320, y: 50 },
    { type: 'sliding_glass_door', group: 2, x: 500, y: 900 },
  ],
  spaces: [
    { label: 'BEDROOM 1', kind: 'room', enclosed: true, bedroom_label: true, wet_kind: 'none', x: 150, y: 200 },
    { label: 'WC', kind: 'wet', enclosed: true, bedroom_label: false, wet_kind: 'wc', x: 400, y: 300 },
    { label: 'WIR', kind: 'closet', enclosed: true, bedroom_label: false, wet_kind: 'none', x: 450, y: 350 },
  ],
  counts: { Door: 2, Window: 2, Space: 2, Bedroom: 1, Toilet: 1 },
};

const seen = [];
const server = createServer((request, res2) => {
  let data = '';
  request.on('data', (c) => (data += c));
  request.on('end', () => {
    seen.push({ headers: request.headers, body: data });
    res2.writeHead(200, { 'content-type': 'application/json' });
    res2.end(
      JSON.stringify({
        model: 'test/model',
        choices: [{ message: { content: JSON.stringify(INV) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      }),
    );
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const runCli = (args, env) =>
  new Promise((resolve) => {
    const proc = spawn(process.execPath, ['--experimental-strip-types', join(root, 'src/headless/cli.ts'), 'ai-count', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (c) => (stdout += c));
    proc.stderr.on('data', (c) => (stderr += c));
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
  });

const tmp = mkdtempSync(join(tmpdir(), 'check-ai-'));
const outPdf = join(tmp, 'out.pdf');
const baseArgs = [sample, '--page', '1', '--provider', 'openrouter', '--base-url', `http://127.0.0.1:${port}/v1`, '--model', 'test/model'];

let r = await runCli([...baseArgs, '-o', outPdf], { ...process.env, OPENROUTER_API_KEY: 'test-key' });
check('ai-count e2e: exits 0', r.code === 0, r.stderr.slice(0, 500));
let out = null;
try {
  out = JSON.parse(r.stdout);
} catch {
  // reported by the next check
}
check('ai-count e2e: stdout is the ai-count JSON', !!out && out.file === sample && out.page === 1 && out.preset === 'aecv', r.stdout.slice(0, 300));
check(
  'ai-count e2e: aecv counts Door 2, Window 2, Space 2, Bedroom 1, Toilet 1',
  !!out && JSON.stringify(out.counts) === JSON.stringify({ Door: 2, Window: 2, Space: 2, Bedroom: 1, Toilet: 1 }),
  JSON.stringify(out?.counts),
);
check(
  'ai-count e2e: 8 items, 5 unconfirmed, byKind Door 2 / Window 3 / Space 3',
  !!out && out.items === 8 && out.unconfirmed === 5 && JSON.stringify(out.byKind) === JSON.stringify({ Door: 2, Window: 3, Space: 3 }),
  JSON.stringify({ items: out?.items, unconfirmed: out?.unconfirmed, byKind: out?.byKind }),
);
check('ai-count e2e: modelCounts present and structured json_schema', !!out && !!out.modelCounts && out.structured === 'json_schema', JSON.stringify({ structured: out?.structured, modelCounts: out?.modelCounts }));
check(
  'ai-count e2e: the server saw the bearer key and an image data URL',
  seen.length >= 1 && seen.some((s) => s.headers.authorization === 'Bearer test-key' && JSON.parse(s.body).messages[0].content[1].image_url.url.startsWith('data:image/png;base64,')),
);
check('ai-count e2e: stdout never shows the key', !r.stdout.includes('test-key'));
check('ai-count e2e: annotated PDF written', existsSync(outPdf) && readFileSync(outPdf).subarray(0, 5).toString() === '%PDF-');

const reopened = await openAny(outPdf);
const markups = await readMarkups(reopened.doc);
check('ai-count e2e: reopened output holds 8 flagged count markups', markups.length === 8 && markups.every((m) => m.type === 'count' && m.status === 'check'), `got ${markups.length}`);
check(
  'ai-count e2e: labels start with "Door (", "Window (" or "Space"',
  markups.every((m) => m.label.startsWith('Door (') || m.label.startsWith('Window (') || m.label.startsWith('Space')),
  JSON.stringify(markups.map((m) => m.label)),
);

check(
  'ai-count e2e: reopened markups keep their item types, so presets recount after saving',
  markups.every((m) => m.item && m.item.source === 'model') &&
    JSON.stringify(countItems(markups, AECV_PRESET).counts) === JSON.stringify({ Door: 2, Window: 2, Space: 2, Bedroom: 1, Toilet: 1 }) &&
    JSON.stringify(countItems(markups, SCHEDULE_PRESET).counts) === JSON.stringify({ Door: 2, Window: 3, Space: 3, Bedroom: 1, Toilet: 1 }),
  JSON.stringify(markups.map((m) => m.item)),
);

// a re-run on its own output replaces the unconfirmed proposals instead of stacking them
const rerunPdf = join(tmp, 'rerun.pdf');
r = await runCli([outPdf, ...baseArgs.slice(1), '-o', rerunPdf], { ...process.env, OPENROUTER_API_KEY: 'test-key' });
const rerun = r.code === 0 ? await readMarkups((await openAny(rerunPdf)).doc) : [];
check('ai-count e2e: re-running on the output replaces proposals (still 8 markups)', r.code === 0 && rerun.length === 8, `exit ${r.code}, ${rerun.length} markups ${r.stderr.slice(0, 300)}`);

r = await runCli([...baseArgs, '--preset', 'schedule'], { ...process.env, OPENROUTER_API_KEY: 'test-key' });
check('ai-count e2e (schedule): exits 0', r.code === 0, r.stderr.slice(0, 500));
out = JSON.parse(r.stdout);
check(
  'ai-count e2e (schedule): Door 2, Window 3, Space 3, Bedroom 1, Toilet 1',
  JSON.stringify(out.counts) === JSON.stringify({ Door: 2, Window: 3, Space: 3, Bedroom: 1, Toilet: 1 }),
  JSON.stringify(out.counts),
);

const envNoKey = { ...process.env };
delete envNoKey.OPENROUTER_API_KEY;
delete envNoKey.PDF2TAKEOFF_AI_KEY;
// no --base-url either: only then is the key mandatory
r = await runCli([sample, '--page', '1', '--provider', 'openrouter', '--model', 'test/model'], envNoKey);
check('ai-count e2e: no key exits 1 naming OPENROUTER_API_KEY', r.code === 1 && r.stderr.includes('OPENROUTER_API_KEY'), r.stderr.slice(0, 300));

await new Promise((resolve) => server.close(resolve));

if (failures > 0) {
  console.error(`\nAI check: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAI check: all steps passed');
