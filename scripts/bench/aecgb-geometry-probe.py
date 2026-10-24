#!/usr/bin/env python3
"""Geometry gate for the room-partition pass (design review section 6, gate 3).

Runs synthetic geometry only -- our own proxy layouts, never benchmark data --
through the official AEC-Geometric-Bench scorer's area preprocessing
(`_poly`: buffer(0) repair of invalid rings; `merge_touching`: union of
polygons within 0.0015 x the short side), and checks:

  * every polygon the engine emitted is a valid ring as submitted (no repair);
  * the instance count after preprocessing equals the number of true rooms
    (partition children separated by a finite strip stay separate);
  * the scorer contract itself on four probes: shared-edge children union to
    one instance, a one-pixel strip keeps two, a self-touching two-lobe ring
    is repaired into two components, a comb is one valid instance.

    python3 -I scripts/bench/aecgb-geometry-probe.py --scorer <bench>/scoring \
        --geometry <dir from partition-gates.mjs> --out <json>
"""
import argparse
import json
import os
import sys

ap = argparse.ArgumentParser()
ap.add_argument('--scorer', required=True)
ap.add_argument('--geometry', required=True)
ap.add_argument('--out', required=True)
a = ap.parse_args()
sys.path.insert(0, a.scorer)
import score as S  # noqa: E402  the official scorer, as a library
from shapely.geometry import Polygon  # noqa: E402

expected = json.load(open(os.path.join(a.geometry, 'expected.json')))
layouts = []
ok = True
for name, n_rooms in sorted(expected.items()):
    P = json.load(open(os.path.join(a.geometry, f'{name}.json')))
    rings = P['areas']
    valid = sum(1 for r in rings if Polygon(r).is_valid)
    gap = 0.0015 * min(P['width'], P['height'])
    inst = S.merge_touching([S._poly(r) for r in rings], gap)
    row = {'layout': name, 'rooms': n_rooms, 'submitted': len(rings), 'valid_as_submitted': valid, 'instances_after_preprocessing': len(inst)}
    row['pass'] = valid == len(rings) and len(inst) == n_rooms
    ok = ok and row['pass']
    layouts.append(row)


def count(rings, w=1000, h=1000):
    return len(S.merge_touching([S._poly(r) for r in rings], 0.0015 * min(w, h)))


sq = lambda x0, y0, x1, y1: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
contract = {
    'shared_edge_children_instances': count([sq(0, 0, 100, 100), sq(100, 0, 200, 100)]),
    'one_px_strip_children_instances': count([sq(0, 0, 100, 100), sq(101, 0, 200, 100)]),
    'two_lobe_ring_valid': Polygon([[0, 0], [4, 0], [4, 4], [0, 4], [0, 0], [-4, 0], [-4, -4], [0, -4]]).is_valid,
    'two_lobe_ring_instances_after_repair': count([[[0, 0], [40, 0], [40, 40], [0, 40], [0, 0], [-40, 0], [-40, -40], [0, -40]]]),
    'comb_instances': count([[[0, 0], [10, 0], [10, 50], [12, 50], [12, 0], [22, 0], [22, 50], [24, 50], [24, 0], [100, 0], [100, 100], [0, 100]]]),
}
contract_ok = (contract['shared_edge_children_instances'] == 1 and contract['one_px_strip_children_instances'] == 2
               and not contract['two_lobe_ring_valid'] and contract['comb_instances'] == 1)
out = {'layouts': layouts, 'all_layouts_pass': ok, 'scorer_contract': contract, 'scorer_contract_as_expected': contract_ok}
json.dump(out, open(a.out, 'w'), indent=2)
print(json.dumps({'layouts_pass': f"{sum(r['pass'] for r in layouts)}/{len(layouts)}", 'scorer_contract': contract}, indent=2))
sys.exit(0 if ok and contract_ok else 1)
