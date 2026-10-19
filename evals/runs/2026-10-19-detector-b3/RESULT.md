# Detector-accuracy eval — first run (bench patch B3)

**Tier-1 CV scan: precision 1.000, recall 0.249 clean / 0.179 degraded.**
Score artifact: `evals/artifacts/bench-detector.json` (hash frozen in
[FREEZE.sha256](FREEZE.sha256), written before these numbers were read or
cited). Baseline ratchet seeded from this run: [../baseline.json](../../baseline.json).

## What ran

- **Engine:** `cvScan` (`src/engine/scan-cv.ts`) — the exact code the
  browser Scan tool runs for tier-1 — pdf2takeoff 0.1.0, with its new
  opt-in trace (`CvTrace`) tagging every component with the first match
  gate it failed.
- **Data:** `scripts/generate-synthetic-dataset.mjs`, 60 sheets per phase,
  seed 42, val split (7 sheets/phase), labels exact by construction.
  Phases: `clean` (`--degrade 0`) and `degraded` (`--degrade 1`: every
  sheet one artifact — blur 13, photocopy 16, noise 13, contrast 9, rotate
  9). Same seed ⇒ same distribution, not sheet-paired.
- **Teach policy:** click instances in order until accepted; acceptance =
  no error + plausible template (≤ label-box area; wall-merged templates
  run ~10× box and are rejected, as a user clicking an isolated symbol
  would) + taught symbol among the hits. 80 teach attempts (clean),
  113 (degraded) across 35 scans each.
- **Matching:** centre distance vs per-label radius (½ longest side + 3 px),
  Hungarian-style augmenting paths, deterministic order.
- **Machine:** Apple Silicon dev machine, Node 22.23.1.

## Numbers

| phase | GT | TP | FP | FN | P | R | F1 |
|---|---|---|---|---|---|---|---|
| clean | 193 | 48 | 0 | 145 | 1.000 | 0.2487 | 0.3983 |
| degraded | 190 | 34 | 0 | 156 | 1.000 | 0.1789 | 0.3036 |

Per class (clean): smoke-alarm strongest (R 0.385, F1 0.556); diffuser
weakest (R 0.178). Miss attribution (clean): `filtered:signature` 78
(54 %), `merged` 39 (27 % — the generator's deliberate wall-parking
quota), `filtered:size` 20, `filtered:fill` 4, `teach-failed` 4.
Degraded: `merged` 59 (38 %), `filtered:signature` 55 (35 %),
`teach-failed` 32 (21 %).

## Reading (the honest interpretation)

Zero false positives in 82 scans: tier-1 is deliberately conservative —
it counts only what visually matches the taught symbol, which is the
right failure mode for a takeoff (a wrong count is worse than a short
one). The recall story is three buckets, and all three are exactly the
declared reason tier-2 (the ONNX detector) exists: the signature gate
rejects size-jittered thin-stroke siblings (54 % of clean misses), the
wall-parking quota merges symbols into wall components (27 %), and
scan-simulation artifacts add merges and teach failures. Tier-2 will be
measured on this same bench, same sheets, same matching, the moment
`public/models/symbols.onnx` ships — that comparison is the point of
this run's baseline.

**Scope caveat:** these synthetic sheets render at ~1.4 px/pt with 1–3 px
strokes — thinner than the app's 3 px/pt PDF raster where tier-1 was
tuned — and are deliberately hostile. Treat these numbers as a lower
bound on home-turf behaviour; the real-drawing smoke (8/8 downlights on
the bundled sample, in CI) covers the friendly case.

> Single run on one machine — not repeatability evidence.
> The reference labels are exact, but the teach policy and match radius
> are bench choices; numbers mean "under this protocol", nothing broader.
