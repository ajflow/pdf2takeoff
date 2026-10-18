#!/usr/bin/env python3
"""Write synthetic drawings in the FloorPlanCAD SVG schema (no dataset needed).

The real dataset cannot be redistributed (CC BY-NC) and its hosts are not
reachable from every machine, so this generator produces stand-ins with the
same structure as the official `svg_gt/*.svg` files, as read by the official
loaders (SymPoint `parse_svg.py`, VecFormer `preprocess.py`):

- root `<svg viewBox="0 0 140 140">` (140 drawing units per tile)
- primitives `<path d="M x y L x y">`, `<path d="M x y A rx ry rot large sweep x y">`,
  `<circle>`, `<ellipse transform="rotate(a cx cy)">`, each inside a layer `<g>`
- `stroke="rgb(r,g,b)"`, `stroke-width`, and the labels `semanticId` (1..35)
  and `instanceId` (one id per countable thing; absent on stuff and background)

Each file holds several instances of a few thing classes at the four
right-angle rotations (doors also mirrored), one class with size variation
(stairs), stuff (walls, a parking spot) and unlabelled background lines, so
scripts/floorplancad-convert.py and scripts/floorplancad-count-bench.mjs can
be exercised end to end. Deterministic for a given seed. The true per-class
counts are printed as JSON for cross-checking the converter.

    python3 scripts/make-floorplancad-sample.py --out <dir> [--count 3] [--seed 7] [--size-jitter 0.2]

`--size-jitter F` scales every chair, table, toilet and window instance by a
factor drawn from [1 - F, 1 + F] (default 0: one size per class per drawing),
the way one drawing inserts the same block at several scales; it exercises the
vector tier's size band without changing the shapes.
"""

from __future__ import annotations

import argparse
import json
import math
import random
import sys
from pathlib import Path

TILE = 140.0
NS = "http://www.w3.org/2000/svg"

# semanticId, name, stroke colour (one CAD layer per class)
SINGLE_DOOR = (1, "single door", "rgb(255,0,0)")
WINDOW = (7, "window", "rgb(0,0,255)")
CHAIR = (13, "chair", "rgb(0,128,0)")
TABLE = (14, "table", "rgb(0,128,0)")
TOILET = (27, "toilet", "rgb(255,0,255)")
STAIRS = (28, "stairs", "rgb(128,64,0)")
WALL = (33, "wall", "rgb(0,0,0)")
PARKING = (32, "parking spot", "rgb(128,128,128)")


def fmt(v: float) -> str:
    return f"{v:.3f}".rstrip("0").rstrip(".")


class Drawing:
    def __init__(self) -> None:
        self.layers: dict[str, list[str]] = {}
        self.next_instance = 1
        self.counts: dict[str, int] = {}

    def add(self, layer: str, element: str) -> None:
        self.layers.setdefault(layer, []).append(element)

    def primitive(self, kind: str, attrs: dict[str, str], cls: tuple[int, str, str], instance: int | None) -> str:
        parts = [f'{k}="{v}"' for k, v in attrs.items()]
        parts.append(f'stroke="{cls[2]}"')
        parts.append('stroke-width="0.35"')
        parts.append('fill="none"')
        parts.append(f'semanticId="{cls[0]}"')
        if instance is not None:
            parts.append(f'instanceId="{instance}"')
        return f"<{kind} {' '.join(parts)}/>"

    def line(self, layer: str, cls, inst, x0, y0, x1, y1) -> None:
        self.add(layer, self.primitive("path", {"d": f"M {fmt(x0)} {fmt(y0)} L {fmt(x1)} {fmt(y1)}"}, cls, inst))

    def arc(self, layer: str, cls, inst, x0, y0, r, x1, y1, sweep: int) -> None:
        self.add(layer, self.primitive("path", {"d": f"M {fmt(x0)} {fmt(y0)} A {fmt(r)} {fmt(r)} 0 0 {sweep} {fmt(x1)} {fmt(y1)}"}, cls, inst))

    def circle(self, layer: str, cls, inst, cx, cy, r) -> None:
        self.add(layer, self.primitive("circle", {"cx": fmt(cx), "cy": fmt(cy), "r": fmt(r)}, cls, inst))

    def ellipse(self, layer: str, cls, inst, cx, cy, rx, ry, angle) -> None:
        attrs = {"cx": fmt(cx), "cy": fmt(cy), "rx": fmt(rx), "ry": fmt(ry)}
        if angle:
            attrs["transform"] = f"rotate({fmt(angle)} {fmt(cx)} {fmt(cy)})"
        self.add(layer, self.primitive("ellipse", attrs, cls, inst))

    def background_line(self, layer: str, x0, y0, x1, y1) -> None:
        self.add(layer, f'<path d="M {fmt(x0)} {fmt(y0)} L {fmt(x1)} {fmt(y1)}" stroke="rgb(160,160,160)" stroke-width="0.18" fill="none"/>')

    def new_instance(self, cls) -> int:
        inst = self.next_instance
        self.next_instance += 1
        self.counts[cls[1]] = self.counts.get(cls[1], 0) + 1
        return inst

    def to_svg(self) -> str:
        out = [f'<svg xmlns="{NS}" viewBox="0 0 {int(TILE)} {int(TILE)}" width="{int(TILE)}" height="{int(TILE)}">']
        for name, elements in self.layers.items():
            out.append(f'<g id="{name}">')
            out.extend("  " + e for e in elements)
            out.append("</g>")
        out.append("</svg>")
        return "\n".join(out) + "\n"


