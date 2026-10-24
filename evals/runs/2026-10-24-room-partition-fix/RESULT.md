# Room partition, review fixes: gates and sheet_02 rerun

This follows [the frozen partition run](../2026-10-24-room-partition/RESULT.md). An independent review found a blocking regression in the swing-arc fit at commit `24441c1`, and reproduced it. A full circle symbol (smoke alarm, downlight) with a crosshair or a centre tick in a corridor was read as door swings. Their chords spanned the corridor and halved the room.

Fixed in `f4ed980`:
- **Circles are never swings.** An arc whose circle is inked more than 30% of a turn beyond its own span is rejected.
- **Double-door split is gated.** The split now runs only when no single circle fits the piece. The halves are kept only if they form a real double door: hinges r1 + r2 apart, comparable radii, quarter-ish arcs meeting midway, both on one side. Leftover meeting pixels no longer move chord ends.
- **Strip clicks are truthful.** A click in a portal strip is now flagged `unresolved`, not `partitioned`.
- **Arc budget counts nearby arcs only.**
- **Region-box cap (8 Mpx):** the region stays whole as `unresolved`, and Dynamic Fill never throws from the pass.
- **Strip dedupe is exact:** pixel for pixel.

Freeze: [FREEZE.sha256](FREEZE.sha256) was committed (`c36b6e7`) before the sheet_02 rerun.

## The review's cases (seed 300,300, no scale; areas in px)

| case | old engine (845b537) | 24441c1 | f4ed980 |
|---|---:|---:|---:|
| corridor ring + full crosshair | 111152, swing | 55413, swing | **111672**, no swing (= plain corridor) |
| corridor ring + centre tick | 111672 | 55700, swing | **111672**, no swing |
| room ring + centre tick / near a wall | 266944 | 266944, swing | 266944, no swing |
| room ring + crosshair / + diameter | 266944, swing | 266944, swing | 266944, no swing |
| ring + diameter tangent to a thin partition | 132567, swing | 132370, swing | **126945**, no swing |
| plain room / corridor, bare rings, S-curve | unchanged | unchanged | unchanged |

The partition case is a deliberate change from the old engine. The same drawing with a solid disc instead of the ring reads 126945 on both the old and new engines. The analytic room minus the disc is 126941. The old 132567 came from a phantom swing: it erased the two semicircles and put the disc back into the room, which is the error check-fill's room U already forbids for a curve that is not a door. All nine ring cases are now regression asserts in `scripts/check-fill.mjs`. Each must equal the room without the symbol (or the analytic disc case) within 0.5 % and report no swing.

## Gates on the fixed engine

| | frozen (24441c1) | fixed (f4ed980) |
|---|---|---|
| gate 4: positives split (3 / 6 / 1.5 px/pt) | 22/22, 8/8, 20/22 | 22/22, 8/8, 20/22 |
| gate 4: non-split + unsupported cases split | 0 / 65 | 0 / 65 |
| gate 5: split precision | 437/437 (100 %) | 438/438 (100 %) |
| gate 5: needed supported doors cut | 437/469 (93.2 %) | 438/471 (93.0 %) |
| gate 5: hard-negative groups split | 0 / 41 | 0 / 40 |
| gate 5: children exact / coarser / wrong | 140 / 16 / 0 | 140 / 17 / 0 |
| end to end own room, pass on = off | 383/444 | 385/444 |
| pass per region, 3 px/pt median / p95 | 5.5 / 27.9 ms | 5.0 / 33.3 ms |
| geometry gate | 21/22 (bath fixture pockets) | 21/22 (same) |

The holdout denominators move because the drawings are the same but fewer phantom swings change which rooms the open regions join.

## sheet_02 rerun (same protocol as the frozen run)

| sheet_02 unassisted | TP / FP / FN | instance F1 | area pixel P / R / F1 |
|---|---:|---:|---:|
| frozen run (24441c1) | 9 / 14 / 13 | 0.400 | 0.8770 / 0.9463 / 0.9103 |
| fixed, partition off | 9 / 14 / 13 | 0.400 | 0.8770 / 0.9464 / 0.9104 |
| fixed, partition on | 9 / 14 / 13 | 0.400 | 0.8770 / 0.9464 / 0.9104 |

All 23 rings are valid. The on and off arms are byte-identical again: 0 regions partitioned, 2 unresolved. One room's outline differs from the frozen run, by a few pixels of area. Single run, one machine; caveats as in the frozen run log.

Outputs: [holdout.json](holdout.json), [holdout.log](holdout.log), [gates-runtime.json](gates-runtime.json), [geometry-gate.json](geometry-gate.json), `bench-on/`, `bench-off/`, [bench-on.log](bench-on.log), [bench-off.log](bench-off.log).
