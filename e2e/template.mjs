// Trade templates in the browser: the picker, loading fit-out's ten tools,
// a wall measured onto the Walls line, and the template summary download.
// Usage: node e2e/template.mjs [url] [screenshot dir]

import { readdirSync } from 'node:fs';
import { openBrowser, checker, sleep } from './cdp.mjs';

const [url = 'http://localhost:4173/', shots = '/tmp/p2t-e2e/template'] = process.argv.slice(2);
const { send, ev, key, clickAt, shot, close, errors, downloads: dl } = await openBrowser(shots);
const { check, ...t } = checker();

await send('Page.navigate', { url: url.replace(/\/$/, '') + '/?file=/examples/sample-floor-plan.pdf' }); await sleep(4000);
await key('c'); await sleep(200);
await ev(`(() => { const s = document.getElementById('calibPreset'); s.value = '100'; s.dispatchEvent(new Event('change')); })()`); await sleep(800);
await ev(`document.activeElement?.blur(); document.getElementById('tabLibrary').click()`); await sleep(300);
const opts = await ev(`[...document.getElementById('templateSelect').options].map(o => o.value).filter(Boolean).join(',')`);
check('template picker lists fit-out, electrical, painting', opts === 'fitout,electrical,painting', opts);
check('template exports hidden before a template is loaded', await ev(`document.getElementById('templateExportBtn').hidden && document.getElementById('templateCopyBtn').hidden`));
await ev(`(() => { const s = document.getElementById('templateSelect'); s.value = 'fitout'; })()`);
await ev(`document.getElementById('templateLoad').click()`); await sleep(400);
const chips = await ev(`[...document.querySelectorAll('#presetList .preset-label')].map(e => e.textContent)`);
check('loading fit-out adds its ten labelled tools', chips.length === 10 && chips[0] === 'Walls', JSON.stringify(chips));
check('template exports appear once loaded', !(await ev(`document.getElementById('templateExportBtn').hidden`)));
check('hint confirms the load', /Commercial fit-out template loaded: 10 tools added/.test(await ev(`document.getElementById('toolHint').textContent`)));
// measure a wall with the Walls tool
await ev(`document.querySelector('#presetList [data-preset="0"]').click()`); await sleep(300);
const toScreen = (x, y) => ev(`(() => { const r = document.getElementById('pageWrap').getBoundingClientRect(); const k = r.width / 841.89; return { x: r.left + ${x} * k, y: r.top + (595.28 - ${y}) * k }; })()`);
const a = await toScreen(100, 300), b = await toScreen(300, 300);
await clickAt(a.x, a.y); await clickAt(b.x, b.y); await key('Enter', 0, 'Enter'); await sleep(600);
const qty = await ev(`[...document.querySelectorAll('.qrow')].map(r => r.textContent.replace(/\\s+/g, ' ').trim()).join(' || ')`);
check('the wall lands on the Walls line', /Walls/.test(qty), qty);
// export the template summary
await ev(`document.getElementById('templateExportBtn').click()`); await sleep(2500);
const files = readdirSync(dl);
check('template summary downloads as Excel', files.some((f) => /fitout-summary\.xlsx$/.test(f)), files.join(','));
console.log('download:', files.join(','));
check('no console exceptions', errors.length === 0, errors.join(' | '));
console.log(t.failed ? `${t.failed} FAILED` : 'ALL PASS');
close();
process.exit(t.failed ? 1 : 0);
