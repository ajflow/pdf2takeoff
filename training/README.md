# Training the symbol detector

This directory holds the data + training pipeline for the tier-2 ML scan
(the ONNX detector that runs in the browser via `src/scan-onnx.ts` and
handles symbols touching lines and cluttered or scanned sheets — the blind
spots of the tier-1 connected-component scan).

## Pipeline

```
scripts/generate-synthetic-dataset.mjs   synthetic sheets + perfect labels (zero deps)
scripts/floorplancad-convert.py          FloorPlanCAD SVG (or DXF) -> images + labels + counts
scripts/floorplancad-count-bench.mjs     one-shot count accuracy on FloorPlanCAD-style SVGs
training/kaggle-train-yolox.ipynb        train + eval + ONNX export (Kaggle GPU)
public/models/                           drop-in: symbols.onnx + symbols.json
```

End to end: generate data → train on Kaggle → download `symbols.onnx` +
`symbols.json` into `public/models/` → reload the app. The Scan tool
auto-upgrades to the detector; no code changes, no rebuild for re-trains.

## Synthetic dataset

```bash
node scripts/generate-synthetic-dataset.mjs --count 200 --seed 42 --debug [--degrade 0.5]
```

- 1280×905 PNG sheets, randomized: wall layouts with door gaps, faint grids,
  dimension lines, title blocks, line weights and ink densities
- 5 symbol classes: `downlight, gpo, switch, smoke, diffuser`
- 14–42 symbols per sheet, size-jittered; most are rejection-sampled clear of
  walls and each other, but a per-sheet quota (15–35%) is parked on wall lines
  so the detector trains on symbols touching linework — the tier-1 CV scan's
  declared blind spot
- Scan-simulation: `--degrade` (default 0.5) marks that fraction of sheets
  with one SESYD-style artifact each — blur, speckle noise, contrast/gamma,
  ±0.6° rotation (labels remapped to match), photocopy (edge shadow +
  contrast + dust) — never stacked, so the detector meets each artifact in
  isolation
- YOLO-format labels (`cls cx cy w h`, normalised), emitted from the same
  coordinates the renderer drew — labels are exact by construction, no
  labelling effort
- 85/15 train/val split, `dataset.yaml` included
- `--debug` also writes overlay images with the label boxes drawn (recipe
  tagged in the filename), so label quality can be verified by eye

Output is **gitignored** (7 MB for 200 sheets) — regenerate on demand or in
the training notebook. 200 sheets ≈ 5,500 labelled instances; scale `--count`
to thousands for production training (the generator is seeded and
reproducible).

## FloorPlanCAD conversion

```bash
python3 scripts/floorplancad-convert.py --src <floorplancad-dir>/svg_gt \
    --out training/floorplancad [--limit 500] [--px 1280] [--mono] [--counts-only]
```

FloorPlanCAD is distributed as SVG tiles (140 drawing units square), never
as DXF. The mode is picked by file extension.

- SVG mode (the dataset): every `<path>`, `<circle>` and `<ellipse>` carries
  `semanticId` (1..35) and, on countable things, `instanceId`. The converter
  groups primitives by instance, boxes each instance in viewBox units
  (arcs, curves and rotated ellipses are sampled, transforms composed),
  rasterises with cairosvg at `--px` on the long edge (`--mono` forces black
  strokes, the usual state of a PDF export), and writes YOLO labels
  normalised to the viewBox. It also writes `counts/<drawing>.json` and one
  `counts.json` with per-class instance counts, boxes and centroids: the
  ground truth for the count bench below (`--counts-only` writes just these)
- Classes: FloorPlanCAD-V2 has 35, 30 countable "things" (ids 1..30: doors,
  windows, furniture, sanitary fixtures, stairs, elevator, escalator) and 5
  "stuff" classes (31..35: row chairs, parking spot, wall, curtain wall,
  railing). The ICCV 2021 paper's "30 categories" is the V1 label set (28
  things plus wall and parking); the released data has 35. YOLO class ids
  are `semanticId - 1` for the 30 things, so `classes.txt` is fixed and the
  same for every run; stuff and background are not boxed. CADTransformer's
  `RemapDict` (a permutation of the 36 ids, kept in the script as
  `CADTRANSFORMER_REMAP` for cross-referencing its outputs) is not applied
