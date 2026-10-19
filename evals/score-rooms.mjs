#!/usr/bin/env node
// B2 scorer: exact-polygon scoring of a room-area candidate against an
// analytic reference. Zero dependencies. Reimplemented from textbook
// algorithms (shoelace, Sutherland–Hodgman clipping, ear-clipping
// triangulation, point-segment distance) — deliberately NOT ported from
// any competitor harness (opentakeoff's is AGPL; this repo stays Apache-2.0).
// See evals/README.md and docs/research/bench-patch-plan.md (patch B2).
//
// Per matched room, three gates (tolerances live in the reference):
//   area_pct   |candArea − truthArea| / truthArea × 100  ≤ area_percent
//   iou        intersection / union                      ≥ overlap_iou
//   boundary   max vertex-to-opposite-edge distance,     ≤ boundary_max_pt
//              both directions (a bounded profile, not Hausdorff)
// Independent failure types: sha_mismatch, duplicate_label, missing_label,
// engine_error, invalid_ring, gate_failed, extra_label. Exit 1 on any.
// Output is deterministic byte-for-byte (fixed ordering, 6-dp rounding) so
// committed scores are frozen evidence — see score-rooms.test.mjs.

// ---------- geometry primitives ----------

const r6 = (v) => Math.round(v * 1e6) / 1e6;

export function signedArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}
export const ringArea = (pts) => Math.abs(signedArea(pts));

/** Normalize to counter-clockwise (the orientation every op below assumes). */
export function toCCW(pts) {
  return signedArea(pts) < 0 ? [...pts].reverse() : pts;
}

export function isConvex(pts) {
  if (pts.length < 3) return false;
  let pos = 0, neg = 0;
  for (let i = 0; i < pts.length; i++) {
    const o = pts[i], a = pts[(i + 1) % pts.length], b = pts[(i + 2) % pts.length];
    const c = (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    if (c > 1e-12) pos++; else if (c < -1e-12) neg++;
    if (pos && neg) return false;
  }
  return true;
}

export function pointSegDistance(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Max over P's vertices of the distance to the nearest edge of Q. */
export function vertexEdgeDistance(P, Q) {
  let max = 0;
  for (const p of P) {
    let min = Infinity;
    for (let i = 0; i < Q.length; i++) {
      const d = pointSegDistance(p, Q[i], Q[(i + 1) % Q.length]);
      if (d < min) min = d;
    }
    if (min > max) max = min;
  }
  return max;
}
export const boundaryDistance = (P, Q) => Math.max(vertexEdgeDistance(P, Q), vertexEdgeDistance(Q, P));

/** Sutherland–Hodgman: clip `subject` (any polygon) by convex CCW `clipper`. */
export function clipConvex(subject, clipper) {
  let out = subject.slice();
  for (let i = 0; i < clipper.length && out.length; i++) {
    const A = clipper[i], B = clipper[(i + 1) % clipper.length];
    const side = (p) => (B.x - A.x) * (p.y - A.y) - (B.y - A.y) * (p.x - A.x);
    const input = out;
    out = [];
    for (let j = 0; j < input.length; j++) {
      const P = input[j], Q = input[(j + 1) % input.length];
      const sp = side(P), sq = side(Q);
      if (sp >= 0) out.push(P);
      if ((sp > 0 && sq < 0) || (sp < 0 && sq > 0)) {
        const t = sp / (sp - sq);
        out.push({ x: P.x + t * (Q.x - P.x), y: P.y + t * (Q.y - P.y) });
      }
    }
  }
  return out;
}

/** Ear-clipping triangulation of a simple CCW polygon. */
export function triangulate(pts) {
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const inTri = (p, a, b, c) => {
    const d1 = cross(a, b, p), d2 = cross(b, c, p), d3 = cross(c, a, p);
    return !(((d1 < 0) || (d2 < 0) || (d3 < 0)) && ((d1 > 0) || (d2 > 0) || (d3 > 0)));
  };
  const idx = pts.map((_, i) => i);
  const tris = [];
  let guard = 0;
  while (idx.length > 3 && guard++ < 1000 * pts.length) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length], ib = idx[i], ic = idx[(i + 1) % idx.length];
      const A = pts[ia], B = pts[ib], C = pts[ic];
      if (cross(A, B, C) <= 1e-12) continue; // reflex or collinear — not an ear
      let ear = true;
      for (const j of idx) {
        if (j === ia || j === ib || j === ic) continue;
        if (inTri(pts[j], A, B, C)) { ear = false; break; }
      }
      if (ear) {
        tris.push([A, B, C]);
        idx.splice(i, 1);
        clipped = true;
        break;
      }
    }
    if (!clipped) break; // degenerate ring; score what we have (validity gate ran first)
  }
  if (idx.length === 3) tris.push([pts[idx[0]], pts[idx[1]], pts[idx[2]]]);
  return tris;
}

