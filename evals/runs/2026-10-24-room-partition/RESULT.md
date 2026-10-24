# Room partition pass: kill criteria, frozen synthetic holdout, one AEC-Geometric-Bench verification

The partition pass from the [design review](../../../docs/research/room-partition-design-review.md) is implemented in `src/engine/partition.ts`. It finds wall-supported doorway portals with an independent swing-door cue, cuts them as finite strips, relabels once, and either replaces the parent region with its children atomically or abstains (`unchanged` / `unresolved`). Automatic extraction is in `src/engine/auto-rooms.ts`. The design's kill criteria pass on synthetic geometry.

**On the single frozen verification on sheet_02 the pass never fired.** It partitioned 0 regions and abstained on 2 (`unresolved`). The arm with the pass on and the arm with it off produced byte-identical predictions. The sheet_02 area-instance F1 rose from 0.295 (B6d) to **0.400**. That gain comes from the engine changes on main since B6d plus valid rings and pixel-exact selection, **not from the partition pass**. This is a negative result for the pass on this sheet, reported as such.

## Freeze

The candidate was frozen at commit `24441c1` before anything was scored. [FREEZE.sha256](FREEZE.sha256) was written after the synthetic gates and before the benchmark run. It covers the engine files, harness, scorer helper, holdout generator, gate outputs, the sheet PDF (`7b09ac17…`, same as B6–P0) and the official scorer (`e338b71e…`, bench commit `b855483`). No code or threshold changed after the holdout or the benchmark were run.

Development used only our own proxies (`scripts/partition-proxies.mjs`) and the dev split of the random generator (seeds 7000–7059). The holdout seeds (20261024–20261223) were fixed before development and run once.

## Kill criteria (design section 6)

| gate | criterion | result | |
|---|---|---|---|
| 1 primitive | gaps of 2r / 2r+1, short flank, fixture bath; transpose and translate | 32→32, 33→34, 56→56, 57→58 px; identical in all four orientations/offsets; short flank closes; bath splits identically transposed | pass |
| 2 information | byte-identical cased opening read as one room or two | one answer (`unresolved`), never split | pass |
| 3 geometry | valid rings; instance count after the official scorer's `buffer(0)` + `merge_touching`, synthetic only | partition children: valid as submitted and separate in every layout. Auto extraction: 21/22 layouts exact; `fixture-dense-bath` scores 4 instances for 2 rooms because seeds inside the wall-attached tub and cistern outlines bound their own pockets (not partition output; existing auto-mode behaviour). Scorer contract: shared edge → 1, 1 px strip → 2, two-lobe ring invalid → 2 after repair, comb → 1 | pass for the pass, miss for auto extraction (see risks) |
| 4 value | ≥18 of 20 door-supported positives split; 0 wrong splits on ≥40 named non-split cases | 22/22 positives at 3 and 6 px/pt (20/22 at 1.5 px/pt, the two others abstain); 0 of 62 non-split + 3 unsupported cases split, at every resolution and through the PDF render path | pass |
| 5 holdout | ≥99 % precision of emitted splits, ≥80 % recall on supported doors, no hard-negative split | 437/437 cuts on real supported doors (**100 %**), 437/469 needed doors cut (**93.2 %**), 0 of 41 hard-negative groups split, 0 children cutting through a room | pass |
| 6 runtime | measured stage cost, fixed work limits, deterministic | see below; 0 work-budget abstentions on the matrix, identical decisions on repeat | pass (6 px/pt p95 above the planning envelope) |

### Proxy matrix (scripts/check-partition.mjs, in `npm run typecheck:engine`)

The pass is fed the region a fill would bound with every doorway open. Each positive must split into its rooms (child IoU ≥ 0.98). No other case may ever split.

