// ScaledDrawingBench scorer. Predictions are JSONL lines { id, answer }:
// a number (in the question's unit), a list of change strings for compare
// questions, or "unanswerable" / null to abstain. Extra fields are ignored.
//
// Per question type: share within 2 percent and within 5 percent of the key,
// MAPE and median APE over answered questions, exact match for counts, set
// F1 for compare questions. An abstention on an answerable question counts
// as wrong; a number given for a question that is unanswerable by design is
// a hallucination, reported as a rate over the unanswerable questions.
// Strata: vector vs raster, scale notation, degradation recipe.

import { readFileSync } from 'node:fs';

export function loadPredictions(path) {
  const map = new Map();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const p = JSON.parse(line);
    if (p && typeof p.id === 'string') map.set(p.id, p);
  }
  return map;
}

/** Normalise a raw answer: { kind: 'abstain' | 'number' | 'set' | 'invalid', value }. */
export function normaliseAnswer(raw) {
  if (raw === null || raw === undefined) return { kind: 'abstain' };
  if (typeof raw === 'object' && !Array.isArray(raw) && 'answer' in raw) return normaliseAnswer(raw.answer);
  if (Array.isArray(raw)) return { kind: 'set', value: new Set(raw.map((s) => String(s).trim().toLowerCase()).filter(Boolean)) };
  if (typeof raw === 'number') return Number.isFinite(raw) ? { kind: 'number', value: raw } : { kind: 'invalid' };
  if (typeof raw === 'string') {
    const s = raw.trim().toLowerCase();
    if (!s || s === 'unanswerable' || s === 'n/a' || s === 'none' || s === 'unknown') return { kind: 'abstain' };
    const num = s.replace(/,/g, '').match(/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/);
    if (num) return { kind: 'number', value: parseFloat(num[0]) };
    if (s.includes('|')) return normaliseAnswer(s.split('|'));
    return { kind: 'invalid' };
  }
  return { kind: 'invalid' };
}

const NUMERIC_TYPES = new Set(['scale', 'length', 'area', 'perimeter', 'dimension_read']);

function judge(q, pred) {
  const a = normaliseAnswer(pred?.answer);
  const unanswerable = q.answer === 'unanswerable';
  const r = { id: q.id, type: q.type, unanswerable, answered: a.kind !== 'abstain', hallucination: false, correct: false, ape: null, f1: null, exact: null };
  if (unanswerable) {
    r.hallucination = a.kind === 'number' || a.kind === 'set';
    r.correct = !r.hallucination;
    return r;
  }
  if (a.kind === 'abstain' || a.kind === 'invalid') return r;
  if (q.type === 'compare') {
    const gt = new Set(q.answer.map((s) => s.toLowerCase()));
    const got = a.kind === 'set' ? a.value : new Set();
    let tp = 0;
    for (const s of got) if (gt.has(s)) tp++;
    const prec = got.size ? tp / got.size : 0;
    const rec = gt.size ? tp / gt.size : 0;
    r.f1 = prec + rec ? (2 * prec * rec) / (prec + rec) : 0;
    r.exact = r.f1 === 1;
    r.correct = r.exact;
    return r;
  }
  if (a.kind !== 'number') return r;
  const gt = Number(q.answer);
  if (q.type === 'count') {
    r.exact = Math.round(a.value) === gt;
    r.ape = gt === 0 ? (a.value === 0 ? 0 : 1) : Math.abs(a.value - gt) / gt;
    r.correct = r.exact;
    return r;
  }
  r.ape = gt === 0 ? (a.value === 0 ? 0 : 1) : Math.abs(a.value - gt) / Math.abs(gt);
  const tol = q.tolerance ?? 0.02;
  r.within2 = r.ape <= 0.02 + 1e-9;
  r.within5 = r.ape <= 0.05 + 1e-9;
  r.exact = r.ape <= tol + 1e-9;
  r.correct = r.within2;
  return r;
}

function aggregate(rows) {
  const answerable = rows.filter((r) => !r.unanswerable);
  const unans = rows.filter((r) => r.unanswerable);
  const answered = answerable.filter((r) => r.answered);
  const apes = answered.map((r) => r.ape).filter((v) => v !== null && Number.isFinite(v));
  const sorted = [...apes].sort((a, b) => a - b);
  const f1s = answerable.filter((r) => r.type === 'compare').map((r) => (r.answered ? r.f1 : 0));
  const numeric = answerable.filter((r) => NUMERIC_TYPES.has(r.type));
  const counts = answerable.filter((r) => r.type === 'count');
  const pct = (num, den) => (den ? Math.round((1000 * num) / den) / 10 : null);
  return {
    n: rows.length,
    answerable: answerable.length,
    answered: answered.length,
    abstained: answerable.length - answered.length,
    accuracy: pct(answerable.filter((r) => r.correct).length, answerable.length),
    within2: numeric.length ? pct(numeric.filter((r) => r.answered && r.within2).length, numeric.length) : null,
    within5: numeric.length ? pct(numeric.filter((r) => r.answered && r.within5).length, numeric.length) : null,
    mape: apes.length ? Math.round((1000 * apes.reduce((s, v) => s + v, 0)) / apes.length) / 10 : null,
    medianApe: sorted.length ? Math.round(1000 * sorted[Math.floor(sorted.length / 2)]) / 10 : null,
    exact: counts.length ? pct(counts.filter((r) => r.answered && r.exact).length, counts.length) : null,
    f1: f1s.length ? Math.round((1000 * f1s.reduce((s, v) => s + v, 0)) / f1s.length) / 10 : null,
    unanswerable: unans.length,
    hallucinations: unans.filter((r) => r.hallucination).length,
    hallucinationRate: unans.length ? pct(unans.filter((r) => r.hallucination).length, unans.length) : null,
  };
}

