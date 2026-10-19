# Evaluation strategy for pdf2takeoff

Research doc (October 2026): how we should measure whether the tool is getting
better — in the direction that actually matters. Companion to
[ai-literature-review.md](ai-literature-review.md) (what to build) and
[market-scan.md](market-scan.md) (what others do); this file is the "how do we
know it worked" half.

Headline: our north-star metric is not mAP. An estimator buys **time and
trust**: quantities they will sign off with minimal correction, faster than
doing it by hand. Everything below follows from committing to that sentence.
The borrowable frameworks: FSC-147's count metrics (MAE/RMSE on counts) for
Scan, TIDE's error decomposition for the detector, SAHI's sliced-inference
discipline for tiling, field-level exact-match + CER for OCR, the construction
QTO literature's %-deviation-from-manual-takeoff convention for end-to-end
accuracy, and golden-set regression gates in CI for every model swap.

---

## 1. What we are solving for

The product promise: *PDF in, quantities out, in less time than a human with a
highlighter, with errors small enough to trust.* That decomposes into three
questions evaluation must answer continuously:

1. **Quantity accuracy** — when the tool (or the model under it) counts 24
   downlights or reads a 12.00 m dimension, how far is it from the truth an
   estimator would accept?
2. **Correction burden** — how many clicks/edits does a human spend fixing
   what the automation proposed? (This is the real "time saved" proxy, and it
   is also our cheapest label source — every correction is training data.)
3. **Robustness across the real input distribution** — scans vs born-digital,
   A0 vs A3, symbols on walls vs clear, dense vs sparse — no slice quietly
   regressing while the average improves.

A detector mAP number answers none of these directly. It stays as a
*diagnostic*, never as the gate.

## 2. Where evaluation stands today

What exists (all of it good, none of it sufficient):

| Layer | Today |
| --- | --- |
| Geometry / tiling correctness | `scripts/check-detector.mjs` — self-locating stub verifies the full tile→NMS→PDF-pt round-trip, border straddlers, caps, guards |
| Annotation round-trip | `scripts/roundtrip-check.mjs` — write→read-back asserts on labels, units, idempotence |
| Generator label quality | invariant asserts in CI (ink-inside-box), `--debug` overlays |
| Engine behaviours | `check-engine.mjs`, `check-fill.mjs`, MCP smoke, one takeoff-spec run grepping `"found": 8` |
| Model quality | "watch val mAP" in the Kaggle notebook, on a synthetic 15% split |

The gaps, in order of how much they can mislead us:

1. **No real-drawing golden set.** Synthetic val mAP measures fit to our
   generator, not performance on tenders. The training README already warns
   synthetic-only risks brittleness; evaluation currently has the same blind
   spot.
2. **No count-level or quantity-level metric.** The product outputs counts and
   lengths; we only ever measure boxes-with-IoU.
3. **No error decomposition.** When recall drops, we don't know if symbols are
   missed, duplicated at tile borders, class-confused, or killed by
   thresholding — so we can't tell data work from threshold work from
   architecture work.
4. **Model swaps bypass CI entirely.** `symbols.onnx` is a gitignored drop-in;
   a re-train that quietly halves recall on scanned sheets ships with a green
   pipeline.
5. **No eval at all** for OCR dimension/scale reading, dynamic fill accuracy,
   tier-1 CV scan quality, or the MCP agent path beyond a smoke test.
6. **No comparison statistics** — "v2 felt better on the val sheet" is the
   current standard of proof between models.

## 3. Frameworks worth borrowing (and what each buys)

### 3.1 Count accuracy as a first-class metric — the FSC-147 convention

The few-shot counting field (FamNet/FSC-147, CVPR 2021 onward) evaluates
exactly our interaction — exemplar in, count out — with **MAE, RMSE, NAE
(normalized absolute error) and SRE** over per-image count errors, never with
detection mAP alone. Mapping to us: for every golden sheet × class, click a GT
instance (or run page-wide), compare returned count vs GT count.

- **Count error** `|pred − gt|` and **signed count error** (bias matters: an
  estimator under-counting conduits loses money differently than over-counting)
- **MAE / RMSE across sheets** for the headline number; RMSE punishes the
  catastrophic sheets that MAE hides
- **Instance-level precision/recall** (match by centre distance, since the
  product promise is "the right symbols", not tight boxes) — precision here is
  the *phantom rate*, the number that decides whether users keep pressing S

