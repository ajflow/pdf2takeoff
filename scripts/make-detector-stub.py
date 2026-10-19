#!/usr/bin/env python3
"""Build the stub detector fixture that scripts/check-detector-node.mjs loads.

The stub is a real ONNX graph with the detector's contract (input `images`
[1,3,S,S] in [0,1], output `output` [1,N,5+C] rows of xyxy, objectness and
class scores, `head: "yolox-raw"`), small enough to commit (about 2 KB) and
input dependent, so the Node loader, the letterbox, the decode and the
click-to-class logic are all exercised by real inference rather than a fake
session:

- the input is cut into a 16 px grid (64 cells for S = 128); each cell is one
  output row whose box is the cell itself
- objectness = 4 x the inked fraction of the cell (ink = 1 - mean RGB),
  clipped to 1: an empty cell scores 0 and never becomes a hit, a cell that
  only catches the anti-aliased edge of a neighbour's symbol stays below the
  manifest's score threshold, a quarter-inked cell is a certain detection
- class 0 `sparse` = 1 - inked fraction of the cell, class 1 `dense` = inked
  fraction: a small square in a cell reads sparse, a nearly filled cell dense

Run from the venv that has `onnx` installed:

    python3 scripts/make-detector-stub.py [scripts/fixtures/detector-stub]
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

S = 128
CELL = 16
GRID = S // CELL
CLASSES = ["sparse", "dense"]


def build() -> onnx.ModelProto:
    rows = GRID * GRID
    boxes = np.zeros((1, rows, 4), dtype=np.float32)
    for gy in range(GRID):
        for gx in range(GRID):
            boxes[0, gy * GRID + gx] = [gx * CELL, gy * CELL, (gx + 1) * CELL, (gy + 1) * CELL]

    nodes = [
        helper.make_node("ReduceMean", ["images"], ["mean"], axes=[1], keepdims=1),
        helper.make_node("Sub", ["one", "mean"], ["dark"]),
        helper.make_node("AveragePool", ["dark"], ["fill"], kernel_shape=[CELL, CELL], strides=[CELL, CELL]),
        helper.make_node("Mul", ["fill", "four"], ["fill4"]),
        helper.make_node("Clip", ["fill4", "zero", "one"], ["obj"]),
        helper.make_node("Reshape", ["obj", "row_shape"], ["obj_rows"]),
        helper.make_node("Reshape", ["fill", "row_shape"], ["dense"]),
        helper.make_node("Sub", ["one", "dense"], ["sparse"]),
        helper.make_node("Concat", ["boxes", "obj_rows", "sparse", "dense"], ["output"], axis=2),
    ]
    initializers = [
        numpy_helper.from_array(np.array(1.0, dtype=np.float32), "one"),
        numpy_helper.from_array(np.array(0.0, dtype=np.float32), "zero"),
        numpy_helper.from_array(np.array(4.0, dtype=np.float32), "four"),
        numpy_helper.from_array(np.array([1, rows, 1], dtype=np.int64), "row_shape"),
        numpy_helper.from_array(boxes, "boxes"),
    ]
    graph = helper.make_graph(
        nodes,
        "pdf2takeoff-detector-stub",
        [helper.make_tensor_value_info("images", TensorProto.FLOAT, [1, 3, S, S])],
        [helper.make_tensor_value_info("output", TensorProto.FLOAT, [1, rows, 5 + len(CLASSES)])],
        initializer=initializers,
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 13)], producer_name="pdf2takeoff")
    model.ir_version = 8
    onnx.checker.check_model(model)
    return model


def main() -> int:
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "scripts/fixtures/detector-stub")
    out.mkdir(parents=True, exist_ok=True)
    onnx.save(build(), out / "symbols.onnx")
    manifest = {
        "model": "symbols.onnx",
        "input": S,
        "classes": CLASSES,
        "score": 0.4,
        "iou": 0.45,
        "head": "yolox-raw",
        "stub": "grid detector for scripts/check-detector-node.mjs, built by scripts/make-detector-stub.py",
    }
    (out / "symbols.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"wrote {out / 'symbols.onnx'} ({(out / 'symbols.onnx').stat().st_size} bytes) and symbols.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
