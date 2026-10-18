# Patch plan 2: fixes and improvements from the October 2026 review and research

> **Status 2026-10-17:** phases 0 to 3 shipped on `claude/code-review-v1q38f`
> (see the git log and the table below). Sources: today's code reviews of
> 6cdff32, 7cc72db and 06fadc6, the fixes merged in PR #1, and the research
> report [AI research for PDF takeoff](../../reports/AI%20research%20for%20PDF%20takeoff.md).
> Patch numbers continue from [patch-plan.md](patch-plan.md) (P1 to P6).
>
> | Patch | Status |
> |---|---|
> | P7 to P11 | shipped |
> | P12 | shipped: `npm run bench`, in CI |
> | P13 | shipped: scale and room-label triggers; door-width cuts of bounded fills (wall ends both sides, room-sized parts) close `fill/interior-door-no-hints`; distance-transform necks at any angle still open |
> | P14 | shipped: votes, consensus, grammars, app and MCP checks; graphic scale-bar tier still open |
> | P15 | shipped, plus a `fill_area` MCP tool |
> | P16 | shipped: go ([vector-spike.md](vector-spike.md)); real CAD exports still to check |
> | P17, P18, P19 | shipped |
> | P3b, P5b, P2b, P20 | open: need a dependency decision (PaddleOCR.js), model artifacts (DINOv2), a dataset licence check and training run (ResPlan), or an agent harness with model access (public benchmarks) |
>
> Bench after phase 3: fill 11/12, count 2/2, scale 9/9. After the room-area bench sweep (`npm run bench:rooms`, [benchmarks/room-area-datasets.md](benchmarks/room-area-datasets.md)): fill 12/12.

## Principles

1. **Fix the deterministic glue first.** Every open bug sits in seam fusion,
   gap-closing rules, reading direction or scale parsing, not in a model.
   The research says better models will not fix these; regression cases will.
2. **Test first, on cases that fail today.** Each patch lands with a check
   script case that fails on the current code (as PR #1 did for the L-room
   and the horizontal-wall door).
3. **Numbers come from tools.** Benchmarks (AECV-Bench, MeasureBench,
   LED-BENCH, DiffSpot) show frontier models miss counts, scales and
   changes. Agents plan; tools measure and carry provenance.
4. **Validate on our own sheets before trusting the literature.** Most
   paper figures in the report came from abstracts. Phase 2 builds the
   fixture set that ranks the competing fill and scale ideas.

## Order at a glance

| Phase | Patch | What | Effort | Depends on |
|---|---|---|---|---|
| 0 | P7 | Carry-over correctness fixes from today's reviews | half a day | none |
| 1 | P8 | Vertical dimension OCR reads the right way up | hours | none |
| 1 | P9 | `read_text` honours rotated text | hours | none |
| 1 | P10 | Detector tiling: seams, caps, real tests | about a day | none |
| 1 | P11 | Dynamic Fill: no closing between walls and furniture lines | hours | none |
| 2 | P12 | Takeoff fixture set and accuracy harness | 1 to 2 days | none |
| 2 | P13 | Dynamic Fill: split rooms joined by an interior door | 1 to 2 days | P11, P12 |
| 2 | P14 | Scale consensus and better scale grammars | 1 to 2 days | P8, P9 |
| 2 | P15 | Provenance on every MCP number | half a day | P14 |
| 3 | P16 | Vector layer spike (go / no-go) | 1 day | none |
| 3 | P17 | Vector count tier | 2 to 3 days | P16 go |
| 3 | P18 | Vector-aware room fill | 2 to 3 days | P16 go, P13 |
| 3 | P19 | Tiered `compare_revisions` with quantity delta | 2 to 3 days | P16 helps |
| 4 | P3b, P5b, P2b | Model work, revised by the research | open | P12 |
| 4 | P20 | Public benchmark runs | 2 to 3 days | P12, P15 |

Phases 0 and 1 are independent of each other and can ship as separate
small PRs. Phase 2 is where we start measuring instead of guessing.

---

## Phase 0: carry-over

### P7: correctness fixes left open by today's reviews

From the review of 6cdff32 (annotation round-trip) and 06fadc6 (tiling),
not covered by PR #1.

