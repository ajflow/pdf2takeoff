# Super prompt: frontier research collaborator for pdf2takeoff

> **Archived 2026-10-24.** Historical record of the first reviewer ask. Its
> numbers are from 2026-10-19, before the opening patch and the spaces
> pass. Reviewer 1's answer is dispositioned in
> [verify-first-plan.md](verify-first-plan.md). Do not send this prompt
> again; the current second-opinion prompt is
> [frontier-model-prompt-4.md](frontier-model-prompt-4.md).

Paste everything below this line into the model. It is self-contained — no
repo access needed. For deeper answers, run each "Problem N" section as its
own conversation afterwards; optionally attach
`docs/research/ai-literature-review.md` and
`evals/runs/2026-10-19-aecgb-b6c/RESULT.md` (on the
`bench/b1-b8-opening-patch` branch only) to that thread.

---

You are acting as a senior research scientist and systems engineer
collaborating with a small team building an open-source construction-takeoff
tool. Your job is to propose concrete, implementable breakthroughs on the
problems below — not a literature survey. Commit to recommendations, rank
them, and disagree with our assumptions where the evidence warrants. You will
be judged on three things: **concreteness** (algorithms and pseudocode we can
implement this month), **constraint discipline** (see the hard constraints —
a proposal violating any of them is dead on arrival, don't waste our time),
and **falsifiability** (every proposal names the cheap experiment that would
kill it fast). If you have web access, verify claims about papers and
benchmarks before citing them; if not, flag your confidence level.

## The product

**pdf2takeoff** (Apache-2.0): PDF construction drawings in, measured
quantities out, 100% in the browser — nothing is ever uploaded (privacy is
the product: confidential tender documents). PDF.js renders; pdf-lib writes
markups back into the PDF as standard annotations that round-trip through
Bluebeam/Acrobat. Tools: length/area/count/volume/angle takeoff, scale
calibration (incl. multi-scale viewports), revision compare (pixel blend),
and an agent path — the same engine runs headless in Node as a CLI and a
local MCP server (12 tools) so an AI agent can run a whole takeoff with
deterministic tools and hand a marked-up PDF to a human.

The auto-count stack ("press S, click one symbol, count them all"):

- **Tier 1 (always present, zero download):** classical CV — rasterize,
  binarize, connected components, shape matching. ~44 ms/sheet.
- **Tier 2 (lazy, drop-in):** ONNX detector via onnxruntime-web (WASM),
  page-wide or tiled per a manifest tile contract; automatic fallback to
  tier 1.
- **Dynamic Fill:** click inside a room → flood fill + boundary trace →
  area. Escalating morphological closing for door gaps; escalating ink
  threshold (150→185→220) for light linework.

**The architecture rule (evidence-backed, do not challenge it):** every
number — dimension, scale, count, area — comes from deterministic code.
Three 2026 VLM benchmarks (DrawingVQA, ArchPlanVQA, FloorplanQA) plus MIT's
Picard study show frontier VLMs misreport drawing numbers. LLMs may plan and
parse semantics; they never measure.

## Hard constraints (all proposals must satisfy all of these)

1. **Client-side only.** Everything runs in the browser: WASM
   (onnxruntime-web), optionally WebGPU as progressive enhancement with WASM
   fallback. No server-side GPU inference, no uploads, no accounts, works
   offline after first load. A Node headless twin shares the engine code.
2. **Licence-clean.** Repo is Apache-2.0. No AGPL code (Ultralytics YOLO is
   explicitly excluded). Datasets under CC BY-NC (FloorPlanCAD, CubiCasa5k,
   AEC-Geometric-Bench sheets) may be used for *evaluation/research only* —
   shipped model weights may train only on our own synthetic data
   (Apache-2.0, generator is seeded and reproducible) and client-consented
   data.
3. **Free static hosting.** Cloudflare Pages free tier; the site must stay
   static-only. No backend compute anywhere.
4. **Size/latency budgets.** Tier-1 stays ~100 ms. Any new model must be
   lazy-loaded and small (target ≤ 40 MB; the current 76 MB tier-2 model is
   the outlier we want dead). Interactive operations stay sub-second.
5. **Determinism** for all measurement outputs (same input → same number).

## Where we are (evidence, October 2026)

- **Tier-1 scan:** precision 1.000, recall 0.249 clean / 0.179 degraded on
  our deliberately hostile synthetic bench (thin strokes, wall-parked
  symbols, scan artifacts). Miss attribution says the losses are: signature
  gate, wall-merges (symbol's connected component fuses with wall network),
  degradation. On home-turf rasters it's near-perfect (8/8 on the sample).
- **Tier-2 detector:** shipped v1 is a torchvision Faster R-CNN
  (MobileNetV3-FPN), 76 MB, 1.6 s/sheet cached WASM, ~4 s first load. The
  planned v2 is a tiled YOLOX-nano honoring a tile contract (`pxPerPt` must
  match training-time effective resolution — v1 declared 1.875, v2's 416 px
  input on 1280×905 sheets makes it ~0.98; a mismatch here silently kills
  recall).
- **Training data:** synthetic generator, 5 symbol classes (downlight, gpo,
  switch, smoke-alarm, diffuser), 14–42 symbols/sheet, 15–35 % parked on
  wall lines, SESYD-style degradation (blur, speckle, contrast/gamma,
  ±0.6° rotation, photocopy — never stacked), labels exact by construction.
  200 sheets ≈ 5,500 instances; scales to thousands. A FloorPlanCAD
  converter exists (research-only weights).
- **Dynamic Fill:** on our analytic room sheet, 6/6 rooms, area error
  ≤ 0.51 %, IoU ≥ 0.9949, boundary ≤ 0.71 pt, 46 ms/room. On the external
  benchmark sheet: area-pixel precision 0.9942 but **recall 0.0611** — only
  ~4 of 22 rooms bound. Accuracy is solved; coverage is the failure.
  Gap-bridging ceiling is 88 px vs 300-dpi imperial door openings.
- **OCR:** tesseract.js (~4 MB lang pack), weak on rotated dimension text.
  Planned: PP-OCR-style det→direction-cls→rec pipeline behind the same
  `OcrWord[]` port. We know the clicked segment's angle, so crops can be
  pre-rotated deterministically. Born-digital PDFs already get exact text
  via the PDF text layer (the MCP `read_text` tool).
- **Eval infra (already built):** run-log convention with input/output
  hashing before scoring, exact-polygon room scorer with self-tests,
  detector bench with per-miss attribution, committed baseline ratchet in
  CI, MCP conformance bench, perf bench. We can measure anything you
  propose, cheaply and reproducibly.

## Problem 1 — highest leverage: room-fill opening leaks

Doors/wide gaps leak the flood fill, so most rooms on real sheets never
bound. Our own auto-seed benchmark attempt failed for this reason alone
(published as a negative result): **no seed placement can help when no room
bounds at all.** Everything downstream (credible auto-fill, unassisted
benchmark runs) is gated on this.

Current mechanics: flood fill against a binarized ink mask; escalating
morphological closing (GapLadder, 88 px ceiling); ink-threshold escalation
for grey lines; topology check that returns "not bounded" rather than a
wrong area.

Stress-test these avenues and rank them (or replace them):

- **(a) Vector-layer parsing for born-digital PDFs.** Content streams
  contain exact path geometry — door swings are literally arcs. Parse the
  vector layer to get exact wall/opening geometry with zero ML, pixels only
  as fallback for scans. Questions: robustness across CAD-to-PDF producers,
  hatches/fills, embedded rasters, clipping paths; how to reconcile vector
  coordinates with the raster frame we measure in.
- **(b) A tiny opening-class detector** trained on our licence-clean
  synthetic door-gap data, gating the fill (DeepFloorplan's
  doors-as-boundary-class finding). How small can it be and still help?
- **(c) Leak backtracking, no new model:** when a fill exceeds the
  max-fraction, analyze the filled region to find leak throats (narrow
  necks — distance transform / morphological analysis), close only those,
  retry. Plus topology validation (Ahmed 2012) and similarity-ordered
  region growing (Adams & Bischof 1994).
- **(d) The lightest credible wall-reconstruction** (HEAT-like planar-graph
  prediction) — is there a browser-feasible version at all?

## Problem 2 — class-agnostic one-click counting (tier 3)

Biggest functional gap: tier-2 only knows 5 trained classes, but every
firm's symbol library differs. The literature says frozen foundation
features + prototype matching detect novel classes with no retraining
(DE-ViT/DINOv2, LOCA, FamNet). **The open research question: foundation
features are trained on natural photos; our domain is 1-bit monochrome
line art.** The one close-domain datapoint (one-shot detection in manga,
ACM MM Asia 2024) needed feature-space augmentation of the exemplar to
bridge exactly this gap.

Evaluate: frozen DINOv2 patch-grid + cosine matching (does the domain gap
kill it on line art?); a small self-supervised encoder pre-trained on our
synthetic line art; SiamFC-style correlation; LOCA-style iterative
prototype adaptation; hybrid designs (tier-1 connected components as
proposal generator + embedding classifier). Budget: ≤ 40 MB lazy, ≤ 1
s/sheet on WASM, page feature grid computed once and cached per page.

## Problem 3 — legend-as-supervision (the zero-click S-key)

Each drawing's legend is free labels: symbol glyphs paired with text tags.
A per-drawing adaptation step (legend region detection → symbol/text
pairing by proximity and alignment → prototypes feeding the Problem-2
matcher) would propose the symbol palette *before* any click, and adapt to
each firm's blocks with zero manual annotation (pattern validated at
research scale: Hain et al., ECML PKDD 2025). Design the concrete recipe
and its kill test (e.g. on 10 real sheets, recover ≥ N prototypes at
precision ≥ X).

## Problem 4 — the v2 detector: smaller, tiled, quantized

The 76 MB v1 download is the dominant cost of tier-2. Design the v2: tiled
YOLOX-nano honoring the `pxPerPt` tile contract, INT8 quantization that
survives onnxruntime-web WASM (which quantization toolchain actually
round-trips?), pruning/distillation using the generator as an unlimited
unlabeled pool, WebGPU cost/benefit. Target ≤ 10 MB and ≤ 1 s/sheet
cached. Also: given our miss-attribution data (signature gate, wall
merges, degradation), what's the cheapest tier-1 gate fix worth trying
first?

## Problem 5 — bootstrapping a real-drawing golden set

Our evaluation design is built; the missing artifact is 20–30 real
annotated sheets (≥ 300 symbol instances, ≥ 2 disciplines, each with a
human ground-truth takeoff). Planned source is "first pilot client" —
chicken and egg. Propose legal, privacy-safe sourcing: municipal permit
open-data portals, public tender archives that publish drawings,
CC-licensed plan collections, redrawing real plans as lookalikes — with a
licence analysis for each, and how they'd survive being published as
benchmark references.

## Problem 6 — beating AEC-Geometric-Bench credibly

External anchor benchmark (Kamai's; scorer Apache-2.0 used clone-alongside,
data CC BY-NC — we may evaluate on it, never train on it, predictions are
ours to publish). Tracks: objects (boxes), areas (room polygons), walls.
Sheet_02 has 22 rooms. Scored in a manifest px frame (≈ PDF pt × 2.78).

Current state and peers on the areas track:

- **Us, click-assisted, default settings:** area-pixel precision 0.9942 /
  recall 0.0611 / pixel F1 0.1151; area-instance F1 0.080 (~4/22 rooms).
- **opentakeoff (open-source peer), tool-assisted first pass:**
  instance F1 0.667 (pixel 0.887).
- **Kamai's own server pipeline:** 0.93.

Coverage is the entire gap (precision is already ~1.0), so the question is
*how to bound all 22 rooms*. Evaluate these levers and design the cheapest
credible path:

1. **Opening-leak fix** (Problem 1) — the precondition for everything.
2. **Auto-seeding from the text layer:** room labels ("BEDROOM 12.4 m²")
   are text inside rooms — label centroids are free fill seeds on
   born-digital sheets. Does sheet_02 (or the bench generally) carry usable
   room-label text?
3. **Printed-area harvest:** many architectural sheets print each room's
   area as text. Reading it (text layer first, OCR fallback) and
   cross-validating against the geometric fill (scale from title block;
   flag mismatches) could jump area accuracy where printed, and
   *audit* the fill everywhere else — also a product feature. Assess the
   risk: printed areas can be stale/wrong/from another revision.
4. **Walls track:** we currently emit `[]` and score an honest 0. Vector
   -layer parsing (Problem 1a) could emit real wall centerlines/faces on
   born-digital sheets — is that a cheap win?
5. **Objects track:** currently skipped (class mismatch vs our electrical
   classes). Does the Problem-2 class-agnostic matcher make it enterable?
6. **Coverage-maximizing cascade:** per room, try fill → printed-area
   cross-check → wall-vector inference, gated so precision never drops.
   Design the gating.

**Anti-overfit discipline (non-negotiable):** we never tune on the bench's
test sheets — tuning happens on our own synthetic/golden sets, the bench is
only the anchor; every published number carries a run log with frozen
hashes and caveat lines. Propose nothing that requires overfitting to
their sheets.

Milestones to plan against: unassisted area-instance F1 ≥ 0.5; then beat
opentakeoff's 0.667; state honestly what it would take to reach 0.93
(server-class pipelines included) and whether it's even compatible with
our constraints.

## What NOT to propose

- A VLM/LLM in the measurement path (reading numbers off rendered images).
  Orchestration-only, ever.
- Server-side GPU inference, uploads, accounts, telemetry.
- AGPL dependencies (Ultralytics included) or shipped weights trained on
  CC BY-NC data.
- "Train a big model on FloorPlanCAD/CubiCasa5k" — research checkpoints
  only; anything shipped trains on our synthetic + client-consented data.

## Required output format

For each problem (1–6), give ranked proposals. For each proposal:

- **Mechanism** — what it actually does, at algorithm level (pseudocode
  welcome)
- **Why it fits the evidence** — which of our numbers/failure modes it
  attacks
- **Data/training needs** — and their licence status
- **Constraint check** — browser/WASM, size, latency, licence, determinism
- **Eval plan** — against our existing metrics (count error, instance P/R
  at centre-distance, area % deviation, IoU, boundary pt, exact-match for
  text/scale reads), which slices (scan vs born-digital, A3 vs A0, etc.)
- **Effort** — S ≤ 1 day, M = a few days, L = a week+
- **Kill criteria** — the cheapest experiment that falsifies it

Then finish with exactly two lists:

1. **Three ideas we haven't considered at all** (the breakthrough asks).
2. **Three assumptions we hold that you'd bet are wrong**, and why.

Prefer fewer, committed recommendations over exhaustive option lists. If
you think one of our six framings is wrong, say so first and propose the
reframe.
