#!/usr/bin/env python3
"""FloorPlanCAD DXF -> YOLO detection dataset converter.

FloorPlanCAD (https://floorplancad.github.io, ICCV 2021) ships ~15k real CAD
floor plans as DXF vector drawings. Countable "thing" symbols (doors,
furniture, sanitary fixtures, ... 30 categories) are drawn as INSERT block
references, so the ground truth for detection is already inside the file:
expand each INSERT's geometry, take its bbox, normalize against the rendered
image extents.

This script walks a directory of .dxf files, renders each modelspace to PNG
(ezdxf drawing add-on, matplotlib backend), and writes YOLO labels
(`cls cx cy w h`, normalized) plus images/ labels/ train-val splits and a
classes.txt. Output layout matches scripts/generate-synthetic-dataset.mjs so
both sources can train the same model.

Usage:
    python3 scripts/floorplancad-convert.py --src <floorplancad-dir> \
        --out training/floorplancad [--class-map map.json] \
        [--limit 500] [--px 1280] [--val-frac 0.1] [--debug]

Class names come from, in order of preference:
    1. --class-map JSON {block_name: class} (pin the official 30 categories
       against your download; names are matched case-insensitively)
    2. the INSERT's "category"/"CATEGORY" DXF attribute, if the file has one
    3. the referenced block's name

Deterministic: files are sorted, split by hashed filename, no RNG.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

import ezdxf
from ezdxf import bbox as ezdxf_bbox
from ezdxf.addons.drawing import Frontend, RenderContext
from ezdxf.addons.drawing.matplotlib import MatplotlibBackend
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

SKIP_BLOCK_PREFIXES = ("*", "$", "_")  # layout frames, viewports, hatch fills


def class_of(insert, class_map: dict[str, str]) -> str | None:
    name = insert.dxf.name
    if name.startswith(SKIP_BLOCK_PREFIXES):
        return None
    if class_map and name.lower() in class_map:
        return class_map[name.lower()]
    for tag in ("category", "CATEGORY", "class"):
        value = insert.get_attrib(tag)
        if value:
            return value.strip()
    return name


def insert_bbox(insert):
    """INSERT placement bbox in modelspace coordinates."""
    try:
        entities = list(insert.virtual_entities())
    except Exception:
        return None
    if not entities:
        return None
    extents = ezdxf_bbox.extents(entities, fast=True)
    if not extents.has_data:
        return None
    return extents.extmin, extents.extmax


def render_dxf(path: Path, png_path: Path, px: int) -> tuple[float, float, float, float]:
    """Render modelspace to PNG; return the data-coordinate extents drawn."""
    doc = ezdxf.readfile(path)
    msp = doc.modelspace()
    fig = plt.figure()
    ax = fig.add_axes((0, 0, 1, 1))
    backend = MatplotlibBackend(ax)
    Frontend(RenderContext(doc), backend).draw_entities(msp)
    # the ezdxf backend owns the axes, so autoscale_view() is a no-op: pin the
    # view to the drawn geometry ourselves (labels normalize against this)
    xmin, ymin = ax.dataLim.x0, ax.dataLim.y0
    xmax, ymax = ax.dataLim.x1, ax.dataLim.y1
    pad = 0.02 * max(xmax - xmin, ymax - ymin)
    xmin, xmax, ymin, ymax = xmin - pad, xmax + pad, ymin - pad, ymax + pad
    ax.set_xlim(xmin, xmax)
    ax.set_ylim(ymin, ymax)
    ax.set_aspect("equal")
    # scale figure so the long edge is exactly px
    w, h = xmax - xmin, ymax - ymin
    if w <= 0 or h <= 0:
        plt.close(fig)
        raise ValueError(f"degenerate extents {w}x{h}")
    dpi = fig.dpi
    fig.set_size_inches(max(1.0, px * (w / max(w, h)) / dpi), max(1.0, px * (h / max(w, h)) / dpi))
    fig.savefig(png_path, dpi=dpi)
    plt.close(fig)
    return xmin, xmax, ymin, ymax


def convert_one(path: Path, out_img: Path, out_lbl: Path, classes: list[str],
                class_index: dict[str, int], class_map: dict[str, str], px: int,
                debug: bool) -> tuple[int, int]:
    """Returns (symbols written, symbols skipped)."""
    doc = ezdxf.readfile(path)
    msp = doc.modelspace()

    rows: list[tuple[int, float, float, float, float]] = []
    skipped = 0
    for insert in msp.query("INSERT"):
        cls = class_of(insert, class_map)
        if cls is None:
            continue
        box = insert_bbox(insert)
        if box is None:
            skipped += 1
            continue
        (x0, y0, _), (x1, y1, _) = box
        if cls not in class_index:
            class_index[cls] = len(classes)
            classes.append(cls)
        rows.append((class_index[cls], x0, y0, x1, y1))

    if not rows:
        return 0, skipped

    # labels normalize against the renderer's own axes limits, so image and
    # labels can never disagree about the coordinate frame
    xmin, xmax, ymin, ymax = render_dxf(path, out_img, px)
    w, h = xmax - xmin, ymax - ymin

    written = 0
    with out_lbl.open("w") as f:
        for cls, x0, y0, x1, y1 in rows:
            cx = ((x0 + x1) / 2 - xmin) / w
            cy = 1 - ((y0 + y1) / 2 - ymin) / h  # image y grows downward
            bw = (x1 - x0) / w
            bh = (y1 - y0) / h
            if not (0 < bw < 1 and 0 < bh < 1 and 0 <= cx < 1 and 0 <= cy < 1):
                skipped += 1
                continue
            f.write(f"{cls} {cx:.6f} {cy:.6f} {bw:.6f} {bh:.6f}\n")
            written += 1
            if debug:
                print(f"  {classes[cls]:<16} cx={cx:.3f} cy={cy:.3f} w={bw:.3f} h={bh:.3f}")
    return written, skipped


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--src", required=True, type=Path, help="directory of .dxf files")
    ap.add_argument("--out", required=True, type=Path, help="output dataset directory")
    ap.add_argument("--class-map", type=Path, help="JSON {block_name: class}")
    ap.add_argument("--limit", type=int, default=0, help="stop after N drawings (0 = all)")
    ap.add_argument("--px", type=int, default=1280, help="long-edge render size")
    ap.add_argument("--val-frac", type=float, default=0.1)
    ap.add_argument("--debug", action="store_true")
    args = ap.parse_args()

    class_map: dict[str, str] = {}
    if args.class_map:
        class_map = {k.lower(): v for k, v in json.loads(args.class_map.read_text()).items()}

    files = sorted(p for p in args.src.rglob("*.dxf") if p.is_file())
    if args.limit:
        files = files[: args.limit]
    if not files:
        print(f"no .dxf files under {args.src}", file=sys.stderr)
        return 1

    for sub in ("images/train", "images/val", "labels/train", "labels/val"):
        (args.out / sub).mkdir(parents=True, exist_ok=True)

    classes: list[str] = []
    class_index: dict[str, int] = {}
    stats = {"drawings": 0, "symbols": 0, "skipped": 0, "empty": 0}

    for i, path in enumerate(files, 1):
        stem = path.stem
        # deterministic split by filename hash
        bucket = "val" if int(hashlib.sha256(stem.encode()).hexdigest(), 16) % 100 < args.val_frac * 100 else "train"
        out_img = args.out / "images" / bucket / f"{stem}.png"
        out_lbl = args.out / "labels" / bucket / f"{stem}.txt"
        try:
            written, skipped = convert_one(path, out_img, out_lbl, classes,
                                           class_index, class_map, args.px, args.debug)
        except Exception as e:
            print(f"[{i}/{len(files)}] {path.name}: FAILED {e}", file=sys.stderr)
            continue
        stats["drawings"] += 1
        stats["symbols"] += written
        stats["skipped"] += skipped
        if written == 0:
            out_img.unlink(missing_ok=True)
            out_lbl.unlink(missing_ok=True)
            stats["empty"] += 1
        if i % 25 == 0 or i == len(files):
            print(f"[{i}/{len(files)}] drawings={stats['drawings']} "
                  f"symbols={stats['symbols']} empty={stats['empty']}", file=sys.stderr)

    (args.out / "classes.txt").write_text("\n".join(classes) + "\n")
    (args.out / "dataset.yaml").write_text(
        f"path: {args.out.resolve()}\ntrain: images/train\nval: images/val\n"
        f"names:\n" + "".join(f"  {i}: {c}\n" for i, c in enumerate(classes))
    )
    print(json.dumps({"classes": dict(enumerate(classes)), **stats}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
