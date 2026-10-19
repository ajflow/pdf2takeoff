# AEC-Geometric-Bench: pdf2takeoff first pass

External anchor benchmark: [KamaiEnterprises/aec-geometric-bench](https://github.com/KamaiEnterprises/aec-geometric-bench)
(MIT code / released data), 15 construction sheets with public ground truth and
a released scorer. Run date 2026-10-19, commit `903b898`, Node v22.23.1,
~23 s per sheet on a laptop CPU, no GPU, no vision model, no clicks — the
deterministic raster engine only (`src/engine/openings.ts`: wall-mask closing,
threshold-gap scanning for doors and windows, enclosed-space counting for
areas). Harness: `scripts/aec-geometric-bench.mjs` (reproduces end to end
against a clone of the bench repo).

What was submitted: walls as the estimated wall mask (run-length rectangles),
areas as enclosed-space rectangles, doors as `Single Swing Door` boxes and
windows as `Window` boxes. Fixtures (sinks, toilets, bathtubs, showers,
cooktops) have no click-free detector in the engine and were not submitted —
under the bench's protocol that costs recall only, never precision.

## Score, and the published field on the same 15 sheets

| system | object F1 | wall px | area px | area inst |
|---|---|---|---|---|
| Kamai (production pipeline) | **0.929** | 0.931 | 0.987 | 0.941 |
| **pdf2takeoff (deterministic, first pass)** | 0.031 | **0.519** | 0.381 (P 0.943) | 0.087 |
| Gemini 3.7 Flash | 0.031 | 0.238 | 0.797 | 0.077 |
| Claude Opus 5 | 0.024 | 0.278 | 0.782 | 0.227 |
| Claude Fable 5 | 0.013 | 0.287 | 0.780 | 0.186 |
| Gemini 3.1 Pro | 0.015 | 0.182 | 0.548 | 0.116 |
| GPT-5.6 Sol | 0.003 | 0.089 | 0.741 | 0.096 |

Full per-class output in `bench/aec-geometric-bench/results/score.txt`.

## Reading

- **Walls are the headline: 0.519 pixel F1, more than double every published
  frontier VLM on the identical sheets.** Precision 0.784 / recall 0.388 — the
  estimator finds the walls it finds cleanly and misses the rest (thin
  partitions below the pen-weight floor, hatch-filled walls the closing
  cannot fuse). This is the task a takeoff actually needs walls for, and a
  classical closing kernel is already beating vision-language models at it.
- **Area precision 0.943** — second only to Kamai's 0.987. When the engine
  says "enclosed space here", it is one (at rectangle granularity). Recall
  0.239 is the gap: rooms whose door gaps defeat the gap scanner stay
  merged into their neighbour or uncounted, and rectangle polygons
  under-cover non-rectangular rooms.
- **Objects 0.031, at the frontier-VLM range.** Windows genuinely match (37
  true positives at IoU 0.50 — also the proof the coordinate frame is
  exact). Doors over-fire on real drawings (433 boxes, none matching): the
  gap classifier was tuned on synthetic plans and reads furniture runs and
  dimension-string gaps as doors. Fixtures are not attempted at all.
- Honest framing: Kamai's 0.929 is a production pipeline purpose-built for
  this corpus. This number is the *floor* of our engine — no model, no
  clicks, no training against this data — published so the next change to
  the openings module has an external number to move.

## Known next levers (from the failure modes above)

1. Door-gap classification retuned on real drawings (the 433 false
   positives are clustered, inspectable failures — the same
   per-sheet-debug workflow the AECV-Bench harness uses).
2. Double-door pairing (leaves to `Double Swing Door`).
3. Room recall: the ResPlan exterior-aware wide-door machinery exists in
   Dynamic Fill; porting it into the openings path should lift area recall
   the same way it lifted room recovery there (53.8% → 94.1%).

## Re-run 2026-10-19: config pin, wall F1 unchanged

The openings module gained an extended closing ladder with two closing
guards, wall-network anchoring and an exterior-facing window gate (see the
AECV-Bench round-3 note). Unpinned, those defaults cost wall recall on these
large commercial sheets (wall F1 0.458): the guards reject cavity-scale
closings whose unclosed reference mask is nearly empty, which is exactly the
state of several sheets here. The harness therefore pins the first pass's
configuration — base ladder `[0,1,2,3]`, guards off — so this anchor's wall
time series stays comparable run over run; the rationale is documented in
the harness header.

Pinned re-run, fifteen sheets, same scorer:

| field | first pass | pinned re-run |
|---|---|---|
| wall pixel P / R / F1 | 0.784 / 0.388 / **0.519** | 0.784 / 0.388 / **0.519** |
| area pixel P / R / F1 | 0.943 / 0.239 / 0.381 | 0.940 / 0.196 / 0.324 |
| area instance F1 | 0.087 | 0.089 |
| window object TP / F1 | 37 / 0.089 | 12 / 0.041 |

Wall predictions reproduce the first pass exactly. The two fields that
moved track the engine's new gates rather than the pin: the spaces
relative-size floor (3% of the largest kept region) drops small room
rectangles (area recall 0.239 → 0.196), and the exterior-facing window test
removes windows whose outside walk crosses wall ink on these dense sheets
(37 → 12 true positives). Both are AECV-motivated trades; if this anchor's
window or area numbers matter for a comparison, run with
`windowExterior=false` / `minSpaceShare=0` and say so.
