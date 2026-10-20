# Legend-guided takeoff pilot

A local, standalone experiment for two declared electrical symbol types (DL1 and SO1), on one digital PDF page at a time. It reuses `scanDocAt`, `vectorDocPage`, text extraction and rendering from the existing headless API. No shared source, package dependencies or lockfiles change.

## Run

From the repository root, with Node >=22.6:

```sh
npm ci
node experiments/legend-takeoff/run.mjs
node experiments/legend-takeoff/serve.mjs
```

Open http://127.0.0.1:5174. Stop the server with Ctrl-C. This serves only the experiment folder on loopback. The runner regenerates six original PDFs and six annotated copies under `output/`, plus evidence JSON, positioned legend JSON, drawing PNGs, `quantities.csv` and `report.json`.

No credentials needed. No network calls in the runner. AI review is **not implemented or replayed**; its comparison rows are explicitly not assessed. Live AI review requires a separately declared call/spend budget and a server-side environment key before implementation.

## Inputs and provenance

`fixtures.json` contains authored symbol placements, manual exclusion regions are declared by the generator, and baseline exemplars are selected at known legend coordinates. This is synthetic oracle ground truth authored before the first scan, **not independent human annotation**. Everything is original and shareable under the repository Apache-2.0 licence. No customer drawings or downloaded model files are included.

The development family is `a` (three sheets); held-out sheets use different geometry families `b` and `c`. The protocol and matching rules were fixed before the initial scanner run. Held-out outcomes were inspected for this report but were not used to tune detection or parsing. This six-sheet pilot is smaller than the mission's suggested 6+6 and cannot establish field accuracy. The test-missing and test-ambiguous cases intentionally expose failure modes.

The parser is deliberately narrow: it searches manually selected legend bounds for a declared code, groups horizontal text, and requires exactly one small vector path to the left. It preserves source text, candidate bounds, association state and exemplar. It does not understand arbitrary legends, multi-path symbols, scans or cross-page exemplars. A missing legend currently yields no extracted entries and two not-assessed quantity rows. Automatic legend discovery and external PDF input are not implemented.

All coordinates carry page 1 and `pdf-points-bottom-left`. Raster display uses the pdf.js viewport transform; conversion round trips are checked. IDs combine source PDF SHA-256, page, type and a hash of coordinates rounded to 0.001pt. Identical source/scan results keep identical IDs. Scans always start from original bytes and never append old markups. Within-type hits within 3pt are deduplicated in sorted coordinate order; different types are not merged.

## Reproduce evaluation

```sh
node experiments/legend-takeoff/run.mjs
npm run bench
npm run build
```

Matching is maximum-cardinality, one-to-one, same type, within 10 PDF points. No hit or truth can be matched twice. Unassessed types have blank quantities and count-error fields; their truth instances remain misses for end-to-end recall. Precision is null without detections. Report both coverage and assessed exact counts so unavailable results cannot masquerade as zero error.

Manual baseline input is one exemplar per available type. Extracted runs share one manually selected primary legend region per sheet with a legend. The repeated-legend sheet also has a second manually declared exclusion region. These selection counts are inputs, not measured user interaction time. No human corrections were applied in evaluation. Runtime in the report measures each scan and hit processing, excluding fixture generation, rendering and legend extraction; sub-millisecond values round to zero.

| Split | Configuration | Correct | Incorrect | Missed | Precision | Recall | Assessed page/types | Exact assessed counts |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| Development | Manual exemplar | 11 | 0 | 0 | 100% | 100% | 6/6 | 6/6 |
| Development | Extracted legend | 11 | 0 | 0 | 100% | 100% | 6/6 | 6/6 |
| Held-out | Manual exemplar | 8 | 3 | 3 | 72.7% | 72.7% | 4/6 | 2/4 |
| Held-out | Extracted legend | 6 | 2 | 5 | 75.0% | 54.5% | 3/6 | 2/3 |
| Both | Extracted + AI | — | — | — | — | — | Not assessed | — |

Extracted legend associations: 9 supported, 9 correct against authored exemplar coordinates, 1 unresolved association on present legends. Two additional types have no legend on test-missing. Each configuration's per-type metrics, absolute count errors and scanning provider are in `output/report.json` and `output/quantities.csv`. All assessed scans in this run used the vector provider. Cloud calls: 0; API cost: $0.

The parser rejected the ambiguous DL1 association. SO1 still falsely matched both octagonal DL1 installations on family c. The manual baseline also cross-matches the lookalike geometry. The negative result demonstrates why stable evidence and a review step matter; no claim is made that extraction improves accuracy. A manual baseline in the ambiguous sheet can itself be contaminated by adjacent legend geometry.

## Two-minute demo

1. Open `dev-clean`: select a quantity row and inspect a numbered hit; green boxes indicate legend associations.
2. Open `dev-repeat`: show that repeated legend examples are excluded.
3. Open `test-transforms`: inspect rotation/size matches.
4. Open `test-ambiguous`: DL1 is not assessed; SO1 shows two false positives. Click a numbered false positive and flag uncertain or reject it. Totals recalculate in code.
5. Download reviewed JSON/CSV. These preserve original evidence and separate timestamped human decisions; they do not overwrite benchmark results. Review state survives drawing/method changes in the tab but is lost on reload unless exported. Corrections cannot be imported yet.
6. Open the original annotated PDF and JSON from the same run. The PDF is the original detector output; browser review decisions do not regenerate it.

## Validation and remaining work

Initial checkout: `e0d57e3a463297b1580f72bf647f3dfe7bbf3083`. The report also records Node, commit and fixture-protocol hash. The implementation is currently uncommitted; the commit field identifies the engine baseline, not a committed experiment revision.

- `npm ci`: completed.
- `npm run bench`: passes, no regressions; one declared pre-existing diagonal room gap.
- `npm run build`: existing `scripts/check-scaled-bench.mjs` fails its generator determinism check against committed `questions.jsonl`, before full app typechecking/bundling. This occurred on the untouched checkout before any experiment files were written. Engine checks through scanning/openings passed. The experiment does not modify this check or room code.
- Runner protocol checks cover one-to-one scoring, augmenting-path matching, deduplication and PDF/raster round trips.
- All six annotated PDFs were rendered and visually checked.

Next: obtain tracking-issue acknowledgement, independent human labels and permission-cleared real electrical sheets; test multi-path legend crops; add budgeted AI review only if it can resolve the documented lookalikes. Keep this fixture set frozen for comparisons. Full mission completion requires that broader evaluation, real input workflow, AI comparison where applicable, and a reviewed draft PR.

`tracking-issue.md` is prepared locally. GitHub CLI is not authenticated, so no issue, push or PR was created. Run `gh auth login` using your own account when ready; record AJ's acknowledgement in the issue. Do not merge or deploy as part of this experiment.

Additional verification: standalone `npx tsc --noEmit` and `npx vite build` both pass, isolating the combined build failure to the pre-existing engine benchmark check. A second experiment run preserved hit IDs and counts exactly. Chrome review UI was checked: selecting a hit reveals provenance; flagging it uncertain decreases supported and increases unresolved totals; reloading restores original results. Test review changes were discarded.
