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

## Open

- Run on real CAD exports (one AutoCAD, one Revit, one Archicad sheet) to
  confirm XObject, layer and dash behaviour before relying on any of them.
- Text drawn as vector outlines (some exporters do this) would show up as
  many small filled paths; not handled yet.