- **Must split, all pass at 3 px/pt:** `two-door` (0.8/0.9/1.0 m, hinge at either jamb, swing either side), `two-door-thickwall`, `two-door-thinline`, `two-door-outline` (hollow walls), `door-mark-on-line` (chord stopped short; the only positive that Dynamic Fill alone returns merged), `two-door-cycle`, `three-room-cycle`, `double-door-12/15/18/24`, `short-flank-pantry`, `fixture-dense-bath`, `room-circulation`, and transposed twins.
- **Never split, all pass:** `l-room` ×4, `alcove` sweep ×10, `corridor` straight/bent/step, `open-plan-stubs` ×3 and with an island, `island-neck` ×2, `column-grid` ×2, `cabinet-false-wall` ×3 (with an arc-shaped chair), `hatch-glyph-shelf`, `window-exterior` ×2, `trace-comb-pinch`, `uncued-door` ×3, `cased-identical-pair`, and transposed twins (62 cases).
- **Unsupported conventions, abstain:** `two-door-open60` (a leaf opened 60° joins its arc into one piece that the swing fit cannot separate), `rotated-door-30/45` (no axis-aligned portal; v1 makes no staircase split). The pass returns `unchanged`, because the swing fit finds no cue at all.
- **Inside Dynamic Fill:** all 47 positive seeds return their own room; 4 go through the pass (the chord-blocked door). The pass fired on 0 non-split seeds. The `large-room-padding` verdict is identical on a tight and a padded page. Seed order (forwards/backwards auto extraction) and parent/child order in the selector give identical rooms.

### Holdout (scripts/partition-holdout.mjs, 200 sheets, run once)

Random grids of 2–9 rooms. Each shared wall gets a supported door, a double door, an unsupported 60° door, an uncued gap, a cased opening, no wall, or a solid wall. Sheets also vary wall convention, thickness, ink grey, resolution, speckle and furniture.

| slice | sheets | cuts (all correct) | needed doors cut |
|---|---:|---:|---:|
| all | 200 | 437 | 437/469 (93.2 %) |
| 3 px/pt | 116 | 255 | 94.8 % |
| 6 px/pt | 44 | 96 | 93.2 % |
| 1.5 px/pt | 40 | 86 | 88.7 % |
| filled walls | 149 | 339 | 95.0 % |
| thin-line walls | 14 | 34 | 89.5 % |
| hollow outline walls | 37 | 64 | 86.5 % |

Of the 162 groups whose ideal partition has ≥2 parts, 140 got the exact children and 16 got coarser ones (a door missed, never a wrong cut). 36 groups were `unresolved`.

End to end, Dynamic Fill returned the seed's own room for 383 of 444 well-posed rooms both with and without the pass. **The pass fired once.** Main's swing chords already close cued doors before the region is bounded. In the pipeline the pass only acts where a chord fails.

### Runtime (gates-runtime.json; Node 22, one machine, warm, median of 3)

| | pass per region | ROI | Dynamic Fill, pass off → on |
|---|---|---|---|
| 3 px/pt, 87 regions | median 5.5 ms, p95 27.9 ms | median 235 k px | median 12.3 → 12.9 ms, p95 33.0 → 35.7 ms |
| 6 px/pt, 29 regions | median 18.2 ms, p95 121.8 ms | median 938 k px | median 63.4 → 63.9 ms, p95 129 → 141 ms |

Scratch memory is 16 bytes per ROI pixel (label + base + span stack), reused across calls. Work limits are counts, not clocks: 512 arcs, 256 portals, 50 k visits per jamb piece search, 3 labelling passes. At 6 px/pt the p95 exceeds the design's planning envelope (≤100 ms at 1 MP). Browser timing was not measured.

## AEC-Geometric-Bench sheet_02, unassisted, one frozen run

Protocol: the B6d unassisted sweep on the current engine, via `scripts/aec-geometric-bench.mjs --fill-auto`.
- **Seeds:** 442 grid seeds every 90 manifest px, column by column. No clicks, no hints (no labels, text boxes, scale or vector bridges), no GT.
- **Fill:** Dynamic Fill on the 3 px/pt raster. The ink threshold escalates 150 → 185 → 220 only while a fill fails. That ladder lived inside the B6d engine; main dropped it, so the harness carries it.
- **Selection:** rooms under 250 manifest px² dropped; intersection-over-min ≥ 0.6 counts as a duplicate, compared on exact pixels.
- **Arms:** partition on, and the identical run with the pass disabled.
- **Scoring:** the bench's own scoring functions, per sheet (`scripts/bench/aecgb-score-sheet.py`).