### 3.2 Error decomposition before optimization — TIDE

[TIDE](https://arxiv.org/abs/2008.08115) (Bolya et al., ECCV 2020;
[toolbox](https://dbolya.github.io/tide)) is the standard tool for splitting
detection error mass into **Cls / Loc / Both / Dupe / Bkg / Miss** and
measuring each type's effect on the metric. We don't need their Python lib —
we need the discipline, with our own taxonomy extended past boxes:

| Error type | Ours | Product cost |
| --- | --- | --- |
| Miss | symbol not returned | under-count, lost money |
| Dupe | two hits, one symbol (tile borders are the suspect) | over-count |
| Cls | downlight returned as smoke-alarm | wrong schedule line |
| Phantom (≈Bkg) | hit on linework/legend/nothing | triage cost, trust |
| Border-miss | symbol cut by a tile edge seen by neither window | tiling-specific Miss |
| Threshold-kill | detection scored below `score` | cheapest fix, most often missed |
| **Scale error** | calibration/OCR misread → every length wrong | catastrophic, box metrics blind to it |
| **Association error** | OCR bound number to the wrong line/symbol | wrong dimension |

The rule this enforces: *no model change ships without a per-type error delta.*
It's how we avoid spending a Kaggle weekend fixing Cls when Miss is 5× the
error mass.

### 3.3 Evaluate the tiled system, not the model — SAHI's lesson

[SAHI](https://github.com/obss/sahi) (Akyon & Altinuc — slicing-aided
inference; see the [Ultralytics SAHI guide](https://docs.ultralytics.com/guides/sahi-tiled-inference))
popularized the now-standard finding for tiled detection: **slice size,
overlap, and match-between-training-and-inference-resolution dominate the
final number as much as the weights do.** Their protocol evaluates the full
sliced pipeline (slice → per-tile infer → fuse → NMS) end-to-end and reports
recall specifically on objects straddling slice borders. Rezvanifar et al.
2020 (already in our lit review) says the same for floor plans.

For us: the detector must always be evaluated *through*
`detectorScan` with the manifest's real `tile` block — never on exported
crops — and **border-straddler recall vs interior recall** is a mandatory
slice (our check-detector stub proves the geometry; only a real-model eval
proves the *recall*). The `pxPerPt` contract in
[specs/detector-tiling.md](../../specs/detector-tiling.md) should be validated
by an eval that fails when training and manifest rates disagree — that class
of bug "quietly kills recall" and is currently invisible.

### 3.4 OCR: field-level exact match, with CER as the diagnostic

Document-extraction practice (see [Mindee on OCR metrics](https://www.mindee.com/blog/ocr-accuracy-choosing-best-api),
[OCR-D's CER definition](https://ocr-d.de/en/spec/ocrd_eval.html)) evaluates
**field exact-match rate** for structured values and CER/WER only as a
diagnostic. A dimension "12.00" read as "12.0B" is a failed field at any CER.
Our additions:

- **Dimension exact-match rate** per golden sheet (the number must be exactly
  right; near-miss digits are not 90% useful)
- **Scale-string exact-match rate** ("1:100", "1/4" = 1'-0"")
- **Tolerance-band pass rate** as the estimator-facing framing: |read −
  printed| within the tolerance a checker would accept (e.g. ≤ ½ of the
  smallest printed graduation)
- **Unit confusion rate** (mm read as m — the exact bug roundtrip-check
  guards on the write side; the read side has no guard yet)
- olmOCR's unit-test-style exact-match rewards (noted in the lit review) are
  the right pattern if a VLM ever enters the read path

### 3.5 End-to-end: the construction QTO convention — % deviation + time

Studies comparing automated vs manual takeoff (Alder, BYU 2006; Li et al., CIB
W78 2025 — 94.1% area accuracy, ~99% time reduction; the BIM-QTO literature)
report **per-quantity-line percent deviation from a human ground-truth
takeoff, plus time taken**. That is the number to put on the tin: "median
quantity deviation X%, 95th percentile Y%, on N sheets" — per quantity type
(count / length / area), per sheet. Two statistical borrowings from
measurement-agreement practice:

- **Paired per-sheet analysis**: every sheet has (auto, manual) pairs — plot
  deviation vs mean (Bland-Altman style) to expose *proportional bias* (e.g.
  lengths systematically 3% short on one scale family) that an average hides
- **Wilcoxon signed-rank / paired bootstrap** on per-sheet errors when
  comparing model versions (standard practice discussion:
  [Cross Validated](https://stats.stackexchange.com/questions/630020/), [Raschka](https://sebastianraschka.com/blog/2018/model-evaluation-selection-part4.html));
  with n≈20 sheets, don't claim wins inside the noise band

Our advantage: `pdf2takeoff run takeoff.yaml` already regenerates quantities
headlessly — **the end-to-end eval is a directory of `takeoff.yaml` +
`expected.json` pairs**, run with `--prev` semantics to diff any candidate
model against the incumbent. The CI `grep '"found": 8'` smoke is the seed of
this; it grows into a golden task suite.

### 3.6 Correction burden — evaluation from the data loop we already have

Human-in-the-loop research treats **edits-per-document and acceptance rate as
evaluation metrics** (see the [HITL metrics framework](https://shibuiyusuke.medium.com/quantitatively-evaluating-human-in-the-loop-for-ai-agents-a-comprehensive-9-axis-metrics-framework-4b5ca2ba2b1)
discussion; NIST's HITL annotation studies). Our status flags (flagged /
confirmed) and the annotation round-trip already record exactly this, locally
and privacy-safely:

- **Confirm rate**: fraction of scan hits confirmed untouched
- **Edits per 100 hits**: renames (→ Cls errors), deletions (→ phantoms),
  manual re-adds (→ Miss) — a free, per-user TIDE
- This doubles as the pilot fine-tune data plan already in training/README:
  corrections are labels *and* eval signal. (Mind the known HITL bias:
  humans under-correct plausible-looking pre-annotations — the
  [Harvard DSR piece](https://hdsr.mitpress.mit.edu/pub/nrcn4h7d) — so
  confirm-rate is an *upper* bound on quality.)

### 3.7 Golden sets as CI gates — including for drop-in models

The eval-in-CI pattern from the LLM world (golden datasets + threshold gates
before deploy — [DeepEval's CI integration](https://deepeval.com/docs/evaluation-unit-testing-in-ci-cd),
[Traceloop's regression pattern](https://www.traceloop.com/blog/automated-prompt-regression-testing-with-llm-as-a-judge-and-ci-cd))
maps directly: **a candidate model runs the golden suite; the swap is blocked
if any slice regresses beyond ε.** Because our models are gitignored drop-ins
that today bypass CI entirely, the practical version is: every `symbols.json`
manifest must carry (or link) its eval record — per-class, per-slice numbers
from the exact artifacts in `public/models/` — and a `check-model` script
re-verifies a small deterministic subset locally (a few sheets, ONNX headless)
so a bad drop-in fails fast in `npm run typecheck:engine` too.

### 3.8 Tooling: what to adopt vs write

- **Don't build AP from scratch in TS.** Per-class AP/AR, confusion matrices,
  PR curves: compute in the Kaggle notebook with
  [pycocotools](https://github.com/cocodataset/cocoapi) or
  [Roboflow supervision](https://supervision.roboflow.com/latest/detection/metrics)
  (`sv.MeanAveragePrecision`, `sv.ConfusionMatrix`) during training, and
  export the numbers with the model.
- **Count metrics, OCR field match, takeoff diffs: write in Node** (~150
  lines each) against the headless engine — they must run in CI and use the
  *product's* code path (`detectorScan`, `ocr`, `run`), not a parallel Python
  reimplementation that can drift. Needs the ONNX detector wired headless
  (onnxruntime-node, or ORT-web's WASM under Node) — currently only tier-1
  `cvScan` runs in `src/headless/ops.ts`.
- **[FiftyOne](https://docs.voxel51.com/user_guide/evaluation)** (free,
  Apache-2.0 core) for *qualitative* error analysis when building datasets:
  load golden set + predictions, slice by error type, eyeball clusters of
  misses, find ground-truth mistakes. Offline laptop use; nothing uploads.
  This is the "which direction" tool — mAP says *whether*, FiftyOne says
  *where*.

## 4. The metric ladder

| Level | Measures | Runs | Gate? |
| --- | --- | --- | --- |
| **L0 — behavioural** | geometry, round-trips, invariants (today's checks) | every commit | hard fail |
| **L1 — component benchmarks** | detector count error + instance P/R per class/slice; tier-1 CV same; OCR field match; fill area MAPE + leak rate | on model swap + weekly | slice-regression ε |
| **L2 — end-to-end takeoff** | per-sheet quantity deviation vs human GT (`takeoff.yaml` + `expected.json`); scale-read exact match | on model swap + release | headline tolerance |
| **L3 — human factors** | confirm rate, edits/100 hits, time/sheet (local status events) | pilot sessions, quarterly | advisory |

Rules: L0–L1 fast (< minutes); L2 minutes; nothing in the ladder needs
network or uploads. Synthetic data may appear in L1 only as *degradation
slices*; headline numbers are real-sheet only.

## 5. The golden set

The single most important artifact. Design:

- **Size to start**: 20–30 real sheets, ≥ 300 labelled symbol instances, ≥ 2
  disciplines (electrical + arch), each with a human takeoff (`expected.json`)
  — a weekend of estimator time, ideally the first pilot client's
  client-consented sheets (never committed; hashed like session persistence).
- **Stratification axes** (each becomes an eval slice): born-digital vs scan
  (and scan-quality tier), page size A4–A0 (tiling on/off naturally varies),
  symbol density, on-wall fraction, degradation artifact where synthetic.
- **We are our own annotation tool**: markups saved into the PDF are standard
  annotations; `cli export` turns them into the quantities CSV. A golden
  sheet = PDF with GT markups + `expected.json` regenerated from it. Zero new
  tooling for counts/lengths; for *symbol* GT boxes, CVAT/Label Studio → COCO
  JSON (their export format), or simply confirmed scan hits promoted to GT —
  the confirm-status round-trip already exists.
- **Research-only benchmarks to borrow for slices we can't yet source**:
  FloorPlanCAD (real CAD-style sheets; CC BY-NC — eval fine, weights never),
  CubiCasa5k (room polygons → fill-area benchmark), Schönfelder 2024 (annotated
  drawing text → OCR benchmark), SESYD (degradation protocol). Their numbers
  go in the eval record tagged `research-benchmark`, kept separate from the
  client-sheet numbers.
- **Leakage discipline**: synthetic val split stays inside the generator's
  seed world and never mixes into golden; golden sheets are never fine-tuned
  on until "graduated" deliberately (and then re-replaced). Version the set
  (`golden/v3`); every eval record names its version.

## 6. Slices that keep us honest

Minimum slice set for any L1/L2 report (all from §5 axes):

1. sheet size × tiling (A3 whole-page vs A0 tiled)
2. border-straddler recall vs interior recall (SAHI slice)
3. on-wall vs clear symbols
4. clean vs degraded (per artifact: blur, speckle, photocopy, rotation)
5. per-class (5 classes today) + top confused-pair table
6. score-threshold sensitivity curve (is the operating point on a cliff?)
7. fallback rate: detector → tier-1 CV downgrade frequency (a broken tile
   config today downgrades *silently* — that rate belongs on the dashboard)
8. confidence calibration if we ever auto-confirm: predicted-score vs
   empirical-precision bins (an estimator trusting "0.9" needs 0.9 to mean it)

## 7. Operating point and direction guardrails

- **Tune the threshold for the product loss, not F1**: minimize weighted
  `α·Miss + β·Phantom` at the count level (phantoms cost trust, misses cost
  money — α > β if tenders price from our counts).
- **Recall floors per high-value class** (e.g. smoke-alarm recall ≥ 0.95) as
  gates, not averages — a mean hides a dead class.
- **Weight errors by quantity impact**: one missed 40 m corridor run ≠ one
  missed GPO. L2 reports per-line deviation; L1 can approximate with
  class-value weights.
- **No model ships on synthetic-val evidence alone**, and no claim of
  improvement without paired per-sheet stats or a slice-level delta beyond
  noise.
- **Determinism stays the referee**: dimensions, scales and counts come from
  the engine (the lit review's VLM conclusion); any LLM in the loop is
  evaluated as an orchestrator (task success on golden MCP tasks), never as
  the measurer.

## 8. Build order

1. **`scripts/eval-scan.mjs`** — L1 count metrics for tier-1 CV scan (needs
   no model infra, runs today against `scanDocAt`): golden dir → per-class
   count error, instance P/R, JSON report. First real numbers within a day.
2. **ONNX headless** — port `detectorScan` into `src/headless/` behind the
   ports (onnxruntime-node or ORT-web WASM under Node); extend eval-scan to
   tier-2 with the manifest's tile config. This also unlocks agent-side scan
   upgrades later.
3. **Golden set v0** — the pilot sheets + `expected.json` + takeoff.yaml
   suite; grow the CI smoke (`grep found: 8`) into `run --check expected.json`
   (fail on any quantity-line deviation beyond tolerance).
4. **Notebook eval cell** — per-class AP + confusion matrix + count metrics
   via supervision/pycocotools on golden (research benchmarks for slices),
   TIDE-style error-mass table, written next to the exported model as
   `symbols.eval.json`; `check-model.mjs` validates manifest↔eval presence and
   re-runs a 3-sheet subset.
5. **OCR/fill/scale benchmarks** — dimension exact-match script against
   Schönfelder-style GT; fill MAPE + leak rate on CubiCasa rooms (research
   tag); scale exact-match per golden sheet.
6. **Correction-burden events** — emit status-change events to the local
   session log; a small report script turns pilots into confirm-rate /
   edits-per-100 numbers (the L3 dashboard, still zero telemetry).

## 9. Traps (how this Goodharts)

- Optimizing generator-val mAP → we get a model that nails our generator's
  quirk distribution; golden real-sheet numbers are the only headline.
- Chasing tight-box AP when the product only needs the right symbol *found
  once* — instance P/R at centre-distance + count error outrank IoU-strict AP.
- Averaging over slices (A0 scanned sheets are the sheets that matter most;
  they must not be diluted by easy A3s).
- Trusting the confirm button alone (pre-annotation acceptance bias).
- Letting a "felt better" model swap ship — no eval record, no swap.
- Evaluating OCR with CER alone — "12.0B" is not 83% of a correct dimension.

## Sources

- TIDE — [paper](https://www.ecva.net/papers/eccv_2020/papers_ECCV/papers/123480562.pdf) /
  [arXiv:2008.08115](https://arxiv.org/abs/2008.08115) /
  [toolbox](https://dbolya.github.io/tide)
- SAHI — [repo](https://github.com/obss/sahi) /
  [Ultralytics guide](https://docs.ultralytics.com/guides/sahi-tiled-inference) /
  [Encord explainer](https://encord.com/blog/slicing-aided-hyper-inference-explained)
- Counting metrics (FSC-147 line) —
  [FSCD-147 metrics](https://www3.cs.stonybrook.edu/~minhhoai/papers/FSCD-ECCV22.pdf) /
  [counting survey 2026](https://arxiv.org/html/2608.23845v1)
- FiftyOne — [evaluating models](https://docs.voxel51.com/user_guide/evaluation) /
  [object detection guide](https://docs.voxel51.com/getting_started/object_detection)
- Supervision metrics —
  [docs](https://supervision.roboflow.com/latest/detection/metrics) /
  [release](https://github.com/roboflow/supervision/discussions/276)
- OCR field/CER metrics — [Mindee](https://www.mindee.com/blog/ocr-accuracy-choosing-best-api) /
  [OCR-D eval spec](https://ocr-d.de/en/spec/ocrd_eval.html)
- QTO accuracy & time studies —
  [Alder 2006 (BYU)](https://scholarsarchive.byu.edu/cgi/viewcontent.cgi?article=1508&context=etd) /
  [Li et al. CIB W78 2025](https://docs.lib.purdue.edu/cgi/viewcontent.cgi?article=2098&context=cib-conferences)
- Paired-comparison statistics —
  [Cross Validated thread](https://stats.stackexchange.com/questions/630020/why-dont-deep-learning-computer-vision-studies-utilize-statistical-tests) /
  [Raschka, model selection part 4](https://sebastianraschka.com/blog/2018/model-evaluation-selection-part4.html)
- Golden-set CI gates —
  [DeepEval CI](https://deepeval.com/docs/evaluation-unit-testing-in-ci-cd) /
  [Traceloop regression pattern](https://www.traceloop.com/blog/automated-prompt-regression-testing-with-llm-as-a-judge-and-ci-cd)
- HITL correction metrics —
  [9-axis framework](https://shibuiyusuke.medium.com/quantitatively-evaluating-human-in-the-loop-for-ai-agents-a-comprehensive-9-axis-metrics-framework-4b5ca2aba2b1) /
  [HDSR pre-annotation bias](https://hdsr.mitpress.mit.edu/pub/nrcn4h7d)
- Domain papers already reviewed in
  [ai-literature-review.md](ai-literature-review.md): FloorPlanCAD, CubiCasa5k,
  Rezvanifar 2020, SESYD, Schönfelder 2024, Ying 2026.
