// Lead capture: the site sign-up forms and the in-app nudges (when they
// show, what they say, and the source tag they post).
// Usage: node e2e/nudge.mjs [url] [screenshot dir]

import { readdirSync } from 'node:fs';
import { openBrowser, checker, sleep } from './cdp.mjs';

const [url = 'http://localhost:4173/', shots = '/tmp/p2t-e2e/nudge'] = process.argv.slice(2);
const { send, ev, key, clickAt, shot, close, errors, downloads: dl } = await openBrowser(shots);
const { check, ...t } = checker();

const base = url.replace(/\/$/, '');
const form = (sel) => ev(`(() => { const f = document.querySelector(${JSON.stringify(sel)}); if (!f) return null; return { action: f.action, target: f.target, post: f.querySelector('input[name=post]')?.value, email: !!f.querySelector('input[type=email][required]'), trap: !!f.querySelector('input[name=website]') }; })()`);
const good = (f, post) => f && f.action === 'https://flowtivity.ai/api/blog/subscribe/' && f.target === '_blank' && f.post === post && f.email && f.trap;

// homepage sign-up
await send('Page.navigate', { url: base + '/' }); await sleep(2500);
const hf = await form('#ai form.signup');
check('homepage AI section has the sign-up form', good(hf, 'pdf2takeoff-home'), JSON.stringify(hf));
await ev(`document.querySelector('#ai form.signup').scrollIntoView({ block: 'center' })`); await sleep(400); await shot('home-signup');

// answer pages
for (const [slug, post] of [['takeoff-benchmarks', 'pdf2takeoff-takeoff-benchmarks'], ['mcp-server-construction-takeoff', 'pdf2takeoff-mcp-server-construction-takeoff']]) {
  await send('Page.navigate', { url: `${base}/${slug}` }); await sleep(1500);
  check(`${slug} has the sign-up form`, good(await form('form.signup'), post));
}
await send('Page.navigate', { url: `${base}/takeoff-without-uploading-drawings` }); await sleep(1200);
check('privacy page says where a sign-up email goes', await ev(`document.body.textContent.includes("goes to Flowtivity's mailing list")`));

// the app: open the sample, scan, Keep all -> the AI prompt (once)
await send('Page.navigate', { url: base + '/?file=/examples/sample-floor-plan.pdf' }); await sleep(4000);
check('no prompt on opening a drawing', !(await ev(`!!document.querySelector('.prompt-card')`)));
const scanAt = async () => { const at = await ev(`(() => { const r = document.getElementById('pageWrap').getBoundingClientRect(); const k = r.width / 841.89; return { x: r.left + 88.35 * k, y: r.top + (595.28 - 271.42) * k }; })()`); await key('s'); await clickAt(at.x, at.y); await sleep(2500); };
await scanAt();
check('no prompt while the scan card is still open', !(await ev(`!!document.querySelector('.prompt-card')`)));
await ev(`document.getElementById('scanKeep').click()`); await sleep(400);
const nf = await form('.prompt-card form');
check('Keep all shows the AI-counting prompt with the sign-up', good(nf, 'pdf2takeoff-app-scan'), JSON.stringify(nf));
await shot('app-ai-nudge');
await ev(`document.querySelector('.prompt-card .prompt-x').click()`); await sleep(200);
check('Dismiss closes it', !(await ev(`!!document.querySelector('.prompt-card')`)));
await ev(`document.getElementById('scanUndo') && 0`);
await scanAt(); await ev(`document.getElementById('scanKeep').click()`); await sleep(400);
check('a second kept scan shows nothing (once only)', !(await ev(`!!document.querySelector('.prompt-card')`)));

// export -> the talk-to-Flowtivity prompt (once a week)
await ev(`document.getElementById('exportCsvBtn').click()`); await sleep(1800);
const talk = await ev(`(() => { const a = document.querySelector('.prompt-card a.btn'); return a ? { href: a.href, target: a.target, text: a.textContent } : null; })()`);
check('an export shows the Flowtivity link', talk && talk.href.startsWith('https://flowtivity.ai/contact/?utm_source=pdf2takeoff') && talk.target === '_blank', JSON.stringify(talk));
await shot('app-talk-nudge');
await ev(`document.querySelector('.prompt-card .prompt-x').click()`); await sleep(200);
await ev(`document.getElementById('exportCsvBtn').click()`); await sleep(1800);
check('a second export the same week shows nothing', !(await ev(`!!document.querySelector('.prompt-card')`)));
const fineInView = await ev(`(() => { const f = document.querySelector('#scanCard'); return true; })()`);

// phone width: the prompt fits
await ev(`localStorage.clear()`);
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await ev(`document.getElementById('exportCsvBtn').click()`); await sleep(1800);
const fit = await ev(`(() => { const n = document.querySelector('.prompt-card'); if (!n) return null; const r = n.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), w: innerWidth }; })()`);
check('on a phone the prompt sits inside the screen', fit && fit.left >= 16 && fit.right <= fit.w - 16, JSON.stringify(fit));
await shot('app-talk-nudge-phone');

// the demo never prompts
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: base + '/' }); await sleep(2000); await ev(`localStorage.clear()`);
await ev(`document.getElementById('demoBtnHero').click()`);
let demoNudge = false; for (let i = 0; i < 30; i++) { await sleep(700); if (await ev(`!!document.querySelector('.prompt-card')`)) demoNudge = true; }
check('the demo never shows a prompt', !demoNudge);

check('no console exceptions', errors.length === 0, errors.join(' | '));
console.log(t.failed ? `${t.failed} FAILED` : 'ALL PASS');
close();
process.exit(t.failed ? 1 : 0);
