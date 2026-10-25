// Printable takeoff report: renders every sheet that carries markups
// (drawing + markup overlay) into a standalone HTML document with per-sheet
// quantity tables and consolidated totals. Opened in a new tab, print /
// save-as-PDF via the browser — the report is the deliverable estimators
// attach to a tender or a review email.

import { state, type Markup, type Pt, calibrationFor, calibrationForMarkup, takeoffData } from './state';
import { getPdfDoc } from './viewer';
import { COLORS, countNumberFor } from './render';
import { buildMatrix, formatMarkupValue } from '../engine/export';
import { fileStem } from './inputs';

const MAX_LONG_EDGE_PX = 1400;

export async function exportReport(): Promise<void> {
  const doc = getPdfDoc();
  if (!doc || !state.markups.length) return;

  const pages = [...new Set(state.markups.map((m) => m.page))].sort((a, b) => a - b);
  const sheets: string[] = [];
  for (const pageNum of pages) {
    sheets.push(await renderSheet(doc, pageNum));
  }

  const date = new Date().toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(baseName())} | takeoff report</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #0f172a; }
  .wrap { max-width: 1100px; margin: 0 auto; padding: 28px 32px 48px; }
  .doc-head { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; border-bottom: 3px solid #0a1220; padding-bottom: 12px; }
  .brand { font-weight: 800; letter-spacing: 0.02em; background: linear-gradient(90deg, #2dd4bf, #38bdf8); -webkit-background-clip: text; background-clip: text; color: transparent; }
  .doc-head h1 { font-size: 20px; margin: 0; }
  .meta { color: #475569; font-size: 12.5px; }
  .print-btn { margin-left: auto; border: 0; border-radius: 999px; padding: 9px 20px; font-weight: 700; color: #06281f; background: linear-gradient(90deg, #2dd4bf, #38bdf8); cursor: pointer; }
  h2 { font-size: 15px; margin: 26px 0 8px; }
  h2 .scale { font-weight: 400; color: #475569; font-size: 12.5px; margin-left: 10px; }
  table { border-collapse: collapse; width: 100%; font-size: 12.5px; }
  th, td { text-align: left; padding: 5px 10px; border-bottom: 1px solid #e2e8f0; }
  th { color: #475569; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
  td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; }
  .sheet img { width: 100%; border: 1px solid #cbd5e1; border-radius: 4px; margin: 8px 0 12px; background: #fff; }
  .totals td { font-weight: 600; }
  .totals tr.group td { font-weight: 400; }
  .totals tr:last-child td { border-bottom: 0; }
  footer { margin-top: 36px; color: #64748b; font-size: 11.5px; border-top: 1px solid #e2e8f0; padding-top: 10px; }
  .section-totals { page-break-inside: avoid; }
  @media print {
    .print-btn { display: none; }
    .wrap { max-width: none; padding: 0; }
    .sheet { page-break-before: always; }
    .sheet:first-of-type { page-break-before: avoid; }
  }
</style>
</head>
<body>
<div class="wrap">
  <header class="doc-head">
    <span class="brand">pdf2takeoff</span>
    <h1>Quantity report: ${escapeHtml(state.fileName || 'Takeoff')}</h1>
    <button class="print-btn" onclick="window.print()">Print / Save as PDF</button>
    <div class="meta" style="width:100%">${date} · ${state.pageCount} sheet${state.pageCount === 1 ? '' : 's'} in set ·
      ${state.markups.length} measurement${state.markups.length === 1 ? '' : 's'} on ${pages.length} sheet${pages.length === 1 ? '' : 's'} · units: ${state.displayUnit}</div>
  </header>

  <div class="section-totals">
    <h2>Totals by group</h2>
    ${totalsTable()}
  </div>

  ${sheets.join('\n')}

  <footer>Made with pdf2takeoff.com, free takeoff software by Flowtivity. Generated locally (open source, Apache-2.0); drawings are never uploaded. Verify quantities against the drawing before pricing.</footer>
</div>
</body>
</html>`;

  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  window.open(url, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function renderSheet(
  doc: NonNullable<Awaited<ReturnType<typeof getPdfDoc>>>,
  pageNum: number,
): Promise<string> {
  const page = await doc.getPage(pageNum);
  const vp1 = page.getViewport({ scale: 1 });
  const scale = Math.min(2, MAX_LONG_EDGE_PX / Math.max(vp1.width, vp1.height));
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  const ctx = canvas.getContext('2d')!;
  // background via the render param — touching the context before render()
  // makes pdf.js v5 never deliver the completion chunk, hanging the promise
  await page.render({ canvas, canvasContext: ctx, viewport: vp, background: '#ffffff' }).promise;

  const markups = state.markups.filter((m) => m.page === pageNum);
  for (const m of markups) drawMarkup(ctx, vp, scale, m);

  const cal = calibrationFor(pageNum);
  const rows = markups
    .map((m) => {
      const v = displayValue(m);
      return `<tr><td>${escapeHtml(m.label)}</td><td>${m.type}</td><td class="n">${v || '<span style="color:#b45309">not calibrated</span>'}</td></tr>`;
    })
    .join('\n');
  return `<section class="sheet">
  <h2>Sheet ${pageNum} of ${state.pageCount}<span class="scale">scale: ${escapeHtml(cal?.source ?? 'not calibrated')}</span></h2>
  <img src="${canvas.toDataURL('image/png')}" alt="Sheet ${pageNum} with markups" />
  <table>
    <thead><tr><th>Label</th><th>Type</th><th class="n">Value</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</section>`;
}

function drawMarkup(
  ctx: CanvasRenderingContext2D,
  vp: { convertToViewportPoint: (x: number, y: number) => number[] },
  scale: number,
  m: Markup,
): void {
  const color = COLORS[m.type] ?? '#333';
  const pts = m.points.map((p) => {
    const [x, y] = vp.convertToViewportPoint(p.x, p.y);
    return { x, y };
  });
  if (pts.length === 0) return;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (m.type === 'length') {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6 * scale;
    ctx.stroke();
    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1.8 * scale, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }
    const mid = pts[Math.max(0, pts.length - 2)] ?? pts[0];
    const end = pts[pts.length - 1] ?? mid;
    label(ctx, scale, labelText(m), { x: (mid.x + end.x) / 2, y: (mid.y + end.y) / 2 });
  } else if (m.type === 'area') {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y);
    ctx.closePath();
    ctx.globalAlpha = 0.13;
    ctx.fillStyle = color;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6 * scale;
    ctx.stroke();
    label(ctx, scale, labelText(m), centroid(pts));
  } else {
    const p = pts[0];
    ctx.beginPath();
    ctx.arc(p.x, p.y, 7 * scale, 0, Math.PI * 2);
    ctx.globalAlpha = 0.92;
    ctx.fillStyle = color;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.font = `700 ${8 * scale}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    ctx.fillText(String(countNumberFor(m)), p.x, p.y);
  }
}

function label(ctx: CanvasRenderingContext2D, scale: number, text: string, at: Pt): void {
  ctx.font = `600 ${8 * scale}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.lineWidth = 2.6 * scale;
  ctx.strokeStyle = '#ffffff';
  ctx.lineJoin = 'round';
  ctx.strokeText(text, at.x, at.y - 8 * scale);
  ctx.fillStyle = '#111827';
  ctx.fillText(text, at.x, at.y - 8 * scale);
}

function labelText(m: Markup): string {
  const v = displayValue(m);
  return v ? `${m.label}: ${v}` : m.label;
}

function displayValue(m: Markup): string {
  return formatMarkupValue(m, calibrationForMarkup(m), state.displayUnit);
}

function centroid(pts: Pt[]): Pt {
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p.x;
    y += p.y;
  }
  return { x: x / pts.length, y: y / pts.length };
}

function totalsTable(): string {
  const matrix = buildMatrix(takeoffData());
  const groupStart = matrix.findIndex((r) => r[0] === 'Group');
  const groups = groupStart >= 0 ? matrix.slice(groupStart + 1) : [];
  const rows = groups
    .map((r) => {
      const [label, type, items, total, unit] = r;
      const totalText =
        total === '' ? '<span style="color:#b45309">not calibrated</span>' : `${total} ${unit}`;
      return `<tr class="group"><td>${escapeHtml(String(label))}</td><td>${escapeHtml(String(type))}</td><td class="n">${items}</td><td class="n">${totalText}</td></tr>`;
    })
    .join('\n');
  return `<table class="totals">
    <thead><tr><th>Group</th><th>Type</th><th class="n">Items</th><th class="n">Total</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function baseName(): string {
  return fileStem(state.fileName) || 'takeoff';
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