- DXF mode (other CAD exports): symbols are `INSERT` block references; the
  converter expands their geometry for the bbox, renders modelspace via the
  ezdxf matplotlib backend and normalises labels against the renderer's own
  frame. Class source: `--class-map` JSON > the INSERT's `category`
  attribute > the block name
- Deterministic hash split, emits `classes.txt` + `dataset.yaml` in the same
  layout as the synthetic generator, so all sources mix freely in training
- Tested on synthetic inputs of both kinds: `scripts/make-floorplancad-sample.py`
  writes drawings in the FloorPlanCAD SVG schema (6 thing classes at the four
  right-angle rotations, mirrored doors, size-varied stairs, walls and parking
  as stuff), and the 50 instances it declares come back as 50 labels and
  matching counts; the DXF path still gives 14 labels on the survey's 2-file
  synthetic DXF

### Count bench (one-shot protocol)

```bash
python3 scripts/floorplancad-convert.py --src <svg-dir> --out <gt-dir> --counts-only
node --experimental-strip-types scripts/floorplancad-count-bench.mjs <svg-dir> \
    --counts <gt-dir>/counts.json [--limit 20] [--policy first|median|largest] \
    [--mono] [--model public/models] [--json results.json]
```

Converts each SVG to a vector PDF with cairosvg (1 unit = 1 mm), clicks the
centroid of one ground-truth instance per class, runs the same `scanDocAt`
the CLI and MCP use, and reports exact-match rate, MAPE, bias, instance
precision / recall and the answering tier per class. On the synthetic SVGs
the vector tier counts five classes exactly and under-counts the size-varied
stairs (recall 43%), the expected one-exemplar limitation.

## Training (Kaggle, free GPUs)

Upload the generated dataset as a Kaggle Dataset, attach
`training/kaggle-train-yolox.ipynb`, enable a T4 accelerator, run all cells.
The notebook trains **YOLOX-nano** (depth 0.33 / width 0.25) at 416 px with
mmdetection, sanity-checks detections on val sheets, and exports ONNX in
exactly the `[1, N, 5+C]` xyxy+objectness+classes layout that
`src/scan-onnx.ts` decodes (`head: "yolox-raw"` in the manifest).

Outputs land in `/kaggle/working/`: `symbols.onnx` + `symbols.json`.

## Shipping a model

Drop both files into `public/models/` (gitignored — model binaries are
training artifacts, not source; see that folder's README). The headless
CLI and MCP server use the same files: `pdf2takeoff scan ... --model <dir>`,
the `PDF2TAKEOFF_MODEL_DIR` environment variable, or `public/models/` when
it holds the binary (`src/headless/detector-node.ts`, onnxruntime-web's
Node WASM backend; `scripts/check-detector-node.mjs` proves the path with a
committed 2 KB stub model). Behaviour:

- **No files** → tier-1 CV scan, nothing extra is ever downloaded
- **Files present** → first scan lazily loads `onnxruntime-web` (WASM from
  jsDelivr), detects page-wide, counts the class nearest the click,
  auto-labels every hit with its class name
- **Anything fails** → automatic fallback to tier-1 in the same click

## Why synthetic first

The detector must generalise to *geometry* (circle-with-cross = downlight),
not to one office's symbol library. Synthetic data teaches shapes at zero
cost and with perfect labels; FloorPlanCAD and client fine-tunes then teach
real-world style. Training purely on synthetic art risks brittleness against
scans — that's what the FloorPlanCAD mix and later client data fix.

## Licence note

Deliberately Apache-2.0-clean: YOLOX / NanoDet are the detector choices;
**Ultralytics YOLO is AGPL and is not used.** The trained weights inherit
the training data's licence terms — synthetic data is ours (Apache-2.0),
FloorPlanCAD is CC BY-NC 4.0 (non-commercial), so a FloorPlanCAD-mixed model
is a research checkpoint, not the shipped one; production models train on
synthetic + client-consented data only.

## Next steps

1. Run the notebook on Kaggle with ~2k synthetic sheets; watch val mAP
2. Download FloorPlanCAD, convert, mix in as a transfer stage
3. Pilot: client corrections on real tenders become fine-tune data
   (private hardware only — never Kaggle)
