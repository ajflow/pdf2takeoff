# AEC-Geometric-Bench sheet_02 — follow-up: engine default, no host tuning (B6b)

**Area-pixel precision 0.9942, recall 0.0611, F1 0.1151; area-instance
F1 0.080 (1 TP / 2 FP / 21 FN).** Same assisted seeds as the first run
([../2026-10-19-aecgb-b6](../2026-10-19-aecgb-b6/RESULT.md)); the only
change is upstream: `dynamicFill` now escalates its ink threshold
(150 → 185 → 220) while a fill is unbounded, so the adapter passes **no
threshold at all** — the product default handles this light-line sheet.
Hashes frozen in [FREEZE.sha256](FREEZE.sha256).

## What changed between b6 and b6b

| | b6 (host-tuned 220) | b6b (engine default ladder) |
|---|---|---|
| host tuning | measured threshold 220, custom gap ladder | none (gap ladder only) |
| areas bounded | 4 | 4 (different, larger: two multi-room regions) |
| area-pixel P / R / F1 | 0.9915 / 0.0388 / 0.0747 | **0.9942 / 0.0611 / 0.1151** |
| area-instance F1 | 0.000 | **0.080** (first instance TP) |

Two seeds that filled small closets under the manual threshold now return
"too small to fill" — the ladder's least-intervention escalation bounds the
*larger* true room first at a lower rung elsewhere. The regression guard
for the engine change is the new grey-wall case in `scripts/check-fill.mjs`
(walls at grey 212, decoy grid at 230: strict-150 must fail, default ladder
must bound, grid must stay background) — it runs in CI via
`npm run typecheck:engine`. All other bench baselines (B2/B3/B5/B7)
re-ran unchanged after the engine change.

## Reading

The b6 finding ("walls render above the fixed ink threshold") is now fixed
in the engine, not worked around in the adapter — real users get
light-line sheets for free. Coverage remains the bottleneck (4-ish of 22
rooms; 10 seeds still unbounded via wide/diagonal openings and
corridor-connected layouts), which is what auto-seeding and the
opening-detection research (patch-plan) are for.

> Same caveats as b6: assisted single sheet, single run, one machine.
