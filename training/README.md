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
scripts/bench/pid_fetch.py               Dataset-P&ID sheets + labels from the public mirror
scripts/bench/pid_train_tiles.py         Dataset-P&ID sheets -> tiled training layout
scripts/bench/pid-count-bench.mjs        one-shot count accuracy over many P&ID sheets
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

## Dataset-P&ID

Dataset-P&ID (Digitize-PID, Paliwal et al. 2021, arXiv 2109.03794) is 500
synthetic P&ID sheets, 7040 x 4480 px, 32 symbol classes, about 115 symbols
per sheet, every one of them fused with the pipe network: the tier-1 scan's
stress case and the detector's first public training target. Background,
licence status (unstated: research use until the authors answer) and the
one-sheet and 50-sheet results are in
[docs/research/benchmarks/raster-symbol-datasets.md](../docs/research/benchmarks/raster-symbol-datasets.md).
The public copy reachable without an account is the Git-LFS mirror
`github.com/ch-hristov/p-id-symbols` (60 overlapping 1280 px tiles per
sheet; `images.zip` is 1.5 GB, `labels.zip` 6.7 MB).

### Fetch

```bash
python3 -I scripts/bench/pid_fetch.py --out /data/pid/bench50 --sheets 134 --count 50 --seed 1
python3 -I scripts/bench/pid_fetch.py --out /data/pid/train150 --count 150 --seed 2 \
    --exclude /data/pid/bench50/manifest.json
```

Pillow is the only dependency. The script reads the zip's central
directory once (cached in `<out>/_src/images-index.json`), pulls each
sheet's 60 tiles with HTTP Range requests (about 3 s per sheet with 8
workers, no 1.5 GB download), checks the tile axis order on the first sheet,
stitches the sheet to `images/<sheet>.png`, and writes `labels/<sheet>.txt`
in sheet coordinates after dropping boxes cut by an interior tile edge and
de-duplicating the 50% overlap (IoU > 0.5 within class; sheet 134 goes from
385 tile boxes to 117 symbols). `--sheets` pins ids, `--seed` draws the rest,
`--exclude` keeps a second run disjoint from the first, `--skip-existing`
resumes, `--time-budget` stops cleanly. `manifest.json` lists every sheet
with its paths, per-class counts and timings; `classes.txt` and
`class-map.json` carry the class table.

Class names: the paper numbers its symbols "Symbol 1" to "Symbol 32" (1 to
25 complex symbols, 26 to 32 basic shapes: instrument bubbles and boxes) and
never names them; the mirror keeps that numbering (id n = Symbol n, id 0 =
"Not_used") and adds the uploader's descriptive names, of which there are
only 30 distinct for the 32 symbols (3 and 5 "Globe_valve_NO", 26 and 27
"Instrument_Field", 28 and 31 "Instrument_Panel", 30 and 32 "box"). The
converter names class n - 1 `S<nn>_<name>` with the duplicate's second
member suffixed `_b` and the typo in 13 fixed, so YOLO ids are 0 to 31 with
no empty class and the paper's number is always in the name. Keep the
output outside the repository; nothing from it is committed.

### Convert to the training layout

```bash
python3 -I scripts/bench/pid_train_tiles.py --src /data/pid/bench50 --src /data/pid/train150 \
    --out /data/pid/yolo --tile 640 --stride 480 --input-size 640
```

Splits by sheet 80/10/10 (seeded; the mirror's own `train.txt` / `val.txt`
split by tile and leak sheets), tiles every sheet at 640 px with a 160 px
overlap (wider than the largest symbol, 157 px, so every symbol lies whole
in at least one tile), keeps a box in a tile when at least 60% of it is
inside, skips tiles with no ink and keeps 5% of the inked label-free tiles
as negatives. The 200 sheets fetched above give 160/20/20 sheets, 15,385
tiles and 41,352 boxes (839 to 3,163 per class in train; flanges are the
big class) in 495 MB, in about four minutes. Output: `images/{train,val,test}`,
`labels/{train,val,test}`, `classes.txt`, `dataset.yaml`, `split.json`
(which sheet went where, per class counts) and `symbols.template.json`.

The tile size is the inference scale: `specs/detector-tiling.md` cuts the
sheet into windows of `inputSize x 3 / pxPerPt` raster px, and a PNG opened
by the CLI is one page of W/3 x H/3 points, so 640 px tiles letterboxed to a
640 px model input mean `pxPerPt = 3.0`, native resolution, symbols 22 to
156 px at the model input. With the notebook's default `INPUT_SIZE = 416`
the same tiles give `pxPerPt = 1.95` and a smallest symbol of about 14 px;
pass `--input-size 416` so the template says so, or raise `INPUT_SIZE` to
640 (YOLOX-nano trains fine at 640; a T4 takes batch 16). The template's
`tile` block (`pxPerPt`, `overlapPx` 160, `maxSymbolPt` 53) must go into the
`symbols.json` the notebook's export cell writes, next to `head`, or the
browser and CLI will resample symbols to a size the model never saw.

### Train

In `training/kaggle-train-yolox.ipynb` set `DATASET_DIR` to the uploaded
`/data/pid/yolo`, `CLASSES` to the 32 names in `classes.txt` (in order),
`INPUT_SIZE` to the value the tiles were cut for, run all cells, and merge
`symbols.template.json`'s `tile` block into the exported `symbols.json`.
Expect the class pairs that differ by one stroke (gate NC vs globe NC,
Symbols 3 and 5) to dominate the confusion matrix; the `test` split holds
whole sheets the model never saw, which is what the count bench below
scores.

### Evaluate (one-shot counting over whole sheets)

```bash
node scripts/bench/pid-count-bench.mjs --manifest /data/pid/bench50/manifest.json --jobs 2 \
    --json results.json --md results.md                      # tier-1 CV, the baseline
node scripts/bench/pid-count-bench.mjs --manifest /data/pid/bench50/manifest.json \
    --model /path/to/model-dir --json detector.json          # the trained detector
```

The protocol is `scripts/check-scan-dataset.mts` (click the first instance
of every class, match hits to boxes by centre-in-box) run over every sheet
in the manifest. Without `--model` the harness is spawned per sheet, so the
tier-1 numbers come from unchanged code; with `--model` every click goes
through `pdf2takeoff scan <sheet>.png --at x,y --model <dir>`, which opens
the PNG directly and answers with the ONNX detector, so both paths share the
matching and the report. It prints and writes per-class recall, precision,
exact-count rate and MAPE pooled over sheets, the mean of the per-sheet
means, per-sheet timings and the worst (sheet, class) pairs with a
heuristic failure type (click rejected, rotated sibling missed, fused with
text, interior differs, look-alike confusion, spurious hits). `--sheets`,
`--limit`, `--remove-lines`, `--dihedral` and `--match-distance` pass
through to the harness. For a detector trained on the layout above, score
the sheets in `split.json`'s `test` list only (`--sheets`), the others were
in training. Budget: the tier-1 path is about 1 s per click (30 s per
sheet on an idle machine); the `--model` path pays a CLI start and a 31 Mpx
decode per click, about 12 s each on a loaded box, so run it on the 20 test
sheets, not all 50 (the plumbing is proven with the stub model in
`scripts/fixtures/detector-stub`, which reports every click as spurious
hits, as it should).

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
