# AEC-Geometric-Bench sheet_02 — auto-seeded attempt (B6 milestone 2)

**Negative result, published as such.** Naive grid auto-seeding scores
*worse* than the click-assisted protocol: area-pixel precision 0.094
(vs 0.994 assisted), recall 0.010 (vs 0.061), area-instance F1 0.057
(1 TP / 12 FP / 21 FN, vs 0.080). Hashes frozen in
[FREEZE.sha256](FREEZE.sha256); scored with the bench's own scorer.

## Protocol

Unassisted: a 90 px grid over the sheet (442 seeds), the engine's default
ink ladder + the wide gap ladder at every seed, every bounded fill kept,
duplicates merged at intersection-over-min ≥ 0.6, slivers < 250 px² dropped.
No ground truth anywhere in the loop. Runtime ~40 min (unbounded seeds pay
the full 3×6 threshold×gap cascade — 417 of 442 seeds never bounded).

## What the numbers say (the finding)

All 13 surviving regions are 1.8k–6.8k manifest-px² — furniture-, fixture-
and text-block scale. Rooms on this sheet are ~100k px² and up: **not a
single room-sized enclosure exists that the fill can bound**, whatever seed
you click or sweep. The assisted run looked better only because a human
aimed at room interiors; its fills are also sub-room, just room-*aligned*
(precision 0.99). Coverage on the areas track is therefore entirely
bottlenecked by the fill's known opening problem — wide and diagonal door
openings leak rooms into corridors — which is exactly the
opening-detection research item in [patch-plan.md](../../../docs/research/patch-plan.md)
(DeepFloorplan-style boundary classes / vector-gap analysis).

Conclusion: milestone 2 (a *credible* unassisted run) needs that research,
not a better seed sweep. The sweep stays in the adapter (`--auto`) as the
reproducible baseline for it.

> Single sheet, single run, one machine. A negative result is still a
> result: it points the next patch at the right file.
