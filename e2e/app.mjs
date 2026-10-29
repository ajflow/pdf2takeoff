// The app end to end on the sample drawing: landing, every rail tool by
// click and key, the command bar, scale, Scan with Keep/Undo/Review, the
// quantities focus, export menu and Excel download, Library, widths from
// 390 to 1920 px, dark mode, and the guided demo to its end card.
// Usage: node e2e/app.mjs [url] [screenshot dir]

import { readdirSync } from 'node:fs';
import { openBrowser, checker, sleep } from './cdp.mjs';

const [url = 'http://localhost:4173/', shots = '/tmp/p2t-e2e/app'] = process.argv.slice(2);
const { send, ev, key, clickAt, shot, close, errors, downloads: dl } = await openBrowser(shots);
const { check, ...t } = checker();

// landing, then the sample
await send('Page.navigate', { url }); await sleep(2500);
check('landing shows, app chrome hidden, one h1', await ev(`document.body.classList.contains('landing') && getComputedStyle(document.querySelector('.rail')).display === 'none' && getComputedStyle(document.querySelector('.topbar')).display === 'none' && document.querySelectorAll('h1').length === 1`));
await ev(`document.getElementById('sampleBtnHero').click()`); await sleep(3500);
const ink = await ev(`(() => { const c = document.getElementById('pdfCanvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 16) if (d[i] < 120) n++; return n; })()`);
check('sample opens with the drawing rendered', !(await ev(`document.body.classList.contains('landing')`)) && ink > 500, `ink ${ink}`);
check('top bar: doc name and page', (await ev(`document.getElementById('fileIndicator').textContent`)) === 'sample-floor-plan.pdf' && (await ev(`document.getElementById('pageIndicator').textContent`)) === 'Page 1 of 2');
check('scale chip asks for a scale', /Set scale/.test(await ev(`document.getElementById('scaleBadge').textContent`)) && await ev(`document.getElementById('scaleBadge').classList.contains('unset')`));

// rail tools: click and key, with tooltips
const tools = await ev(`[...document.querySelectorAll('.rail [data-tool]')].map(b => ({ t: b.dataset.tool, tip: b.querySelector('.tip')?.textContent.trim(), key: b.querySelector('.tip kbd')?.textContent }))`);
check('12 rail tools with name + key tooltips', tools.length === 12 && tools.every(t => t.tip && t.key), JSON.stringify(tools));
let clickOk = true, keyOk = true;
for (const t of tools) {
  await ev(`document.querySelector('.rail [data-tool="${t.t}"]').click()`); await sleep(60);
  if (!(await ev(`document.querySelector('.rail [data-tool="${t.t}"]').classList.contains('active')`))) clickOk = false;
}
for (const t of tools) {
  await ev(`document.activeElement?.blur()`);
  await key(t.key.toLowerCase()); await sleep(60);
  if (!(await ev(`document.querySelector('.rail [data-tool="${t.t}"]').classList.contains('active')`))) { keyOk = false; console.log('  key miss', t.t, t.key); }
  await key('Escape');
}
check('every tool selects by click', clickOk);
check('every tool selects by its key', keyOk);
await key('v');

// ⌘K
await key('k', 4); await sleep(250);
check('⌘K opens the command bar', await ev(`!document.getElementById('cmdk').classList.contains('hidden') && document.activeElement?.id === 'cmdkInput'`));
await ev(`(() => { const i = document.getElementById('cmdkInput'); i.value = 'area'; i.dispatchEvent(new Event('input')); })()`); await sleep(150);
check('"area" offers the Area tool first', (await ev(`document.querySelector('.cmdk-item[aria-selected="true"] .t')?.textContent`)) === 'Area');
await key('Enter'); await sleep(200);
check('Enter runs it: Area is the tool, the bar closed', await ev(`document.querySelector('.rail [data-tool="area"]').classList.contains('active') && document.getElementById('cmdk').classList.contains('hidden')`));
await key('k', 4); await sleep(200); await key('Escape'); await sleep(150);
check('Esc closes the command bar', await ev(`document.getElementById('cmdk').classList.contains('hidden')`));
await key('v');

