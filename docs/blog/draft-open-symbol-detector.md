---
title: "Seven Kaggle Versions Later: Teaching a Browser to Count Symbols"
draft: true
date: 2026-10-17
author: "AJ Wawan"
tags: [pdf2takeoff, machine-learning, construction-tech, open-source]
---

# Seven Kaggle Versions Later: Teaching a Browser to Count Symbols

Last night we shipped the machine-learning scan for
[pdf2takeoff](https://pdf2takeoff.com), our free and open-source takeoff tool.
Open a drawing, press `S`, click one light fixture, and a neural network running
entirely inside your browser counts every fixture of that type on the sheet,
pre-labelled, in about 1.6 seconds. No upload. No server. No GPU farm. The final
verification, run on production:

```
Scan counted 9 × downlight in 4070 ms
```

(That 4 seconds includes downloading the 76 MB model the first time. Cached
scans run in 1.6s.)

This post is the honest version of how it got there, because the honest version
is more useful than the highlight reel.

## What we built, in one paragraph

A construction takeoff lives or dies on counting: downlights, power points,
smoke alarms, diffusers, across dozens of sheets. Doing it by hand is how
quantities get missed. pdf2takeoff already had a fast classic-CV scan: click a
symbol and it matches every visually identical one on the page. The ML upgrade
adds robustness: a trained detector that recognises symbol *types* rather than
pixel shapes, labels them by name, and keeps working when symbols touch walls or
sheets get cluttered. The detector is a torchvision Faster R-CNN
(MobileNetV3-FPN) trained on 2,000 procedurally generated drawing sheets with
56,293 perfectly labelled symbols, exported to ONNX, and executed in the
visitor's browser through onnxruntime-web. Everything in the stack is
Apache-2.0. We deliberately avoided the popular YOLO packaging: it's AGPL, and a
licence that forces our users to open their estimating workflows is not a price
a takeoff tool should charge.

## The approach, before the war story

Three decisions made the ending possible:

**1. Ship the seam before the model.** Long before any training run, the app
grew a drop-in folder: put `symbols.onnx` and a `symbols.json` manifest into
`public/models/`, reload, and the scan quietly upgrades from CV to the
detector. Any failure anywhere falls back to the CV scan in the same click.
The model is an artifact, not a code change. This is why, once training
finally succeeded, going live took minutes.

**2. Synthetic data first.** We wrote a generator that draws randomized
floor plans: walls, door arcs, faint grids, title blocks, dimension lines,
and five symbol classes scattered with realistic clutter. Labels come from
the same coordinates the renderer used, so they are exact by construction and
cost nothing to produce. 2,000 sheets, one command, seeded and reproducible.
Real drawings will improve the model later; synthetic data made the first
model possible tonight.

**3. Verify in the real environment.** Every stage was tested in an actual
browser against the deployed app, not just in training metrics. This caught a
bug that every offline test had missed, which we'll get to.

## Where we got stuck: the seven versions

The training ran on Kaggle's free GPUs, and it took seven versions of the
notebook. Each failure taught something worth writing down.

| Version | What happened |
| --- | --- |
| v1 | The training data didn't attach to the committed notebook; the first cell asserted, correctly, that no dataset existed. |
| v2 | Kaggle's image had moved to Python 3.13 and torch 2.11. The detection framework we'd planned on (mmdetection, via mmcv wheels) publishes no Python 3.13 wheels at all. Uninstallable, at any index. |
| v3 | We rewrote training on torchvision (preinstalled, Apache-2.0). Training itself worked beautifully: 30 epochs, loss 0.94 to 0.55, 28 detections on a held-out sheet. Then the ONNX export crashed on a one-line bug: we passed a batched tensor where the model wanted a single image. |
| v4 | Fixed the batch dim. Export crashed differently: torch 2.11's new default exporter (dynamo) refuses torchvision's NMS internals. Data-dependent control flow, unguardable. |
| v5 | Forced the classic tracer and installed the exporter's new `onnxscript` dependency. Crashed on an edge case nobody warns you about: we traced with a zeros dummy image, the model correctly found zero objects in it, and the padding arithmetic indexed an empty tensor. |
| v6 | Rewrote the export wrapper as pure branch-free tensor math. The trace ran... and produced a graph that returned zero rows for everything. Tracing with an empty dummy had baked degenerate shapes into the graph. |
| v7 | The fix that finally worked: configure the detector to always return a fixed top-100 rows, making the entire export shape-static by construction. No branches, no padding, no dynamic anything. Clean export, first try. |

The lesson from v5 and v6 is the one we'd underline twice: **never trace an
export with a degenerate input.** A blank image is "valid" to every assertion
you wrote and still poisons the graph. Trace with a real sample.

## The 76 MB problem

The trained model weighed 76 MB, and our static host (Cloudflare Pages)
rejects files over 25 MB. Options: quantize (accuracy risk, WASM support
risk), or host the weights elsewhere. GitHub release assets would be
obvious, but they don't send CORS headers, and the browser needs to fetch the
model cross-origin. The solution: push the model to a dedicated `model-v1`
branch of the repo and serve it from `raw.githubusercontent.com`, which does
send `Access-Control-Allow-Origin: *`. The repo's copy of `symbols.json`
points at the absolute URL, the app learned to accept absolute model paths,
and re-training in the future is a two-file swap: push a new branch, update
the manifest.

## The bug that only exists above ten detections

Here's why we verify in the real environment. Every stub-model test passed.
Training metrics passed. The production smoke test failed with nonsense:
"Scan counted 2 × symbol 22" on a sheet with twenty-something fixtures, and
our manifest only defines five classes. There is no class 22.

The decoder that reads the ONNX output had a reasonable-looking heuristic:
given a `[1, A, B]` tensor, assume the larger dimension is the row stride,
because transposed exports exist. Our model emits `[1, N, 10]`: N detections,
each a row of `[x1, y1, x2, y2, objectness, class×5]`. With N = 23
detections, the heuristic flipped: stride 23, ten "rows", reads sliding
across real row boundaries, classes picked from pixel coordinates. Garbage
in, garbage counted.

The bug is invisible below ten detections, which is exactly the size of every
test fixture we had ever used. The fix is one line of honesty: derive the
row stride from the manifest's class count (`5 + classes.length`) instead of
guessing from dimension sizes. After the fix: `Scan counted 16 × downlight
in 1592 ms`, correct label, sane count, on a sheet the model had never seen.

## Where this goes next

The detector you can try today knows five symbol types and works best on
clean, vector-drawn plans (try the demo set linked from the tool). Sheets
outside its training family get an honest answer: "no symbols found, try the
classic scan", and the CV fallback is still one click away. From here the
roadmap is a data flywheel rather than a model-architecture problem: mix in
real CAD datasets, then learn from corrections real estimators make, with
client data never leaving hardware we control. The training notebook, the
data generator, and the entire app are open source under Apache-2.0 at
[github.com/ajflow/pdf2takeoff](https://github.com/ajflow/pdf2takeoff).

Free GPUs, synthetic data, an open licence, and a browser: it turns out
that's enough to give away an AI takeoff. Come break it.
