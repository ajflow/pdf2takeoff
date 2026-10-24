# Room-partition design review: evidence, not a new benchmark submission

The [design and adversarial review](../../../docs/research/room-partition-design-review.md) answers frontier prompt 3. Production code and the user's prompt are unchanged. All new files remain uncommitted.

## Subsequent fix pass

The verified P0 defects were then fixed in production code. `closeLine` now uses the correct flat-array base for horizontal rows. Dynamic Fill traces directed pixel-cell edges and returns a polygon only after explicit closure and simple-ring validation. The analytic scorer shares that validator. The new regression cases cover transpose invariance, a comb-shaped enclosure and a non-adjacent repeated vertex.

The post-fix probe is [engine-probes-after.json](engine-probes-after.json): horizontal and transposed-vertical closing now match exactly, and the formerly accepted touching ring is rejected. The analytic six-room evaluation passes 6/6, with area deviation ≤0.1701%, IoU ≥0.995702 and boundary error ≤0.4714 pt. Full build and the baseline ratchet pass. This is still not a room-partition implementation or a new external benchmark run.

## What was actually executed

- Node synthetic probes against the existing `closeLine`, `dynamicFill` and local ring validator. No benchmark input or GT is loaded by this script.
- Official-scorer synthetic tests for shared-edge children, a positive separating strip and exact IoU=0.5.
- Validity inspection of **already frozen predictions only**: 28 input rings → 12 invalid rings → 43 components after repair → 39 after union. This does not assign FP causes or inspect benchmark annotations.
- Reproduction of **reference systems' published scores**, as requested: OpenTakeoff 14 TP / 6 FP / 8 FN, F1 0.666667; Kamai 17 / 2 / 5, F1 0.829268. This verification reads benchmark GT, emits only aggregate reference scores and never generates or tunes our predictions.

No room-partition algorithm was implemented or timed. No new pdf2takeoff prediction was generated. No benchmark threshold or gap ladder was changed. The proposed full proxy matrix has been specified, not claimed as executed.

## Reproduce

Use Node >=22.6 (this review used 22.23.1) and a Python environment with the official scorer's `numpy`, `Pillow` and `shapely` dependencies. The scorer clone must be at `b855483786285ee31120c2e5e03f985810bf7b08` for these comparisons.

```sh
node evals/probe-room-partition.mjs
python evals/aecgb/probe-partition-contract.py
python evals/aecgb/verify-reference-scores.py
```

The Node probe intentionally reports existing defects; its successful exit means the diagnostic ran, not that those engine checks passed. The scorer-contract script asserts its synthetic expectations. The reference script downloads one pinned public prediction JSON and validates its hash; it does not download or port peer code.

Outputs:

- [engine-probes.json](engine-probes.json)
- [engine-probes-after.json](engine-probes-after.json)
- [scorer-probes.json](scorer-probes.json)
- [reference-scores.json](reference-scores.json)
- [environment.json](environment.json)
- [FREEZE.sha256](FREEZE.sha256)

The freeze records the final review evidence and its source files after this review. It is not represented as a pre-scoring freeze for a new experiment. The prediction SHA matches the prior B6d freeze. Reference results are reproducible with today's pinned analytic scorer; historical scorer identity for OpenTakeoff is not established by its README. Single local verification, no browser performance evidence.
