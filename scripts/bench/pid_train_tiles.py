#!/usr/bin/env python3
"""Build the detector training layout from Dataset-P&ID sheets fetched by
scripts/bench/pid_fetch.py: split by sheet, tile at the detector's inference
scale, write YOLO labels per tile plus classes.txt, dataset.yaml and a
symbols.json template with the matching `tile` block.

    python3 -I scripts/bench/pid_train_tiles.py --src /data/pid/bench50 --src /data/pid/train150 \
        --out /data/pid/yolo [--tile 640] [--stride 480] [--input-size 640] \
        [--val 0.1] [--test 0.1] [--seed 1] [--min-visible 0.6] [--keep-empty 0.05]

Why these numbers (specs/detector-tiling.md): the detector cuts the raster
into windows of W = inputSize x RASTER_SCALE / pxPerPt raster pixels and
letterboxes each to inputSize. A sheet PNG opened by the CLI is one page of
W/3 x H/3 points, so RASTER_SCALE = 3 reproduces the native pixels, and a
640 px training tile fed to a 640 px input means pxPerPt = 640 x 3 / 640 =
3.0: the model sees the sheet at native resolution, where Dataset-P&ID
symbols are 32 to 153 px (10 to 51 pt). Training at the notebook's default
INPUT_SIZE = 416 on the same 640 px tiles gives pxPerPt = 416 x 3 / 640 =
1.95 and a smallest symbol of about 21 input pixels; pass --input-size 416
so the template says so. The stride leaves a 160 px overlap, wider than the
largest symbol, so every symbol lies whole in at least one tile. A box is
kept in a tile when at least --min-visible of its area is inside (clipped to
the tile); fragments below that are dropped because the detector's fusion
drops boxes on interior tile edges anyway. Tiles with no ink are skipped;
inked tiles without a label are kept at the --keep-empty rate as negatives.

The split is by sheet (never by tile; the mirror's own train/val lists leak
sheets across the split). Output goes outside the repository and nothing in
it is committed.
"""

from __future__ import annotations

import argparse
import json
import math
import random
import sys
from collections import Counter
from pathlib import Path

from PIL import Image

RASTER_SCALE = 3


def log(*a: object) -> None:
    print(*a, file=sys.stderr, flush=True)


def load_sheets(srcs: list[Path]) -> tuple[list[dict], list[str]]:
    sheets: list[dict] = []
    classes: list[str] | None = None
    seen: set[int] = set()
    for src in srcs:
        with (src / "manifest.json").open(encoding="utf8") as f:
            m = json.load(f)
        if classes is None:
            classes = list(m["classes"])
        elif list(m["classes"]) != classes:
            raise SystemExit(f"{src}: class list differs from the first source")
        for s in m["sheets"]:
            sid = int(s["sheet"])
            if sid in seen:
                log(f"sheet {sid} appears twice, keeping the first")
                continue
            seen.add(sid)
            sheets.append({**s, "src": src})
    if classes is None:
        raise SystemExit("no sources")
    sheets.sort(key=lambda s: int(s["sheet"]))
    return sheets, classes


