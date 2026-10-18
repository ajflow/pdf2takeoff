#!/usr/bin/env python3
"""Fetch Dataset-P&ID (Digitize-PID) sheets from the Git-LFS mirror and write
them as full sheets with YOLO labels in sheet pixel coordinates.

Background: docs/research/benchmarks/raster-symbol-datasets.md. The mirror
(github.com/ch-hristov/p-id-symbols, "adopted from" arXiv 2109.03794) ships
500 sheets as 60 overlapping 1280 x 1280 JPEG tiles each (640 px stride,
file names {sheet}_{y}_{x}.jpg) inside a 1.5 GB images.zip, plus labels.zip
with one YOLO txt per tile. Instead of downloading the whole zip, this script
reads the zip's central directory once and pulls each tile with HTTP Range
requests (about 60 requests, 5 MB per sheet; a few seconds with 8 workers).

Per sheet it writes
    <out>/images/<sheet>.png      7040 x 4480 greyscale, the stitched sheet
    <out>/labels/<sheet>.txt      "class cx cy w h" normalised to the sheet
and once per run
    <out>/classes.txt             32 names, one per line (class id = line)
    <out>/class-map.json          the mirror id -> paper symbol -> name table
    <out>/manifest.json           sheets, paths, counts, timings, sources

Labels: tile boxes are mapped to sheet pixels; a box cut by an interior tile
edge (within 1 px of an edge the tile shares with a neighbour) is a fragment
of a symbol a neighbouring tile sees whole and is dropped; the remaining
boxes are de-duplicated within class at IoU > 0.5 (50% tile overlap means
most symbols are labelled two to four times). Class ids are re-based so that
the paper's Symbol n becomes class n - 1 (the mirror reserves id 0 as
"Not_used"; see CLASSES below for the mapping and its caveats).

Usage:
    python3 -I scripts/bench/pid_fetch.py --out /path/outside/repo \
        [--count 50] [--seed 1] [--sheets 134,7,22] [--exclude other/manifest.json] \
        [--labels-zip labels.zip] [--workers 8] [--skip-existing]

The output directory must be outside the repository: nothing from the
dataset is committed (its licence is unstated, see the research note). Run
with -I: the zip and its labels are third-party data. Dependencies: Pillow;
everything else is the standard library.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import random
import struct
import sys
import time
import urllib.request
import zipfile
import zlib
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image

MIRROR = "https://github.com/ch-hristov/p-id-symbols"
IMAGES_URL = "https://media.githubusercontent.com/media/ch-hristov/p-id-symbols/main/images.zip"
LABELS_URL = "https://media.githubusercontent.com/media/ch-hristov/p-id-symbols/main/labels.zip"
TILE = 1280
STRIDE = 640
SHEETS = 500

# Class table. The Digitize-PID paper (Paliwal et al. 2021, Fig. 2) names its
# classes only "Symbol 1" to "Symbol 32" (1 to 25 drawn as "complex symbols",
# 26 to 32 as "basic shapes": instrument bubbles and boxes). The mirror's
# dataset.yaml keeps the paper's numbering (id n = Symbol n, id 0 = Not_used,
# never used in the labels) and adds the uploader's descriptive names, which
# give only 30 distinct strings for the 32 symbols: 3 and 5 are both
# "Globe_valve_NO", 26 and 27 both "Instrument_Field", 28 and 31 both
# "Instrument_Panel", 30 and 32 both "box"; 13 is misspelt "Globle_valve_NC"
# and 7 has a space. We therefore name class n-1 "S<nn>_<uploader name>" so
# the paper's number is always visible, fix the typo, and suffix the second
# member of each duplicate pair "_b" (which of the pair is which variant is
# not stated anywhere; by eye on sheet 134, 26/27 and 28/31 differ in the
# tag text layout and 30/32 in the box's line style).
CLASSES = [
    (1, "S01_Gate_Valve", "Gate_Valve"),
    (2, "S02_Ball_Valve", "Ball_Valve"),
    (3, "S03_Globe_valve_NO", "Globe_valve_NO"),
    (4, "S04_Gate_valve_NO", "Gate_valve_NO"),
    (5, "S05_Globe_valve_NO_b", "Globe_valve_NO"),
    (6, "S06_Butterfly_valve", "Butterfly_valve"),
    (7, "S07_Plug_valve", "Plug valve"),
    (8, "S08_Check_valve", "Check_valve"),
    (9, "S09_Diaphragm_valve", "Diaphragm_valve"),
    (10, "S10_Needle_valve", "Needle_valve"),
    (11, "S11_Half_Filled_Gate_Valve", "Half_Filled_Gate_Valve"),
    (12, "S12_Gate_Valve_NC", "Gate_Valve_NC"),
    (13, "S13_Globe_valve_NC", "Globle_valve_NC"),
    (14, "S14_Control_Valve", "Control_Valve"),
    (15, "S15_Rotary_Valve", "Rotary_Valve"),
    (16, "S16_Ball_valve_NC", "Ball_valve_NC"),
    (17, "S17_Paddle_blind", "Paddle_blind"),
    (18, "S18_Spectacle_blind_Closed", "Spectacle_blind_Closed"),
    (19, "S19_Spectacle_blind_Open", "Spectacle_blind_Open"),
    (20, "S20_Reducer", "Reducer"),
    (21, "S21_Flange_or_Nozzle", "Flange_or_Nozzle"),
    (22, "S22_Rupture_disk", "Rupture_disk"),
    (23, "S23_Pipe_Insulation_or_Tracing", "Pipe_Insulation_or_Tracing"),
    (24, "S24_Flow_Arrow", "Flow_Arrow"),
    (25, "S25_sight_glass", "sight_glass"),
    (26, "S26_Instrument_Field", "Instrument_Field"),
    (27, "S27_Instrument_Field_b", "Instrument_Field"),
    (28, "S28_Instrument_Panel", "Instrument_Panel"),
    (29, "S29_Instrument_Aux_Panel", "Instrument_Aux_Panel"),
    (30, "S30_box", "box"),
    (31, "S31_Instrument_Panel_b", "Instrument_Panel"),
    (32, "S32_box_b", "box"),
]
NAMES = [c[1] for c in CLASSES]


def log(*a: object) -> None:
    print(*a, file=sys.stderr, flush=True)


def http_range(url: str, start: int, end: int, retries: int = 4) -> bytes:
    req = urllib.request.Request(url, headers={"Range": f"bytes={start}-{end}", "User-Agent": "pdf2takeoff-bench"})
    last: Exception | None = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                data = r.read()
            if len(data) != end - start + 1:
                raise IOError(f"short range read {len(data)} of {end - start + 1}")
            return data
        except Exception as e:  # noqa: BLE001 - retry network errors, report the last
            last = e
            time.sleep(1.5 * (attempt + 1))
    raise IOError(f"range {start}-{end} of {url} failed: {last}")


def http_size(url: str) -> int:
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "pdf2takeoff-bench"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return int(r.headers["Content-Length"])


def read_central_directory(url: str, cache: Path) -> dict[str, dict]:
    """Return {basename: {method, csize, usize, lho}} for every image entry, cached as JSON."""
    if cache.exists():
        with cache.open(encoding="utf8") as f:
            return json.load(f)
    size = http_size(url)
    tail = http_range(url, max(0, size - 65536), size - 1)
    i = tail.rfind(b"PK\x05\x06")
    if i < 0:
        raise IOError("end of central directory not found")
    eocd = tail[i : i + 22]
    n = struct.unpack("<H", eocd[10:12])[0]
    cdsize = struct.unpack("<I", eocd[12:16])[0]
    cdoff = struct.unpack("<I", eocd[16:20])[0]
    if cdoff == 0xFFFFFFFF or n == 0xFFFF:
        j = tail.rfind(b"PK\x06\x06")
        z64 = tail[j : j + 56]
        n = struct.unpack("<Q", z64[32:40])[0]
        cdsize = struct.unpack("<Q", z64[40:48])[0]
        cdoff = struct.unpack("<Q", z64[48:56])[0]
    log(f"images.zip: {size / 1e9:.2f} GB, {n} entries, central directory {cdsize / 1e6:.1f} MB")
    cd = http_range(url, cdoff, cdoff + cdsize - 1)
    entries: dict[str, dict] = {}
    p = 0
    while p + 46 <= len(cd) and cd[p : p + 4] == b"PK\x01\x02":
        method = struct.unpack("<H", cd[p + 10 : p + 12])[0]
        csize, usize = struct.unpack("<II", cd[p + 20 : p + 28])
        fn_len, ex_len, cm_len = struct.unpack("<HHH", cd[p + 28 : p + 34])
        lho = struct.unpack("<I", cd[p + 42 : p + 46])[0]
        name = cd[p + 46 : p + 46 + fn_len].decode("utf8", "replace")
        if name.lower().endswith((".jpg", ".jpeg", ".png")):
            entries[os.path.basename(name)] = {"method": method, "csize": csize, "usize": usize, "lho": lho}
        p += 46 + fn_len + ex_len + cm_len
    cache.parent.mkdir(parents=True, exist_ok=True)
    with cache.open("w", encoding="utf8") as f:
        json.dump(entries, f)
    return entries


def fetch_entry(url: str, e: dict) -> bytes:
    lh = http_range(url, e["lho"], e["lho"] + 29)
    if lh[:4] != b"PK\x03\x04":
        raise IOError("bad local header")
    fn_len, ex_len = struct.unpack("<HH", lh[26:30])
    start = e["lho"] + 30 + fn_len + ex_len
    data = http_range(url, start, start + e["csize"] - 1)
    if e["method"] == 8:
        data = zlib.decompress(data, -15)
    elif e["method"] != 0:
        raise IOError(f"unsupported zip method {e['method']}")
    if len(data) != e["usize"]:
        raise IOError("size mismatch after inflate")
    return data


def tile_names(sheet: int, entries: dict[str, dict]) -> list[tuple[int, int, str]]:
    """(x, y, name) for every tile of the sheet, from the zip index."""
    out = []
    prefix = f"{sheet}_"
    for name in entries:
        if not name.startswith(prefix):
            continue
        stem = name.rsplit(".", 1)[0]
        parts = stem.split("_")
        if len(parts) != 3:
            continue
        y, x = int(parts[1]), int(parts[2])
        out.append((x, y, name))
    out.sort(key=lambda t: (t[1], t[0]))
    return out


def iou(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> float:
    ax0, ay0, ax1, ay1 = a[0] - a[2] / 2, a[1] - a[3] / 2, a[0] + a[2] / 2, a[1] + a[3] / 2
    bx0, by0, bx1, by1 = b[0] - b[2] / 2, b[1] - b[3] / 2, b[0] + b[2] / 2, b[1] + b[3] / 2
    iw = max(0.0, min(ax1, bx1) - max(ax0, bx0))
    ih = max(0.0, min(ay1, by1) - max(ay0, by0))
    inter = iw * ih
    union = a[2] * a[3] + b[2] * b[3] - inter
    return inter / union if union > 0 else 0.0


def sheet_labels(sheet: int, tiles: list[tuple[int, int, str]], labels: zipfile.ZipFile, label_names: dict[str, str], W: int, H: int) -> tuple[list[tuple[int, float, float, float, float]], dict]:
    """Tile labels -> de-duplicated sheet boxes (class0, cx, cy, w, h in px)."""
    raw = 0
    clipped = 0
    not_used = 0
    rows: list[tuple[int, float, float, float, float]] = []
    for x0, y0, name in tiles:
        stem = name.rsplit(".", 1)[0]
        member = label_names.get(stem + ".txt")
        if member is None:
            continue
        text = labels.read(member).decode("utf8", "replace")
        for ln in text.splitlines():
            p = ln.split()
            if len(p) < 5:
                continue
            raw += 1
            c = int(p[0])
            if c < 1 or c > 32:
                not_used += 1
                continue
            cx, cy, w, h = (float(v) for v in p[1:5])
            bx0, by0, bx1, by1 = (cx - w / 2) * TILE, (cy - h / 2) * TILE, (cx + w / 2) * TILE, (cy + h / 2) * TILE
            # interior tile edges: an edge is interior unless it is also the sheet border
            cut = (bx0 < 1 and x0 > 0) or (by0 < 1 and y0 > 0) or (bx1 > TILE - 1 and x0 + TILE < W) or (by1 > TILE - 1 and y0 + TILE < H)
            if cut:
                clipped += 1
                continue
            rows.append((c - 1, x0 + cx * TILE, y0 + cy * TILE, w * TILE, h * TILE))
    # larger boxes first so a fragment never shadows the full box
    rows.sort(key=lambda r: -(r[3] * r[4]))
    keep: list[tuple[int, float, float, float, float]] = []
    for r in rows:
        if not any(k[0] == r[0] and iou(k[1:], r[1:]) > 0.5 for k in keep):
            keep.append(r)
    keep.sort(key=lambda r: (r[0], r[2], r[1]))
    return keep, {"raw": raw, "clipped": clipped, "not_used": not_used, "unclipped": len(rows), "kept": len(keep)}


def stitch(tiles: list[tuple[int, int, str]], blobs: dict[str, bytes]) -> Image.Image:
    W = max(x for x, _, _ in tiles) + TILE
    H = max(y for _, y, _ in tiles) + TILE
    sheet = Image.new("L", (W, H), 255)
    for x, y, name in tiles:
        with Image.open(io.BytesIO(blobs[name])) as im:
            if im.size != (TILE, TILE):
                raise IOError(f"{name}: tile is {im.size}, expected {TILE} square")
            sheet.paste(im.convert("L"), (x, y))
    return sheet


def overlap_check(tiles: list[tuple[int, int, str]], blobs: dict[str, bytes]) -> float:
    """Mean abs difference between the shared halves of the first two horizontal neighbours (0 = consistent axis order)."""
    by_pos = {(x, y): n for x, y, n in tiles}
    a, b = by_pos.get((0, 0)), by_pos.get((STRIDE, 0))
    if not a or not b:
        return -1.0
    with Image.open(io.BytesIO(blobs[a])) as ia, Image.open(io.BytesIO(blobs[b])) as ib:
        ra = ia.convert("L").crop((STRIDE, 0, TILE, TILE)).tobytes()
        rb = ib.convert("L").crop((0, 0, TILE - STRIDE, TILE)).tobytes()
    return sum(abs(p - q) for p, q in zip(ra[::97], rb[::97])) / max(1, len(ra[::97]))


def parse_sheets(spec: str) -> list[int]:
    out: list[int] = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, b = part.split("-", 1)
            out.extend(range(int(a), int(b) + 1))
        else:
            out.append(int(part))
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", required=True, type=Path, help="output directory (outside the repository)")
    ap.add_argument("--count", type=int, default=50, help="number of sheets (listed ones first, then a seeded sample)")
    ap.add_argument("--seed", type=int, default=1, help="seed for the random sample of sheet ids")
    ap.add_argument("--sheets", default="", help="sheet ids to include first, e.g. 134,7,20-25")
    ap.add_argument("--exclude", type=Path, action="append", default=[], help="manifest.json whose sheets are excluded from the sample (repeatable)")
    ap.add_argument("--labels-zip", type=Path, help="local labels.zip (default: fetched from the mirror into <out>/_src)")
    ap.add_argument("--images-url", default=IMAGES_URL)
    ap.add_argument("--workers", type=int, default=8, help="parallel tile downloads")
    ap.add_argument("--skip-existing", action="store_true", help="keep sheets already in <out>/images")
    ap.add_argument("--time-budget", type=float, default=0, help="stop starting new sheets after this many seconds (0 = no limit)")
    args = ap.parse_args()

    out: Path = args.out
    repo = Path(__file__).resolve().parents[2]
    if repo in out.resolve().parents or out.resolve() == repo:
        log(f"refusing to write inside the repository ({repo}); pick --out outside it")
        return 2
    (out / "images").mkdir(parents=True, exist_ok=True)
    (out / "labels").mkdir(parents=True, exist_ok=True)
    src = out / "_src"
    src.mkdir(exist_ok=True)

    labels_zip = args.labels_zip or src / "labels.zip"
    if not labels_zip.exists():
        log(f"fetching labels.zip from {LABELS_URL}")
        with urllib.request.urlopen(urllib.request.Request(LABELS_URL, headers={"User-Agent": "pdf2takeoff-bench"}), timeout=300) as r:
            labels_zip.write_bytes(r.read())
    labels = zipfile.ZipFile(labels_zip)
    label_names = {os.path.basename(n): n for n in labels.namelist() if n.endswith(".txt")}
    log(f"labels.zip: {len(label_names)} tile label files")

    entries = read_central_directory(args.images_url, src / "images-index.json")
    log(f"images index: {len(entries)} tiles")

    excluded: set[int] = set()
    for m in args.exclude:
        with m.open(encoding="utf8") as f:
            excluded.update(int(s["sheet"]) for s in json.load(f)["sheets"])
    wanted = [s for s in parse_sheets(args.sheets) if s not in excluded]
    pool = [s for s in range(SHEETS) if s not in excluded and s not in wanted]
    rng = random.Random(args.seed)
    rng.shuffle(pool)
    wanted += pool[: max(0, args.count - len(wanted))]
    wanted = wanted[: args.count]

    (out / "classes.txt").write_text("\n".join(NAMES) + "\n", encoding="utf8")
    with (out / "class-map.json").open("w", encoding="utf8") as f:
        json.dump(
            {
                "note": "class id (0-based) = paper Symbol n - 1 = mirror id - 1; the paper numbers its 32 symbols without names, the descriptive part is the mirror uploader's (30 distinct strings for 32 symbols, duplicates suffixed _b)",
                "classes": [{"id": n - 1, "paper_symbol": n, "name": name, "mirror_id": n, "mirror_name": mirror, "shape_group": "complex" if n <= 25 else "basic"} for n, name, mirror in CLASSES],
            },
            f,
            indent=1,
        )

    manifest_path = out / "manifest.json"
    manifest: dict = {
        "dataset": "Dataset-P&ID (Digitize-PID, Paliwal et al. 2021, arXiv 2109.03794)",
        "mirror": MIRROR,
        "images_url": args.images_url,
        "labels_zip": str(labels_zip),
        "tile_px": TILE,
        "stride_px": STRIDE,
        "classes": NAMES,
        "label_convention": "class cx cy w h normalised to the sheet; class = paper Symbol n - 1",
        "sheets": [],
    }
    if args.skip_existing and manifest_path.exists():
        with manifest_path.open(encoding="utf8") as f:
            old = json.load(f)
        manifest["sheets"] = [s for s in old.get("sheets", []) if (out / s["image"]).exists()]
    have = {int(s["sheet"]) for s in manifest["sheets"]}

    t_start = time.time()
    checked = False
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        for i, sheet in enumerate(wanted):
            if sheet in have:
                continue
            if args.time_budget and time.time() - t_start > args.time_budget:
                log(f"time budget reached after {len(manifest['sheets'])} sheets")
                break
            tiles = tile_names(sheet, entries)
            if len(tiles) != 60:
                log(f"sheet {sheet}: {len(tiles)} tiles in the index, skipping")
                continue
            t0 = time.time()
            blobs = dict(zip((n for _, _, n in tiles), ex.map(lambda n: fetch_entry(args.images_url, entries[n]), (n for _, _, n in tiles))))
            t_fetch = time.time() - t0
            if not checked:
                d = overlap_check(tiles, blobs)
                log(f"overlap check on sheet {sheet}: mean abs diff {d:.2f} between shared halves (expect about 0)")
                if d > 8:
                    log("tile axis order looks wrong; aborting")
                    return 1
                checked = True
            img = stitch(tiles, blobs)
            W, H = img.size
            boxes, stats = sheet_labels(sheet, tiles, labels, label_names, W, H)
            img_rel = f"images/{sheet}.png"
            lab_rel = f"labels/{sheet}.txt"
            img.save(out / img_rel, optimize=False, compress_level=3)
            with (out / lab_rel).open("w", encoding="utf8") as f:
                for c, cx, cy, w, h in boxes:
                    f.write(f"{c} {cx / W:.6f} {cy / H:.6f} {w / W:.6f} {h / H:.6f}\n")
            per_class: dict[str, int] = {}
            for c, *_ in boxes:
                per_class[str(c)] = per_class.get(str(c), 0) + 1
            manifest["sheets"].append(
                {
                    "sheet": sheet,
                    "image": img_rel,
                    "labels": lab_rel,
                    "width": W,
                    "height": H,
                    "boxes": len(boxes),
                    "classes_present": len(per_class),
                    "per_class": per_class,
                    "label_stats": stats,
                    "bytes": sum(len(b) for b in blobs.values()),
                    "fetch_s": round(t_fetch, 2),
                    "total_s": round(time.time() - t0, 2),
                }
            )
            manifest["sheets"].sort(key=lambda s: s["sheet"])
            with manifest_path.open("w", encoding="utf8") as f:
                json.dump(manifest, f, indent=1)
            log(f"[{i + 1}/{len(wanted)}] sheet {sheet}: {W}x{H}, {stats['raw']} tile boxes -> {len(boxes)} symbols in {len(per_class)} classes, fetch {t_fetch:.1f}s, total {time.time() - t0:.1f}s")
    log(f"done: {len(manifest['sheets'])} sheets in {out} ({time.time() - t_start:.0f}s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
