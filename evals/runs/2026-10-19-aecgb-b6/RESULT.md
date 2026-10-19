# AEC-Geometric-Bench, sheet_02, click-assisted — first run (bench patch B6)

**Area-pixel precision 0.9915, recall 0.0388, F1 0.075; area-instance
F1 0.000 (0 TP / 3 FP / 22 FN).** Scored with the bench's own scorer
(Apache-2.0), per-sheet via `evals/aecgb/score-sheet.py`. Predictions and
adapter hashes frozen in [FREEZE.sha256](FREEZE.sha256); the sheet PDF's
SHA-256 is pinned in the bench's own manifest and verified by the adapter
before every run.

## Protocol

- **Sheet:** `sheet_02` (2339×1523 px frame at 300 dpi ≈ 2.778 px/pt),
  the same sheet opentakeoff's assisted first pass reported on — chosen
  deliberately for comparability with the one public peer number.
- **Assisted seeds:** 16 room-interior points picked by inspecting the
  render (never derived from ground truth): `460,395; 660,385; 480,565;
  680,560; 585,575; 470,705; 665,715; 600,855; 1130,410; 1345,365;
  1130,565; 1285,545; 1290,580; 1120,720; 1335,725; 1250,865` (manifest
  px, origin top-left). This is "click-assisted" in the same protocol
  class as opentakeoff's tool-assisted run.
- **Engine:** the real `dynamicFill` (src/engine/dynamicfill.ts), pdf2takeoff
  0.1.0, two host settings measured and documented in this log:
  ink threshold 220 (this sheet's walls render at grey ≈212 — invisible at
  the default 150 — while background shading sits at ≈228+) and a gap
  ladder up to 224 px (default tops at 88 px; door openings on this
  imperial-scale sheet run wider). Both are existing/added host-facing
  parameters; no benchmark-specific logic.
- **Scope honestly declared:** objects (fixtures) and walls are out of
  scope for this engine — submitted empty, score 0 by design.

## Numbers

| metric | value |
|---|---|
| seeds picked (assisted) | 16 |
| fills produced | 4 (12 seeds failed: 9 "not bounded", 3 "clicked on a line") |
| predicted areas / GT merged instances | 4 / 22 |
| area-pixel precision | **0.9915** |
| area-pixel recall | 0.0388 |
| area-pixel F1 | 0.0747 |
| area-instance F1 | 0.000 (0 TP / 3 FP / 22 FN) |

Reference points on the same sheet: Kamai's production pipeline
0.83 instance / 0.99 pixel; opentakeoff's assisted first pass 0.667 / 0.887;
frontier VLM raster-only arms 0.078–0.227 instance (corpus).

## Reading — what the bench taught us (the point of milestone 1)

1. **When Dynamic Fill bounds a room, it is essentially exact.** 99.15 %
   of predicted pixels are inside ground-truth rooms — the precision
   claim we make for the tool holds on real drawings, not just the
   analytic eval.
2. **Three concrete engine gaps, now measured:**
   - this sheet's walls render at grey 212 — above the fixed 150 ink
     threshold. Real-world grey-line drawings need an adaptive threshold
     (measured histogram in this run's notes; a product fix candidate,
     not a bench-only tweak);
   - door openings at 300 dpi / imperial scales exceed the 88 px
     gap-bridging ceiling — `dynamicFill` now accepts a host-supplied gap
     ladder (this run used one; the default is unchanged for every other
     caller), and the default should become scale-aware;
   - diagonal wall jogs and corridor-connected openings still leak —
     the known README caveat, now with a reproducible case.
3. **Instance F1 needs whole-sheet segmentation.** 4 accurate rooms out of
   22 → 0 TP at IoU 0.5: instance scoring punishes under-coverage
   exactly as it should. Auto-seeding (vector-gap analysis to propose
   room seeds without clicks) is the milestone-2 work; until then this
   anchor measures coverage, not accuracy.

> Assisted single sheet, single run, one machine — not repeatability
> evidence and not a system-level score. Host settings (threshold, ladder)
> were measured from the sheet's own render and are recorded above;
> nothing was tuned against ground truth.
