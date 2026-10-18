# Vector layer spike (patch-plan-2 P16)

Status 2026-10-17: **go**, for a vector count tier (P17) and vector-aware
fill (P18) on born-digital sheets, with the raster tiers kept as fallback.

## What was built

`src/engine/vector.ts` walks pdf.js's operator list (`page.getOperatorList()`)
into page-space segments with line width, stroke / fill, dash state, curve
flag, owning path and Form XObject instance. It takes pdf.js's `OPS` table as
an argument, so the engine stays free of pdf.js imports.
`scripts/check-vector.mjs` (in `typecheck:engine`) guards it.

## Answers

| Question | Answer |
|---|---|
| `constructPath` layout in pdfjs-dist 5.7 | `[paintOp, [pathData], minMax]`; `pathData` is a flat array of DrawOPS codes (0 move, 1 line, 2 cubic, 3 quadratic, 4 close) with coordinates in user space. The current transform comes from separate `transform` / `save` / `restore` ops; Form XObjects bracket with `paintFormXObjectBegin [matrix, bbox]` / `End`. |
| Speed | A synthetic A1 sheet with 128,700 operators (20k lines, 300 symbol instances, arcs, dashes): 0.46 s for `getOperatorList`, 0.08 s for the walk. The bundled sample: 33 ms. Under the 1 s budget. |
| Coordinates | Exact. The sample's partition comes out at x 173.4 pt from y 118.3 to 316.8 (60 + 4 m and 90 + 1 m at 1:100); symbol instances drawn as Form XObjects land at their placed positions. |
| Line weights | Kept per segment in page-space points (ExtGState `LW` included): the sample's 2.6 pt outer walls, 1.6 pt partition and 1.1 pt symbols separate cleanly. |
| Blocks as Form XObjects | Counted and attributed per instance when the producer emits them (pdf-lib `embedPage` does). Whether common CAD exporters (AutoCAD, Revit, Archicad) keep blocks as XObjects or explode them is **not verified**: the repo has no real CAD exports. P17 therefore groups by geometry, not by XObject. |
| Layers (optional content) | `beginMarkedContentProps OC` is counted; the sample has none. Not yet used. |
| Dashes | `setDash` (and ExtGState `D`) flag segments as dashed. Exporters that pre-split dashes into separate short segments are not detected as dashed; P17's grouping tolerates them. |

## Real CAD exports (2026-10-18)

