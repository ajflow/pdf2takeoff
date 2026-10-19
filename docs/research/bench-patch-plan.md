# Bench patch plan: building pdf2takeoff's published benchmark suite

> **Status 2026-10-19:** **B1–B8 shipped, all follow-ups closed or
> honestly dispositioned.** Milestone 2 (auto-seeded external run) was
> first attempted with a naive grid sweep and published as a **negative
> result**: no room-sized enclosure is fill-bounded on the benchmark sheet
> ([b6c](../../evals/runs/2026-10-19-aecgb-b6c/RESULT.md); the sweep stays
> in the adapter as the reproducible baseline). The b6d follow-up
> diagnosed that negative — it was over-closing shredding room interiors,
> not unbridgeable openings — and shipped the opening-detection patch
> (run-length-gated closing, escalation-past-pockets, 4-directional
> tracer), lifting the assisted anchor to pixel F1 0.539 / recall 0.392
> and **reversing the milestone-2 negative: the same unassisted sweep now
> finds 28 room-sized regions at pixel F1 0.882 / recall 0.935, instance
> F1 0.295 with zero human input**
> ([b6d](../../evals/runs/2026-10-19-aecgb-b6d/RESULT.md)).
> B8 shipped as the
> proposals UX:
> scan hits land flagged (⚑) as proposals — the existing ○/⚑/✓ cycle is
> the review vocabulary — and the markups totals show a live per-label
> **kept-rate** (kept/proposed; deletions are judged false positives,
> ✓ confirmations explicit accepts), persisted per file alongside the
> session and reset on clear/open. No competitor ships a per-run accuracy
> readout (market-scan §7 recommendation 3).
> `evals/` now holds: the run-log convention (B1);
> the analytic room-area eval (B2 — 6/6 rooms, area ≤ 0.51 %, IoU ≥ 0.9949,
> boundary ≤ 0.71 pt); the detector-accuracy bench with miss attribution
> (B3 — tier-1 precision 1.000, recall 0.249 clean / 0.179 degraded;
> misses = signature gate, wall merges, degradation → tier-2's job list);
> the committed baseline ratchet in CI (B4); the perf bench + perf.md with
> counts gated and ms informational (B5 — render 12.5 ms/page, scan
> 43.6 ms, fill 45.9 ms/room, compare 75.5 ms, round-trip 3 ms); and the
> external AEC-Geometric-Bench anchor (B6 — sheet_02 click-assisted:
> **area-pixel precision 0.9915**, recall 0.0388, instance F1 0.000;
> scored with Kamai's own scorer; predictions published, data never
> vendored or trained on); and the MCP workflow conformance bench
> (B7 — 18 contract checks over the real stdio server incl. the
> uncalibrated-measure contract and a fresh-process round-trip that
> surfaced a third product finding: calibration does not ride in the
> saved PDF — **now fixed**: the page calibration rides in markup comments
> (`[mpp:<exact double>]`) and restores at open everywhere (MCP reports
> `restoredCalibrations`; the app fills uncalibrated pages; guards in
> `scripts/roundtrip-check.mjs`; bench contract flipped, baseline
> deliberately ratcheted 18→15 calls —
> [b7](../../evals/runs/2026-10-19-mcp-b7/RESULT.md) /
> [b7b](../../evals/runs/2026-10-19-mcp-b7b/RESULT.md)).
> B6 surfaced four evidenced engine gaps that are
> now fixed with CI regression cases or parameterized: grey-line walls
> above the fixed 150 ink threshold (**fixed**: the engine escalates its
> ink threshold 150→185→220 while a fill is unbounded — explicit host
> thresholds are honoured exactly; CI regression case in
> `scripts/check-fill.mjs`; re-running the external anchor with zero host
> tuning improved it to instance F1 0.080 / pixel F1 0.115,
> [b6b run log](../../evals/runs/2026-10-19-aecgb-b6b/RESULT.md)); the
> 88 px gap-bridging ceiling vs 300-dpi/imperial door openings
> (parameterized: host `GapLadder`); over-closing that welded interior
> linework into false walls and shredded rooms into the furniture-scale
> pockets b6c measured as "no enclosures" (**fixed**: run-length-gated
> closing bridges only between long wall runs); and a contour tracer that
> could outline half a region through interior notches with a plausible
> area ratio (**fixed**: 4-directional wall-follower). Together the
> opening patch lifted the assisted anchor to **pixel F1 0.539, recall
> 0.392 (6.4×), instance F1 0.121**
> ([b6d run log](../../evals/runs/2026-10-19-aecgb-b6d/RESULT.md) —
> diagnosed with a rung sweep + truth-polygon gate analysis, never tuned
> against truth). All other baselines re-ran unchanged.
> Derived from the competitor-benchmark findings in
> [market-scan.md](market-scan.md) §7–8 and a source-level review of how
> rival harnesses work (opentakeoff `evals/`, Takeoff-Lens `benchmarks/`,
> open-pdf-studio perf tooling, OpenConstructionERP's ratchet, Kamai's
> AEC-Geometric-Bench scorer). Companion to [patch-plan.md](patch-plan.md).

Purpose: turn our unpublished numbers (val mAP in Kaggle notebooks, scan
latency in a blog draft, correctness gates in CI logs) into a public
`evals/` suite with a committed baseline ratchet, an external anchor, and a
run-log convention — the cheapest big move on the trust axis, where
opentakeoff scores 5/5 and we score 2.5.

## Licence rule for this whole plan (read first)

The two best harnesses are **AGPL** (opentakeoff, OpenConstructionERP) and
one is LGPL (open-pdf-studio). **We borrow their mechanics, never their
code** — porting AGPL source into this repo would make the repo AGPL.
Shoelace areas, Sutherland–Hodgman clipping, ear-clipping triangulation,
Hungarian-style nearest-first assignment and flat-baseline ratchets are
textbook algorithms: we implement fresh from the descriptions below.
Takeoff-Lens is MIT (its ~350-line stdlib matching core may be ported with
attribution). Kamai's scorer is Apache-2.0 but its data is CC BY-NC 4.0 —
the scorer and data both stay out of our repo (clone-alongside pattern).

## Findings in one screen

1. **Our bench axes are uncontested** (market-scan §7): no competitor
   publishes detection mAP, browser latency and model size together; only
   opentakeoff publishes anything comparable, and as end-to-end F1.
2. **The conformance-bench recipe is proven and small**: opentakeoff's
   scorer is ~350 lines of zero-dependency JS — synthetic sheet with
   ground truth analytic by construction (rooms = wall-face rectangles
   inset half the stroke width), exact polygon-intersection scoring
   (clip + triangulate), per-shape gates (area %, IoU, boundary px),
   independent failure modes (missing/duplicate/extra/invalid/holed), and
   self-tests including re-scoring frozen historical runs byte-for-byte.
3. **Our synthetic generator is half a detector bench already**:
   `generate-synthetic-dataset.mjs` emits exact-by-construction YOLO
   labels; Takeoff-Lens's matching design (centre-distance in PDF points,
   deterministic assignment, P/R/F1, miss attribution by pipeline stage)
   is a ~150–200-line Node port.
4. **AEC-Geometric-Bench is adoptable**: submissions are plain JSON
   (`objects` boxes, `areas`/`walls` polygons in the manifest px frame,
   ≈ PDF pt × 2.78); the scorer is Apache-2.0; nothing about it requires a
   VLM. Our flood-fill fits the **areas** track (opentakeoff's
   tool-assisted first pass: area-instance F1 0.667; Kamai's pipeline:
   0.93). Objects track is class-mismatched for us (architectural vs our
   electrical classes) — skip, say so. Walls: we emit `[]` and score an
   honest 0.
5. **Committed-baseline ratchets make perf/accuracy regressions visible in
   PRs**: OCE's flat `baseline.json` + absolute-drop gate (~120 lines) and
   opentakeoff's `git diff --exit-code` on committed `results.json`
   ("a ruler that silently stops matching the engine is worse than no
   ruler").
6. **The run-log convention is free and is what makes numbers publishable
   without overclaiming**: freeze input/output hashes before scoring, crop
   PNGs of disputed regions, RESULT.md with the caveat lines ("one run,
   not repeatability evidence", "reference not human-reviewed").

## The patches

Effort: S ≈ a day, M ≈ a few days, L ≈ a week+. Assumes familiarity with
the codebase. Ordered by implementation sequence, not importance.

### B1. `evals/` run-log convention + README — S

Pure convention, zero code. Establishes `evals/runs/<date>-<id>/` with
`FREEZE.sha256` (input PDFs, model manifest, outputs hashed *before*
scoring), score JSONs, overlay/crop PNGs of every disputed region, and
`RESULT.md` carrying the opentakeoff caveat lines. `evals/README.md`
states the method for every number we publish (data, split, seed,
hardware, cache state, engine version). This patch is first because every
later patch publishes through it.

*Files:* new `evals/`, `evals/README.md`, `evals/runs/.gitkeep`;
`.gitignore` for bulky artifacts.
*Borrows:* opentakeoff `FREEZE.json` / blind-runs / evidence-README
patterns (AGPL — convention only, no code).

### B2. Analytic room-area reference + exact-polygon scorer — M

The measurement-correctness anchor. A small
`evals/make-room-sheet.mjs` (in the spirit of opentakeoff's 66-line
zero-dep sample generator, ours via pdf-lib) draws a known roomed sheet —
rooms as wall rectangles with known stroke widths — and emits
`evals/room-sheet.reference.json`: sheet SHA-256, PDF-pt geometry,
per-room truth polygons inset half the stroke width, tolerances
(`area_percent`, `IoU`, `boundary_max_px`). `evals/score-rooms.mjs`
scores a candidate JSON: shoelace areas, convex clip + concave
triangulation for intersection area, boundary vertex-to-edge distance,
ring validity (self-intersection, repeats, holes), and independent
missing/duplicate/extra/invalid failures; exit 1 on any fail.
`evals/score-rooms.test.mjs` (`node:test`) asserts the failure modes —
equal-area-but-shifted fails IoU, same-bbox-wrong-shape fails, rounding-
quantum fixture — plus the frozen-evidence test: re-scoring a committed
historical run must reproduce its score JSON byte-for-byte.

This generalizes `scripts/check-fill.mjs` (one 12 %-tolerance room) into
a per-room numeric benchmark with tight, defensible tolerances, and gives
Dynamic Fill a published correctness number.

*Files:* new `evals/make-room-sheet.mjs`, `evals/score-rooms.mjs`,
`evals/score-rooms.test.mjs`, `evals/room-sheet.reference.json`;
optionally retires cases from `scripts/check-fill.mjs`.
*Borrows:* opentakeoff `make_sample_plan.py` + `score.mjs` + `score.test.mjs`
mechanics (**reimplement — AGPL**).

### B3. Detector accuracy bench on synthetic sheets — M

`evals/bench-detector.mjs` runs tier-1 CV and tier-2 ONNX (when
`public/models/` is populated) over K seeded generator sheets, matches
hits to the exact labels by centre distance in PDF points (match radius ≈
symbol half-width) with deterministic assignment (nearest-first
augmenting paths), and reports micro P/R/F1 per class per tier plus
FP/FN ids. The Takeoff-Lens jewel: **miss attribution** — instrument the
tier-1 filter chain and caps so every rejected candidate carries
`candidate_status` (`filtered` / `ranked_out` / `nms-merged` /
`capped`), so every FN says *why* it was missed. Output goes through B1's
run-log convention; the headline number is what the Kaggle val mAP story
has been missing — an end-to-end scan-accuracy figure computed against
exact labels, reproducible with `--seed`.

*Files:* new `evals/bench-detector.mjs`; light instrumentation in
`src/engine/scan.ts` (candidate status) and reuse of
`scripts/generate-synthetic-dataset.mjs` as-is.
*Borrows:* Takeoff-Lens `accuracy_benchmark.py` design (**MIT — portable
with attribution**).

### B4. Committed baseline ratchet in CI — S

`evals/baseline.json` — flat metrics from B2/B3 (+ existing gates):
`fill.area_pct_p95`, `det.tier1.f1`, `det.tier2.f1`, `roundtrip.count`,
perf determinism counts (tiles touched, detections per soak page).
`evals/compare.mjs` (~100 lines): absolute-drop gate (default 5 pp),
underscore-prefixed keys are metadata, **a metric present in baseline but
missing from the current report is itself a regression**, `--update-baseline`
to ratchet after deliberate improvements. CI runs B2/B3/B7 in one job and
gates via compare; a second opentakeoff-style gate commits
`evals/perf-results.json` and fails on uncommitted diff so a
perf-affecting PR carries its delta in the diff.

*Files:* new `evals/baseline.json`, `evals/compare.mjs`;
`.github/workflows/ci.yml` (+1 job).
*Borrows:* OpenConstructionERP `compare.py`/`baseline.json` pattern
(**reimplement — AGPL**); opentakeoff's committed-results diff gate
(same).

### B5. Perf results doc + determinism gate — S–M

Run `scripts/make-soak.mjs` at fixed seed + CLI `scan`/`compare` timings;
record medians and *deterministic counts* (not raw ms, which flap in CI)
in `evals/perf-results.json`; publish `evals/perf.md` in open-pdf-studio's
format: scope (PDFs, pages, fresh-process), discarded-runs-and-why, each
finding tied to a commit SHA with before/after. Include the numbers we
already have but haven't published anywhere: tier-1 ≈ 100 ms, tier-2
1.6 s cached / 4 s first (76 MB), with hardware + cache-state method.

*Files:* new `evals/perf-results.json`, `evals/perf.md`; uses
`scripts/make-soak.mjs` as-is.
*Borrows:* open-pdf-studio `docs/performance/*` discipline (**LGPL —
format only**).

### B6. AEC-Geometric-Bench adapter, areas track — M (assisted) / L (auto-seeded)

External anchor. `evals/aecgb/` with a frame-conversion script (PDF pt →
manifest px, ≈ ×2.78) and a predictions dir; the bench repo cloned
*alongside* (never vendored, never trained on — CC BY-NC). Milestone 1:
one sheet, click-assisted flood-fill seeds through our CLI/MCP, publish
area-instance F1 and area-pixel F1 through B1's convention, honestly
labelled "assisted" (that is exactly what opentakeoff's first pass was:
0.667 / 0.887 on sheet_02). Milestone 2: auto-seed rooms from vector-gap
analysis so the run is unassisted. Emit `walls: []`; skip the objects
track with a README sentence on the class mismatch.

*Files:* new `evals/aecgb/` (convert, predict-from-seeds, README);
reuses CLI `run`/`scan` + engine flood fill.
*Licence:* scorer Apache-2.0 (may study; we still don't vendor it), data
CC BY-NC 4.0 (eval-only; predictions + numbers are ours to publish).

### B7. MCP workflow conformance bench — M

Upgrade `scripts/mcp-smoke.mjs` into `evals/mcp-workflow-bench.mjs`:
drive the real local MCP server through the full takeoff workflow —
open → render → read_text scale → set_scale → measure per room → scan →
annotate → export → **fresh-process re-import with exact round-trip
equality** — asserting the expected refusals (measure before set_scale
must refuse; our calibration-required design is a feature to test). Write
a calls/timings ledger into the run dir. DevDependency
`@modelcontextprotocol/sdk` (already a runtime dep for the server — no
new weight) or drive the CLI to stay dep-free.

*Files:* new `evals/mcp-workflow-bench.mjs` (from
`scripts/mcp-smoke.mjs`).
*Borrows:* opentakeoff `run.mjs` shape (**reimplement — AGPL**).

### B8. (Adjacent, not bench-core) Live per-run accuracy readout — M

The app-side payoff of B3's instrumentation: Scan proposals carry
confidence; user accept/reject decisions over hits give a live
precision/recall readout per symbol type (the Takeoff-Lens pattern with
public numbers — nobody in the field ships this). Recorded through the
same `candidate_status` vocabulary, aggregated into the B1 run-log format
when the user opts in. Listed here so the instrumentation done in B3 is
designed with this consumer in mind; the UI work itself belongs to the
Scan-proposals roadmap item.

## Sequencing

1. **B1** (convention) — unblocks publishing everything after.
2. **B2 + B3** (the two scorers) — the substance.
3. **B4 + B5** (ratchet + perf doc) — wires substance into CI and docs.
   → *Checkpoint: publish `evals/README.md` with the full three-axis
   disclosure — the scorecard trust move.*
4. **B6** (external anchor, one sheet assisted) — the comparable number.
5. **B7** (MCP conformance) and **B8** (live readout) — depth.

## Deliberately not ported

- **OCE's nightly LLM judge** — paid API, secrets, non-determinism; every
  pdf2takeoff metric is geometric and deterministic. (Remember only the
  cost-cap-with-deterministic-fallback pattern if an agent-assisted eval
  ever lands.)
- **open-pdf-studio's dual-renderer pixel regression** — we *are* pdf.js;
  a MuPDF reference diff would measure engine cosmetics and cost a Python
  dep; `scripts/golden-raster.mjs` already covers browser-vs-Node parity.
  Steal its screenshot-hash sanity guard ("a run whose zooms render
  identically is invalid") if we ever build a viewer perf harness.
- **AECGB objects track / training on its sheets** — class mismatch, and
  CC BY-NC makes any trained weights research-only.
- **Blind agent runs** — need an LLM; out of scope for a deterministic
  product. The freeze-then-score protocol still governs human runs.
