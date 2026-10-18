#!/usr/bin/env python3
"""Render ResPlan floor plans to benchmark PDFs for Dynamic Fill.

ResPlan (Abouagour and Garyfallidis, arXiv 2508.14006, CC BY 4.0) ships
17,000 residential plans as shapely polygons (walls, doors, windows, rooms)
in a normalised canvas. This script picks test-split plans, recovers the
metric scale, renders each plan as a clean vector PDF at a drawing ratio in
several door-drawing variants, and writes a task file with one click point
and ground-truth area per room. scripts/room-bench.mjs runs the fill on the
output and scores it. See scripts/bench/README.md for setup.

Dependencies: shapely >= 2, cairosvg (both from PyPI). Run with `python3 -I`
because the pickle comes from a third party: it is loaded through a
restricted unpickler that only admits shapely.io.from_wkb and the two numpy
scalar helpers the file needs, and raises on anything else.

Variants (per plan, `<id>_<variant>.pdf`):
  A  walls plus window outlines; door openings left as bare gaps
  B  A plus the door leaf drawn closed in the opening (ResPlan door polygon
     outline), which seals every doorway with ink
  C  A plus a conventional open-door symbol: leaf perpendicular to the wall
     at one jamb and a quarter-circle swing arc to the other jamb
  D  B rasterised at 150 dpi and embedded as an image PDF (with --raster)

Ground truth per room (`<id>_tasks.json`), all in m2:
  gt_m2         the ResPlan room polygon as is (between inside face and wall
                centreline, see docs/research/benchmarks/room-area-datasets.md)
  gt_face_m2    polygon minus the wall polygons: the inside-face area a
                floor-finish takeoff wants and what the fill measures
  gt_centre_m2  polygon buffered by half the wall depth and clipped to the
                building envelope: a centreline-area approximation
  gt_face_nodoor_m2  inside-face area minus the door openings, which ResPlan
                room polygons partly include and a fill never does (the leaf
                outline or the closed gap runs between the jambs)
Flags per room: expectLeak (balcony, garden, parking, pool: outside the
envelope, so a fill runs off the page), open (shares more than OPEN_M of
boundary with another room with no wall or door between, so a fill merges
them: open kitchens, stairs in halls), openM (that length), doors (openings
touching the room), swing_m2 (door swing sectors inside the room: variant C
draws them as ink, so a fill there stops at the arc).

Rotation (`--rotate 15,30 --rotate-share 0.1`): every tenth plan is turned
about its envelope centre, cycling through the angles, so its walls and
door gaps run off-axis (the diagonal-wall subset); `rotationDeg` in the task
file says which, and the bench scores rotated plans on their own rows.

Usage:
  python3 -I scripts/bench/resplan_to_pdf.py --resplan /path/to/resplan \\
      --out /path/to/outdir [--limit 200] [--seed 1] [--ratio 100] \\
      [--variants ABC] [--raster] [--labels] [--page a3|fit] \\
      [--rotate 15,30 [--rotate-share 0.1]]
"""

import argparse
import base64
import io
import json
import math
import os
import pickle
import random
import sys
import zipfile

try:
    import shapely
    import shapely.io
    from shapely.geometry import LineString, MultiPolygon, Point, Polygon
    from shapely.geometry.base import BaseGeometry
    from shapely.affinity import rotate
    from shapely.ops import unary_union
    from shapely.validation import make_valid
    import cairosvg
except ImportError as exc:  # pragma: no cover
    sys.exit(f"missing dependency: {exc}. Install shapely and cairosvg (see scripts/bench/README.md)")

ROOM_KEYS = ("living", "bedroom", "bathroom", "kitchen", "storage", "stair", "balcony", "garden", "parking", "pool")
EXPECT_LEAK = {"balcony", "garden", "parking", "pool"}
# a doorless opening to another room wider than this (m) is open plan: no
# gap closing may bridge it, so the fill is expected to merge the two
OPEN_M = 1.3
DOOR_KEYS = ("door", "front_door")
A3 = (1190.55, 841.89)
MARGIN = 40.0
STROKE = 0.5  # pt, window and door outlines