| sheet_02 unassisted | submitted / scored | TP / FP / FN | instance F1 | area pixel P / R / F1 |
|---|---:|---:|---:|---:|
| B6d (commit 409e168, last published) | 28 / 39 | 9 / 30 / 13 | 0.295 | 0.835 / 0.935 / 0.882 |
| this engine, partition **off** | 23 / 23 | 9 / 14 / 13 | 0.400 | 0.877 / 0.946 / 0.910 |
| this engine, partition **on** | 23 / 23 | 9 / 14 / 13 | **0.400** | 0.877 / 0.946 / **0.910** |

All 23 rings are valid as submitted, so no repair split them, unlike B6d (12 of 28 rings invalid, 39 scored instances).

Sweep counts (both arms): 51 seeds skipped inside rooms already accepted, 354 unbounded at every threshold, 10 on a line, 4 below the size floor, 23 rooms, 0 duplicates. The `on` arm reports 2 regions `unresolved` (the pass saw a wall-supported opening or door cue it would not cut) and 0 `partitioned`. Each arm took about 406 s; the two ran in parallel.

Reading, without inspecting ground truth: the pass's precision-first evidence rule (a fitted swing arc hinged at a jamb, plus both jambs as walls) found nothing to cut on this sheet. Either its doorways are already closed by the chords, or they are openings without a cue the pass will accept. Which of these drives the remaining 14 FPs was not diagnosed, because that would mean reading GT for this sheet. FN stays at 13, the same as B6d.

### 15-sheet anchor

The existing 15-sheet harness (`scripts/aec-geometric-bench.mjs`, default mode) was rerun alongside, pinned to the same config as before. It submits areas from the openings detector's enclosed-space rectangles and never calls Dynamic Fill or the partition pass, so it is an anchor only. It reproduces the last published numbers exactly:
- wall pixel P/R/F1 0.784 / 0.388 / 0.519;
- area pixel 0.941 / 0.230 / 0.370;
- area instance 0.149 / 0.074 / 0.099;
- object micro F1 0.011.

The fill-based sweep was not run on the other 14 sheets: at ~7 minutes per sheet per arm it is not cheap, and the protocol fixed sheet_02 as the verification.

## Caveats

- Single sheet, single run, one machine; not repeatability or corpus evidence.
- Synthetic-tuned verification on a previously diagnosed sheet, not a blind test. The pass's thresholds come from our own proxies and dev split only.
- The 0.295 → 0.400 change compares two engines (B6d at 409e168, main plus this branch). The ablation arm shows the partition pass contributes nothing to it.
- The harness carries the B6d ink ladder and passes no hints. The product's click tool runs at tolerance 150 with text-layer hints, so these numbers are the unassisted protocol, not the click path.
- Node timing is not browser timing.

## Reproduce

```sh
npm run typecheck:engine                      # includes scripts/check-partition.mjs
node --experimental-strip-types scripts/partition-gates.mjs --out evals/runs/2026-10-24-room-partition
python3 -I scripts/bench/aecgb-geometry-probe.py --scorer <bench>/scoring --geometry evals/runs/2026-10-24-room-partition/geometry --out geometry-gate.json
node --experimental-strip-types scripts/partition-holdout.mjs --split holdout --count 200 --json holdout.json
PDF2TAKEOFF_PYTHON=<python with numpy, Pillow, shapely> node --experimental-strip-types scripts/aec-geometric-bench.mjs \
  --fill-auto --bench <aec-geometric-bench@b855483> --out <dir> --sheet sheet_02 --grid 90 --arms on,off
```

Outputs: [holdout.json](holdout.json), [holdout.log](holdout.log), [gates-runtime.json](gates-runtime.json), [geometry-gate.json](geometry-gate.json) (inputs in `geometry/`), `bench-on/` and `bench-off/` (predictions, per-arm score, summary), [bench-on.log](bench-on.log), [bench-off.log](bench-off.log), [FREEZE.sha256](FREEZE.sha256).
