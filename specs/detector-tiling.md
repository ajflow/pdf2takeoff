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
  "classes": ["downlight", "gpo", "switch", "smoke-alarm", "diffuser"],
  "head": "yolox-raw",
  "tile": { "pxPerPt": 1.5, "overlapPx": 32 }
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
- **Spacing**: windows are placed on an even grid per axis with spacing
  ≤ `W − overlapPx` (so actual overlap is always at least `overlapPx`), and
  the final window is edge-aligned — the sheet border is never cut off.
- **Fusion**: every window's detections are mapped back to raster px through
  the same inverse letterbox transform (window offset included) and one
  per-class NMS runs across all of them — duplicates in overlap regions
  merge, cross-window evidence survives.
- Click-to-class selection, decode formats (`yolox-raw` / `mmdet`) and the
  tier-1 fallback are unchanged; a broken tile config (more than 512
  windows) throws, which `scan.ts` catches and downgrades to the CV scan.

Absent `tile` ⇒ legacy whole-page letterbox, bit-identical to v1.

## Training implications

The model must see symbols at the manifest's `pxPerPt` **at model input**.
Concretely: if you re-train on synthetic sheets rendered at
RASTER_SCALE = 3 (1280×905 px for ~427×302 pt) with whole-page letterbox to
416 px, the effective rate is `416 × 3 / 1280 ≈ 0.98` px/pt — declare that,
not 3. The shipped v1 model's recipe — the same sheets letterboxed to its
800 px input — corresponds to `800 × 3 / 1280 = 1.875`; that is the number
to declare if it is ever opted into tiling. If you instead train on 416-px
crops of the 3× raster, declare 3.
Mismatched values make the window grid resample symbols to a size the model
never saw: recall quietly dies, so this number belongs in the training
notebook's export cell, written into `symbols.json` next to `head`.

## Verification

`scripts/check-detector.mjs` (runs in `npm run typecheck:engine`) drives
`detectorScan` two ways. A fixed-answer fake session asserts the hits land at
the expected tile centres in raster space, that duplicate rows merge under
NMS, and that the legacy no-tile path maps a whole-page detection back to the
same point. A self-locating stub then flood-fills dark blobs in the actual
CHW input, verifying the full geometry round-trip (tile → resample → decode →
offset → NMS → PDF points): every planted symbol on a 1200×840 pt sheet is
recovered exactly once — including tile-border straddlers and sheet corners —
with zero phantoms, column-major output tensors decode identically, a
crushed-symbol legacy pass returns the documented error, and the MAX_DET cap
and the runaway-tile guard both hold.