| Fix | File | Change | Check |
|---|---|---|---|
| Re-saves grow the file | `src/engine/annotate.ts` | After `annots.remove(i)`, `context.delete(ref)` for our own annotation dicts | `roundtrip-check.mjs`: indirect object count is stable across 3 re-saves (today it grows by one object per markup per save) |
| Depth read from the label | `src/engine/read.ts` | Anchor the depth match at the end: `/\(depth ([^)]*)\)$/` | Round-trip a volume labelled `Pad (depth 1 m) east` |
| CLI run silently drops existing markups | `src/headless/cli.ts` | Document the replace behaviour, or add `--keep-existing` that parses existing annotations and appends spec markups | Spec-runner smoke on a PDF that already holds markups |
| Tile check never tests tile pixels | `scripts/check-detector.mjs` | Fake `run()` returns boxes from the dark pixels it is given, so a broken `+ ox / + oy` offset fails | Mutation: deleting the offset must fail the check |
| Spec overstates "bit-identical" | `specs/detector-tiling.md` | Reword to "same geometry; NMS fix applies" | none |

---

## Phase 1: quick wins (hours each)

### P8: vertical dimension OCR reads the right way up

**Problem.** `ocrCorridor` (`src/app/ocr.ts:148-175`) orders endpoints by x
only, so a near-vertical segment gets θ of about +90° or -90° depending on
click order and sub-pixel jitter. About half of vertical dimensions are
read upside down; a misread that still parses skips the full-page fallback.

**Evidence.** Drafting convention: aligned dimensions read from the bottom
or the right. eDOCr2 canonicalises orientation before recognition; Rhino
uses a 10° tolerance. Upside-down digits often produce a leading zero
("1200" reads "0021").

**Change.**
1. Fold θ into [-90°, 90°); within 10° of +90°, map to -90° (read from the
   right).
2. Within ±20° of vertical, OCR both 0° and 180°. Pick by: parses, no
   leading zero, word confidence, agreement with the current scale.
3. Digit whitelist (`0-9 . , ' " - x m`) on the corridor worker.

**Check.** New headless test with synthetic vertical dimension strips at
88°, 90°, 92° and both click orders: all read correctly. Keep the OCR
engine behind the existing `OcrWord[]` port so P3b can swap it later.

### P9: `read_text` honours rotated text

**Problem.** `read_text` (`src/headless/mcp.ts:201-215`) uses only the
translation of the pdf.js text matrix, so vertical words get wrong centres
and an agent can pair a value with the wrong dimension line.

**Evidence.** pdf.js source: `transform` is the full text matrix and
`width` runs along the baseline.

**Change.** Baseline unit vector from `(t[0], t[1])`, up vector from
`(t[2], t[3])`; place each split word along the baseline, offset by half
the height along the up vector; report `angleDeg` per word.

**Check.** Extend `scripts/mcp-smoke.mjs` with a PDF holding text at 0°,
90° and 270°; assert word centres within 1 pt of the drawn positions.

### P10: detector tiling, seams and caps

Inactive in production until the manifest gets a `tile` block, so this can
land before tiling is switched on.

**Problems.** IoU NMS cannot merge a truncated box with the full box in the
next tile (double count). The 32 px example overlap is below a 9 mm
symbol (about 76 px at 3 px/pt), so a seam symbol may never be whole in
any tile. `MAX_DET = 500` applies across all classes before the class
filter. `MAX_WINDOWS = 512` rejects A0 at `pxPerPt: 3` (513 windows) and
falls back to the CV scan silently.

**Evidence.** SAHI defaults: greedy merge with intersection over the
smaller box (IoS) 0.5, per class. TA-TM (2026 preprint): 128 px overlap
lifts boundary recall. Practitioner tiling code drops boxes touching an
inner edge.

**Change** (`src/engine/scan-onnx.ts`, `specs/detector-tiling.md`).
1. Overlap rule: `overlapPx >= 1.25 × largest symbol px`; the manifest
   loader warns or clamps when it is smaller.
2. Drop detections touching an interior window edge (not the sheet edge)
   before fusion.
3. In `nmsPerClass`, pairs from different windows merge at IoS > 0.5;
   pairs in the same window keep the IoU test.
