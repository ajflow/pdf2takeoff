// Self-tests for the B2 room-area scorer (node --test evals/score-rooms.test.mjs).
// Two jobs: (1) prove the geometry against analytic values and every failure
// mode, (2) frozen evidence — re-scoring the committed fixture must reproduce
// the committed score byte-for-byte, so scorer changes cannot silently move
// old numbers. See evals/README.md.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  ringArea, intersectionArea, boundaryDistance, ringValid,
  scoreRooms, serializeScore,
} from './score-rooms.mjs';

const sq = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const P = (arr) => arr.map(([x, y]) => ({ x, y }));
const SHA = 'f'.repeat(64);
const makeRef = (rooms, tolerances = { area_percent: 1, overlap_iou: 0.985, boundary_max_pt: 1 }) => ({
  schema_version: 1, eval: 'room-area', source_pdf_sha256: SHA, page: 1,
  pdf_points: { page_width: 100, page_height: 100 }, rooms, tolerances,
});
const makeCand = (rooms) => ({ schema_version: 1, eval: 'room-area', source_pdf_sha256: SHA, rooms });

// ---------- geometry primitives ----------

test('shoelace area: 4×4 square = 16', () => {
  assert.equal(ringArea(P(sq(0, 0, 4, 4))), 16);
});

const approx = (actual, expected, eps = 1e-9) => assert.ok(
  Math.abs(actual - expected) < eps,
  `${actual} ≉ ${expected}`,
);

test('intersection: square ∩ L-shape = 12 (concave clipper path)', () => {
  const square = P(sq(1, 1, 5, 5)); // area 16
  const lShape = P([[1, 1], [9, 1], [9, 3], [3, 3], [3, 9], [1, 9]]); // area 28
  // square minus the 2×2 top-right notch (x>3, y>3) = 16 − 4
  approx(intersectionArea(square, lShape), 12);
  approx(intersectionArea(lShape, square), 12); // symmetric
});

test('intersection: same-bbox triangle vs square → inter 2, IoU exactly 0.5', () => {
  const square = P(sq(0, 0, 2, 2)); // 4
  const triangle = P([[0, 0], [2, 0], [0, 2]]); // 2, inscribed
  const inter = intersectionArea(triangle, square);
  approx(inter, 2);
  approx(inter / (4 + 2 - inter), 0.5);
});

test('intersection: disjoint polygons → 0', () => {
  approx(intersectionArea(P(sq(0, 0, 2, 2)), P(sq(5, 5, 7, 7))), 0);
});

test('boundary distance: unit square vs (1,1) shift = √2 (both directions)', () => {
  assert.ok(Math.abs(boundaryDistance(P(sq(0, 0, 1, 1)), P(sq(1, 1, 2, 2))) - Math.SQRT2) < 1e-9);
});

// ---------- ring validity ----------

test('ringValid: rejects bowtie, repeated vertex, <3 vertices, non-finite', () => {
  // asymmetric bowtie (a symmetric one has zero area and trips that gate first)
  assert.match(ringValid([[0, 0], [4, 2], [4, 0], [0, 4]]).reason, /self-intersecting/);
  assert.match(ringValid([[0, 0], [0, 0], [4, 4], [4, 0]]).reason, /repeated vertex/);
  assert.match(ringValid([[0, 0], [4, 0]]).reason, /fewer than 3/);
  assert.match(ringValid([[0, 0], [4, NaN], [4, 4]]).reason, /non-finite/);
  assert.equal(ringValid(sq(0, 0, 4, 4)).ok, true);
});

// ---------- scoring failure modes ----------

const roomA = { label: 'A', seed_pt: [2, 2], truth_pts: sq(0, 0, 4, 4), truth_area_pt2: 16 };

test('exact candidate → pass, zero failures', () => {
  const r = scoreRooms(makeRef([roomA]), makeCand([{ label: 'A', polygon_pts: sq(0, 0, 4, 4) }]));
  assert.equal(r.verdict, 'pass');
  assert.equal(r.failures.length, 0);
  assert.equal(r.summary.passed, 1);
});

