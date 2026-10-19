# Benchmark results ledger

`ledger.jsonl` holds one JSON line per benchmark run, so the accuracy numbers
of this engine travel with the commit that produced them and a change can be
read as a delta, not a screenshot. Append-only: never rewrite an old line.

```bash
npm run bench:ledger                  # run the fast benches, append a "synthetic" line
npm run bench:ledger -- --compare     # and print the delta against the previous synthetic line
npm run bench:ledger -- --dry-run     # print the line, append nothing
npm run bench:ledger -- --skip floorplancad   # without a Python that has cairosvg
```

The synthetic run needs no external data. It executes, in order:

| Step | Script | Headline numbers |
|---|---|---|
| takeoff bench | `scripts/takeoff-bench.mjs --json` | fill pass count and median area error, count exact rate, scale pass count, known gaps still open |
| scan check | `scripts/check-scan.mjs` | ok or failure count (tier-1 CV scan: line removal, dihedral, dashed lines) |
| fill check | `scripts/check-fill.mjs` | cases, median and max area error against the ideal |
| FloorPlanCAD synthetic | `scripts/make-floorplancad-sample.py` (seed 7, 3 drawings) then `scripts/floorplancad-convert.py --counts-only` then `scripts/floorplancad-count-bench.mjs --json` | exact rate, recall, stairs recall, per class |

The FloorPlanCAD step needs a Python with `cairosvg`: pass `--python <bin>`
(or set `PDF2TAKEOFF_PYTHON`) and, when it is not next to that Python or on
`PATH`, `--cairosvg <bin>` (or `CAIROSVG`). Without them the line still
appends with `floorplancadExactRate: null` and a note saying why.

## Line schema (schema 1)

Every line carries:

| Field | Meaning |
|---|---|
| `schema` | `1` |
| `kind` | `synthetic` (this script's own run) or `external` (a bench on downloaded data) |
| `dataset` | `synthetic`, or the dataset name of an external run (`resplan`, `aecv-bench`, `dataset-pid`, `scaled-drawings`, ...) |
| `bench` | external lines only: the script that produced the numbers (`room-bench`, `aecv-bench`, `check-scan-dataset`, `scaled-drawing-bench`) |
| `date` | ISO 8601, when the run finished |
| `commit`, `branch`, `dirty` | `git rev-parse --short=12 HEAD`, the branch, whether tracked files had uncommitted changes |
| `node` | Node version |
| `headline` | a flat object of the numbers to compare across runs (see below) |
| `notes` | free text: what was skipped, what failed, what the run was for |

Synthetic lines add `durationMs` and `benches` (the per-step detail: pass
lists, per-class FloorPlanCAD rows, failing case ids). Their `headline` keys:

| Key | From |
|---|---|
| `fillPass`, `fillTotal`, `fillMedianErrPct` | takeoff bench `fill` cases: passes, cases, median absolute area error in percent |
| `countExact`, `countTotal`, `countExactRate` | takeoff bench `count` cases: exact counts over cases |
| `scalePass`, `scaleTotal` | takeoff bench `scale` cases |
| `knownOpen` | takeoff bench cases marked `known` that still fail |
| `scanCheck`, `scanCheckFailures` | `ok` or `N failure(s)` from check-scan.mjs |
| `fillCheck`, `fillCheckMedianErrPct` | check-fill.mjs: `ok` or failures, median area error over its rooms |
| `floorplancadExactRate`, `floorplancadRecall`, `floorplancadStairsRecall` | the synthetic FloorPlanCAD count bench, all classes, policy `first`; `null` when the step did not run |

## External-data benches

Benches that need downloaded data (ResPlan, AECV-Bench, Dataset-P&ID, the
scaled-drawing set) are run by hand and append their own line, picking the
headline numbers that matter for them:

```bash
node scripts/bench-ledger.mjs --external room-bench --dataset resplan \
  --metrics '{"plans":100,"variant":"B","medErrFace":-0.021,"p90AbsErrFace":0.08,"leakRate":0.02,"recovered":0.93}' \
  --source bench/out/room-bench-B.json --note "hints=all" --compare
node scripts/bench-ledger.mjs --external check-scan-dataset --dataset dataset-pid \
  --metrics '{"classes":30,"meanRecall":0.42,"meanPrecision":0.9,"exact":11,"mape":0.31}'
node scripts/bench-ledger.mjs --external aecv-bench --dataset aecv-bench --metrics results/aecv-summary.json
node scripts/bench-ledger.mjs --external scaled-drawing-bench --dataset scaled-drawings --metrics results/scaled.json
```

`--metrics` is inline JSON or the path of a JSON file holding a flat object
of numbers (and short strings such as a variant letter). `--compare` finds the
previous line with the same `bench` and `dataset` and prints the per-key delta.
Recommended keys so that lines stay comparable: `room-bench` records `plans`,
`variant`, `medErrFace`, `p90AbsErrFace`, `medIoU`, `leakRate`, `recovered`
from its "all enclosed rooms" row; `check-scan-dataset` records `classes`,
`meanRecall`, `meanPrecision`, `exact`, `mape` from its summary JSON;
`aecv-bench` records per-question-type exact match rates and the overall mean;
`scaled-drawing-bench` records its pass count and median scale error.

## Reading the ledger

```bash
tail -n 1 bench/results/ledger.jsonl | jq .headline
jq -r 'select(.dataset=="synthetic") | [.date, .commit, .headline.fillPass, .headline.countExactRate, .headline.floorplancadExactRate] | @tsv' bench/results/ledger.jsonl
```

Dates are not run order across machines; sort by `date` when in doubt. A line
with `dirty: true` was produced from uncommitted changes and is a working
note, not a record of a commit.