4. Filter to the clicked class before capping; cap per class, and return
   a `truncated` flag the UI and MCP surface.
5. Skip windows with no ink; replace the hard window cap with a time
   budget plus progress, densest windows first.

**Check.** `check-detector.mjs` cases: truncated box in window A plus full
box in window B counts 1; two adjacent same-class symbols in one window
count 2; A0 at `pxPerPt: 3` runs; 1,200 symbols over 8 windows returns
1,200 or sets `truncated`.

### P11: Dynamic Fill does not close between walls and furniture

**Problem.** `closingThresholds` (`src/engine/dynamicfill.ts`) closes any
short ink-free run with ink at both ends, including the strip between a
wall and a parallel bench line, which removes real floor area.

**Evidence.** de las Heras et al. (ICDAR 2013, IJDAR 2014): walls are
parallel lines longer than thick; a door gap sits between two wall *ends*.

**Change.** Gate each run: close it only if the ink at both ends continues
along the run's own axis for at least about 1.5× the page's wall
thickness (estimated once from the ink run-width histogram). A bench
strip is bounded by the sides of lines, not their ends, so it fails the
gate.

**Check.** `check-fill.mjs`: room with a door gap and a bench line 40 px
from a wall returns the full room area within 3%; existing cases still
pass. The threshold precompute stays one pass per page.

---

## Phase 2: measure, then fix the harder problems

### P12: takeoff fixture set and accuracy harness

**Why.** The fill and scale ideas compete; the research could not rank
them on real drawings. No public benchmark measures length or area
takeoff from scaled drawings.

**Change.** `scripts/takeoff-bench.mjs` plus fixtures generated by
`scripts/generate-synthetic-dataset.mjs`, which already knows the
ground-truth scale, wall lengths and room areas:
- rooms joined by interior doors, bench strips, diagonal wings, curved
  walls, L-rooms;
- vertical and rotated dimensions, colon-less, imperial and bar scales;
- symbols on tile seams and touching walls.

Report per item: count error, area error (separately from counts, since
they fail differently), and pass rate within ±2%, ±10%, ±25%. Run in CI
with a floor, so regressions fail the build.

### P13: Dynamic Fill splits rooms joined by an interior door

**Problem.** Escalation only fires when the fill exceeds 40% of the page,
so two rooms joined by a door inside a sealed building fill as one.

**Evidence.** Robotics room segmentation (Bormann et al., ICRA 2016;
DUDE, 2026); door swing arcs mark openings; born-digital room labels.

**Change**, in order, each step measured on P12 before the next:
1. **Semantic triggers.** Escalate when the fill contains two or more room
   labels from the text layer, or when its area is larger than the area
   written in its own label, or implausible for one room at the
   calibrated scale.
