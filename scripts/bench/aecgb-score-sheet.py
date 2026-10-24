#!/usr/bin/env python3
"""Per-sheet AEC-Geometric-Bench area scores with the official scorer's own
functions (scoring/score.py as a library). The upstream CLI pools all 15
sheets; this reports one sheet's area instance and pixel numbers.

    python3 -I scripts/bench/aecgb-score-sheet.py --bench <clone> --sheet sheet_02 --pred <file.json>
"""
import argparse
import json
import os
import sys

ap = argparse.ArgumentParser()
ap.add_argument('--bench', required=True)
ap.add_argument('--sheet', required=True)
ap.add_argument('--pred', required=True)
a = ap.parse_args()
sys.path.insert(0, os.path.join(a.bench, 'scoring'))
import score as S  # noqa: E402

gt = S.load_gt(os.path.join(a.bench, 'dataset'))
G = gt[a.sheet]
gap = 0.0015 * min(G['w'], G['h'])
P = json.load(open(a.pred))
rings = P.get('areas') or []
polys = [S._poly(r) for r in rings]
pa = S.merge_touching(polys, gap)
ga = S.merge_touching(G['areas'], gap)
tp, fp, fn = S.match(pa, ga)
i, p_, g_ = S.pixel_counts(pa, ga, G['w'], G['h'])
ip, ir, if1 = S.f1(tp, fp, fn)
pp, pr, pf1 = S.f1(i, p_, g_)
print(json.dumps({
    'sheet': a.sheet,
    'submitted_rings': len(rings),
    'valid_rings_as_submitted': sum(1 for r in rings if S.Polygon(r).is_valid) if rings else 0,
    'scored_area_instances': len(pa),
    'gt_area_instances': len(ga),
    'area_instance': {'tp': tp, 'fp': fp, 'fn': fn, 'precision': ip, 'recall': ir, 'f1': if1},
    'area_pixel': {'precision': pp, 'recall': pr, 'f1': pf1},
}, indent=2))