class RestrictedUnpickler(pickle.Unpickler):
    """Admit only the globals the ResPlan pickle needs; refuse everything else."""

    ALLOWED = {
        ("shapely.io", "from_wkb"),
        ("numpy", "dtype"),
        ("numpy._core.multiarray", "scalar"),
        ("numpy.core.multiarray", "scalar"),
    }

    def find_class(self, module, name):
        if (module, name) not in self.ALLOWED:
            raise pickle.UnpicklingError(f"blocked global {module}.{name}")
        if module == "shapely.io":
            return shapely.io.from_wkb
        if module == "numpy":
            import numpy

            return numpy.dtype
        import numpy._core.multiarray as m

        return m.scalar


def load_plans(path):
    """ResPlan.pkl from a repo dir, a .zip or the .pkl itself."""
    if os.path.isdir(path):
        for cand in ("ResPlan.pkl", "ResPlan.zip"):
            p = os.path.join(path, cand)
            if os.path.exists(p):
                path = p
                break
        else:
            sys.exit(f"no ResPlan.pkl or ResPlan.zip in {path}")
    if path.endswith(".zip"):
        with zipfile.ZipFile(path) as z:
            name = next(n for n in z.namelist() if n.endswith(".pkl"))
            with z.open(name) as f:
                data = RestrictedUnpickler(io.BytesIO(f.read())).load()
    else:
        with open(path, "rb") as f:
            data = RestrictedUnpickler(f).load()
    if not isinstance(data, list):
        sys.exit("unexpected pickle layout: expected a list of plan dicts")
    return data


def valid(g):
    if g is None:
        return None
    if not isinstance(g, BaseGeometry):
        return None
    if g.is_empty:
        return g
    return g if g.is_valid else make_valid(g)


def polys(g):
    """Polygon parts of any geometry (drops lines and points from make_valid)."""
    if g is None or g.is_empty:
        return []
    if g.geom_type == "Polygon":
        return [g]
    out = []
    for part in getattr(g, "geoms", []):
        out.extend(polys(part))
    return out


def rect_axes(poly):
    """Minimum rotated rectangle of a door or window: centre, long axis unit
    vector, long and short half-lengths. Long axis runs along the wall."""
    mrr = poly.minimum_rotated_rectangle
    c = list(mrr.exterior.coords)[:4]
    e0 = (c[1][0] - c[0][0], c[1][1] - c[0][1])
    e1 = (c[2][0] - c[1][0], c[2][1] - c[1][1])
    l0 = math.hypot(*e0)
    l1 = math.hypot(*e1)
    if l0 >= l1:
        u = (e0[0] / l0, e0[1] / l0) if l0 else (1.0, 0.0)
        long_, short = l0, l1
    else:
        u = (e1[0] / l1, e1[1] / l1) if l1 else (1.0, 0.0)
        long_, short = l1, l0
    cx = sum(p[0] for p in c) / 4
    cy = sum(p[1] for p in c) / 4
    return (cx, cy), u, long_ / 2, short / 2


