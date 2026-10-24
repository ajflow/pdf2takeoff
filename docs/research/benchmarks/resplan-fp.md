# ResPlan-FP: pdf2takeoff first pass

External anchor benchmark: [fpvec-lab](https://github.com/Cyprinus12138/fpvec-lab)'s
ResPlan-FP (MIT code, data CC BY 4.0 via
[Hugging Face `Tristan12138/resplan-fp`](https://huggingface.co/datasets/Tristan12138/resplan-fp)),
16,998 residential plans rendered as clean 256 x 256 `clean_band_v1` raster
images with wall-first vector ground truth (walls as centreline segments with
openings attached, rooms as wall-cycle polygons). Official test split of
1,000 plans (id-fingerprint `669656eabb515960`), all scored, missing
predictions score zero. Run date 2026-10-24, commit `72f2ec3`, Node v22.23.4,
CPU-only, no vision model, no GPU, no clicks, no network at run time: the
deterministic raster engine only (`src/engine/openings.ts`: wall-mask closing,
threshold-gap scanning for doors and windows, enclosed-space counting), at
untouched default settings. Engine time 0.09 s per plan (90 s for the split);
the benchmark's own Python scorer adds about 7 minutes for the full metrics at
two tolerances. Harness: `scripts/resplan-fp-bench.mjs`; fetch-and-rerun note
in `bench/resplan-fp/README.md`.

What was submitted, per category:

- **Walls**: centrelines skeletonised (Zhang-Suen) from the detector's wall
  mask, traced and merged through junctions, short nubs pruned, near-coincident
  endpoints welded (3 px, inside the scorer's 12.3-unit weld), fragments
  re-joined across collinear gaps up to 24 px (the render cuts every opening
  out of the wall band as white space while the ground truth runs the wall
  straight through it).
- **Openings**: the gap classifier's doors (double-leaf gaps deduped to one)
  as type `door` and its window groups as type `window`, centre and width from
  the gap box, scaled by exactly 4 (image px to the 1024 frame, y down in
  both). Gaps the classifier cannot label ("passages") are not submitted, and
  an opening whose host wall segment was not predicted is dropped.
- **Rooms**: `countEnclosedSpaces` regions as explicit rectangles.

What the mapping loses: rooms are bounding rectangles of the detected spaces,
so non-rectangular rooms lose IoU; merged window groups submit one wide
opening where the truth has several; wall thickness is the engine's page-px
estimate times 4, which over-estimates these 5 to 6 px bands (the scorer's
wall matcher ignores thickness, so this is cosmetic); all walls are typed
`interior` (type only affects the non-gating edit-cost term); genuinely
diagonal walls shorter than 12 px are dropped as junction noise (about 0.4% of
ground-truth walls are off-axis by more than the scorer's 15 degree gate).

No engine setting was changed and nothing was tuned on the evaluation split.
Two harness-side conversion parameters were picked on the first 200 plans of
the 1,000-plan validation split only: the bridge gap (24 px won over 40 and 64
on wall F1: 0.321 / 0.309 / 0.295 at tolerance 0.05) and the rooms mode
(explicit rectangles, room F1 0.067, over leaving rooms to the scorer's
faces-of-the-wall-graph convention, 0.002: the wall mask does not close
enough rooms for faces to exist).

## Score, and the published field on the same split

All reference rows were re-scored by us with the benchmark's own scorer and
shipped prediction files, and reproduce its published wall F1 exactly
(0.688 / 0.640 / 0.968 / 0.811, and the Gemini room 0.524 and r_val 0.045 of
its README), so every number below is like for like. Room F1 is
tolerance-independent (IoU at 0.5). The fine-tuned and sequence-decode tracks
emit walls only, so their openings are zero by construction and their rooms
come from the scorer's face convention.

| system | wall F1 @0.05 | wall F1 @0.015 | room F1 | opening F1 @0.05 |
|---|---|---|---|---|
| fine-tuned, wall-first decode | **0.968** | **0.957** | **0.939** | 0.000 |
| Gemini 3.1 Pro, zero-shot (200-plan subset) | 0.811 | 0.472 | 0.524 | **0.752** |
| zero-shot fusion | 0.688 | 0.599 | 0.235 | 0.339 |
| zero-shot, wall-first sequence decode | 0.640 | 0.505 | 0.054 | 0.000 |
| **pdf2takeoff (deterministic, after the ink-dominated fix), full test split** | 0.635 (P 0.790 / R 0.543) | 0.404 | 0.169 | 0.027 |
| pdf2takeoff, same fix, same 200-plan subset as the Gemini row | 0.647 | 0.412 | 0.177 | 0.020 |
| pdf2takeoff (deterministic, first pass), full test split | 0.339 (P 0.442 / R 0.281) | 0.220 | 0.078 | 0.018 |
| pdf2takeoff, same 200-plan subset as the Gemini row | 0.377 | 0.246 | 0.099 | 0.016 |

Edit cost (mean total per plan, 0.05): 181.4 (ours) against 147.5 (fusion),
182.2 (sequence decode), 99.2 (fine-tuned), 103.5 (Gemini, on its subset).
Full per-tolerance JSON for the first pass in
`bench/resplan-fp/results/score_test.firstpass.json` and
`score_test_llm200.firstpass.json` (the un-suffixed names hold the current
numbers, after the fix below); per-track reference rows in
`bench/resplan-fp/results/baseline_*.json`.

## After the ink-dominated fix

The empty-mask half was one mechanism, and this pass fixes it in the engine
(`src/engine/openings.ts`): no engine setting changed, no harness parameter
touched, run date 2026-10-24 on the same commit's working tree. Measuring the
failure signature on the validation split first sharpened the first-pass
reading above: on 454 of the 476 empty val plans the closing radii actually
find the walls (their trial scores read 0.5 to 0.68), but the closing growth
guard rejects every one of them, because it compares the closed mask's mass
against the unclosed mask, which the oversized kernel has erased to nothing;
only 22 plans score 0 at every radius. The floor problem is the same in both
groups: the pen weight lands inside the wall band, so the 1.6x pen floor sits
above the real 5 to 6 px bands, and the thickness estimate reads the
junction-blob bins above the floor instead.

The change is a guarded retry inside `estimateWalls`, the function that turns
the binarised page into a wall mask. After the closing ladder has chosen its
winner, if the chosen estimate kept no wall-scored ink (wall score 0), the
wall floor sits above the dominant bin of the long-run stroke histogram, that
bin carries real mass, and thin ink holds under half of all ink, the walls
are the dominant long-run class itself and the ladder is re-run with that bin
as the floor, in place of the pen-derived one. Each condition earns its place:

- *wall score 0*: the engine returned nothing usable, so there is nothing to
  lose; any drawing it currently reads well keeps its bit-for-bit output
  because the guard never opens.
- *dominant long-run bin above the floor*: the specific way the pen model
  fails here, and the only case where a retry can change the outcome.
- *thin ink under half of all ink*: keeps the retry on ink-dominated
  renders, where walls are most of the ink. On pen-dominated sheets (text,
  hatch and furniture over half the ink) the pen model's assumptions hold and
  an empty mask has other causes; re-reading a dominant bin there could
  promote texture to walls. All 476 empty val plans sit under the line
  (thinnest-share maximum 0.435).
- an explicit `wallThicknessPx` pin still wins over the retry.

The retry re-enters the same code path, so it also applies inside the
upsampled pass, which is where these plans end up working: the 5 to 6 px
bands are under the 7 px working floor, so the detector re-estimates at 2x
with the corrected floor and the kernel finally sits between the wall and
the line weight. Nothing is domain-specific: the retry reads only the
drawing's own stroke-width histogram, and the one threshold (the half-ink
line) is the definition of ink-dominated rather than a fit to this corpus.

Thresholds were chosen on the validation split only (all 1,000 val plans).
The test split was run once, after the change was frozen; nothing was touched
after seeing its numbers.

| split | wall F1 @0.05 | wall F1 @0.015 | room F1 | opening F1 @0.05 | edit cost | empty-mask plans |
|---|---|---|---|---|---|---|
| val, 1,000 plans, before | 0.325 | 0.210 | 0.077 | 0.016 | 182.4 | 476 of 1,000 |
| val, 1,000 plans, after | 0.632 | 0.402 | 0.158 | 0.025 | 156.8 | 0 |
| test, 1,000 plans, after (single run) | 0.635 | 0.404 | 0.169 | 0.027 | 156.6 | 0 (was 458) |
| test, LLM 200-plan subset, after (single run) | 0.647 | 0.412 | 0.177 | 0.020 | 155.3 | 0 (was 82) |

The aggregate lands at the zero-shot fusion track's own level (0.688), from
0.339, by recovering exactly the plans that used to submit nothing. Engine
time rises from 0.09 to about 0.32 s per plan on this corpus: failing plans
now run the closing ladder twice at each scale instead of once.

### Regression proof

Everywhere else the engine runs, the outputs were captured before the change
into `bench/resplan-fp/.cache/oracle/before/` and after into
`bench/resplan-fp/.cache/oracle/after/`, then compared byte for byte with
timing fields aside. All identical:

- `scripts/check-openings.mjs`, `check-fill.mjs`, `check-detector.mjs`,
  `check-detector-node.mjs`, `check-scaled-bench.mjs`: stdout identical
- `npm run bench`: stdout identical
- AECV-Bench, CV-only (120 plans, no label OCR): per-plan CSV byte-identical;
  summary JSON and stdout differ only in millisecond fields, so no plan's
  counts, thickness or score moved (the one all-zero plan, 5000_0001, does
  not trigger the guard)
- AEC-Geometric-Bench (15 sheets): per-sheet prediction JSONs and the score
  file byte-identical; stdout differs only in per-sheet seconds
- `public/examples/*.pdf` (90 pages): the full `detectOpenings` and
  `countEnclosedSpaces` result per page, with masks and histograms as
  digests, byte-identical

`npm run build` passes, and `scripts/check-engine.mjs` (the environment
purity guard) passes.

## Reading

- **The aggregate hides a bimodal reality.** 458 of the 1,000 plans submit no
  walls at all. On the 542 plans where the engine produces any wall mask, the
  per-plan wall F1 median is 0.638 (first quartile 0.578, maximum 0.837),
  which is the zero-shot fusion track's own level (0.688 aggregate). The
  failure is one diagnosable mechanism, not general weakness, and it is the
  whole gap between 0.339 and the mid-0.6s.
- **The mechanism, measured**: `clean_band_v1` renders carry almost no thin
  ink (only 1 px door arcs and window lines, about 9% of ink), so the pen
  weight estimate, which assumes the thinnest fifth of the ink is pen work,
  lands mid-wall at 5 to 6 px. The wall floor (1.6x pen) then sits above the
  true 5 to 6 px bands, the thickness estimate latches onto junction-blob
  bins (t reads 10 to 13 px), and the opening kernel (0.75x t) opens the real
  bands away: the wall mask comes back empty and the closing-radius ladder
  scores 0.000 everywhere. Plans where the kernel happens to land at 5 px
  escape and score well.
- **Openings are the second honest gap**: 432 submitted against 14,445 in the
  ground truth. At 256 px the arc-and-leaf and double-line evidence is 1 px
  thin, and the classifier, built for dense sheets, reads almost none of it;
  the gaps it finds but cannot label (passages) are not submitted under our
  no-guessing rule, though about half would be doors (the split is 51/49
  door/window on validation).
- **Rooms 0.078 from 1,477 submitted rectangles** against 5,618: the space
  pass inherits the wall mask's gaps, and regions that leak to the page edge
  are rejected as exterior, the same recall pattern the AEC-Geometric-Bench
  anchor shows. What survives is real (IoU-matched rectangles are rooms), but
  coverage is thin, and with an incomplete mask the scorer's face convention
  cannot help either (faces 0.002 on validation).
- Honest framing: this corpus is the opposite of the engine's home ground.
  Dense 300 dpi commercial sheets with text, hatch and fixtures are where the
  estimator's assumptions come from; these are synthetic, noise-free,
  thin-band 256 px renders where walls are nearly all of the ink. Both
  failure modes here are "the render violates an assumption the estimator
  makes", which is precisely what an external anchor is for. As in the AEC
  anchor, this number is the floor of the engine, published so the next
  change to the openings module has an external number to move.

## Known next levers (from the failure modes above)

1. ~~A pen/wall floor that survives ink-dominated renders~~ done: the
   guarded retry above roughly doubled wall F1, as predicted, and the
   empty-mask count went to zero on both splits.
2. Small-scale opening evidence: the arc, leaf and window-line probes assume
   thicker bands; upsampling the classifier pass (the detector already
   upsamples for thin walls, the threshold just assumes real-drawing line
   weights) would let it see 1 px evidence at 2-3x. This is now the biggest
   honest gap: 809 openings submitted against 14,445 in the ground truth,
   and the mask the classifier sits on is no longer the limit.
3. Rooms follow the mask, part one came free: with the mask fixed the space
   pass doubled room F1 (0.078 to 0.169) with no rooms-specific work, as
   predicted. Still open: non-rectangular rooms lose IoU as bounding
   rectangles, and the scorer's face convention remains out of reach while
   the mask's openings are bridged by prediction rather than read from the
   drawing.
