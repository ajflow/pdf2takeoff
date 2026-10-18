# Benchmark survey for pdf2takeoff

Date: 2026-10-18. Seven notes in this folder examine public benchmarks and
datasets against which pdf2takeoff could be evaluated. Each note marks claims
as [verified] (seen in cloned code or downloaded data) or [reported] (paper,
site or search snippet). This page ranks them and records the two engine
findings the survey turned up along the way.

## Ranking by fit and effort

| Rank | Benchmark | Tests | Public data | Licence | Effort to first result | Note |
|---|---|---|---|---|---|---|
| 1 | ResPlan (17k vector plans) | Dynamic Fill room area | Yes, 100 MB zip in the GitHub repo | CC BY 4.0 (Kaggle copy says BY-NC-SA, unresolved) | About one day; a trial already ran end to end | [room-area-datasets.md](room-area-datasets.md) |
| 2 | AECV-Bench (120 raster plans, 192 QA) | Door, window, room, toilet counts vs VLM leaderboard | Yes, inside the GitHub repo | None stated; 75 plans look CubiCasa-derived (BY-NC) | About two weeks after the raster input fix | [aecv-bench.md](aecv-bench.md) |
| 3 | Dataset-P&ID (500 synthetic sheets, 30 classes) | Scan one-shot count and ONNX detector mAP | Yes, via a Git-LFS mirror | Unknown | A few days for the detector path | [raster-symbol-datasets.md](raster-symbol-datasets.md) |
| 4 | DesignQA (20 scale questions) and MechVQA (445 dimension questions) | Calibrate then measure, dimension reading, tools vs no-tools | Yes, cloned in full | Code Apache-2.0, data unstated | About one week plus roughly 150 USD of model calls | [drawing-vqa-benchmarks.md](drawing-vqa-benchmarks.md) |
| 5 | FloorPlanCAD (SVG, 35 classes) | One-shot count per class on vector plans | Yes, but every mirror was blocked from this container | CC BY-NC 4.0 | About one week; needs an SVG converter, the DXF one does not apply | [floorplancad-archcad.md](floorplancad-archcad.md) |
| 6 | AEC-Bench (196 Harbor tasks) | read_text on navigation and cross-reference tasks; no quantity task | Code yes, PDFs on a blocked host | Apache-2.0 | Needs Docker and about 400 agent runs per model | [aec-bench.md](aec-bench.md) |
| 7 | TakeoffBench-V1 (Handoff) | Full residential takeoff, coverage and P@25 | Harness yes, blueprints by email request | No LICENSE file | Depends on data request; metrics reusable now | [takeoffbench-handoff.md](takeoffbench-handoff.md) |
| 8 | ArchCAD-400k | Vector symbol spotting | Gated 40k slice on Hugging Face | CC BY-NC 4.0, code academic only | Not worth it before FloorPlanCAD | [floorplancad-archcad.md](floorplancad-archcad.md) |
| 9 | DrawingVQA, LED-BENCH, MMArch, VDiff-Bench | Drawing QA, change detection | Private data or not yet released | Various | Blocked on the authors | [drawing-vqa-benchmarks.md](drawing-vqa-benchmarks.md) |
| 10 | DELP/SkeySpot, SESYD, Roboflow sets, CubiCasa5K, MSD, RPLAN, MLSTRUCT-FP | Symbols and rooms | Request-only, blocked here, or missing the fields needed | Mostly non-commercial | Secondary | notes above |

## What the trials showed

- **ResPlan through Dynamic Fill.** On plan 1 rendered to a 1:100 PDF, 8 of 9
  rooms filled with IoU 0.91 to 0.98 and a systematic 2 to 9 percent area
  underestimate. The shortfall is a boundary convention: ResPlan room polygons
  extend into the wall, and the trace stops inside the ink. With bare door gaps
  instead of drawn leaves, 6 of 9 rooms leaked. [verified]
- **Dataset-P&ID through Scan.** On sheet 134 (117 symbols, 30 classes), 23 of
  30 one-click classes landed on a single connected component because the symbol
  is fused with the pipe network. Mean recall 0.046. This quantifies the
  symbols-touching-linework blind spot and is the case for the detector tier or
  a line-removal pre-pass. [verified]
- **AECV-Bench samples through Scan.** Door swing arcs fuse with walls and are
  rejected as click targets; a toilet click found 1 of 2. Bedroom and toilet
  counts need room-label OCR, which is browser-only today. [verified]
- **AECV-Bench leaderboard reproduced** from the repo's 29 result CSVs: best
  mean exact match 0.543, best door exact match 0.43, best window 0.39. [verified]

## Engine findings that need fixing before any raster benchmark

1. **Headless raster crash.** `scan` and `compare` exit 139 (segfault) on any
   image-only PDF. Two agents isolated it independently to renderRasterNode
   (pdf.js plus @napi-rs/canvas drawing an image XObject). Vector PDFs are fine.
   Scanned sheets cannot run through the CLI or MCP server until this is fixed.
2. **No image input.** The CLI and MCP accept only PDFs. AECV-Bench, Dataset-P&ID
   and most symbol sets are PNG or JPG. A wrapper (pdf-lib at 3 px per point so
   RASTER_SCALE 3 reproduces native pixels) exists in the scratchpad; it should
   become a CLI option.
3. **OCR is browser-only.** tesseract.js is not wired into the Node path, so
   room-label counting (bedrooms, toilets) and title-block scale reading cannot
   run headless.
4. **Detector not reachable headless.** ops.ts never calls detectorScan, and the
   shipped manifest is a 5-class electrical model with no overlap with any
   public dataset.

## Gap nobody fills

No public benchmark tests length or area measurement from a scaled drawing.
DesignQA's 20 scale questions are the closest. The drawing-vqa note contains a
one-page spec for a ScaledDrawingBench built from scripts/takeoff-bench.mjs and
scripts/generate-synthetic-dataset.mjs: 200 sheets, vector and degraded raster
halves, five scale notations, about 2,000 questions, scored within 2 and 5
percent plus MAPE and a hallucination rate.

## Network note

From this container only github.com, raw.githubusercontent.com and PyPI were
reachable. arxiv.org, huggingface.co, Zenodo, Kaggle, Google Drive, Roboflow,
CVF and all GitHub Pages sites returned 403 at the proxy. Anything marked
[reported] could not be re-read at source and should be checked before citing.
