# Training the symbol detector

This directory holds the data + training pipeline for the tier-2 ML scan
(the ONNX detector that runs in the browser via `src/scan-onnx.ts` and
handles symbols touching lines and cluttered or scanned sheets — the blind
spots of the tier-1 connected-component scan).

## Pipeline

```
scripts/generate-synthetic-dataset.mjs   synthetic sheets + perfect labels (zero deps)
scripts/floorplancad-convert.py          FloorPlanCAD DXF -> images + labels
training/kaggle-train-yolox.ipynb        train + eval + ONNX export (Kaggle GPU)
public/models/                           drop-in: symbols.onnx + symbols.json
```

End to end: generate data → train on Kaggle → download `symbols.onnx` +
`symbols.json` into `public/models/` → reload the app. The Scan tool
auto-upgrades to the detector; no code changes, no rebuild for re-trains.

## Synthetic dataset

```bash
node scripts/generate-synthetic-dataset.mjs --count 200 --seed 42 --debug
```

- 1280×905 PNG sheets, randomized: wall layouts with door gaps, faint grids,
  dimension lines, title blocks, line weights and ink densities
- 5 symbol classes: `downlight, gpo, switch, smoke, diffuser`
- 14–42 symbols per sheet placed clear of walls and each other (rejection
  sampled), size-jittered
- YOLO-format labels (`cls cx cy w h`, normalised), emitted from the same
  coordinates the renderer drew — labels are exact by construction, no
  labelling effort
- 85/15 train/val split, `dataset.yaml` included
- `--debug` also writes overlay images with the label boxes drawn, so label
  quality can be verified by eye (verified for seed 42)

Output is **gitignored** (7 MB for 200 sheets) — regenerate on demand or in
the training notebook. 200 sheets ≈ 5,500 labelled instances; scale `--count`
to thousands for production training (the generator is seeded and
reproducible).

## FloorPlanCAD conversion

```bash
python3 scripts/floorplancad-convert.py --src <floorplancad-dxf-dir> \
    --out training/floorplancad [--class-map map.json] [--limit 500] [--px 1280]
```

- Ground truth comes free from the vector data: every symbol in FloorPlanCAD
  is an `INSERT` block reference; the converter expands its geometry
  (rotation/scale aware) for the bbox
- Renders each modelspace to PNG via the ezdxf matplotlib backend; labels
  normalize against the renderer's own coordinate frame, so image and labels
  cannot disagree
- Class source: `--class-map` JSON > the INSERT's `category` attribute > the
  block name — pin the official 30 categories when you download the dataset
- Deterministic hash split, emits `classes.txt` + `dataset.yaml` in the same
  layout as the synthetic generator, so both sources mix freely in training
- Round-trip tested on a synthetic DXF (8 symbols, 3 classes, rotations
  0/45/90/180): overlay inspection confirms every box tightly encloses its
  symbol

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
training artifacts, not source; see that folder's README). Behaviour:

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