// scale: a 1:100 preset changes the chip
await ev(`(() => { const sel = document.getElementById('calibPreset'); sel.value = '100'; sel.dispatchEvent(new Event('change')); })()`); await sleep(300);
const chip = await ev(`document.getElementById('scaleBadge').textContent`);
check('scale chip: 1:100, set by hand', /1:100/.test(chip) && /set by hand/.test(chip) && !(await ev(`document.getElementById('scaleBadge').classList.contains('unset')`)), chip);
check('hint pill shows the latest hint', await ev(`document.getElementById('hintPill').classList.contains('show') && document.getElementById('toolHint').textContent.length > 0`));

// review-first scan on the downlights (PDF point 88.35, 271.42 on the A4 landscape sample)
const at = await ev(`(() => { const r = document.getElementById('pageWrap').getBoundingClientRect(); const k = r.width / 841.89; return { x: r.left + 88.35 * k, y: r.top + (595.28 - 271.42) * k }; })()`);
await key('s'); await clickAt(at.x, at.y); await sleep(2500);
const card = await ev(`({ open: !document.getElementById('scanCard').classList.contains('hidden'), n: document.getElementById('scanCount').textContent, label: document.getElementById('scanLabel').textContent, meta: document.getElementById('scanMeta').textContent })`);
check('scan proposes 8 hits and shows the review card', card.open && card.n === '8', JSON.stringify(card));
await shot('scan-card');
await ev(`document.getElementById('scanKeep').click()`); await sleep(300);
await ev(`document.getElementById('tabMarkups').click()`); await sleep(200);
const confirmed = await ev(`document.querySelectorAll('#markupRows .status-btn.st-confirmed').length`);
check('Keep all confirms the 8 hits and closes the card', confirmed === 8 && await ev(`document.getElementById('scanCard').classList.contains('hidden')`), `confirmed ${confirmed}`);
await shot('markups-view');
const before = await ev(`document.querySelectorAll('#markupRows tr[data-id]').length`);
await key('s'); await clickAt(at.x, at.y); await sleep(2500);
await ev(`document.getElementById('scanUndo').click()`); await sleep(300);
const after = await ev(`document.querySelectorAll('#markupRows tr[data-id]').length`);
check('Undo on a second scan removes its hits', after === before && before === 8, `${before} -> ${after}`);
// Review steps through the hits: Enter keeps, Delete removes, Esc ends
await key('s'); await clickAt(at.x, at.y); await sleep(2500);
await ev(`document.getElementById('scanReview').click()`); await sleep(500);
const r1 = await ev(`document.getElementById('scanMeta').textContent`);
await key('Enter'); await sleep(300);
const r2 = await ev(`document.getElementById('scanMeta').textContent`);
await key('Delete', 0, 'Delete'); await sleep(300);
const r3 = await ev(`({ meta: document.getElementById('scanMeta').textContent, n: document.getElementById('scanCount').textContent })`);
check('Review: "1 of 8", Enter keeps (1 of 7), Delete removes (7 hits left)', /1 of 8/.test(r1) && /1 of 7/.test(r2) && /1 of 6/.test(r3.meta) && r3.n === '7', `${r1} | ${r2} | ${JSON.stringify(r3)}`);
await shot('review');
await key('Escape'); await sleep(200);
check('Esc ends the review, the card stays for a decision', /found in/.test(await ev(`document.getElementById('scanMeta').textContent`)) && !(await ev(`document.getElementById('scanCard').classList.contains('hidden')`)));
await ev(`document.getElementById('scanUndo').click()`); await sleep(300);
await key('v');

