# Super prompt 3: the benchmark task — room partition design

Paste everything below the line. This is a *design and adversarial-review*
task, not a strategy question — the direction is decided and the timeline
is a hackathon (days). Optionally attach
`evals/runs/2026-10-19-aecgb-b6d/RESULT.md`; the prompt is self-contained
without it.

---

You are the algorithm designer and adversarial reviewer for one specific,
high-stakes component of a construction-takeoff engine. We implement; you
design, stress-test, and try to break your own design before we code it.
Timeline is days. Depth on this one problem beats breadth.

## Context: the engine (deterministic, in-browser, zero ML)

**pdf2takeoff** turns PDF floor plans into quantities entirely client-side.
Its **Dynamic Fill** (pure TypeScript, no DOM) takes a seed point inside a
room and returns the room's polygon + area:

1. Render page → grayscale raster; binarize at ink threshold `t`.
2. **Run-length-gated closing** before flooding: `closeLine(mask, r,
   vertical, minRun)` dilates ink runs horizontally/vertically so that two
   *long* ink runs (walls) within `2r` of each other get welded — bridging
   door gaps — while short runs (text, ticks, furniture strokes) are never
   bridged. `minRun = max(24, r)`.
3. Escalating ladder over bridge radius `r ∈ [0, 16, 32, 48, 80, 112]` px
   and ink threshold `t ∈ [150, 185, 220]`; every reject (leak, implausible
   pocket, bad trace) escalates instead of aborting.
4. Flood fill (4-connected) from the seed; trace the region boundary with a
   4-directional wall-follower; plausibility checks (shoelace area vs pixel
   count, size bounds).

This stack, with three recent fixes (the gated closing, reject-tolerant
escalation, the 4-dir tracer), just produced these externally-scored
results on a public benchmark sheet (AEC-Geometric-Bench, sheet_02, 22
ground-truth rooms, their scorer, our predictions):

- **Unassisted auto-seed sweep (442 grid seeds, no human, no GT in the
  loop):** area-pixel P/R/F1 = 0.835 / 0.935 / 0.882; **area-instance
  F1 = 0.295** (9 TP / 30 FP / 13 FN).
- Reference points: open-source peer tool-assisted 0.667 instance F1;
  bench owner's server ML pipeline ≈ 0.83 on this sheet (unverified),
  0.93 corpus-wide.

Pixel coverage is nearly solved. **Instance F1 is the score, and its
diagnosed failure budget is:**

1. **30 FPs = door-spanning polygons.** Wide openings (measured 145–256 px
   at window bands; door cases similar) exceed the ladder's 112 px ceiling,
   so the fill passes through unbridged and the region still *bounds* — on
   the next room's walls. One region = two rooms + the opening between
   them. The run log's verdict: "an inference problem (split at interior
   walls), not a fill problem."
2. **13 FNs:** small fixture-dense rooms where even gated closing leaves
   no clean interior window for a seed to bound; plus seeds landing in
   circulation space that is genuinely no GT room (those are scoring
   artifacts, not engine misses).

## The task

Design the **room-partition pass**: given a traced region that may span
multiple true rooms joined by openings, emit one polygon per true room.

Candidate approaches to compare (or beat):

- **(a) Pinch splitting via distance transform:** rooms are wide, door
  throats are narrow. Compute the distance transform of the filled region;
  cut where local width drops below a threshold (~1.5–2× bridge radius);
  persistence-style — only splits that survive above a width threshold are
  kept.
- **(b) Bridge-site cutting:** the gated closing knows where it welded two
  long runs; record those sites as virtual walls and cut the traced
  polygon where it crosses them. (Caveat: our FPs come from openings the
  ladder did *not* bridge — evaluate whether attempted-but-unbridged gaps
  can be recorded the same way.)
- **(c) Re-fill per sub-region:** insert virtual walls at candidate
  passages, re-flood, keep the partition whose sub-regions all pass
  plausibility.
- **(d) Wall-ink evidence:** only split where actual wall ink flanks the
  passage (door jambs / wall endpoints), as opposed to alcove necks or
  L-room elbows which have no such evidence.

**The hard requirement is precision of the split itself.** These must NOT
be split: L-shaped rooms, rooms with alcoves/recesses, corridors (narrow
but one room), open-plan areas, rooms containing interior
columns/islands/furniture clumps. A partition that over-splits trades 30
FPs for new ones and gains nothing. Your edge-case matrix must name each
of these and state the expected behaviour and the cue that distinguishes
it from a true door passage.

Also design (second priority):

- **The fixture-dense FN rooms:** propose a fill strategy when no clean
  interior window exists (largest inscribed rectangle/erosion as
  plausibility anchor? fixture-mask suppression via the existing
  run-length gate at a smaller scale?).
- **Safe widening policy:** can the ladder go to r ≈ 128–144 for the
  145–256 px bands without re-triggering over-closing, given the
  run-length gate `minRun = max(24, r)`? At what r does the gate itself
  start welding legitimate short-wall architecture (pantries, shallow
  niches)? Derive the ceiling, don't guess.

## Anti-overfit protocol (binding)

We never tune against the benchmark's ground truth — GT was used for
*diagnosis only*, once, and the bench sheets are verification, never
training signal. Your design must come with **synthetic proxy cases**
specifiable in our own deterministic generators (an analytic room-sheet
drawer and a seeded random sheet generator that already draws walls with
door gaps, text, furniture strokes, degradation): for every failure mode
in your edge-case matrix, name the proxy sheet and the assert that would
catch a regression. The benchmark run happens once, at the end, as
verification.

## Constraints

- Deterministic (same input → same polygons), pure TypeScript engine, no
  DOM, runs in WASM-era browser budgets (the whole fill is ~58 ms/room
  today; the partition pass should stay in that order — state your cost
  model).
- No ML unless you can argue a tiny deterministic-looking component is
  *necessary* — and then argue licence (Apache-2.0-compatible training
  data only) and size explicitly. The current story "zero model, zero
  download, beats server pipelines" is part of the value; don't break it
  without strong reason.

## Verification sub-task (only if you have web/clone access)

- The bench owner's per-sheet areas number on sheet_02 (we believe ≈ 0.83
  instance F1; verify or refute) and the scorer's matching rule (IoU
  threshold? one-to-one assignment? how are extra predictions penalized?).
- Whether the open-source peer's 0.667 is comparable (assisted vs
  unassisted, same sheet, same scorer version).

## Required output

1. **Ranked design** for the partition pass — one primary recommendation,
   pseudocode level, with the alternatives it beat and why.
2. **Edge-case matrix** — every named non-split case + every split case,
   the discriminating cue, and the synthetic proxy + assert for each.
3. **Cost model** — expected ms/region and memory; where it fits in the
   existing ladder.
4. **FN-room strategy** and **ladder-widening ceiling** (derived, with the
   reasoning shown).
5. **Kill criteria** — the cheapest synthetic experiment that would
   falsify the primary design before we invest in the bench run.
6. **Generalization risks** — what breaks on a different producer's
   sheets (line weights, door conventions, scale), ranked.

Rules: commit to one design; no surveys without a decision; every claim
about our engine's behaviour that you rely on, flag as [assumed] if it
isn't stated above.
