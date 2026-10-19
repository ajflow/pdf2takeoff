# AEC-Geometric-Bench sheet_02 — opening-detection patch verified (B6d)

**Assisted (same 16 seeds as
[b6](../2026-10-19-aecgb-b6/RESULT.md) /
[b6b](../2026-10-19-aecgb-b6b/RESULT.md)): area-pixel precision 0.8594,
recall 0.3922, F1 0.5386; area-instance F1 0.121** — recall up **6.4×**
(0.0611 → 0.3922) and pixel F1 up **4.7×** (0.1151 → 0.5386) purely from
three engine fixes, zero host tuning. **Unassisted (the b6c grid sweep
re-run, 442 seeds, no human): 28 regions, area-pixel precision 0.8353 /
recall 0.9352 / F1 0.8824, area-instance F1 0.295** — the b6c negative is
reversed. Hashes frozen in [FREEZE.sha256](FREEZE.sha256).

## What b6c actually measured (and what it wasn't)

The b6c negative ("no room-sized enclosure bounds, whatever the seed")
was real but the mechanism was mis-guessed: not unbridgeable openings —
**over-closing**. A rung-by-rung sweep (`evals/aecgb/diag-fill.mjs`) showed
the uncapped fill barely shrinks from r=0 (81.3 % page) to r=112 (76.9 %),
and a gate analysis against the bench's own truth polygons
(`evals/aecgb/diag-gates.mjs`, ground truth used for **diagnosis only**)
showed the real failure: at r=112 the classic closing welds any ink runs
within 224 px of each other along a row/column into solid boundary —
including the short runs of text, ticks and symbol strokes *inside* rooms.
**19 of 22 truth rooms lost all open interior space**; fills that "bounded"
were furniture-scale pockets between welded bands (b6c's 13 regions,
1.8–6.8 k px², were exactly these pockets).

## The three fixes (all in the engine, `src/engine/dynamicfill.ts`)

1. **Run-length-gated closing** — `closeLine(mask, w, h, r, vertical,
   minRun)`: only runs ≥ `minRun` participate in a bridge (the fill ladder
   passes `max(24, r)`). A door gap sits between two long wall runs;
   the space between parallel interior linework sits between short runs.
   Ungated closing cannot tell those apart; gated closing bridges doors
   and ignores furniture. Re-running the gate diagnostic after the fix:
   19 → 6 rooms without an open 21×21 px interior window, and the
   analysable rooms fill 70–88 % of their truth area instead of exploding
   or pocketing.
2. **Escalation survives pocket traces** — previously a bounded fill whose
   outline failed the shoelace-vs-pixel-count plausibility band aborted
   the whole ladder with "not bounded". On this sheet a t=150 furniture
   pocket aborted the search before t=185 bounded the real room (found by
   a threshold×rung verdict matrix: t=185/r=0 returns a room, the default
   call returned an error in 35 ms). Now every reject — leak, implausible
   trace, too-small pocket — escalates; exhaustion returns the most
   specific error.
3. **4-directional contour tracer** — the 8-directional Moore trace could
   follow a sub-contour through interior linework and return *half a
   room* as the polygon (reproduced synthetically: a wall-to-wall dashed
   row with 40 px passable gaps traced as a top-half rectangle with a
   *plausible* area ratio). The fill is 4-connected, so a 4-directional
   wall-follower cannot diagonal-jump the notches; it also terminates on
   returning to the start pixel in the start exit direction (the naive
   position-only check either loops or closes sub-loops).

## Same seeds, before → after

| | b6 (host-tuned) | b6b (engine ladder) | **b6d (opening patch)** |
|---|---|---|---|
| fills from the 16 seeds | 4 | 4 | **7** |
| area-pixel P / R / F1 | 0.9915 / 0.0388 / 0.0747 | 0.9942 / 0.0611 / 0.1151 | **0.8594 / 0.3922 / 0.5386** |
| area-instance F1 | 0.000 | 0.080 (1 TP) | **0.121** (2 TP / 9 FP / 20 FN) |

Precision drops 0.99 → 0.86 by design: a bridged opening spans the wall
line, so the polygon covers door gaps that GT annotates as wall — the
honest trade for recall, and the right one for a takeoff tool (the user
trims a door lip in one drag; they cannot drag in a missing room).

## Milestone 2 revisited: the unassisted sweep now works

Re-running the b6c grid sweep (`--auto`, 442 seeds, 90 px grid, no human,
no ground truth anywhere in the loop) on the patched engine:

| | b6c auto (pre-patch) | **b6d auto (post-patch)** |
|---|---|---|
| regions found | 13 (all furniture-scale pockets) | **28** |
| area-pixel P / R / F1 | 0.094 / — / — | **0.8353 / 0.9352 / 0.8824** |
| area-instance | 0 TP | **9 TP / 30 FP / 13 FN, F1 0.295** |

The b6c conclusion ("no room-sized enclosure is fill-bounded on this
sheet, whatever the seed") is **reversed** — the enclosures were there all
along; classic closing was shredding them into pockets before the fill
could see them. Pixel recall 0.935 means the unassisted sweep now covers
almost the whole room area of the sheet. The 30 instance FPs are
door-spanning polygons bleeding into neighbouring rooms (the same
bridge-the-opening trade as the precision drop above) — tightening that
is an inference problem (split at interior walls), not a fill problem.
Cost: the sweep took 3296 s vs b6c's faster run, because the pre-patch
engine *aborted* ladders early on pocket traces (bug 2) — honest work
that was previously being skipped.

## Regression guards added

- `scripts/check-fill.mjs` case 5: a room whose door needs the r=44 rung
  crossed by a wall-to-wall dashed row (26 px runs, 40 px gaps) — ungated
  closing welds the dashes and returns half the room; the gate must return
  ≥ 88 % of the ideal area. Cases 1–4 unchanged (gap bridge, sealed room,
  unbounded, grey-wall ink ladder).
- Full ladder re-ran clean after the fixes: B2 rooms 6/6 (IoU 0.995–0.997,
  ratchet ok), B3 detector bench unchanged, B5 perf fill 6/6 rooms at
  57.6 ms/room median (45.9 → 57.6 ms — the gate's run-length pre-pass and
  the 4-dir walker; counts still the gate, ms informational), B7 MCP
  17/17, build ✓, `evals/compare.mjs` ok against the committed baseline.

## Remaining gaps (honest)

- 9 of 16 assisted seeds still fail: 4 "clicked on a line", 5 "not
  bounded" — the unbounded ones are corridor/lobby seeds that sit in no
  GT room (checked against truth for diagnosis: `460,395` and `1130,410`
  are circulation space) plus small fixture-dense rooms (Area 0) where
  even gated closing leaves no clean interior.
- Wide cased openings (> 2×112 px) and window bands are still not
  bridged — gate widths of 145–256 px were measured at window annotations.
  That is the next rung of the ladder (`GapLadder` can be widened by
  hosts) or true opening inference; not attempted here.

> Assisted single sheet, single run, one machine — not repeatability
> evidence and not a system-level score. Host settings: none (engine
> defaults + the adapter's documented gap ladder `[0,16,32,48,80,112]`).