def positions(length: int, tile: int, stride: int) -> list[int]:
    if length <= tile:
        return [0]
    pos = list(range(0, length - tile + 1, stride))
    if pos[-1] != length - tile:
        pos.append(length - tile)
    return pos


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--src", type=Path, action="append", required=True, help="directory written by pid_fetch.py (repeatable)")
    ap.add_argument("--out", type=Path, required=True, help="output dataset directory (outside the repository)")
    ap.add_argument("--tile", type=int, default=640, help="tile side in sheet pixels")
    ap.add_argument("--stride", type=int, default=480, help="tile stride in sheet pixels (overlap = tile - stride)")
    ap.add_argument("--input-size", type=int, default=640, help="model input size the tiles will be letterboxed to (for the symbols.json template)")
    ap.add_argument("--val", type=float, default=0.1)
    ap.add_argument("--test", type=float, default=0.1)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--min-visible", type=float, default=0.6, help="keep a box when at least this fraction of its area lies in the tile")
    ap.add_argument("--keep-empty", type=float, default=0.05, help="fraction of inked, label-free tiles kept as negatives")
    ap.add_argument("--limit-sheets", type=int, default=0)
    ap.add_argument("--jpeg", action="store_true", help="write tiles as JPEG quality 92 instead of PNG (a third of the size; the notebook globs *.png, so only with a matching edit)")
    args = ap.parse_args()

    repo = Path(__file__).resolve().parents[2]
    out: Path = args.out
    if repo in out.resolve().parents or out.resolve() == repo:
        log(f"refusing to write inside the repository ({repo})")
        return 2
    if args.stride <= 0 or args.stride > args.tile:
        log("--stride must be in (0, tile]")
        return 2

    sheets, classes = load_sheets(args.src)
    if args.limit_sheets:
        sheets = sheets[: args.limit_sheets]
    rng = random.Random(args.seed)
    order = sheets[:]
    rng.shuffle(order)
    n = len(order)
    n_test = round(n * args.test)
    n_val = round(n * args.val)
    split_of: dict[int, str] = {}
    for i, s in enumerate(order):
        split_of[int(s["sheet"])] = "test" if i < n_test else "val" if i < n_test + n_val else "train"
    splits = ("train", "val", "test")
    for sp in splits:
        (out / "images" / sp).mkdir(parents=True, exist_ok=True)
        (out / "labels" / sp).mkdir(parents=True, exist_ok=True)

    stats = {sp: {"sheets": 0, "tiles": 0, "empty_tiles": 0, "boxes": 0, "per_class": Counter()} for sp in splits}
    skipped_blank = 0
    dropped_fragments = 0
    max_box_px = 0
    min_box_px = 10**9
    ext = "jpg" if args.jpeg else "png"
    for idx, s in enumerate(sheets):
        sid = int(s["sheet"])
        sp = split_of[sid]
        st = stats[sp]
        st["sheets"] += 1
        img_path = s["src"] / s["image"]
        with Image.open(img_path) as im:
            im = im.convert("L")
            W, H = im.size
            boxes = []
            for ln in (s["src"] / s["labels"]).read_text(encoding="utf8").splitlines():
                p = ln.split()
                if len(p) < 5:
                    continue
                c = int(p[0])
                cx, cy, w, h = (float(v) for v in p[1:5])
                bw, bh = w * W, h * H
                max_box_px = max(max_box_px, bw, bh)
                min_box_px = min(min_box_px, bw, bh)
                boxes.append((c, cx * W - bw / 2, cy * H - bh / 2, cx * W + bw / 2, cy * H + bh / 2))
            for y0 in positions(H, args.tile, args.stride):
                for x0 in positions(W, args.tile, args.stride):
                    x1, y1 = x0 + args.tile, y0 + args.tile
                    tile_im = im.crop((x0, y0, x1, y1))
                    lo, _hi = tile_im.getextrema()
                    if lo > 200:
                        skipped_blank += 1
                        continue
                    rows = []
                    for c, bx0, by0, bx1, by1 in boxes:
                        ix0, iy0, ix1, iy1 = max(bx0, x0), max(by0, y0), min(bx1, x1), min(by1, y1)
                        if ix1 <= ix0 or iy1 <= iy0:
                            continue
                        vis = (ix1 - ix0) * (iy1 - iy0) / ((bx1 - bx0) * (by1 - by0))
                        if vis < args.min_visible:
                            dropped_fragments += 1
                            continue
                        cx = ((ix0 + ix1) / 2 - x0) / args.tile
                        cy = ((iy0 + iy1) / 2 - y0) / args.tile
                        rows.append(f"{c} {cx:.6f} {cy:.6f} {(ix1 - ix0) / args.tile:.6f} {(iy1 - iy0) / args.tile:.6f}")
                        st["per_class"][c] += 1
                    if not rows:
                        if rng.random() >= args.keep_empty:
                            continue
                        st["empty_tiles"] += 1
                    stem = f"{sid}_{y0}_{x0}"
                    if args.jpeg:
                        tile_im.save(out / "images" / sp / f"{stem}.{ext}", quality=92)
                    else:
                        tile_im.save(out / "images" / sp / f"{stem}.{ext}", compress_level=3)
                    (out / "labels" / sp / f"{stem}.txt").write_text("\n".join(rows) + ("\n" if rows else ""), encoding="utf8")
                    st["tiles"] += 1
                    st["boxes"] += len(rows)
        if (idx + 1) % 10 == 0 or idx + 1 == len(sheets):
            log(f"[{idx + 1}/{len(sheets)}] sheet {sid} -> {sp}; tiles so far " + ", ".join(f"{sp2} {stats[sp2]['tiles']}" for sp2 in splits))

    (out / "classes.txt").write_text("\n".join(classes) + "\n", encoding="utf8")
    (out / "dataset.yaml").write_text(
        f"path: {out.resolve()}\ntrain: images/train\nval: images/val\ntest: images/test\nnames:\n" + "".join(f"  {i}: {c}\n" for i, c in enumerate(classes)),
        encoding="utf8",
    )
    px_per_pt = args.input_size * RASTER_SCALE / args.tile
    max_symbol_pt = math.ceil(max_box_px / RASTER_SCALE) if max_box_px else 30
    template = {
        "model": "symbols.onnx",
        "input": args.input_size,
        "classes": classes,
        "score": 0.25,
        "iou": 0.45,
        "head": "yolox-raw",
        "tile": {"pxPerPt": round(px_per_pt, 3), "overlapPx": args.tile - args.stride, "maxSymbolPt": max_symbol_pt},
    }
    with (out / "symbols.template.json").open("w", encoding="utf8") as f:
        json.dump(template, f, indent=2)
    summary = {
        "sources": [str(s) for s in args.src],
        "tile_px": args.tile,
        "stride_px": args.stride,
        "input_size": args.input_size,
        "px_per_pt": px_per_pt,
        "max_symbol_px": max_box_px,
        "min_symbol_px": min_box_px,
        "max_symbol_pt": max_symbol_pt,
        "split": {sp: sorted(sid for sid, s2 in split_of.items() if s2 == sp) for sp in splits},
        "skipped_blank_tiles": skipped_blank,
        "dropped_fragments": dropped_fragments,
        "stats": {sp: {**{k: v for k, v in st.items() if k != "per_class"}, "per_class": {classes[c]: n for c, n in sorted(st["per_class"].items())}} for sp, st in stats.items()},
    }
    with (out / "split.json").open("w", encoding="utf8") as f:
        json.dump(summary, f, indent=1)
    for sp in splits:
        st = stats[sp]
        log(f"{sp}: {st['sheets']} sheets, {st['tiles']} tiles ({st['empty_tiles']} negatives), {st['boxes']} boxes")
    log(f"symbols {min_box_px:.0f} to {max_box_px:.0f} px; template tile block: pxPerPt {px_per_pt:.3f}, overlapPx {args.tile - args.stride}, maxSymbolPt {max_symbol_pt}")
    log(f"blank tiles skipped {skipped_blank}, fragments below {args.min_visible:.0%} visibility dropped {dropped_fragments}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