test('shifted equal-area square: area gate passes, IoU + boundary fail', () => {
  const r = scoreRooms(makeRef([roomA]), makeCand([{ label: 'A', polygon_pts: sq(2, 0, 6, 4) }]));
  assert.equal(r.verdict, 'fail');
  const f = r.failures.find((x) => x.type === 'gate_failed');
  assert.deepEqual(f.failed, ['iou', 'boundary']);
  assert.equal(r.rooms[0].gates.area, true);
  assert.equal(r.rooms[0].metrics.area_pct, 0);
});

test('same-bbox wrong shape: all three gates fail', () => {
  const r = scoreRooms(makeRef([roomA]), makeCand([{ label: 'A', polygon_pts: [[0, 0], [4, 0], [0, 4]] }]));
  const f = r.failures.find((x) => x.type === 'gate_failed');
  assert.deepEqual(f.failed, ['area', 'iou', 'boundary']);
});

test('missing, duplicate, extra, engine-error, invalid rings each fail independently', () => {
  const ref = makeRef([roomA, { label: 'B', seed_pt: [8, 8], truth_pts: sq(6, 6, 10, 10), truth_area_pt2: 16 }]);
  const r = scoreRooms(ref, makeCand([
    { label: 'A', polygon_pts: sq(0, 0, 4, 4) }, // pass
    { label: 'A', polygon_pts: sq(0, 0, 4, 4) }, // duplicate A
    { label: 'C', polygon_pts: sq(0, 0, 4, 4) }, // extra
  ]));
  const types = r.failures.map((f) => f.type).sort();
  assert.deepEqual(types, ['duplicate_label', 'extra_label', 'missing_label']);

  const r2 = scoreRooms(ref, makeCand([{ label: 'A', error: 'not bounded' }, { label: 'B', polygon_pts: [[0, 0], [2, 2], [2, 0], [0, 2]] }]));
  assert.deepEqual(r2.failures.map((f) => f.type).sort(), ['engine_error', 'invalid_ring']);
});

test('sha mismatch: single failure, everything else unscored', () => {
  const r = scoreRooms(makeRef([roomA]), { ...makeCand([{ label: 'A', polygon_pts: sq(0, 0, 4, 4) }]), source_pdf_sha256: '0'.repeat(64) });
  assert.deepEqual(r.failures.map((f) => f.type), ['sha_mismatch']);
  assert.equal(r.verdict, 'fail');
});

test('serializeScore is deterministic: two scorings, identical bytes', () => {
  const ref = makeRef([roomA]);
  const cand = makeCand([{ label: 'A', polygon_pts: sq(0.2, 0.1, 3.9, 4) }]);
  assert.equal(serializeScore(scoreRooms(ref, cand)), serializeScore(scoreRooms(ref, cand)));
});

// ---------- frozen evidence ----------

const here = dirname(fileURLToPath(import.meta.url));
const FIX = join(here, 'fixtures');

test('frozen evidence: committed fixture re-scores byte-for-byte', () => {
  const reference = JSON.parse(readFileSync(join(FIX, 'frozen.reference.json'), 'utf8'));
  const candidate = JSON.parse(readFileSync(join(FIX, 'frozen.candidate.json'), 'utf8'));
  const frozen = readFileSync(join(FIX, 'frozen.score.json'), 'utf8');
  assert.equal(serializeScore(scoreRooms(reference, candidate)), frozen);
});

// ---------- CLI ----------

test('CLI: pass fixture exits 0, fail exits 1, --out matches serializeScore', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eval-rooms-'));
  const passCand = join(dir, 'pass.json');
  const failCand = join(dir, 'fail.json');
  const out = join(dir, 'score.json');
  writeFileSync(passCand, JSON.stringify(makeCand([{ label: 'A', polygon_pts: sq(0, 0, 4, 4) }])));
  writeFileSync(join(dir, 'ref.json'), JSON.stringify(makeRef([roomA])));
  writeFileSync(failCand, JSON.stringify(makeCand([{ label: 'A', polygon_pts: sq(9, 9, 13, 13) }])));

  const ok = spawnSync(process.execPath, [join(here, 'score-rooms.mjs'), passCand, '--reference', join(dir, 'ref.json'), '--out', out], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /verdict: PASS/);
  const result = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(result.verdict, 'pass');

  const bad = spawnSync(process.execPath, [join(here, 'score-rooms.mjs'), failCand, '--reference', join(dir, 'ref.json')], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /verdict: FAIL/);
});
