#!/usr/bin/env python3
"""Per-sheet reporter for AEC-Geometric-Bench, using the bench's own scoring
functions (score.py) as a library — their metrics, one sheet at a time.
The upstream CLI pools all 15 sheets; milestone 1 predicts one sheet, so the
pooled table mostly measures the 14 empty sheets.

    python3 evals/aecgb/score-sheet.py sheet_02 ../predictions/sheet_02.json
(run from evals/aecgb/repo, or fix the paths below)
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'repo', 'scoring'))
import score as S  # noqa: E402  (the bench's Apache-2.0 scorer)

sheet = sys.argv[1]
pred_path = sys.argv[2]
gt_dir = os.path.join(os.path.dirname(__file__), 'repo', 'dataset')

gt = S.load_gt(gt_dir)
G = gt[sheet]
gap = 0.0015 * min(G['w'], G['h'])
P = json.load(open(pred_path))

pa = S.merge_touching([S._poly(r) for r in (P.get('areas') or [])], gap)
ga = S.merge_touching(G['areas'], gap)
inst_tp, inst_fp, inst_fn = S.match(pa, ga)
i, p_, g_ = S.pixel_counts(pa, ga, G['w'], G['h'])

out = {
    'sheet': sheet,
    'n_predicted_areas': len(P.get('areas') or []),
    'n_gt_area_instances_merged': len(ga),
    'area_instance': {'tp': inst_tp, 'fp': inst_fp, 'fn': inst_fn, 'f1': S.f1(inst_tp, inst_fp, inst_fn)},
    'area_pixel': {'f1': S.f1(i, p_, g_), 'precision': S.f1(i, p_, g_)[0], 'recall': S.f1(i, p_, g_)[1]},
}
print(json.dumps(out, indent=2))