2. **Door-width closing.** Once scale is calibrated, always try the rung
   matching 0.6 to 1.0 m (safe after P11's gate).
3. **Neck cuts.** Distance transform inside the fill; cut at necks of half a
   door width only when wall ends sit on both sides and a second cue
   agrees (door arc, labels on both sides), so L-rooms are not cut at the
   elbow.

**Check.** P12 interior-door fixtures return the clicked room within 3%.
No regression on L-rooms or sealed rooms.

### P14: scale consensus and better scale grammars

**Problems.** First match wins; a colon-less ratio is now missed; imperial
and graphic scales are not parsed; nothing checks one scale source
against another.

**Evidence.** PlanMetric (RANSAC over dimension spans, explicit
"conflict"); Lv et al. (CVPR 2021); ISO 5455 preferred series; chart
parsing's tick-label fit.

**Change** (`src/engine/ocr.ts`, new `src/engine/scale.ts`).
1. Every source is a vote: title-block ratio, imperial note, scale bar,
   each dimension read against its measured length. RANSAC with a ±2%
   band per viewport returns `agreed`, `conflict` or `insufficient`.
2. Diagnose disagreements: ×6 suggests the "1200 as 1:200" misread, ×10 a
   unit slip, ×2 or ×√2 a reduced print.
3. Grammars: colon substitutes (`; . | i l`) or a bare "1NNN" only next to
   SCALE / @ / AT and only as low-confidence votes; imperial
   (`1/4" = 1'-0"` is 1:48, `1" = 20'` is 1:240); FULL SIZE, HALF SIZE;
   NTS abstains.
4. Graphic bar tier: a line with three or more ticks near SCALE, labels in
   arithmetic progression, RANSAC fit.

**Check.** P12 scale fixtures; unit tests for each grammar; the app shows
"scale conflict" instead of silently applying one.

### P15: provenance on every MCP number

**Evidence.** BIM-agent studies: unit handling and faithful values are the
bottleneck. AEC-Bench: agents default to the text layer.

**Change** (`src/headless/mcp.ts`, `specs/headless-engine.md`). Every
numeric result carries `unit`, `scaleSource` (and consensus status from
P14), `bbox` and `method`. Area results also report boundary convention
and gap-closing rung. The spec states that only tool calls create
quantities. Tool docs steer agents away from rendering pages to read
numbers.

**Check.** `mcp-smoke.mjs` asserts provenance fields on measure, scan,
fill and read_text.

---

## Phase 3: use the vector layer

The largest opportunity in the research: pdf2takeoff never reads PDF
vector paths, so every count and fill works on rasters.

### P16: vector layer spike (go / no-go)

**Questions** on the repo samples and a few real CAD exports:
- Does `getOperatorList` extraction (paths, transforms, line widths, dash
  patterns, Form XObjects) stay under about 1 s per A1 sheet?
- Do exporters keep blocks as Form XObjects and layers as optional content
  groups, or explode them?
- Are dashes a dash pattern or pre-split segments?
- What is the exact `constructPath` argument layout in pdfjs-dist 5.4?

**Output.** A short findings note and `src/engine/vector.ts` extraction
behind a port, if the answers support P17 to P19.

### P17: vector count tier

Click a symbol; build a normalised path signature (segments, arcs, relative
geometry); hash and look up across the page; verify with a shape distance.
No tiles, so no seams or window caps; handles symbols touching walls,
which the raster matcher misses. Falls back to raster tiers on scans.

### P18: vector-aware room fill

Build the closing mask from heavy strokes only (line width separates walls
from furniture exactly). Detect doors as arc plus leaf line and add the
hinge-to-jamb chord as a virtual wall. Endpoint-pair bridging works at any
angle, covering diagonal and curved walls that axis-aligned closing misses.

### P19: tiered `compare_revisions` with quantity delta

**Evidence.** VLMs find at most 40.7% of real changes (DiffSpot);
Drawing-Checker only uses an LLM after deterministic matching.

**Change** (`src/engine/compare.ts`, `src/engine/diff.ts`, MCP tool):
register sheets, vector diff where both are vector (exact, moved, added,
removed, modified, grouped into change regions), text-layer diff so a
changed dimension is a changed value, raster overlay for scans. New
**quantity delta** mode: re-run saved counts and measures on the new
revision and report the differences. No paper does this.

---

## Phase 4: model work, revised by the research

| Patch | Original plan | Revision |
|---|---|---|
| P3b (OCR model half) | Hand-built PP-OCR ONNX port | Use the official Apache-2.0 `@paddleocr/paddleocr-js` SDK with its text-line orientation stage, behind the same `OcrWord[]` port; compare against Tesseract on P12 crops before switching |
| P5b (click-any-symbol tier) | DINOv2 prototype matcher | NCC candidates, DINOv2 verify, adaptive gap threshold, 8 dihedral poses, seam fusion from P10; Alt-click negative exemplars for lookalikes (GPO vs switch) |
| P2b (learned openings) | Blocked on non-commercial data | ResPlan (CC BY 4.0) unblocks a small opening-heatmap model; legal check on listing provenance first; ships only as backup to P13 and P18 |

### P20: public benchmark runs

Run an agent with pdf2takeoff tools on AECV-Bench's counting set, add a
"pdf2takeoff MCP" configuration to the AEC-Bench harness, and publish P12
as a length and area benchmark. Goal: turn "numbers come from tools" into a
measured result.

---

## Non-goals for now

- Server-class learned spotters (VecFormer, DPSS, SymPoint-V2) and
  sequence floor plan parsers (Raster2Seq, RoomFormer): GPU-bound and
  trained on research-only data. Revisit only with an optional server.
- Asking a VLM to read numbers, find changes or count from pixels.