class Plan:
    def __init__(self, raw, ratio, page_mode, labels, rotation=0.0):
        self.id = int(raw["id"])
        self.ratio = ratio
        self.labels = labels
        self.rotation = float(rotation)
        geo = {k: valid(v) for k, v in raw.items() if isinstance(v, BaseGeometry)}
        if self.rotation and geo.get("inner") is not None and not geo["inner"].is_empty:
            # the diagonal-wall subset: the whole plan turned about the envelope
            # centre, so every wall, door and room polygon is off-axis
            origin = geo["inner"].centroid
            geo = {k: (rotate(v, self.rotation, origin=origin) if v is not None and not v.is_empty else v) for k, v in geo.items()}
        self.inner = geo["inner"]
        area_m2 = float(raw["area"])
        if self.inner is None or self.inner.is_empty or area_m2 <= 0:
            raise ValueError("plan has no envelope or area")
        # canvas units per metre: `area` is the envelope area in m2 (validated
        # in docs/research/benchmarks/room-area-datasets.md)
        self.k = math.sqrt(self.inner.area / area_m2)
        self.wall_depth = float(raw.get("wall_depth") or 0.0)
        self.wall = geo.get("wall") or Polygon()
        self.windows = polys(geo.get("window"))
        # the front door usually appears in both `door` and `front_door`: keep one copy
        self.doors = []
        for key in DOOR_KEYS:
            for p in polys(geo.get(key)):
                if any(p.intersection(q).area > 0.5 * p.area for _, q in self.doors):
                    continue
                self.doors.append((key, p))
        self.rooms = []
        for key in ROOM_KEYS:
            for i, p in enumerate(polys(geo.get(key))):
                self.rooms.append((key, i, p))
        self.pt_per_m = 72 / 0.0254 / ratio
        self.s = self.pt_per_m / self.k  # pt per canvas unit
        land = geo.get("land")
        bounds = land.bounds if land is not None and not land.is_empty else self.inner.bounds
        for p in self.windows + [d for _, d in self.doors]:
            b = p.bounds
            bounds = (min(bounds[0], b[0]), min(bounds[1], b[1]), max(bounds[2], b[2]), max(bounds[3], b[3]))
        self.bounds = bounds
        gw = (bounds[2] - bounds[0]) * self.s + 2 * MARGIN
        gh = (bounds[3] - bounds[1]) * self.s + 2 * MARGIN
        if page_mode == "a3" and gw <= A3[0] and gh <= A3[1]:
            self.W, self.H = A3
            self.page = "a3"
        else:
            self.W, self.H = gw, gh
            self.page = "fit"
        self.ox = (self.W - (bounds[2] - bounds[0]) * self.s) / 2
        self.oy = (self.H - (bounds[3] - bounds[1]) * self.s) / 2

    # canvas (y up, as shapely) to SVG (y down) and PDF (y up) point space
    def tx(self, x):
        return (x - self.bounds[0]) * self.s + self.ox

    def ty_svg(self, y):
        return self.H - ((y - self.bounds[1]) * self.s + self.oy)

    def to_pdf(self, x, y):
        return [round(self.tx(x), 3), round((y - self.bounds[1]) * self.s + self.oy, 3)]

    def path(self, poly):
        d = []
        for ring in [poly.exterior, *poly.interiors]:
            pts = list(ring.coords)
            d.append("M" + " L".join(f"{self.tx(x):.2f},{self.ty_svg(y):.2f}" for x, y in pts) + " Z")
        return " ".join(d)

    def door_swing(self, poly, rooms_union):
        """Open-door geometry: hinge at one jamb, leaf tip, the opposite jamb
        and the swing width (canvas units). The door swings into whichever
        side of the opening lies inside the envelope (and inside a room when
        it can)."""
        (cx, cy), u, hw, ht = rect_axes(poly)
        n = (-u[1], u[0])
        width = 2 * hw
        probe_d = ht + width / 2
        side = 1.0
        best = -1.0
        for sgn in (1.0, -1.0):
            px, py = cx + sgn * n[0] * probe_d, cy + sgn * n[1] * probe_d
            pt = Point(px, py)
            score = (2 if rooms_union.contains(pt) else 0) + (1 if self.inner.contains(pt) else 0)
            if score > best:
                best, side = score, sgn
        nx, ny = n[0] * side, n[1] * side
        # jambs are the two short sides; the hinge sits at the jamb corner on the swing side
        hinge = (cx - u[0] * hw + nx * ht, cy - u[1] * hw + ny * ht)
        other = (cx + u[0] * hw + nx * ht, cy + u[1] * hw + ny * ht)
        tip = (hinge[0] + nx * width, hinge[1] + ny * width)
        return hinge, tip, other, width

    def swing_sector(self, poly, rooms_union):
        """The quarter disc a door sweeps (shapely polygon, canvas units)."""
        hinge, tip, other, width = self.door_swing(poly, rooms_union)
        a1 = math.atan2(tip[1] - hinge[1], tip[0] - hinge[0])
        a2 = math.atan2(other[1] - hinge[1], other[0] - hinge[0])
        d = (a2 - a1 + math.pi) % (2 * math.pi) - math.pi
        pts = [hinge] + [(hinge[0] + width * math.cos(a1 + d * t / 16), hinge[1] + width * math.sin(a1 + d * t / 16)) for t in range(17)]
        return Polygon(pts)

    def door_symbol(self, poly, rooms_union):
        """Open-door symbol for variant C: leaf line and swing arc (SVG path d)."""
        hinge, tip, other, width = self.door_swing(poly, rooms_union)
        r = width * self.s
        # SVG arc from tip to the other jamb around the hinge; sweep flag from orientation
        cross = (tip[0] - hinge[0]) * (other[1] - hinge[1]) - (tip[1] - hinge[1]) * (other[0] - hinge[0])
        sweep = 0 if cross > 0 else 1  # y flips in SVG space
        return (
            f"M{self.tx(hinge[0]):.2f},{self.ty_svg(hinge[1]):.2f} L{self.tx(tip[0]):.2f},{self.ty_svg(tip[1]):.2f} "
            f"A{r:.2f},{r:.2f} 0 0 {sweep} {self.tx(other[0]):.2f},{self.ty_svg(other[1]):.2f}"
        )

    def svg(self, variant):
        out = [
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{self.W:.2f}pt" height="{self.H:.2f}pt" viewBox="0 0 {self.W:.2f} {self.H:.2f}">',
            f'<rect width="{self.W:.2f}" height="{self.H:.2f}" fill="white"/>',
        ]
        for p in polys(self.wall):
            out.append(f'<path d="{self.path(p)}" fill="black" fill-rule="evenodd"/>')
        for p in self.windows:
            out.append(f'<path d="{self.path(p)}" fill="none" stroke="black" stroke-width="{STROKE}"/>')
        if variant in ("B", "D"):
            for _, p in self.doors:
                out.append(f'<path d="{self.path(p)}" fill="none" stroke="black" stroke-width="{STROKE}"/>')
        elif variant == "C":
            rooms_union = unary_union([p for _, _, p in self.rooms if not p.is_empty]) if self.rooms else Polygon()
            for _, p in self.doors:
                out.append(f'<path d="{self.door_symbol(p, rooms_union)}" fill="none" stroke="black" stroke-width="{STROKE}"/>')
        if self.labels:
            for key, i, p in self.rooms:
                if key in EXPECT_LEAK:
                    continue
                c = p.representative_point()
                out.append(
                    f'<text x="{self.tx(c.x):.2f}" y="{self.ty_svg(c.y) - 6:.2f}" font-family="Helvetica" font-size="6" text-anchor="middle">{key.upper()} {i + 1}</text>'
                )
        out.append("</svg>")
        return "\n".join(out)

    def tasks(self, variants):
        walls = self.wall
        half = self.wall_depth / 2
        doors_union = unary_union([p for _, p in self.doors]) if self.doors else Polygon()
        rooms_union = unary_union([p for _, _, p in self.rooms if not p.is_empty]) if self.rooms else Polygon()
        swings = unary_union([self.swing_sector(p, rooms_union) for _, p in self.doors]) if self.doors else Polygon()
        # open-plan check: boundary shared with another room that neither a
        # wall nor a door covers (an open kitchen off the living room, a stair
        # in a hall). No fill can separate such rooms; the bench scores them
        # apart as "expect merge".
        blocked = unary_union([walls.buffer(0.5), doors_union.buffer(0.5)])
        names = [f"{key}_{i}" for key, i, _ in self.rooms]
        open_to = {name: [] for name in names}
        open_len = {name: 0.0 for name in names}
        for a in range(len(self.rooms)):
            pa = self.rooms[a][2]
            for b in range(a + 1, len(self.rooms)):
                pb = self.rooms[b][2]
                if not pa.intersects(pb.buffer(0.5)):
                    continue
                shared = pa.exterior.intersection(pb.buffer(0.5))
                if shared.is_empty:
                    continue
                opening = shared.difference(blocked)
                m = opening.length / self.k
                if m > OPEN_M:
                    open_to[names[a]].append(names[b])
                    open_to[names[b]].append(names[a])
                    open_len[names[a]] += m
                    open_len[names[b]] += m
        rooms = []
        for key, i, p in self.rooms:
            face = valid(p.difference(walls))
            centre = valid(p.buffer(half, join_style="mitre").intersection(self.inner)) if half > 0 else p
            if centre is None or centre.is_empty or key in EXPECT_LEAK:
                centre = p  # outside the envelope (balcony, garden): no centreline convention
            clicks = []
            seen = set()

            def add(pt):
                if pt is None or pt.is_empty:
                    return
                xy = self.to_pdf(pt.x, pt.y)
                key_ = (round(xy[0], 1), round(xy[1], 1))
                if key_ not in seen and not walls.intersects(pt):
                    seen.add(key_)
                    clicks.append(xy)

            # click candidates stay out of walls, door openings and door swings
            # (variant C draws the swing arc as ink, which would wall the click in)
            clear = valid(p.difference(walls).difference(doors_union).difference(swings.buffer(0.5)))
            if clear is None or clear.is_empty:
                clear = valid(p.difference(walls).difference(doors_union))
            for part in sorted(polys(clear), key=lambda g: -g.area)[:2]:
                add(part.representative_point())
                # a second candidate off the first: the largest inscribed-ish point
                add(part.buffer(-min(part.bounds[2] - part.bounds[0], part.bounds[3] - part.bounds[1]) / 4).representative_point() if part.area > 0 else None)
            add(p.representative_point())
            if p.contains(p.centroid):
                add(p.centroid)
            doors_here = sum(1 for _, d in self.doors if d.distance(p) <= max(half, 1e-6))
            rooms.append(
                {
                    "name": f"{key}_{i}",
                    "type": key,
                    "expectLeak": key in EXPECT_LEAK,
                    "open": bool(open_to[f"{key}_{i}"]),
                    "openTo": open_to[f"{key}_{i}"],
                    "openM": round(open_len[f"{key}_{i}"], 2),
                    "doors": doors_here,
                    "clicks": clicks,
                    "gt_m2": p.area / self.k**2,
                    "gt_face_m2": face.area / self.k**2,
                    "gt_face_nodoor_m2": valid(face.difference(doors_union)).area / self.k**2,
                    "gt_centre_m2": centre.area / self.k**2,
                    "swing_m2": valid(p.intersection(swings)).area / self.k**2,
                    "gt_rings": [[self.to_pdf(x, y) for x, y in ring.coords] for ring in [p.exterior, *p.interiors]],
                    "gt_face_rings": [
                        [self.to_pdf(x, y) for x, y in ring.coords] for part in polys(face) for ring in [part.exterior, *part.interiors]
                    ],
                }
            )
        return {
            "id": self.id,
            "source": "ResPlan",
            "ratio": self.ratio,
            "metersPerPt": 1 / self.pt_per_m,
            "pageW": round(self.W, 2),
            "pageH": round(self.H, 2),
            "page": self.page,
            "k_units_per_m": self.k,
            "wall_depth_m": self.wall_depth / self.k,
            "door_widths_m": sorted(round(2 * rect_axes(p)[2] / self.k, 3) for _, p in self.doors),
            "variants": list(variants),
            "labels": bool(self.labels),
            "rotationDeg": self.rotation,
            "rooms": rooms,
        }