/** Exact intersection area of two simple polygons (either may be concave). */
export function intersectionArea(P, Q) {
  const p = toCCW(P), q = toCCW(Q);
  const trisOf = (poly) => (isConvex(poly) ? [poly] : triangulate(poly));
  let sum = 0;
  for (const tp of trisOf(p)) for (const tq of trisOf(q)) sum += ringArea(clipConvex(tp, tq));
  return sum;
}

/** Proper crossing between any two non-adjacent edges (strict signs). */
export function selfIntersects(pts) {
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a1 = pts[i], a2 = pts[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      if (j === i || (j + 1) % n === i || i === (j + 1) % n) continue; // adjacent
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;           // share a vertex
      const b1 = pts[j], b2 = pts[(j + 1) % n];
      const d1 = cross(b1, b2, a1), d2 = cross(b1, b2, a2);
      const d3 = cross(a1, a2, b1), d4 = cross(a1, a2, b2);
      if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
    }
  }
  return false;
}

export function ringValid(rawPts) {
  if (!Array.isArray(rawPts) || rawPts.length < 3) return { ok: false, reason: 'fewer than 3 vertices' };
  const pts = rawPts.map((p) => ({ x: p.x ?? p[0], y: p.y ?? p[1] }));
  if (pts.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return { ok: false, reason: 'non-finite coordinate' };
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    if (Math.hypot(q.x - p.x, q.y - p.y) < 1e-9) return { ok: false, reason: `repeated vertex at index ${(i + 1) % pts.length}` };
  }
  if (ringArea(pts) <= 1e-9) return { ok: false, reason: 'zero area' };
  if (selfIntersects(pts)) return { ok: false, reason: 'self-intersecting ring' };
  return { ok: true, pts };
}

// ---------- scoring ----------

const asPts = (arr) => arr.map((p) => ({ x: p[0], y: p[1] }));

/** Deterministic ordering: sha, duplicates (sorted), per-reference-room
 *  (missing / engine_error / invalid_ring / gate_failed), extras (sorted). */