// the quantities view: selecting a row fades the other markups
await ev(`document.getElementById('tabQty').click()`); await sleep(150);
// a length markup too, so there is something to fade
await key('l'); 
const p1 = await ev(`(() => { const r = document.getElementById('pageWrap').getBoundingClientRect(); return { x: r.left + r.width * 0.6, y: r.top + r.height * 0.3, x2: r.left + r.width * 0.8 }; })()`);
await clickAt(p1.x, p1.y); await clickAt(p1.x2, p1.y); await key('Enter'); await key('v');
await ev(`[...document.querySelectorAll('.qrow')].find(r => /Scanned|Downlight|symbol/.test(r.textContent))?.click()`); await sleep(300);
const focus = await ev(`({ focusing: document.getElementById('markupsLayer').classList.contains('focusing'), lit: document.querySelectorAll('#markupsLayer .markup.focus').length, faded: document.querySelectorAll('#markupsLayer .markup:not(.focus)').length, sel: document.querySelectorAll('.qrow.sel').length })`);
check('selecting a quantity row lights its 8 markups and fades the rest', focus.focusing && focus.lit === 8 && focus.faded >= 1 && focus.sel === 1, JSON.stringify(focus));
await shot('focus');
await key('Escape'); await sleep(200);
check('Esc lets go of the row', !(await ev(`document.getElementById('markupsLayer').classList.contains('focusing')`)));

// export menu
await ev(`document.getElementById('exportMenuBtn').click()`); await sleep(150);
const items = await ev(`[...document.querySelectorAll('#exportMenu .menu-item')].map(b => b.textContent.trim())`);
check('Export menu: Excel, CSV, Copy, Report, Save into the PDF', items.length === 5 && /Excel/.test(items[0]) && /PDF/.test(items[4]), items.join(' | '));
await shot('export-menu');
await ev(`document.querySelector('#exportMenu [data-proxy="exportXlsxBtn"]').click()`); await sleep(2000);
check('Export to Excel downloads a workbook', readdirSync(dl).some(f => f.endsWith('.xlsx')), readdirSync(dl).join(','));
await ev(`document.getElementById('moreBtn').click()`); await sleep(150);
check('More menu holds Open, Units, Live, Demo', await ev(`['openBtn','unitSelect','sessionBtn','demoBtn'].every(id => document.getElementById('moreMenu').contains(document.getElementById(id)))`));
await key('Escape');

// library view
await ev(`document.getElementById('tabLibrary').click()`); await sleep(150);
check('Library view shows the tool library, columns and layers', await ev(`!document.getElementById('viewLibrary').hidden && !!document.querySelector('#viewLibrary #presetLabel') && !!document.querySelector('#viewLibrary #columnsBox') && !!document.querySelector('#viewLibrary #layersBox')`));
await shot('library-view');
await ev(`document.getElementById('tabQty').click()`);

// widths
const widths = {};
for (const w of [1920, 1440, 1280, 1100, 960, 860, 390]) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: w < 600 }); await sleep(350);
  widths[w] = (await ev('document.documentElement.scrollWidth')) <= w;
  if (w === 390 || w === 960) await shot(`width-${w}`);
}
check('no sideways scroll from 390 to 1920 px', Object.values(widths).every(Boolean), JSON.stringify(widths));
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }); await sleep(300);
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }); await sleep(300);
await shot('dark'); 
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });

// the demo still runs to its end card
await send('Page.navigate', { url }); await sleep(2500);
await ev(`document.getElementById('demoBtnHero').click()`);
let ended = false; for (let i = 0; i < 40 && !ended; i++) { await sleep(1000); ended = await ev(`!document.getElementById('demoEnd').classList.contains('hidden')`); }
const rows = await ev(`document.querySelectorAll('#demoResults tr').length`);
check('the demo runs to its end card with 3 result rows', ended && rows === 3, `ended ${ended} rows ${rows}`);
await shot('demo-end');
check('no console exceptions', errors.length === 0, errors.join(' | '));
close();
console.log(t.failed ? `${t.failed} FAILED` : 'ALL PASS');
process.exit(t.failed ? 1 : 0);