const TYPES = ['scale', 'length', 'area', 'perimeter', 'count', 'dimension_read', 'compare'];

export function scorePredictions(questions, preds, manifest, meta = {}) {
  const sheetOf = new Map((manifest?.sheets ?? []).map((s) => [s.id, s]));
  const rows = questions.map((q) => {
    const r = judge(q, preds.get(q.id));
    const s = sheetOf.get(q.sheet);
    r.sheet = q.sheet;
    r.half = s?.kind ?? 'unknown';
    r.notation = s?.notation ?? 'unknown';
    r.recipe = s?.recipe ?? (s?.kind === 'vector' ? 'none' : 'unknown');
    r.missing = !preds.has(q.id);
    return r;
  });
  const byType = (list) => Object.fromEntries(TYPES.filter((t) => list.some((r) => r.type === t)).map((t) => [t, aggregate(list.filter((r) => r.type === t))]));
  const halves = [...new Set(rows.map((r) => r.half))];
  const result = {
    benchmark: 'ScaledDrawingBench',
    version: manifest?.version ?? null,
    seed: manifest?.seed ?? null,
    system: meta.system ?? 'submission',
    questions: rows.length,
    missingPredictions: rows.filter((r) => r.missing).length,
    overall: aggregate(rows),
    byType: byType(rows),
    byHalf: Object.fromEntries(halves.map((h) => [h, { overall: aggregate(rows.filter((r) => r.half === h)), byType: byType(rows.filter((r) => r.half === h)) }])),
    byNotation: Object.fromEntries([...new Set(rows.map((r) => r.notation))].map((k) => [k, aggregate(rows.filter((r) => r.notation === k))])),
    byRecipe: Object.fromEntries([...new Set(rows.map((r) => r.recipe))].map((k) => [k, aggregate(rows.filter((r) => r.recipe === k))])),
    notes: meta.notes ?? [],
    seconds: meta.seconds ? Math.round(meta.seconds) : undefined,
    rows,
  };
  return result;
}

const fmt = (v, suffix = '') => (v === null || v === undefined ? 'n/a' : `${v}${suffix}`);

function table(agg, label) {
  return `| ${label} | ${agg.answerable} | ${agg.answered} | ${fmt(agg.within2, '%')} | ${fmt(agg.within5, '%')} | ${fmt(agg.mape, '%')} | ${fmt(agg.exact, '%')} | ${fmt(agg.f1, '%')} | ${fmt(agg.accuracy, '%')} | ${agg.unanswerable ? `${agg.hallucinations}/${agg.unanswerable}` : 'n/a'} |`;
}

export function renderMarkdown(result) {
  const head = '| Type | Answerable | Answered | Within 2% | Within 5% | MAPE | Exact | Set F1 | Accuracy | Hallucinated / unanswerable |\n|---|---|---|---|---|---|---|---|---|---|';
  const lines = [];
  lines.push(`# ScaledDrawingBench v${result.version ?? '?'} results: ${result.system}`);
  lines.push('');
  lines.push(`${result.questions} questions (seed ${result.seed ?? '?'}); ${result.missingPredictions} without a prediction${result.seconds ? `; ${result.seconds} s` : ''}.`);
  lines.push('');
  lines.push('Accuracy is within 2 percent for scale, length, area, perimeter and dimension_read, exact match for count, and an exact change set for compare; abstentions on answerable questions count as wrong. MAPE is over answered questions. The last column counts numeric or list answers given to questions that are unanswerable by design.');
  lines.push('');
  for (const [half, data] of Object.entries(result.byHalf)) {
    lines.push(`## ${half} half`);
    lines.push('');
    lines.push(head);
    for (const [t, agg] of Object.entries(data.byType)) lines.push(table(agg, t));
    lines.push(table(data.overall, 'all'));
    lines.push('');
  }
  lines.push('## Overall');
  lines.push('');
  lines.push(head);
  for (const [t, agg] of Object.entries(result.byType)) lines.push(table(agg, t));
  lines.push(table(result.overall, 'all'));
  lines.push('');
  lines.push('## By scale notation');
  lines.push('');
  lines.push('| Notation | Answerable | Accuracy | Within 2% | MAPE | Hallucinated / unanswerable |\n|---|---|---|---|---|---|');
  for (const [k, agg] of Object.entries(result.byNotation)) lines.push(`| ${k} | ${agg.answerable} | ${fmt(agg.accuracy, '%')} | ${fmt(agg.within2, '%')} | ${fmt(agg.mape, '%')} | ${agg.unanswerable ? `${agg.hallucinations}/${agg.unanswerable}` : 'n/a'} |`);
  lines.push('');
  lines.push('## By degradation recipe');
  lines.push('');
  lines.push('| Recipe | Answerable | Accuracy | Within 2% | MAPE |\n|---|---|---|---|---|');
  for (const [k, agg] of Object.entries(result.byRecipe)) lines.push(`| ${k} | ${agg.answerable} | ${fmt(agg.accuracy, '%')} | ${fmt(agg.within2, '%')} | ${fmt(agg.mape, '%')} |`);
  lines.push('');
  if (result.notes?.length) {
    lines.push('## Notes');
    lines.push('');
    for (const n of result.notes) lines.push(`- ${n}`);
    lines.push('');
  }
  return lines.join('\n');
}
