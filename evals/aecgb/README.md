# AEC-Geometric-Bench adapter (external anchor, bench patch B6)

Scores pdf2takeoff's room-fill against
[KamaiEnterprises/aec-geometric-bench](https://github.com/KamaiEnterprises/aec-geometric-bench)
using **their** scorer (Apache-2.0) on **their** released sheets. The bench
repo is cloned alongside (`evals/aecgb/repo/`, gitignored) — never vendored
into this repo, never trained on: the dataset is **CC BY-NC 4.0**, so
eval-only use is the licence-clean lane, and any model trained on these
sheets would be research-only forever. We publish only our predictions and
numbers, which the data licence does not attach to.

## Run it

```bash
git clone --depth 1 https://github.com/KamaiEnterprises/aec-geometric-bench evals/aecgb/repo
node evals/aecgb/predict-sheet02.mjs --render-png evals/aecgb/sheet02.png
# inspect the render, pick one seed per room (assisted protocol), then:
node evals/aecgb/predict-sheet02.mjs --seeds "x,y;x,y;…" --out evals/aecgb/predictions/sheet_02.json
python3 evals/aecgb/score-sheet.py sheet_02 evals/aecgb/predictions/sheet_02.json
# corpus table (14 empty sheets drag it; see the per-sheet reporter above):
python3 evals/aecgb/repo/scoring/score.py --pred evals/aecgb/predictions --name "pdf2takeoff"
```

The adapter verifies the sheet PDF's SHA-256 against the bench manifest
before anything else, renders through the engine's own Node adapters, and
runs the real `dynamicFill`. After the engine gained its default
ink-threshold escalation ladder (walls at grey ≈212 vs shading ≈228 — the
b6 finding, fixed in `src/engine/dynamicfill.ts` with a CI regression case
in `scripts/check-fill.mjs`), the adapter passes no threshold at all.
Runs: [b6, host-tuned](runs/2026-10-19-aecgb-b6/RESULT.md),
[b6b, engine default — better: instance F1 0.080, pixel F1 0.115](
runs/2026-10-19-aecgb-b6b/RESULT.md), and
[b6d, opening-detection patch — pixel F1 0.539, recall 6.4×](
runs/2026-10-19-aecgb-b6d/RESULT.md).

## Leak diagnostics (how the b6d patch was designed)

- `diag-fill.mjs` — pick a seed and a closing rung, flood without the
  fraction cap, render fill/boundary/seed to a PNG. The r-sweep at seed
  (460,395) (81.3 % of page at r=0, still 76.9 % at r=112) killed the
  "unbridgeable opening" hypothesis.
- `diag-gates.mjs` — for every ground-truth room polygon (diagnosis only,
  never seed-picking), flood from an open interior point and locate the
  exact pixels where the fill crosses the truth boundary, with per-gate
  width, darkest nearby ink, and overlapping annotations. This found the
  real b6c mechanism: classic closing welds interior linework into false
  walls (19/22 rooms shredded at r=112) → run-length-gated closing,
  escalation-past-pockets, and a 4-directional tracer in the engine
  (all in `src/engine/dynamicfill.ts`, regression case 5 in
  `scripts/check-fill.mjs`).

## Scope

Areas track only (this engine fills rooms). Objects (doors/windows/fixtures)
are class-mismatched with our electrical-symbol detector and submitted
empty; walls need an extractor we don't have and are submitted empty. The
bench README documents the submission format; `score-sheet.py` reuses the
bench's scoring functions for per-sheet numbers (their CLI pools all 15).

**Milestone 2 (auto-seed): first attempt was an honest negative, now a
positive.** The first `--auto` grid sweep (442 seeds, no human) found only
furniture-scale pockets — pixel precision 0.094
([b6c run log](../runs/2026-10-19-aecgb-b6c/RESULT.md)) — and the
diagnosis became the opening-detection patch (run-length-gated closing,
escalation-past-pockets, 4-directional tracer). The same sweep on the
patched engine finds **28 room-sized regions: pixel F1 0.882 (P 0.835 /
R 0.935), instance F1 0.295**
([b6d run log](../runs/2026-10-19-aecgb-b6d/RESULT.md)). The remaining
instance FPs are door-spanning polygons bleeding into neighbours — an
inference problem (split at interior walls), not a fill problem.