def rot(points, cx, cy, angle_deg, mirror=False):
    """Rotate (and optionally mirror across the local x axis) points about (cx, cy)."""
    a = math.radians(angle_deg)
    out = []
    for x, y in points:
        dx, dy = x - cx, y - cy
        if mirror:
            dy = -dy
        out.append((cx + dx * math.cos(a) - dy * math.sin(a), cy + dx * math.sin(a) + dy * math.cos(a)))
    return out


# --- symbols; each returns the primitives through the drawing ----------------
def door(d: Drawing, cx, cy, size, angle, mirror):
    """Leaf line plus a quarter-circle swing arc, as CAD door blocks draw it."""
    inst = d.new_instance(SINGLE_DOOR)
    hinge, tip, end = rot([(cx, cy), (cx, cy - size), (cx + size, cy)], cx, cy, angle, mirror)
    d.line("doors", SINGLE_DOOR, inst, hinge[0], hinge[1], tip[0], tip[1])
    # the sweep flag flips with mirroring so the arc stays on the leaf's side
    d.arc("doors", SINGLE_DOOR, inst, tip[0], tip[1], size, end[0], end[1], 0 if mirror else 1)


def window(d: Drawing, cx, cy, size, angle):
    inst = d.new_instance(WINDOW)
    h = size / 2
    for off in (-0.6, 0.0, 0.6):
        (x0, y0), (x1, y1) = rot([(cx - h, cy + off), (cx + h, cy + off)], cx, cy, angle)
        d.line("windows", WINDOW, inst, x0, y0, x1, y1)
    for sx in (-h, h):
        (x0, y0), (x1, y1) = rot([(cx + sx, cy - 0.6), (cx + sx, cy + 0.6)], cx, cy, angle)
        d.line("windows", WINDOW, inst, x0, y0, x1, y1)


def chair(d: Drawing, cx, cy, size, angle):
    inst = d.new_instance(CHAIR)
    h = size / 2
    pts = rot([(cx - h, cy - h), (cx + h, cy - h), (cx + h, cy + h), (cx - h, cy + h)], cx, cy, angle)
    for i in range(4):
        (x0, y0), (x1, y1) = pts[i], pts[(i + 1) % 4]
        d.line("furniture", CHAIR, inst, x0, y0, x1, y1)
    (bx0, by0), (bx1, by1) = rot([(cx - h, cy - h - 0.8), (cx + h, cy - h - 0.8)], cx, cy, angle)
    d.line("furniture", CHAIR, inst, bx0, by0, bx1, by1)


def table(d: Drawing, cx, cy, size):
    inst = d.new_instance(TABLE)
    d.circle("furniture", TABLE, inst, cx, cy, size / 2)


def toilet(d: Drawing, cx, cy, size, angle):
    inst = d.new_instance(TOILET)
    d.ellipse("sanitary", TOILET, inst, cx, cy, size * 0.3, size * 0.42, angle)
    # cistern: a small rectangle behind the bowl
    w, h = size * 0.5, size * 0.18
    pts = rot([(cx - w / 2, cy + size * 0.42), (cx + w / 2, cy + size * 0.42), (cx + w / 2, cy + size * 0.42 + h), (cx - w / 2, cy + size * 0.42 + h)], cx, cy, angle)
    for i in range(4):
        (x0, y0), (x1, y1) = pts[i], pts[(i + 1) % 4]
        d.line("sanitary", TOILET, inst, x0, y0, x1, y1)


def stairs(d: Drawing, cx, cy, width, steps, angle):
    inst = d.new_instance(STAIRS)
    depth = 1.2
    h = width / 2
    length = steps * depth
    pts = rot([(cx - h, cy - length / 2), (cx + h, cy - length / 2), (cx + h, cy + length / 2), (cx - h, cy + length / 2)], cx, cy, angle)
    d.line("stairs", STAIRS, inst, pts[0][0], pts[0][1], pts[3][0], pts[3][1])
    d.line("stairs", STAIRS, inst, pts[1][0], pts[1][1], pts[2][0], pts[2][1])
    for i in range(steps + 1):
        y = cy - length / 2 + i * depth
        (x0, y0), (x1, y1) = rot([(cx - h, y), (cx + h, y)], cx, cy, angle)
        d.line("stairs", STAIRS, inst, x0, y0, x1, y1)


