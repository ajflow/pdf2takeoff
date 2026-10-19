# evals — pdf2takeoff's published benchmark suite

This directory is the honest-numbers wing of the repo: reproducible
harnesses whose ground truth is analytic by construction, a scorer with
self-tests, and a run-log convention for publishing results without
overclaiming. Plan and provenance: [docs/research/bench-patch-plan.md](../docs/research/bench-patch-plan.md);
competitive context (who else publishes anything): [docs/research/market-scan.md](../docs/research/market-scan.md) §7.

Mechanics borrow from what the field does well (opentakeoff's analytic
conformance bench, Takeoff-Lens's accuracy harness, OpenConstructionERP's
baseline ratchet) — **reimplemented from scratch**: those harnesses are
AGPL, and this repo stays Apache-2.0.

## What runs today

### Room-area eval (B2) — engine fill vs analytic truth

```bash
node evals/make-room-sheet.mjs    # draw the sealed roomed sheet + reference.json
node evals/run-rooms.mjs          # run the real engine fill → candidate.json
node evals/score-rooms.mjs        # exact-polygon scoring → pass/fail, exit code
# or all three:
npm run eval:rooms
```

- **Sheet:** deterministic pdf-lib drawing (fixed creation date, no fonts)
  — a 3×2 grid of rooms, walls as stroked centerlines. Regenerating the
  PDF reproduces the SHA-256 pinned in `room-sheet.reference.json`
  (the generator asserts this itself, every run).
- **Truth:** each room's ground-truth polygon is the room inset by *half
  the adjacent wall stroke* (wall faces, not centerlines) — exact by
  construction, in PDF points, origin bottom-left.
- **Candidate:** `src/engine/dynamicfill.ts` — the same Dynamic Fill the
  browser app runs — seeded at each room's centre, page rendered at
  `RASTER_SCALE` (3 px/pt) through the Node raster adapter.
- **Scoring:** zero-dependency exact geometry. Per room: area error %,
  IoU via polygon intersection (convex clip + ear-clipping triangulation),
  boundary distance (max vertex-to-opposite-edge, both directions), and
  ring-validity checks (self-intersection, repeated vertices, degenerate).
  Missing, duplicate, extra, engine-error and invalid rooms each fail
  independently. Tolerances live in the reference JSON and were set with
  headroom over observed error (see the latest run log).
- **Method disclosure:** engine version and render scale are recorded in
  every candidate file; numbers are single-machine, single-run unless a
  run log says otherwise.

`node --test evals/score-rooms.test.mjs` self-tests the scorer: analytic
intersection values, the shifted-equal-area and same-bbox-wrong-shape
failures, every label/validity failure mode, CLI exit codes, and a
frozen-evidence check — re-scoring the committed fixture must reproduce
the committed score byte-for-byte, so scorer changes cannot silently move
old numbers.

### Detector-accuracy bench (B3) — tier-1 scan, P/R/F1 + miss attribution

```bash
npm run eval:detectors   # generates paired-phase datasets, scans, scores
```

- **Data:** the committed synthetic generator (`scripts/generate-synthetic-dataset.mjs`),
  seeded (60 sheets, seed 42 per phase), labels exact by construction. Two
  phases from the same seed: `clean` (`--degrade 0`) and `degraded`
  (`--degrade 1` — every sheet carries one scan artifact). Same seed ⇒ same
  distribution, but **not sheet-paired** (degradation consumes the rng
  stream); compare phases as distributions.
- **Engine:** the real `cvScan` (`src/engine/scan-cv.ts`) over each val
  sheet, one teach-click per class. Teach policy mirrors the UX: click
  instances in order until the scan accepts one, where acceptance requires
  a plausible template (a click on a wall-parked symbol resolves to the
  whole wall network — rejected, as a competent user clicks an isolated
  instance) and the taught symbol among the hits. Teach attempts are
  counted; every unteachable class-instance set is attributed `teach-failed`.
- **Matching:** centre distance in image px against each label's radius
  (half the longest box side + 3 px), Hungarian-style augmenting paths,
  deterministic order — the Takeoff-Lens (MIT) design, reimplemented.
- **Miss attribution:** the engine's opt-in trace (`CvTrace`) tags every
  component with the first gate it failed (`filtered:size|aspect|fill|
  signature`), wall/structure merges (`merged`), size-bound drops
  (`dropped:too-small|too-large`), or `teach-failed` — so every miss says
  why. This is the instrumentation tier-2 will be measured with too: the
  same bench, same sheets, same matching, `tiers.tier2_onnx` flips from
  `absent` to benched once `public/models/symbols.onnx` ships.
- **App-side payoff (B8, shipped):** scan hits land as flagged proposals
  (⚑ → ✓ or delete) and the totals show a live per-label kept-rate —
  user decisions become the accuracy signal this bench measures offline.
- **Honest scope:** the generator renders thin strokes (~1.4 px/pt, 1–3 px
  lines) — thinner than the app's 3 px/pt PDF raster where tier-1 was
  tuned, and deliberately hostile (wall-parked symbols, clutter, scan
  artifacts). These numbers are a *lower bound* on tier-1's home-turf
  behaviour; the real-drawing smoke (CI: 8/8 downlights on the sample at
  3 px/pt) and the room-area eval cover the home turf. Latest numbers:
  [runs/2026-10-19-detector-b3](runs/2026-10-19-detector-b3/RESULT.md) and
  [baseline.json](baseline.json).

