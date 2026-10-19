# Model drop-in folder

This is where a trained symbol-detection model lands. When both files below
exist, the Scan tool automatically upgrades from the classic CV scan to the
ONNX detector (see `src/scan-onnx.ts`) — no code changes, no rebuild needed
for a re-train: replace the files and reload.

## Files

| File                | Purpose                                              |
| ------------------- | ---------------------------------------------------- |
| `symbols.json`      | Manifest: class names, input size, thresholds        |
| `symbols.onnx`      | The detector (or whatever `model` in the manifest names) |

## Manifest format

```json
{
  "model": "symbols-yolox-nano.onnx",
  "input": 416,
  "classes": ["downlight", "gpo", "switch", "smoke-alarm", "diffuser"],
  "score": 0.25,
  "iou": 0.45,
  "head": "yolox-raw"
}
```

- `classes` — index order must match the detector's output columns (same
  order as `dataset.yaml` used in training).
- `score` / `iou` — optional detection thresholds (defaults 0.25 / 0.45).
- `head` — `"yolox-raw"` for official YOLOX exports (score = objectness ×
  class), `"mmdet"` for mmdetection exports where scores are pre-combined.

The `.onnx` binaries are gitignored (they are build artifacts of the
training pipeline); commit only this README. Keep trained checkpoints in the
release they came from, or re-train via `training/` — the pipeline is
reproducible from the synthetic generator seed.

## Headless (CLI, MCP, benches)

The same two files serve the Node side: `pdf2takeoff scan <pdf> --page N
--at x,y --model <dir>`, the `PDF2TAKEOFF_MODEL_DIR` environment variable,
or this folder when it holds the binary (a manifest whose `model` is a URL
is read as `<dir>/<basename>`; the CLI never downloads). The loader is
`src/headless/detector-node.ts` (onnxruntime-web's Node entry, WASM, no extra
dependency). With no model present the scan stays on the vector and CV tiers.

## How it behaves in the app

- No files here → tier-1 CV scan (template match) is used, nothing extra is
  ever downloaded.
- Files present → on first scan the app lazily loads `onnxruntime-web`
  (WASM, from jsDelivr), runs inference in-page, and labels every hit with
  its class name. The user still "clicks one, counts them all": the class
  nearest the click is what gets counted.
- Anything fails (offline, corrupt file) → automatic fallback to tier-1 in
  the same click. Scanning never hard-fails because of the model.
