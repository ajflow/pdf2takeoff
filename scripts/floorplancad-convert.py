#!/usr/bin/env python3
"""FloorPlanCAD (SVG) or DXF floor plans -> YOLO detection dataset converter.

FloorPlanCAD (https://floorplancad.github.io, ICCV 2021; V2 label set) ships
about 15k real CAD floor plans as SVG tiles, never as DXF: every `<path>`,
`<circle>` and `<ellipse>` inside the layer `<g>` groups carries the labels
`semanticId` (1..35, absent = background) and `instanceId` (one id per
countable instance; absent or -1 on stuff). Counting distinct instanceIds per
class is the ground truth for one-shot counting, and the union of an
instance's primitives is its detection box.

Classes (FloorPlanCAD-V2, 35; see FPC_CLASSES below): 30 "thing" classes
(ids 1..30, countable: doors, windows, furniture, sanitary fixtures, stairs,
elevator, escalator) plus 5 "stuff" classes (31..35: row chairs, parking
spot, wall, curtain wall, railing). The ICCV 2021 paper described the V1 set
of 30 categories (28 things plus wall and parking as stuff); the released data
has the 35 above. CADTransformer renumbers them with its `RemapDict`
(CADTRANSFORMER_REMAP below, a permutation of ids 0..35, not a fold to 30);
this script keeps the official V2 ids and writes YOLO class ids 0..29 =
semanticId - 1 for the 30 things, so `classes.txt` is the same for every run.

Two input modes, picked by file extension:

SVG mode (FloorPlanCAD): parse the primitives (paths with lines, arcs and
curves; circles; ellipses with rotate transforms), group them by
(instanceId, semanticId) for thing classes, box each instance in viewBox
units, rasterise with cairosvg to PNG at --px on the long edge, write YOLO
labels normalised to the viewBox (the image frame), and write per-drawing
counts (`counts/<stem>.json`) plus one `counts.json` for the whole run with
per-class instance counts, boxes and centroids: the ground truth that
scripts/floorplancad-count-bench.mjs clicks and scores.

DXF mode: countable symbols are INSERT block references; expand each INSERT's
geometry, take its bbox, render modelspace to PNG (ezdxf drawing add-on,
matplotlib backend) and normalise labels against the rendered extents. Class
names come from --class-map JSON {block_name: class}, the INSERT's
"category"/"CATEGORY" attribute, or the block name, in that order.

Both modes write `images/{train,val}`, `labels/{train,val}`, `classes.txt`
and `dataset.yaml`, the layout of scripts/generate-synthetic-dataset.mjs, so
all sources can train the same model. Deterministic: files are sorted, split
by hashed filename, no RNG.

Usage:
    python3 scripts/floorplancad-convert.py --src <dir of .svg or .dxf> \
        --out training/floorplancad [--limit 500] [--px 1280] [--val-frac 0.1] \
        [--mono] [--counts-only] [--class-map map.json] [--debug]

--mono forces every stroke to black before rasterising (CADTransformer's
--cvt_color), since real PDF exports are usually monochrome. --counts-only
writes only the counts files (no PNGs, no labels): the quick way to build
bench ground truth.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

# --- FloorPlanCAD-V2 class table -------------------------------------------------
FPC_CLASSES: dict[int, str] = {
    1: "single door", 2: "double door", 3: "sliding door", 4: "folding door", 5: "revolving door", 6: "rolling door",
    7: "window", 8: "bay window", 9: "blind window", 10: "opening symbol",
    11: "sofa", 12: "bed", 13: "chair", 14: "table", 15: "TV cabinet", 16: "Wardrobe", 17: "cabinet",
    18: "gas stove", 19: "sink", 20: "refrigerator", 21: "airconditioner", 22: "bath", 23: "bath tub",
    24: "washing machine", 25: "squat toilet", 26: "urinal", 27: "toilet",
    28: "stairs", 29: "elevator", 30: "escalator",
    31: "row chairs", 32: "parking spot", 33: "wall", 34: "curtain wall", 35: "railing",
}
FPC_THING_IDS = tuple(range(1, 31))
FPC_STUFF_IDS = tuple(range(31, 36))
FPC_BACKGROUND = 36  # what the loaders assign to primitives without semanticId

# CADTransformer's RemapDict (config/anno_config.py): the order its models
# were trained in. A permutation of the 36 ids (0 = background in that code),
# e.g. single door 1 -> 33, wall 33 -> 35. Kept for cross-referencing its
# outputs; not applied here.
CADTRANSFORMER_REMAP: dict[int, int] = {
    0: 0, 3: 1, 4: 2, 5: 3, 6: 4, 7: 5, 8: 6, 9: 7, 10: 8, 11: 9, 12: 10, 13: 11, 14: 12, 15: 13,
    16: 14, 17: 15, 18: 16, 19: 17, 20: 20, 21: 21, 22: 18, 23: 19, 24: 22, 25: 23, 26: 24, 27: 25,
    28: 26, 29: 27, 30: 28, 31: 29, 32: 30, 33: 35, 34: 31, 35: 32, 1: 33, 2: 34,
}

SKIP_BLOCK_PREFIXES = ("*", "$", "_")  # layout frames, viewports, hatch fills (DXF)


# =============================================================================
# SVG mode
# =============================================================================

Matrix = tuple[float, float, float, float, float, float]  # a b c d e f, as SVG matrix()
IDENTITY: Matrix = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)


def mat_mul(m: Matrix, n: Matrix) -> Matrix:
    a, b, c, d, e, f = m
    a2, b2, c2, d2, e2, f2 = n
    return (a * a2 + c * b2, b * a2 + d * b2, a * c2 + c * d2, b * c2 + d * d2, a * e2 + c * f2 + e, b * e2 + d * f2 + f)


def mat_apply(m: Matrix, x: float, y: float) -> tuple[float, float]:
    a, b, c, d, e, f = m
    return a * x + c * y + e, b * x + d * y + f


_TRANSFORM_RE = re.compile(r"(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)")


def parse_transform(text: str | None) -> Matrix:
    """An SVG transform attribute as one affine matrix (left to right)."""
    m = IDENTITY
    if not text:
        return m
    for name, body in _TRANSFORM_RE.findall(text):
        v = [float(t) for t in re.split(r"[\s,]+", body.strip()) if t]
        if name == "matrix" and len(v) == 6:
            n: Matrix = (v[0], v[1], v[2], v[3], v[4], v[5])
        elif name == "translate":
            n = (1, 0, 0, 1, v[0], v[1] if len(v) > 1 else 0.0)
        elif name == "scale":
            n = (v[0], 0, 0, v[1] if len(v) > 1 else v[0], 0, 0)
        elif name == "rotate":
            a = math.radians(v[0])
            r: Matrix = (math.cos(a), math.sin(a), -math.sin(a), math.cos(a), 0, 0)
            if len(v) >= 3:
                n = mat_mul(mat_mul((1, 0, 0, 1, v[1], v[2]), r), (1, 0, 0, 1, -v[1], -v[2]))
            else:
                n = r
        elif name == "skewX":
            n = (1, 0, math.tan(math.radians(v[0])), 1, 0, 0)
        elif name == "skewY":
            n = (1, math.tan(math.radians(v[0])), 0, 1, 0, 0)
        else:
            continue
        m = mat_mul(m, n)
    return m


_PATH_TOKEN_RE = re.compile(r"[MmLlHhVvZzCcSsQqTtAa]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?")
_ARG_COUNT = {"M": 2, "L": 2, "H": 1, "V": 1, "Z": 0, "C": 6, "S": 4, "Q": 4, "T": 2, "A": 7}
SAMPLES = 12  # points sampled per curve or arc for the bbox


def _arc_points(x0, y0, rx, ry, rot_deg, large, sweep, x1, y1):
    """Sample an SVG elliptical arc (endpoint parametrisation, SVG spec F.6.5)."""
    if rx == 0 or ry == 0:
        return [(x0, y0), (x1, y1)]
    rx, ry = abs(rx), abs(ry)
    phi = math.radians(rot_deg)
    cp, sp = math.cos(phi), math.sin(phi)
    dx, dy = (x0 - x1) / 2, (y0 - y1) / 2
    x1p = cp * dx + sp * dy
    y1p = -sp * dx + cp * dy
    lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
    if lam > 1:
        rx *= math.sqrt(lam)
        ry *= math.sqrt(lam)
    num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
    den = rx * rx * y1p * y1p + ry * ry * x1p * x1p
    coef = 0.0 if den == 0 else math.sqrt(max(0.0, num / den))
    if large == sweep:
        coef = -coef
    cxp = coef * rx * y1p / ry
    cyp = -coef * ry * x1p / rx
    cx = cp * cxp - sp * cyp + (x0 + x1) / 2
    cy = sp * cxp + cp * cyp + (y0 + y1) / 2

    def ang(ux, uy, vx, vy):
        d = math.hypot(ux, uy) * math.hypot(vx, vy)
        if d == 0:
            return 0.0
        a = math.acos(max(-1.0, min(1.0, (ux * vx + uy * vy) / d)))
        return -a if ux * vy - uy * vx < 0 else a

    t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
    dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
    if not sweep and dt > 0:
        dt -= 2 * math.pi
    elif sweep and dt < 0:
        dt += 2 * math.pi
    pts = []
    for i in range(SAMPLES + 1):
        t = t1 + dt * i / SAMPLES
        ex, ey = rx * math.cos(t), ry * math.sin(t)
        pts.append((cp * ex - sp * ey + cx, sp * ex + cp * ey + cy))
    return pts


def _bezier_points(ctrl):
    n = len(ctrl) - 1
    pts = []
    for i in range(SAMPLES + 1):
        t = i / SAMPLES
        x = y = 0.0
        for k, (px, py) in enumerate(ctrl):
            w = math.comb(n, k) * (1 - t) ** (n - k) * t ** k
            x += w * px
            y += w * py
        pts.append((x, y))
    return pts


def path_points(d: str) -> list[tuple[float, float]]:
    """Points along an SVG path (vertices, sampled curves and arcs) for its bbox."""
    tokens = _PATH_TOKEN_RE.findall(d)
    pts: list[tuple[float, float]] = []
    i = 0
    cmd = None
    cx = cy = sx = sy = 0.0
    prev_ctrl: tuple[float, float] | None = None
    while i < len(tokens):
        t = tokens[i]
        if t.isalpha():
            cmd = t
            i += 1
            if cmd in "Zz":
                cx, cy = sx, sy
                prev_ctrl = None
                continue
        if cmd is None:
            raise ValueError(f"path data starts without a command: {d[:40]}")
        upper = cmd.upper()
        n = _ARG_COUNT[upper]
        args = [float(v) for v in tokens[i:i + n]]
        if len(args) < n:
            break
        i += n
        rel = cmd.islower()
        ox, oy = (cx, cy) if rel else (0.0, 0.0)
        if upper == "M":
            cx, cy = ox + args[0], oy + args[1]
            sx, sy = cx, cy
            pts.append((cx, cy))
            cmd = "l" if rel else "L"  # subsequent pairs are implicit lineto
            prev_ctrl = None
        elif upper == "L":
            cx, cy = ox + args[0], oy + args[1]
            pts.append((cx, cy))
            prev_ctrl = None
        elif upper == "H":
            cx = ox + args[0]
            pts.append((cx, cy))
            prev_ctrl = None
        elif upper == "V":
            cy = oy + args[0]
            pts.append((cx, cy))
            prev_ctrl = None
        elif upper in ("C", "S", "Q", "T"):
            if upper == "C":
                ctrl = [(cx, cy), (ox + args[0], oy + args[1]), (ox + args[2], oy + args[3]), (ox + args[4], oy + args[5])]
            elif upper == "S":
                c1 = (2 * cx - prev_ctrl[0], 2 * cy - prev_ctrl[1]) if prev_ctrl else (cx, cy)
                ctrl = [(cx, cy), c1, (ox + args[0], oy + args[1]), (ox + args[2], oy + args[3])]
            elif upper == "Q":
                ctrl = [(cx, cy), (ox + args[0], oy + args[1]), (ox + args[2], oy + args[3])]
            else:
                c1 = (2 * cx - prev_ctrl[0], 2 * cy - prev_ctrl[1]) if prev_ctrl else (cx, cy)
                ctrl = [(cx, cy), c1, (ox + args[0], oy + args[1])]
            pts.extend(_bezier_points(ctrl))
            prev_ctrl = ctrl[-2]
            cx, cy = ctrl[-1]
        elif upper == "A":
            x1, y1 = ox + args[5], oy + args[6]
            pts.extend(_arc_points(cx, cy, args[0], args[1], args[2], int(args[3]) != 0, int(args[4]) != 0, x1, y1))
            cx, cy = x1, y1
            prev_ctrl = None
    return pts


def _local_tag(el) -> str:
    return el.tag.rsplit("}", 1)[-1]


def _label(el, *names: str) -> int | None:
    for n in names:
        v = el.get(n)
        if v is not None and v.strip() != "":
            try:
                return int(float(v))
            except ValueError:
                return None
    return None


def svg_primitives(root):
    """Yield (semanticId, instanceId, points in viewBox units, layer index) per primitive."""
    layer = 0

    def walk(el, m: Matrix, layer_idx: int):
        nonlocal layer
        for child in el:
            tag = _local_tag(child)
            cm = mat_mul(m, parse_transform(child.get("transform")))
            if tag == "g":
                layer += 1
                yield from walk(child, cm, layer)
                continue
            if tag == "path":
                local = path_points(child.get("d", ""))
            elif tag == "circle":
                cx, cy, r = float(child.get("cx", 0)), float(child.get("cy", 0)), float(child.get("r", 0))
                local = [(cx + r * math.cos(t), cy + r * math.sin(t)) for t in (k * math.pi / 6 for k in range(12))]
            elif tag == "ellipse":
                cx, cy = float(child.get("cx", 0)), float(child.get("cy", 0))
                rx, ry = float(child.get("rx", 0)), float(child.get("ry", 0))
                local = [(cx + rx * math.cos(t), cy + ry * math.sin(t)) for t in (k * math.pi / 6 for k in range(12))]
            elif tag in ("line", "polyline", "polygon", "rect"):
                # not in the FloorPlanCAD vocabulary, but cheap to honour
                if tag == "line":
                    local = [(float(child.get("x1", 0)), float(child.get("y1", 0))), (float(child.get("x2", 0)), float(child.get("y2", 0)))]
                elif tag == "rect":
                    x, y = float(child.get("x", 0)), float(child.get("y", 0))
                    w, h = float(child.get("width", 0)), float(child.get("height", 0))
                    local = [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]
                else:
                    nums = [float(v) for v in re.split(r"[\s,]+", child.get("points", "").strip()) if v]
                    local = list(zip(nums[0::2], nums[1::2]))
            else:
                yield from walk(child, cm, layer_idx)
                continue
            if not local:
                continue
            pts = [mat_apply(cm, x, y) for x, y in local]
            yield (
                _label(child, "semanticId", "semantic-id", "semantic_id"),
                _label(child, "instanceId", "instance-id", "instance_id"),
                pts,
                layer_idx,
            )

    yield from walk(root, parse_transform(root.get("transform")), 0)


def parse_viewbox(root) -> tuple[float, float, float, float]:
    vb = root.get("viewBox")
    if vb:
        v = [float(t) for t in re.split(r"[\s,]+", vb.strip()) if t]
        if len(v) == 4 and v[2] > 0 and v[3] > 0:
            return v[0], v[1], v[2], v[3]
    w = float(re.sub(r"[a-z%]+$", "", root.get("width", "0")) or 0)
    h = float(re.sub(r"[a-z%]+$", "", root.get("height", "0")) or 0)
    if w > 0 and h > 0:
        return 0.0, 0.0, w, h
    raise ValueError("svg has neither a viewBox nor width/height")


def svg_ground_truth(path: Path) -> dict:
    """Per-instance boxes and per-class counts of one FloorPlanCAD SVG."""
    root = ET.parse(path).getroot()
    minx, miny, vbw, vbh = parse_viewbox(root)
    groups: dict[tuple[int, int], dict] = {}
    stuff: dict[str, int] = {}
    unassigned = 0
    background = 0
    for sem, inst, pts, _layer in svg_primitives(root):
        if sem is None or sem == FPC_BACKGROUND:
            background += 1
            continue
        name = FPC_CLASSES.get(sem, f"class {sem}")
        if sem not in FPC_THING_IDS:
            stuff[name] = stuff.get(name, 0) + 1
            continue
        if inst is None or inst < 0:
            unassigned += 1  # a thing primitive without an instance: nothing to count
            continue
        g = groups.setdefault((inst, sem), {"classId": sem, "class": name, "instanceId": inst, "pts": [], "primitives": 0})
        g["pts"].extend(pts)
        g["primitives"] += 1
    instances = []
    counts: dict[str, int] = {}
    for (inst, sem), g in groups.items():  # insertion order = file order
        xs = [p[0] for p in g["pts"]]
        ys = [p[1] for p in g["pts"]]
        x0, y0, x1, y1 = min(xs), min(ys), max(xs), max(ys)
        instances.append({
            "class": g["class"], "classId": sem, "instanceId": inst, "primitives": g["primitives"],
            "bbox": [round(x0, 4), round(y0, 4), round(x1, 4), round(y1, 4)],
            "centroid": [round((x0 + x1) / 2, 4), round((y0 + y1) / 2, 4)],
        })
        counts[g["class"]] = counts.get(g["class"], 0) + 1
    return {
        "file": path.name,
        "viewBox": [minx, miny, vbw, vbh],
        "counts": dict(sorted(counts.items())),
        "instances": instances,
        "stuffPrimitives": dict(sorted(stuff.items())),
        "unassignedThingPrimitives": unassigned,
        "backgroundPrimitives": background,
    }


def svg_bytes(path: Path, mono: bool) -> bytes:
    if not mono:
        return path.read_bytes()
    ET.register_namespace("", "http://www.w3.org/2000/svg")
    tree = ET.parse(path)
    for el in tree.getroot().iter():
        if el.get("stroke") not in (None, "none"):
            el.set("stroke", "rgb(0,0,0)")
        if el.get("fill") not in (None, "none"):
            el.set("fill", "rgb(0,0,0)")
    return ET.tostring(tree.getroot(), encoding="utf-8", xml_declaration=True)


def render_svg(path: Path, png_path: Path, px: int, mono: bool, vb: tuple[float, float, float, float]) -> tuple[int, int]:
    import cairosvg  # lazy: DXF-only machines need not have it

    _, _, vbw, vbh = vb
    scale = px / max(vbw, vbh)
    w, h = max(1, round(vbw * scale)), max(1, round(vbh * scale))
    cairosvg.svg2png(bytestring=svg_bytes(path, mono), write_to=str(png_path), output_width=w, output_height=h, background_color="white")
    return w, h


def convert_one_svg(path: Path, out_img: Path, out_lbl: Path, px: int, mono: bool, counts_only: bool, debug: bool) -> tuple[dict, int, int]:
    """Returns (ground truth record, labels written, labels skipped)."""
    gt = svg_ground_truth(path)
    minx, miny, vbw, vbh = gt["viewBox"]
    if counts_only or not gt["instances"]:
        return gt, 0, 0
    w, h = render_svg(path, out_img, px, mono, (minx, miny, vbw, vbh))
    gt["image"] = [w, h]
    written = skipped = 0
    with out_lbl.open("w") as f:
        for inst in gt["instances"]:
            x0, y0, x1, y1 = inst["bbox"]
            cx = ((x0 + x1) / 2 - minx) / vbw
            cy = ((y0 + y1) / 2 - miny) / vbh  # SVG y already grows downward
            bw = (x1 - x0) / vbw
            bh = (y1 - y0) / vbh
            if not (0 < bw < 1 and 0 < bh < 1 and 0 <= cx < 1 and 0 <= cy < 1):
                skipped += 1
                continue
            cls = inst["classId"] - 1
            f.write(f"{cls} {cx:.6f} {cy:.6f} {bw:.6f} {bh:.6f}\n")
            written += 1
            if debug:
                print(f"  {inst['class']:<16} #{inst['instanceId']:<4} cx={cx:.3f} cy={cy:.3f} w={bw:.3f} h={bh:.3f}")
    return gt, written, skipped


# =============================================================================
# DXF mode (unchanged behaviour; imports are lazy so SVG-only runs need no ezdxf)
# =============================================================================

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
    from ezdxf import bbox as ezdxf_bbox

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
    import ezdxf
    from ezdxf.addons.drawing import Frontend, RenderContext
    from ezdxf.addons.drawing.matplotlib import MatplotlibBackend
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

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


def convert_one_dxf(path: Path, out_img: Path, out_lbl: Path, classes: list[str],
                    class_index: dict[str, int], class_map: dict[str, str], px: int,
                    debug: bool) -> tuple[int, int]:
    """Returns (symbols written, symbols skipped)."""
    import ezdxf

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


# =============================================================================
# driver
# =============================================================================

def write_dataset_files(out: Path, classes: list[str]) -> None:
    (out / "classes.txt").write_text("\n".join(classes) + "\n")
    (out / "dataset.yaml").write_text(
        f"path: {out.resolve()}\ntrain: images/train\nval: images/val\n"
        f"names:\n" + "".join(f"  {i}: {c}\n" for i, c in enumerate(classes))
    )


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--src", required=True, type=Path, help="directory of .svg (FloorPlanCAD) or .dxf files")
    ap.add_argument("--out", required=True, type=Path, help="output dataset directory")
    ap.add_argument("--class-map", type=Path, help="DXF mode: JSON {block_name: class}")
    ap.add_argument("--limit", type=int, default=0, help="stop after N drawings (0 = all)")
    ap.add_argument("--px", type=int, default=1280, help="long-edge render size")
    ap.add_argument("--val-frac", type=float, default=0.1)
    ap.add_argument("--mono", action="store_true", help="SVG mode: force all strokes black before rasterising")
    ap.add_argument("--counts-only", action="store_true", help="SVG mode: write counts files only (no images or labels)")
    ap.add_argument("--debug", action="store_true")
    args = ap.parse_args()

    class_map: dict[str, str] = {}
    if args.class_map:
        class_map = {k.lower(): v for k, v in json.loads(args.class_map.read_text()).items()}

    svgs = sorted(p for p in args.src.rglob("*.svg") if p.is_file())
    dxfs = sorted(p for p in args.src.rglob("*.dxf") if p.is_file())
    if svgs and dxfs:
        print(f"{args.src} holds both .svg and .dxf files; convert them in separate runs", file=sys.stderr)
        return 1
    mode = "svg" if svgs else "dxf"
    files = svgs or dxfs
    if args.limit:
        files = files[: args.limit]
    if not files:
        print(f"no .svg or .dxf files under {args.src}", file=sys.stderr)
        return 1

    for sub in ("images/train", "images/val", "labels/train", "labels/val"):
        (args.out / sub).mkdir(parents=True, exist_ok=True)
    if mode == "svg":
        (args.out / "counts").mkdir(parents=True, exist_ok=True)

    # SVG: the fixed 30 thing classes; DXF: discovered in order of appearance
    classes: list[str] = [FPC_CLASSES[i] for i in FPC_THING_IDS] if mode == "svg" else []
    class_index: dict[str, int] = {}
    stats = {"mode": mode, "drawings": 0, "symbols": 0, "skipped": 0, "empty": 0}
    all_counts: dict[str, dict] = {}
    per_class: dict[str, int] = {}

    for i, path in enumerate(files, 1):
        stem = path.stem
        # deterministic split by filename hash
        bucket = "val" if int(hashlib.sha256(stem.encode()).hexdigest(), 16) % 100 < args.val_frac * 100 else "train"
        out_img = args.out / "images" / bucket / f"{stem}.png"
        out_lbl = args.out / "labels" / bucket / f"{stem}.txt"
        try:
            if mode == "svg":
                gt, written, skipped = convert_one_svg(path, out_img, out_lbl, args.px, args.mono, args.counts_only, args.debug)
                gt["split"] = bucket
                all_counts[stem] = gt
                (args.out / "counts" / f"{stem}.json").write_text(json.dumps(gt, indent=2) + "\n")
                for name, n in gt["counts"].items():
                    per_class[name] = per_class.get(name, 0) + n
                if args.counts_only:
                    written = len(gt["instances"])
            else:
                written, skipped = convert_one_dxf(path, out_img, out_lbl, classes, class_index, class_map, args.px, args.debug)
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

    if mode == "svg":
        (args.out / "counts.json").write_text(json.dumps(all_counts, indent=2) + "\n")
        stats["perClass"] = dict(sorted(per_class.items()))
    if not args.counts_only:
        write_dataset_files(args.out, classes)
    print(json.dumps({"classes": dict(enumerate(classes)), **stats}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
