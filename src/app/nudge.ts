// Two quiet prompts inside the app, each easy to dismiss. After the first scan
// someone keeps: AI counting is coming, with a sign-up for Flowtivity's Friday
// digest (once, ever). After an export: a link to talk to Flowtivity (at most
// once a week). Both open flowtivity.ai in a new tab so the takeoff stays put,
// and neither shows during the demo or on the landing page. What was shown is
// remembered in this browser only; nothing is sent anywhere unless the person
// submits the form or follows the link.

const WEEK = 7 * 86_400_000;
const SEEN_AI = 'p2t-nudge-ai';
const SEEN_TALK = 'p2t-nudge-talk';

const read = (key: string): number => {
  try {
    return Number(localStorage.getItem(key)) || 0;
  } catch {
    return 0;
  }
};
const write = (key: string, value: number): void => {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // private window or blocked storage: the prompt may show again, which is fine
  }
};

const quiet = (): boolean => document.body.classList.contains('demo') || document.body.classList.contains('landing');

let card: HTMLElement | null = null;

function close(): void {
  card?.remove();
  card = null;
}

function show(label: string, html: string): HTMLElement {
  close();
  card = document.createElement('aside');
  card.className = 'prompt-card';
  card.setAttribute('aria-label', label);
  card.innerHTML = `${html}<button class="prompt-x" type="button" aria-label="Dismiss">&times;</button>`;
  card.querySelector('.prompt-x')!.addEventListener('click', close);
  document.body.append(card);
  return card;
}

/** A scan was kept (Keep all, or a review finished). */
export function noteScanKept(): void {
  if (quiet() || read(SEEN_AI)) return;
  write(SEEN_AI, Date.now());
  const el = show(
    'AI counting is coming',
    `<p class="prompt-t">AI counting is coming to the browser</p>
    <p>Scan counts one symbol at a time. AI counting will propose every door, window and fixture for you to check. Hear when it lands:</p>
    <form class="prompt-form" action="https://flowtivity.ai/api/blog/subscribe/" method="post" target="_blank" rel="noopener">
      <label class="prompt-sr" for="nudgeEmail">Email</label>
      <input type="email" id="nudgeEmail" name="email" required autocomplete="email" placeholder="you@company.com.au" />
      <button class="btn primary" type="submit">Keep me posted</button>
      <input type="hidden" name="post" value="pdf2takeoff-app-scan" />
      <span class="prompt-hp" aria-hidden="true"><input type="text" name="website" tabindex="-1" autocomplete="off" /></span>
    </form>
    <p class="prompt-fine">Announced in Flowtivity's Friday digest, one email a week, unsubscribe anytime. Your email goes to Flowtivity; your drawings stay on this computer.</p>`,
  );
  // the confirmation opens in its own tab; this one goes back to the takeoff
  el.querySelector('form')!.addEventListener('submit', () => setTimeout(close, 0));
}

/** Something was exported or saved. */
export function noteExport(): void {
  if (quiet()) return;
  const last = read(SEEN_TALK);
  if (last && Date.now() - last < WEEK) return;
  write(SEEN_TALK, Date.now());
  const el = show(
    'Talk to Flowtivity',
    `<p class="prompt-t">Estimating at volume?</p>
    <p>Flowtivity, the team behind pdf2takeoff, automates takeoff and quoting for estimating teams.</p>
    <a class="btn primary" href="https://flowtivity.ai/contact/?utm_source=pdf2takeoff&amp;utm_medium=app&amp;utm_campaign=after-export" target="_blank" rel="noopener">Book a free consult</a>`,
  );
  el.querySelector('a')!.addEventListener('click', () => setTimeout(close, 0));
}

export function initNudges(): void {
  // the real export buttons (the top bar's Export menu proxies click these too);
  // a moment's delay lets the download or report open first
  for (const id of ['exportXlsxBtn', 'exportCsvBtn', 'copyTsvBtn', 'reportBtn', 'savePdfBtn', 'templateExportBtn', 'templateCopyBtn']) {
    document.getElementById(id)?.addEventListener('click', () => setTimeout(noteExport, 1200));
  }
}
