# Detector tiling (tier-2 scan on large sheets)

Status: **implemented** (`src/engine/scan-onnx.ts`, manifest opt-in).
Related: [headless-engine.md](headless-engine.md) §5 (scan tiers),
[../docs/research/ai-literature-review.md](../docs/research/ai-literature-review.md)
— Rezvanifar et al. 2020 (tile-based detection on floor plans).

## Problem

Whole-page letterboxing resamples the entire sheet — 842×595 pt at
RASTER_SCALE = 3 px/pt is a 2526×1785 raster — into the model's square input
(416 px for YOLOX-nano). On an A3 or A0 sheet that crushes a 9 mm symbol to a
handful of input pixels, far below the size band the synthetic training set
presents (1280×905 sheets → 416 px keeps symbols at their trained size). The
detector's recall collapses exactly on the large sheets that matter.

## Design

When the model manifest declares a `tile` block, the raster is cut into
square windows and each is letterboxed to `inputSize` independently:

```json
{
  "model": "symbols.onnx",
  "classes": ["downlight", "gpo", "switch", "smoke", "diffuser"],
  "head": "yolox-raw",
  "tile": { "pxPerPt": 1.5, "overlapPx": 32, "maxSymbolPt": 30 }
}
```

- **Window side** `W = inputSize × RASTER_SCALE / pxPerPt` raster px. The
  resample of a W-px window to `inputSize` lands symbols at exactly
  `pxPerPt` input pixels per PDF point — the rate training must match
  (below).
- **pxPerPt** is a property of the *training recipe*, not the sheet: with
  1280×905 synthetic sheets (~427×302 pt at RASTER_SCALE = 3) letterboxed to
  416 px, symbols train at ≈ 416 × 3 / 1280 ≈ 0.98 px/pt; a tiled manifest for
  that model declares `pxPerPt: 0.98` and gets 1280-px windows at the same
  rate.
- **Overlap**: the effective overlap is the manifest's `overlapPx` (up to
  `W − 1`), raised automatically towards `1.25 × maxSymbolPt × RASTER_SCALE
  + 4` raster px but never past `W / 2`. `maxSymbolPt` is the largest symbol in PDF points (default 30,
  about 10.6 mm). With overlap wider than any symbol, every symbol lies
  whole, clear of interior edges, in at least one window. A 9 mm symbol is
  about 76 raster px, so the old 32 px example could leave a symbol on a
  seam cut in half in both windows.
- **Spacing**: windows are placed on an even grid per axis with spacing
  ≤ `W − overlap` (so actual overlap is always at least that), and the final
  window is edge-aligned: the sheet border is never cut off.
- **Blank windows** (no ink, sampled every other pixel) are skipped.
- **Fusion**:
  1. Every window's detections are mapped back to raster px through the
     same inverse letterbox transform (window offset included).
  2. Boxes touching an interior window edge (one shared with a neighbour,
     not the sheet border) are dropped: they are fragments of a symbol a
     neighbouring window sees whole.
  3. The class of the detection nearest the click is chosen, and only that
     class is fused, so other symbols on a busy sheet cannot crowd it out.
  4. Greedy suppression, best score first (larger box first on ties): IoU
     within a window (rows of neighbouring symbols survive); across windows
     a box is also merged when either covers half the other (intersection
     over the smaller box, as SAHI does), the kept box grows to the union of
     what it absorbs, and the pass repeats while it grows, so all fragments
     of a symbol cut by tiles in both directions collapse into one.
- **Caps**: at most 2000 hits are returned; beyond that the result sets
  `truncated` and the note says so. More than 4096 non-blank tiles throws,
  which `scan.ts` catches and downgrades to the CV scan with a warning.
- Decode formats (`yolox-raw` / `mmdet`) and the tier-1 fallback are
  unchanged.

Absent `tile` ⇒ legacy whole-page letterbox: same geometry as v1, with the
fixed suppression (overlapping duplicates are suppressed, not kept) and the
class chosen before suppression.

## Training implications

The model must see symbols at the manifest's `pxPerPt` **at model input**.
Concretely: if you re-train on synthetic sheets rendered at
RASTER_SCALE = 3 (1280×905 px for ~427×302 pt) with whole-page letterbox to
416 px, the effective rate is `416 × 3 / 1280 ≈ 0.98` px/pt — declare that,
not 3. If you instead train on 416-px crops of the 3× raster, declare 3.
Mismatched values make the window grid resample symbols to a size the model
never saw: recall quietly dies, so this number belongs in the training
notebook's export cell, written into `symbols.json` next to `head`.

## Verification

`scripts/check-detector.mjs` (runs in `npm run typecheck:engine`) drives
`detectorScan` with a fake session that detects every dark blob in the
input it is actually given, so window offsets and resampling are exercised
(feeding a window the wrong pixels fails the check). It asserts:

- the legacy whole-page path maps detections back to the page;
- symbols swept across vertical and horizontal seams count exactly once;
- tightly packed neighbours on a seam count separately;
- a sparse 3000×3000 sheet needing about 4,356 windows runs only the inked
  ones;
- 2,809 symbols return the first 2000 with `truncated` set.
