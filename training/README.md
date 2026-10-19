# Training the symbol detector

This directory holds the data + training pipeline for the tier-2 ML scan
(the ONNX detector that runs in the browser via `src/engine/scan-onnx.ts`
and handles symbols touching lines and cluttered or scanned sheets — the
blind spots of the tier-1 connected-component scan).

## Pipeline

```
scripts/generate-synthetic-dataset.mjs   synthetic sheets + perfect labels (zero deps)
scripts/floorplancad-convert.py          FloorPlanCAD DXF -> images + labels
training/kaggle-train-yolox.ipynb        train + eval + ONNX export (ABANDONED v1 — see Training below)
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
- 5 symbol classes: `downlight, gpo, switch, smoke-alarm, diffuser` — the
  canonical name is `smoke-alarm` everywhere (generator, notebook, manifest);
  class *indices* are what matter to the model, names only label hits
- 14–42 symbols per sheet, size-jittered; most are rejection-sampled clear of
  walls and each other, but a per-sheet quota (15–35%) is parked on wall lines
  so the detector trains on symbols touching linework — the tier-1 CV scan's
  declared blind spot
- An always-on invariant asserts every symbol's ink stays inside its label
  box (+2px) — this is what caught the original smoke-alarm defect, where the
  "solid centre dot" was drawn with a 99px brush stamp and presented class 3
  as a giant ink blob; the generator now draws a true filled disc
  (`fillDisc`)
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

## Training (Kaggle, free GPUs) — read this first

**The committed `kaggle-train-yolox.ipynb` is the abandoned v1 attempt, kept
for reference.** mmdetection needs mmcv wheels that were never published for
Kaggle's Python 3.13; after several iterations that stack was dropped. What
actually shipped as the v1 model is a **torchvision Faster R-CNN
(MobileNetV3-FPN)** export trained in plain torch — the honest account of
those iterations lives in
[`docs/blog/draft-open-symbol-detector.md`](../docs/blog/draft-open-symbol-detector.md).

The v2 retrain must additionally honour the **tile contract**
([`specs/detector-tiling.md`](../specs/detector-tiling.md)): the engine now
cuts large sheets into tiles when the manifest declares
`tile: {pxPerPt, overlapPx}`, so the training recipe must present symbols at
that same `pxPerPt` at model input and the export cell must write it into
`symbols.json`. With 1280×905 synthetic sheets (~427×302 pt at 3 px/pt)
letterboxed whole-page to a 416 px input, the effective rate is
`416 × 3 / 1280 ≈ 0.98` px/pt — declare that number, not 3. (The shipped v1
recipe — the same sheets letterboxed to its 800 px input — is
`800 × 3 / 1280 = 1.875`.) A v2 notebook
should start from the working torch stack, not the mmdet one.

Upload the generated dataset as a Kaggle Dataset, attach the notebook,
enable a T4 accelerator, run all cells. Outputs land in `/kaggle/working/`:
`symbols.onnx` + `symbols.json` in exactly the `[1, N, 5+C]`
xyxy+objectness+classes layout that `src/engine/scan-onnx.ts` decodes
(`head: "yolox-raw"` in the manifest).

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
