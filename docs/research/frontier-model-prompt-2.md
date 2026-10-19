# Super prompt 2: second-opinion review of pdf2takeoff direction

Paste everything below the line into the second model. It is self-contained.
For depth, run the "tensions" as follow-up threads afterwards; optionally
attach `docs/research/verify-first-plan.md` (our disposition of reviewer 1)
and `docs/research/frontier-model-prompt.md` (the original ask) to those
threads.

---

You are the **second independent reviewer** of a direction decision. A first
frontier model already reviewed this project and proposed a strategy; the
team dispositioned it. Your value is **disagreement and arbitration** — if
you agree with everything below, you are useless to us. Do not defer to the
first reviewer, and do not defer to the team's own conclusions; where you
think both are wrong, say so first. You are judged on: **independence**,
**concreteness** (recommendations a solo maintainer can start this week),
and **constraint discipline** (proposals violating the hard constraints are
dead — don't spend words on them).

## The product

**pdf2takeoff** (Apache-2.0, free, no account): construction PDF drawings
in, measured quantities out, 100% in the browser — nothing is ever uploaded
(privacy is the product: confidential tender documents). PDF.js renders;
pdf-lib writes markups back into the PDF as standard annotations that
round-trip through Bluebeam/Acrobat (calibration rides in the comments).
Tools: length/area/count/volume/angle takeoff, scale calibration incl.
multi-scale viewports, OCR dimension/scale auto-read, revision compare
(pixel blend), live same-machine sessions, printable reports, CSV/xlsx
export. The same engine runs headless in Node as a CLI and a local MCP
server (12 tools) so an AI agent can run a takeoff with deterministic tools
and hand a marked-up PDF to a human.

Auto-count stack: **tier 1** classical CV (connected components + shape
matching, ~44 ms/sheet, zero download, always present) → **tier 2** lazy
ONNX detector (onnxruntime-web WASM, drop-in `symbols.onnx` + manifest,
auto-fallback to tier 1). **Dynamic Fill**: click a room → flood fill +
boundary trace → area, with escalating morphological closing for door gaps.

**Architecture rule (settled, do not challenge):** every number comes from
deterministic code; three 2026 VLM benchmarks show frontier VLMs misreport
drawing numbers. LLMs orchestrate only.

**Business reality:** solo maintainer, free static hosting only
(Cloudflare Pages free tier), free Kaggle GPUs for training, no budget.
Success = estimator adoption and contributor community; revenue is
adjacent consulting. Every patch competes for the same weekends — effort
is sized S (≤1 day) / M (few days) / L (week+).

## Hard constraints (all bind)

1. Client-side only: browser WASM (WebGPU optional, WASM fallback), no
   server inference, no uploads, works offline. Node headless twin shares
   the engine.
2. Licence-clean: Apache-2.0 repo; no AGPL (no Ultralytics); shipped
   weights train only on own synthetic data (seeded, reproducible
   generator) + client-consented data; CC BY-NC datasets (FloorPlanCAD,
   CubiCasa5k, AEC-Geometric-Bench) are eval/research-only.
3. Static-only deploy, free tier.
4. Size/latency: new models ≤ 40 MB lazy (current 76 MB tier-2 is the
   outlier we want dead); interactive ops sub-second; tier-1 ~100 ms.
5. Determinism for all measurement outputs.

## Where we are (evidence, October 2026)

- **Tier-1 scan:** precision 1.000 / recall 0.249 clean, 0.179 degraded on
  a deliberately hostile synthetic bench (thin strokes, wall-parked
  symbols, scan artifacts); misses attributed to a signature gate, wall
  merges, degradation. Near-perfect on home-turf rasters.
- **Tier-2 detector:** v1 is torchvision Faster R-CNN (MobileNetV3-FPN),
  76 MB, 1.6 s/sheet cached WASM, ~4 s first load. v2 (tiled YOLOX-nano
  honoring a `pxPerPt` tile contract) planned, not run.
- **Training data:** synthetic generator — 5 electrical symbol classes,
  14–42 symbols/sheet, 15–35 % parked on wall lines, isolated SESYD-style
  degradation, labels exact by construction; scales to thousands of
  sheets.
- **Dynamic Fill:** analytic bench 6/6 rooms, area error ≤ 0.51 %, IoU
  ≥ 0.9949. External benchmark sheet: area-pixel precision 0.9942 /
  **recall 0.0611** (~4 of 22 rooms bound) — the door/opening leak means
  most rooms never bound; our own auto-seed bench attempt failed for this
  reason alone (published as a negative result).
- **OCR:** tesseract.js, weak on rotated dimension text; planned
  PP-OCR-style det→cls→rec behind the same port.
- **External anchor (AEC-Geometric-Bench, areas track, click-assisted):**
  us instance F1 0.080; open-source peer opentakeoff 0.667 (assisted);
  bench owner's server pipeline 0.93. Precision ~1.0 — coverage is the
  entire gap.
- **Eval infra (built, unusual for a project this size):** run-log
  convention with pre-scoring input/output hashes, exact-polygon room
  scorer with self-tests, detector bench with per-miss attribution,
  committed baseline ratchet in CI, MCP conformance bench, perf bench.
  Anti-overfit rule: never tune on the external bench's sheets.
- **Trust axis:** pre-evals we scored ~2.5/5 vs opentakeoff's 5 in a
  market scan of published evidence; the evals suite was the response.

## What we asked reviewer 1 (the six problems)

1. Room-fill opening leaks (highest leverage; blocks everything).
2. Class-agnostic one-click counting — does the photo-pretrained-feature
   domain gap kill it on 1-bit line art?
3. Legend-as-supervision (per-drawing adaptation from the legend).
4. v2 detector: tiled YOLOX-nano, INT8 quantization surviving
   onnxruntime-web, ≤ 10 MB.
5. Bootstrapping a real-drawing golden set (20–30 sheets) without a pilot
  client — legal, privacy-safe sourcing.
6. Beating AEC-Geometric-Bench credibly (milestones: unassisted instance
   F1 ≥ 0.5, then 0.667; what would 0.93 take?).

## Reviewer 1's answer (the reframe)

It declined the six and argued: *don't make automation smarter, make
verification and correction nearly free.* Five points:

1. **Inspectable explanations** — every quantity carries its evidence
   (source sheet, boundary, calibration, bridged openings, review status);
   "why does this say 124.6 m²?" answered by the drawing.
2. **Seconds-to-repair** — failed fill highlights candidate escape paths;
   user draws a temporary barrier; instant retry; corrections reusable
   within the document. Counting gets positive + rejected-lookalike
   examples with live preview.
3. **Vector fingerprints for symbol search** — parse the PDF's original
   vector paths, fingerprint repeated symbol geometry; zero model, zero
   download; born-digital only; grouping robustness is the experiment.
4. **Revision re-review queue** — associate changes with measurement
   geometry so a revision produces "review these 4 things" instead of a
   full redo; changed calibration invalidates its page's quantities.
5. **Product scorecard** — time-to-reviewed-takeoff, corrections per 100
   symbols, errors after review; kept-rate is an acceptance signal, not
   accuracy.

It closed by proposing one bounded demonstration: a complete room workflow
(click → fill or repair → inspect → confirm → export with evidence)
validated on held-out real drawings.

## Our disposition of reviewer 1

**Reframe accepted, with two corrections.** Our evidence agrees with it —
everywhere we measure, precision ≈ 1.0 and *coverage* is the failure — and
it matches our stated north star (estimators buy time and trust: sign-off
with minimal correction).

Correction 1: **repair UX doesn't score on the benchmark.** The external
bench requires unassisted runs; human barriers are disallowed. So
opening-detection research stays a parallel track (bench), repair is the
product track — and they meet at the flywheel: every human-drawn barrier is
a labelled opening, i.e. the licence-clean training data the opening
detector needs.

Correction 2: **two foundations, not five features.** Points 1+2 need one
persistence mechanism (a per-markup sidecar record — never in PDF
annotation comments, that channel stays minimal); point 4 reuses the
existing compare / `run --prev` diff machinery.

Derived patches and sequence:

- **V1 measurement sidecar** (M, foundational) — per-markup record:
  method, calibration source, engine assumptions, review status, barriers.
- **V2 fill repair UX** (M, highest leverage) — leak-throat highlighting +
  temporary barriers, retained per document; barrier labels accumulate
  toward the opening detector; rejected-lookalike for counting.
- **V3 evidence in exports + MCP** (S) — evidence columns everywhere.
- **V4 revision re-review queue** (M–L) — change-region ∩ markup geometry,
  calibration invalidation, bias-to-flagging.
- **V5 vector-fingerprint spike** (S–M, timeboxed, kill test: frozen
  method, P/R/latency across several PDF producers, keep only if it beats
  the raster matcher).
- **V6 human-factors telemetry** (S) — already specced elsewhere;
  confirm-rate stays an upper-bound acceptance signal.

Sequence: V1+V2 → V3 → V4; V5 parallel; V6 with pilots. Checkpoint: the
room-workflow demonstration on held-out real drawings, published through
the run-log convention.

**Explicitly not adopted:** deprioritizing the six problems. The
class-agnostic matcher, legend supervision, the v2 quantized model and the
golden-set bootstrap remain open — reviewer 1 simply didn't answer them.

## The tensions we want you to adjudicate

1. **Verify-first vs research-first for the next month of a solo
   maintainer.** We chose V1+V2 first. Right call, or does the matcher /
   v2 model / golden set gate adoption more than repair UX does?
2. **Running two tracks (product repair UX + bench opening research) with
   one person.** Is the flywheel story (barriers → opening labels) real
   compounding, or a comforting reason to split focus?
3. **Which unanswered problem actually gates estimator adoption?** Rank:
   opening/fill coverage, class-agnostic counting, model size (76 MB),
   golden set / credibility, OCR quality, revision re-review.
4. **The sidecar/provenance foundation (V1):** trust differentiator that
   no competitor ships, or premature infrastructure before anyone depends
   on the basics?
5. **The browser-only constraint as moat:** does privacy + no-server
   permanently cap achievable quality vs server pipelines (0.93), and is
   "verifiable, correctable, private" the right hill — or should some
   optional server path be entertained (it currently cannot be, per
   constraints — so if you'd change the constraint, argue it explicitly
   rather than assuming it)?
6. **Adoption mechanics for a free tool with no marketing budget:** what
   actually gets an estimator to switch for one tender, and what single
   metric tells us within 30 days whether the direction is right?

## Required output

1. **Verdict on direction** — agree / disagree / modify, with the
   reasoning that would change our mind, not restatement of our own
   evidence.
2. **Where reviewer 1 was wrong, and where our disposition was wrong** —
   separately; at least one candidate each, or say explicitly you cannot
   find one and why.
3. **Your independent "move the needle" ranking** — top 5 actions across
   both lines, each with: why *now*, cost (S/M/L), and the failure mode
   if it's the wrong bet.
4. **A stop-doing list** — what we should cut or freeze, including
   anything we currently maintain that earns its keep only sentimentally.
5. **The 30-day leading indicator** — one measurable signal (we can
   instrument locally, zero telemetry) that discriminates between "this
   direction is working" and "it isn't," and when we should pivot.
6. **A 90-day sequence** honoring the constraints and solo capacity,
   ending in something demonstrable.

Rules: no literature surveys without a decision attached; fewer, committed
recommendations beat exhaustive option lists; every recommendation names
its kill criteria; if you have web access, verify factual claims before
relying on them, otherwise flag confidence.