Five redistributable born-digital sheets found on GitHub (the session's
network allowed only GitHub hosts; no ArchiCAD export exists there, and
Graphisoft's samples forbid redistribution):

| Sheet | Producer | Size | Ops p1 | Segs | Forms | Layers | Dashed | Tiny filled | Top line widths (pt) |
|---|---|---|---|---|---|---|---|---|---|
| Packt AutoCAD 2025 `10-4_Floor Plan ARCH.pdf` (MIT) | AutoCAD 2025 `pdfplot17.hdi` | ANSI D | 12,369 | 36,409 | 0 | 725 | 0 | 2 | 0.70 (36k), 0.85 |
| Packt AutoCAD 2025 `10-4_Sample Project.pdf` sheet A101 (MIT) | AutoCAD 2025 | ANSI E | 13,864 | 31,516 | 0 | 157 | 0 | 633 | 0.70, 0.95, 0 (filled), 0.50, 1.45 |
| Packt Revit course `028-Floor-Plans.pdf` (MIT) | Revit via PScript5 + Ghostscript 8.15 | A1 | 107,405 | 105,712 | 0 | 0 | 0 | 66 | 0.25 (100k), 0.60, 0.95, 0.50 |
| Kamai AEC-Geometric-Bench `sheet_09.pdf` (CC BY-NC 4.0) | AutoCAD, metadata stripped | ANSI E | 129,298 | 179,953 | 0 | 0 | 0 | 1,296 | 0.70 (135k), 0.25, 0 (filled), 0.50, 1.70 |
| OpeningDesign 44 E Mifflin Suite 802 permit set p1 (CC BY-SA 4.0) | "DDT PDF Export" (Revit practice) | ANSI E | 16,783 | 76,307 | 0 | 0 | 0 | 12 | 0.15 (73k), 0.35, 0.25, 1.00 |

Answers the spike could not give before:

- **Blocks are exploded.** Not one Form XObject on any sheet, AutoCAD or
  Revit. P17's decision to group symbols by geometry, not by XObject, was
  right; nothing else would have worked.
- **Dashes are pre-split.** `setDash` never appears; dashed lines arrive as
  separate short segments. The walker's `dashed` flag is therefore always
  false on real exports; dash detection needs a collinear-short-segment
  heuristic if it is ever needed.
- **Layers survive only from AutoCAD.** Optional-content groups: 725 and
  157 on the AutoCAD sheets, none from the Revit or redacted exports.
- **AutoCAD SHX text comes as outlines.** 633 and 1,296 tiny filled paths
  on the AutoCAD sheets (a second, invisible text copy carries the strings).
  These outlines are ink to the raster tiers and short strokes to the
  vector tiers.
- **Speed holds.** Operator list 126 ms to 931 ms, walk 35 ms to 90 ms on
  the heaviest (107k operators). Rendering at 3 px/pt: 1.0 s to 3.3 s per
  E-size sheet (59 Mpx); a fill on such a raster takes 1.2 s to 2.9 s in
  Node.

What the sheets broke, in order of severity:

1. **Headless rendering segfaulted on three of five sheets** (fixed on this
   branch). Not the sheets' fault: pdfjs-dist nests its own
   `@napi-rs/canvas` 0.1.100, pdf.js's Node canvas factory builds every
   image's temporary canvas from that copy, and `drawImage` of it into our
   1.0.11 page context crosses two skia binaries. The first sheet with a
   title-block logo crashed `render_page`, `scan`, `fill_area` and
   `compare` alike. `pdfjs-node.ts` now hands pdf.js a canvas factory
   backed by our module and publishes our `DOMMatrix`; the bench embeds a
   logo on every sheet so this cannot come back.
2. **0.15 pt pens dissolve in the ink mask.** 73k of the OpeningDesign
   sheet's 76k segments are 0.15 pt: 0.45 px at 3 px/pt, anti-aliased to
   grey that straddles the 150 luminance threshold. Walls break and fills
   leak (one room came back unbounded without hints, 3.9 m² with the vector
   bridges). The raster tiers need either a higher render scale for thin
   sheets, an adaptive ink threshold, or ink rasterised from the vector
   layer with a 1 px minimum width. **Open.**
3. **Vector door bridges over-fire on exploded exports.** 613, 1,152, 971,
   2,483 and 3,275 bridges per sheet, uncalibrated: every exploded block,
   hatch line and text outline contributes free ends. P18's free-end test
   needs the raster rule's structural and length gates and a per-sheet cap.
   **Open.**
4. **Room-label detection is far too loose on real text layers:** 27,
   116, 311, 2 and 149 "room labels" per sheet (schedules, legends, grid
   bubbles). The label-driven split keeps escalating until the fill holds
   one label, so a fill touching a schedule can be over-split. **Open**,
   needs a legend and schedule exclusion (P21 will know where those are).
5. **Junk doorway clusters at 8 to 9 pt** (schedule grids, legend boxes)
   formed the sheet's "door width" on the Revit sheet and would have raised
   a false scale warning against a correct 1:100. Fixed on this branch:
   the warning defers to any printed scale and ignores agreed widths under
   14 pt; the fill's own use of sheet widths was already guarded by the
   room-sized split test.

## Open

- An ArchiCAD export (Graphisoft's Hillside House can be exported locally
  under its personal-use licence) and a native Revit 2022+ PDF (producer
  string "Autodesk Revit") remain unverified.
- Items 2 to 4 above.
- Text drawn as vector outlines is now confirmed (AutoCAD SHX); a filter
  that drops tiny filled paths before symbol grouping and bridging is the
  obvious first step.
