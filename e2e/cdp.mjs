// A headless Chrome driven over the DevTools protocol, for the browser
// suites in this folder. Each session gets a fresh temporary profile and a
// port Chrome picks itself, and Chrome is killed when the session closes,
// when the process exits, or on Ctrl-C, so no browser is left running.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME =
  process.env.CHROME ||
  [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].find((p) => existsSync(p));

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const live = new Set();
const killAll = () => {
  for (const c of live) c.kill('SIGKILL');
  live.clear();
};
process.on('exit', killAll);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130));

/**
 * Starts Chrome and opens a session on its first tab. `shots` is the folder
 * for screenshots and downloads (downloads go to `<shots>/downloads`).
 */
export async function openBrowser(shots) {
  if (!CHROME) throw new Error('no Chrome found: set CHROME to its path');
  mkdirSync(shots, { recursive: true });
  const downloads = join(shots, 'downloads');
  rmSync(downloads, { recursive: true, force: true });
  mkdirSync(downloads, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'p2t-e2e-'));
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
  live.add(chrome);

  let port;
  for (let i = 0; i < 80 && !port; i++) {
    await sleep(250);
    try {
      port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
    } catch {}
  }
  if (!port) throw new Error('Chrome did not start');
  let target;
  for (let i = 0; i < 40 && !target; i++) {
    try {
      target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page');
    } catch {}
    if (!target) await sleep(250);
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });

  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description?.split('\n')[0] ?? m.params.exceptionDetails.text);
  };
  const send = (method, params = {}) =>
    new Promise((r) => {
      const n = ++id;
      pending.set(n, r);
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text);
    return r.result.result?.value;
  };
  const key = async (k, mods = 0, code) => {
    for (const type of ['keyDown', 'keyUp'])
      await send('Input.dispatchKeyEvent', {
        type,
        key: k,
        code: code ?? (k.length === 1 ? 'Key' + k.toUpperCase() : k),
        modifiers: mods,
        text: type === 'keyDown' && k.length === 1 && !mods ? k : undefined,
        windowsVirtualKeyCode: k === 'Enter' ? 13 : k === 'Escape' ? 27 : k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0,
      });
    await sleep(120);
  };
  const clickAt = async (x, y) => {
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    await sleep(150);
  };
  const shot = async (name) => {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(shots, `${name}.png`), Buffer.from(s.result.data, 'base64'));
  };
  const close = () => {
    ws.close();
    chrome.kill('SIGKILL');
    live.delete(chrome);
    // Chrome may still be writing its profile as it dies; a profile left in
    // the temp dir is harmless, a failed run over it is not
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {}
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  return { send, ev, key, clickAt, shot, close, errors, downloads };
}

/** PASS/FAIL lines and a failure count, the same shape as scripts/check-*.mjs. */
export function checker() {
  const t = { failed: 0 };
  t.check = (label, cond, detail = '') => {
    console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}${cond ? '' : ' ' + detail}`);
    if (!cond) t.failed++;
  };
  return t;
}