### MCP workflow conformance bench (B7)

```bash
npm run eval:mcp      # → artifacts/mcp-workflow.json; counts are ratchet-gated
```

Drives the real local MCP server over stdio through the full agent takeoff
— including the **uncalibrated contract** (measure returns `value: null`,
not an error; angle/count are scale-free) and a **fresh-process re-import**
of the saved PDF requiring the markup set *and calibrations* to round-trip:
values are live at open (the page calibration rides in markup comments as
`[mpp:…]` — the b7 finding, fixed; see
[b7 run log](runs/2026-10-19-mcp-b7/RESULT.md) and
[b7b after the fix](runs/2026-10-19-mcp-b7b/RESULT.md)). 17 contract
checks, 15 tool calls; call count and round-trip markup count are
baseline-gated, timings informational.

### Baseline ratchet (B4)

```bash
npm run eval:check                  # compare current metrics vs evals/baseline.json
node evals/compare.mjs --update-baseline   # deliberate ratchet after an improvement
```

Committed [baseline.json](baseline.json) holds the flat metrics from B2/B3/B5
(fill area/IoU/boundary extrema; detector P/R/F1 per phase; perf counts).
CI runs the benches then `eval:check` and fails on any regression worse than
the per-metric threshold (default 0.05 absolute); underscore keys are
metadata; a baseline metric missing from the current report is itself a
regression. Directions: `fill.area_pct_max` and `fill.boundary_pt_max`
are lower-is-better; everything else higher-is-better.

### Perf bench (B5)

```bash
npm run eval:perf      # → artifacts/perf-results.json; numbers in perf.md
```

In-process timings of the engine's hot paths through the same Node adapters
the CLI/MCP use (render, tier-1 scan, fill, compare, annotation round-trip),
median-of-N with warm-up. **Deterministic counts are baseline-gated; the
millisecond figures are informational and never CI-gated** (runners flap).
Method, numbers and the discarded-run log: [perf.md](perf.md). Browser-side
figures (tier-2 scan 1.6 s cached / ~4 s first incl. 76 MB) live there too,
marked as production/blog numbers rather than harness measurements.

### AEC-Geometric-Bench anchor (B6) — external, manual, not in CI

Scores our room fill against an external public benchmark using *their*
scorer, so our numbers are comparable to a peer's: sheet_02, click-assisted
areas track → **area-pixel precision 0.8594 / recall 0.3922 / F1 0.5386;
area-instance F1 0.121** with the engine's default settings (7 of 16 seeds
fill; recall 6.4× the pre-patch run).
The bench repo is cloned alongside and never vendored (dataset CC BY-NC —
eval-only, never trained on; scorer Apache-2.0). Everything:
[aecgb/README.md](aecgb/README.md) and the run logs
([b6](runs/2026-10-19-aecgb-b6/RESULT.md),
[b6b after the ink-ladder fix](runs/2026-10-19-aecgb-b6b/RESULT.md),
[b6c auto-seed attempt — honest negative](runs/2026-10-19-aecgb-b6c/RESULT.md),
[b6d after the opening-detection patch](runs/2026-10-19-aecgb-b6d/RESULT.md))
— the bench surfaced four engine gaps, all fixed with CI regression cases
or parameterized: grey-line walls (ink-threshold escalation ladder), the
gap-bridging ceiling (host `GapLadder`), over-closing shredding room
interiors into furniture-scale pockets (run-length-gated closing — only
long wall runs can be bridged), and a tracer that could outline half a
region through interior notches (4-directional wall-follower). The b6c
"opening-leak" negative was really over-closing in disguise — diagnosed
with a rung sweep and a truth-polygon gate analysis
([diag-fill/diag-gates](aecgb/README.md#leak-diagnostics-how-the-b6d-patch-was-designed)),
never by tuning against truth. Milestone 2 (unassisted auto-seed) went
from an honest negative (b6c: 13 furniture-scale pockets, pixel P 0.094)
to **pixel F1 0.882 / recall 0.935 with 28 regions and zero human input**
on the patched engine — same sweep, same seeds.

## Run-log convention (B1)

Every published result gets a directory `evals/runs/<date>-<id>/`
containing:

- `FREEZE.sha256` — hashes of everything the run consumed and produced
  (PDF, reference, candidate, score), written **before** the numbers are
  read or cited;
- `score.json` — the scorer's exact output;
- `overlay-<room>.png` per disputed or interesting room (truth in green,
  candidate in red);
- `RESULT.md` — what ran, what passed, what failed, and the standing
  caveats.

Standing caveat lines every RESULT.md carries (learned from watching
opentakeoff publish theirs):

> Single run on one machine — not repeatability evidence.
> The reference is analytic but the tolerances are ours; a pass means
> "within the tolerance we committed to", nothing broader.

Generated artifacts (the PDF, candidate files, overlays) live in
`evals/artifacts/` and are gitignored; the reference, fixtures and run
logs are committed.