export function scoreRooms(reference, candidate) {
  const failures = [];
  const rooms = [];
  const fail = (room) => ({ label: room.label, status: 'failed', passed: false, ...room });

  if (candidate.source_pdf_sha256 !== reference.source_pdf_sha256) {
    return {
      schema: 'evals/score-rooms/1', eval: reference.eval ?? 'room-area',
      verdict: 'fail',
      summary: { rooms: reference.rooms.length, passed: 0, failed: reference.rooms.length },
      failures: [{ type: 'sha_mismatch', reference: reference.source_pdf_sha256, candidate: candidate.source_pdf_sha256 }],
      rooms: reference.rooms.map((r) => fail({ label: r.label })),
    };
  }

  const candRooms = candidate.rooms ?? [];
  const byLabel = new Map();
  for (const r of candRooms) {
    if (!byLabel.has(r.label)) byLabel.set(r.label, []);
    byLabel.get(r.label).push(r);
  }
  for (const label of [...byLabel.keys()].sort()) {
    if (byLabel.get(label).length > 1) {
      failures.push({ type: 'duplicate_label', label, count: byLabel.get(label).length });
    }
  }

  const tol = reference.tolerances;
  let passed = 0;
  for (const ref of reference.rooms) {
    const cands = byLabel.get(ref.label) ?? [];
    if (cands.length === 0) {
      failures.push({ type: 'missing_label', label: ref.label });
      rooms.push(fail({ label: ref.label }));
      continue;
    }
    const cand = cands[0];
    if (cand.error) {
      failures.push({ type: 'engine_error', label: ref.label, error: cand.error });
      rooms.push(fail({ label: ref.label }));
      continue;
    }
    const valid = ringValid(cand.polygon_pts ?? []);
    if (!valid.ok) {
      failures.push({ type: 'invalid_ring', label: ref.label, reason: valid.reason });
      rooms.push(fail({ label: ref.label }));
      continue;
    }
    const truthPts = asPts(ref.truth_pts);
    const candArea = ringArea(valid.pts);
    const truthArea = ref.truth_area_pt2;
    const inter = intersectionArea(valid.pts, truthPts);
    const union = candArea + truthArea - inter;
    const metrics = {
      area_pt2: r6(candArea),
      truth_area_pt2: truthArea,
      area_pct: r6((Math.abs(candArea - truthArea) / truthArea) * 100),
      iou: r6(union > 0 ? inter / union : 0),
      boundary_pt: r6(boundaryDistance(valid.pts, truthPts)),
    };
    const gates = {
      area: metrics.area_pct <= tol.area_percent,
      iou: metrics.iou >= tol.overlap_iou,
      boundary: metrics.boundary_pt <= tol.boundary_max_pt,
    };
    const ok = gates.area && gates.iou && gates.boundary;
    if (!ok) {
      failures.push({
        type: 'gate_failed',
        label: ref.label,
        failed: Object.entries(gates).filter(([, v]) => !v).map(([k]) => k),
      });
    } else passed++;
    rooms.push({ label: ref.label, status: 'scored', passed: ok, metrics, gates });
  }

  const refLabels = new Set(reference.rooms.map((r) => r.label));
  for (const label of [...byLabel.keys()].sort()) {
    if (!refLabels.has(label)) failures.push({ type: 'extra_label', label });
  }

  return {
    schema: 'evals/score-rooms/1',
    eval: reference.eval ?? 'room-area',
    verdict: failures.length ? 'fail' : 'pass',
    summary: { rooms: reference.rooms.length, passed, failed: reference.rooms.length - passed },
    failures,
    rooms,
  };
}

/** Canonical serialization — the byte-stability contract for frozen evidence. */
export const serializeScore = (result) => JSON.stringify(result, null, 2) + '\n';

// ---------- CLI ----------

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const args = process.argv.slice(2);
  const flag = (name, dflt) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
  };
  const VALUE_FLAGS = ['--reference', '--out'];
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (VALUE_FLAGS.includes(args[i])) { i++; continue; }
    if (args[i].startsWith('--')) continue;
    positional.push(args[i]);
  }
  const candidatePath = positional[0] ?? new URL('./artifacts/candidate-rooms.json', import.meta.url).pathname;
  const referencePath = flag('reference', new URL('./room-sheet.reference.json', import.meta.url).pathname);
  const outPath = flag('out', null);

  const { readFileSync, writeFileSync } = await import('node:fs');
  const reference = JSON.parse(readFileSync(referencePath, 'utf8'));
  const candidate = JSON.parse(readFileSync(candidatePath, 'utf8'));
  const result = scoreRooms(reference, candidate);

  const w = 8;
  console.log(`${'room'.padEnd(w)}${'area pt²'.padStart(12)}${'area %'.padStart(10)}${'IoU'.padStart(10)}${'bnd pt'.padStart(9)}  verdict`);
  for (const room of result.rooms) {
    const m = room.metrics;
    console.log(
      room.label.padEnd(w)
      + (m ? m.area_pt2.toFixed(1).padStart(12) + m.area_pct.toFixed(4).padStart(10) + m.iou.toFixed(6).padStart(10) + m.boundary_pt.toFixed(4).padStart(9) : ''.padEnd(41))
      + `  ${room.status === 'scored' ? (room.passed ? 'PASS' : 'FAIL') : room.status.toUpperCase()}`,
    );
  }
  for (const f of result.failures) {
    console.log(`failure: ${f.type}${f.label ? ` [${f.label}]` : ''}${f.reason ? ` — ${f.reason}` : ''}${f.failed ? ` — gates: ${f.failed.join(', ')}` : ''}${f.error ? ` — ${f.error}` : ''}`);
  }
  console.log(`verdict: ${result.verdict.toUpperCase()} (${result.summary.passed}/${result.summary.rooms} rooms, ${result.failures.length} failures)`);
  if (outPath) {
    writeFileSync(outPath, serializeScore(result));
    console.log(`score written: ${outPath}`);
  }
  process.exit(result.verdict === 'pass' ? 0 : 1);
}