def write_pdf(svg_text, path):
    cairosvg.svg2pdf(bytestring=svg_text.encode("utf-8"), write_to=path)


def write_raster_pdf(svg_text, path, W, H, dpi=150):
    png = cairosvg.svg2png(bytestring=svg_text.encode("utf-8"), dpi=dpi, scale=dpi / 72)
    b64 = base64.b64encode(png).decode("ascii")
    wrapper = (
        f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="{W:.2f}pt" height="{H:.2f}pt" viewBox="0 0 {W:.2f} {H:.2f}">'
        f'<image x="0" y="0" width="{W:.2f}" height="{H:.2f}" xlink:href="data:image/png;base64,{b64}"/></svg>'
    )
    cairosvg.svg2pdf(bytestring=wrapper.encode("utf-8"), write_to=path)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--resplan", required=True, help="ResPlan repo dir (with ResPlan.zip and split.json), the zip, or ResPlan.pkl")
    ap.add_argument("--split", help="split.json (default: next to --resplan)")
    ap.add_argument("--out", required=True, help="output directory")
    ap.add_argument("--limit", type=int, default=200, help="number of test plans (default 200)")
    ap.add_argument("--seed", type=int, default=1, help="sample seed (default 1)")
    ap.add_argument("--ids", help="comma-separated plan ids instead of a sample")
    ap.add_argument("--ratio", type=int, default=100, help="drawing ratio 1:N (default 100)")
    ap.add_argument("--variants", default="ABC", help="subset of ABC to render (default ABC)")
    ap.add_argument("--raster", action="store_true", help="also write variant D (B rasterised at 150 dpi)")
    ap.add_argument("--labels", action="store_true", help="draw room names as text so the labels hint path runs")
    ap.add_argument("--page", choices=("a3", "fit"), default="a3", help="A3 landscape when the plan fits, else fit with a 40 pt margin")
    ap.add_argument("--rotate", help="comma-separated angles in degrees; rotated plans cycle through them (the diagonal-wall subset)")
    ap.add_argument("--rotate-share", type=float, default=1.0, help="share of the plans to rotate when --rotate is given (default 1.0: every plan; 0.1: every tenth)")
    args = ap.parse_args()
    angles = [float(a) for a in args.rotate.split(",")] if args.rotate else []
    rotate_every = max(1, round(1 / args.rotate_share)) if angles and args.rotate_share > 0 else 0

    data = load_plans(args.resplan)
    by_id = {int(pl["id"]): pl for pl in data if "id" in pl}
    if args.ids:
        ids = [int(x) for x in args.ids.split(",")]
    else:
        split_path = args.split or os.path.join(args.resplan if os.path.isdir(args.resplan) else os.path.dirname(args.resplan), "split.json")
        with open(split_path) as f:
            test_ids = [int(x) for x in json.load(f)["test"]]
        rng = random.Random(args.seed)
        ids = sorted(rng.sample(test_ids, min(args.limit, len(test_ids))))
    os.makedirs(args.out, exist_ok=True)
    variants = [v for v in "ABC" if v in args.variants.upper()]
    if args.raster:
        variants.append("D")
    written = []
    skipped = 0
    rotated = 0
    for n, pid in enumerate(ids):
        raw = by_id.get(pid)
        if raw is None:
            print(f"skip {pid}: not in dataset", file=sys.stderr)
            skipped += 1
            continue
        rotation = 0.0
        if rotate_every and n % rotate_every == 0:
            rotation = angles[rotated % len(angles)]
            rotated += 1
        try:
            plan = Plan(raw, args.ratio, args.page, args.labels, rotation)
        except (ValueError, KeyError) as exc:
            print(f"skip {pid}: {exc}", file=sys.stderr)
            skipped += 1
            continue
        if not plan.rooms:
            skipped += 1
            continue
        for v in variants:
            path = os.path.join(args.out, f"{pid}_{v}.pdf")
            if v == "D":
                write_raster_pdf(plan.svg("D"), path, plan.W, plan.H)
            else:
                write_pdf(plan.svg(v), path)
        with open(os.path.join(args.out, f"{pid}_tasks.json"), "w") as f:
            json.dump(plan.tasks(variants), f, indent=1)
        written.append(pid)
    with open(os.path.join(args.out, "index.json"), "w") as f:
        json.dump({"source": "ResPlan", "ratio": args.ratio, "seed": args.seed, "variants": variants, "rotate": angles, "rotateShare": args.rotate_share if angles else 0, "ids": written}, f, indent=1)
    print(f"wrote {len(written)} plans x {len(variants)} variants to {args.out} (skipped {skipped}, rotated {rotated})")


if __name__ == "__main__":
    main()