def walls(d: Drawing, rng: random.Random):
    """Outer wall with a doubled line, two internal partitions; stuff, so no instanceId."""
    m = 8.0
    t = 1.2
    for x0, y0, x1, y1 in [(m, m, TILE - m, m), (TILE - m, m, TILE - m, TILE - m), (TILE - m, TILE - m, m, TILE - m), (m, TILE - m, m, m)]:
        d.line("walls", WALL, None, x0, y0, x1, y1)
    for x0, y0, x1, y1 in [(m + t, m + t, TILE - m - t, m + t), (TILE - m - t, m + t, TILE - m - t, TILE - m - t), (TILE - m - t, TILE - m - t, m + t, TILE - m - t), (m + t, TILE - m - t, m + t, m + t)]:
        d.line("walls", WALL, None, x0, y0, x1, y1)
    px = rng.uniform(55, 85)
    d.line("walls", WALL, None, px, m + t, px, TILE / 2)
    d.line("walls", WALL, None, px + t, m + t, px + t, TILE / 2)
    py = rng.uniform(55, 85)
    d.line("walls", WALL, None, m + t, py, TILE / 2, py)
    d.line("walls", WALL, None, m + t, py + t, TILE / 2, py + t)


def parking(d: Drawing, x, y):
    for i in range(3):
        d.line("parking", PARKING, None, x + i * 6, y, x + i * 6, y + 12)
    d.line("parking", PARKING, None, x, y, x + 12, y)


def make_drawing(rng: random.Random, size_jitter: float = 0.0) -> Drawing:
    d = Drawing()
    # faint background grid, unlabelled (loaders treat it as background)
    for i in range(1, 7):
        d.background_line("grid", i * 20, 2, i * 20, TILE - 2)
        d.background_line("grid", 2, i * 20, TILE - 2, i * 20)
    walls(d, rng)
    parking(d, 112, 112)
    # free slots on a 20-unit grid inside the walls, away from the parking stuff
    slots = [(x, y) for x in range(22, 120, 18) for y in range(22, 100, 18)]
    rng.shuffle(slots)
    plan = [("door", rng.randint(3, 5)), ("window", rng.randint(2, 4)), ("chair", rng.randint(3, 6)),
            ("table", rng.randint(1, 3)), ("toilet", rng.randint(2, 3)), ("stairs", rng.randint(2, 3))]
    door_size = rng.uniform(5.5, 7.0)
    window_size = rng.uniform(6.0, 8.0)
    chair_size = rng.uniform(3.0, 3.8)
    table_size = rng.uniform(5.0, 7.0)
    toilet_size = rng.uniform(5.0, 6.0)
    for kind, n in plan:
        for _ in range(n):
            if not slots:
                break
            sx, sy = slots.pop()
            cx, cy = sx + rng.uniform(-2, 2), sy + rng.uniform(-2, 2)
            angle = rng.choice([0, 90, 180, 270])
            j = rng.uniform(1 - size_jitter, 1 + size_jitter) if size_jitter > 0 else 1.0
            if kind == "door":
                door(d, cx, cy, door_size, angle, rng.random() < 0.5)
            elif kind == "window":
                window(d, cx, cy, window_size * j, angle)
            elif kind == "chair":
                chair(d, cx, cy, chair_size * j, angle)
            elif kind == "table":
                table(d, cx, cy, table_size * j)
            elif kind == "toilet":
                toilet(d, cx, cy, toilet_size * j, angle)
            else:
                stairs(d, cx, cy, rng.uniform(5, 8), rng.randint(4, 8), angle)
    return d


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--count", type=int, default=3)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--size-jitter", type=float, default=0.0, help="per-instance scale jitter for chairs, tables, toilets and windows (0 = one size per class)")
    args = ap.parse_args()
    if not 0 <= args.size_jitter < 1:
        ap.error("--size-jitter must be in [0, 1)")
    args.out.mkdir(parents=True, exist_ok=True)
    rng = random.Random(args.seed)
    truth = {}
    for i in range(args.count):
        d = make_drawing(rng, args.size_jitter)
        stem = f"synth-{i + 1:03d}"
        (args.out / f"{stem}.svg").write_text(d.to_svg())
        truth[stem] = dict(sorted(d.counts.items()))
    print(json.dumps(truth, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
