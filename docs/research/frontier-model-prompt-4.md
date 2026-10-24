# Super prompt 4: second-opinion review of pdf2takeoff direction (refreshed)

Replaces prompt 2, whose evidence went stale within a day. Paste everything
below the line into the second model. It is self-contained. Before sending,
fill in the one `[MAINTAINER: ...]` line. For depth, run each tension as its
own follow-up thread; optional attachments that exist on `main`:
`evals/README.md` (headline numbers and published failures),
`docs/research/room-partition-design-review.md` (the current room-split
design) and `docs/research/market-scan.md` (competitor field).

---

You are the **second independent reviewer** of a direction decision. A first
frontier model reviewed this project and proposed a strategy; the team
dispositioned it; then the team built something else. Your value is
**independent judgement**: disagree with the first reviewer, with the team,
or with both, wherever the evidence supports it. Disagreement must be
evidenced, not performed. Equally, state explicitly where you agree and why
that agreement is not obvious. You are judged on: **independence**,
**concreteness** (recommendations a solo maintainer can start this week),
and **constraint discipline** (proposals violating the constraints below are
dead unless you argue for changing the constraint itself, explicitly).

## The product

**pdf2takeoff** (Apache-2.0, free, no account): construction PDF drawings
in, measured quantities out. The browser app runs 100% client-side and
never uploads a drawing (privacy is the product: confidential tender
documents). PDF.js renders; pdf-lib writes markups back into the PDF as
standard annotations that round-trip through Bluebeam/Acrobat. Tools:
length/area/perimeter/count/volume/angle takeoff, scale calibration incl.
multi-scale viewports, OCR dimension/scale auto-read, Dynamic Fill (click a
room, get its area), revision compare, printable reports, CSV/xlsx export.
The same engine runs headless in Node as a CLI and a local MCP server, so an
AI agent can run a takeoff with deterministic tools and hand a marked-up PDF
to a human. It installs today with `npx github:ajflow/pdf2takeoff`; an npm
package is built but not yet published.

Auto-count stack: **tier 1** classical CV (connected components + shape
matching, ~100 ms, zero download) and **tier 2** lazy ONNX detector
(onnxruntime-web WASM, five electrical classes, 76 MB, 1.6 s cached),
falling back to tier 1. Every automatic hit lands as a flagged proposal the
user confirms or deletes; a per-label kept-rate shows how often the tool
was right on this user's symbols.

**Architecture rule, as practised:** models may propose; deterministic code
measures; a person reviews every proposal. Every length, area and scale
comes from deterministic code, because 2026 VLM benchmarks show frontier
models misreport drawing numbers. The one place a model now produces counts
is the **opt-in AI count** (CLI only, not the browser app): the user brings
their own key via environment variable for OpenRouter, OpenAI, Gemini or
Z.ai, or points it at a local Ollama/LM Studio server so nothing leaves the
machine. The model inventories doors, windows and spaces; its answers come
back as flagged count markups through the same review flow as scan hits.
This rule is open to challenge; tension 2 asks you to.

**Business reality:** solo maintainer plus occasional outside contributors,
free static hosting (Cloudflare Pages free tier), free Kaggle GPUs for
training, no budget. Success = estimator adoption and a contributor
community; revenue is adjacent consulting (the site now presents it as
"pdf2takeoff by Flowtivity"). Every patch competes for the same weekends.
Effort is sized S (1 day or less) / M (a few days) / L (a week or more).

## Constraints (all bind unless you argue to change one)

1. Browser app is client-side only: WASM (WebGPU optional), no server
   inference, no uploads, works offline. Node headless twin shares the
   engine.
2. Licence-clean: Apache-2.0; no AGPL (no Ultralytics); shipped weights
   train only on own seeded synthetic data plus client-consented data; CC
   BY-NC datasets are evaluation/research only.
3. Static-only deploy, free tier, no backend compute.
4. New models 40 MB or less, lazy-loaded (the 76 MB tier-2 model is the
   outlier); interactive ops sub-second.
5. Deterministic measurement outputs.
6. Zero telemetry in the product.

## Where we are (evidence, 24 October 2026)

All numbers below are committed in the repo with reproduce commands.

- **ScaledDrawingBench v0.1** (ours, seeded, CC BY 4.0): 99.8% on the
  born-digital vector half (980 questions); 37.3% on the degraded-scan
  raster half (968 questions; was 23.0% at intake); 0 hallucinations on 92
  unanswerable-by-design questions.
- **AEC-Geometric-Bench** (external, released scorer, 15 sheets): wall
  pixel F1 **0.519**, about 1.8x the best frontier VLM (0.18 to 0.29);
  Kamai's purpose-built pipeline scores 0.931. Area pixel precision 0.94
  but area recall only about 0.23, against the VLMs' 0.55 to 0.80. Object
  F1 0.031 (doors over-fire, fixtures not attempted).
- **Rooms on the bench's sheet_02** (22 rooms; instance F1 is the score):
  an unassisted auto-seed sweep at an earlier commit reached area-pixel F1
  0.882 but instance F1 only **0.295** (9 TP / 30 FP / 13 FN). A design
  review then found 12 of the 28 submitted rings were invalid polygons; the
  scorer's repair split them into extra components, inflating the FP count.
  That geometry defect is now fixed. Verified peers on the same sheet and
  scorer: OpenTakeoff **0.667** (tool-assisted, not unassisted), Kamai
  **0.829** (its 0.931 is the corpus-wide figure, not this sheet). Most
  false positives are believed to be regions that run through a doorway and
  merge two rooms. A **room-partition pass** (wall-supported doorway strips,
  then relabelling, with an explicit "unresolved" result instead of risky
  splits) is being built now; its outcome is pending. Do not propose it as
  new; do critique it.
- **AECV-Bench** (external, 120 raster plans, counting task): deterministic
  engine with no vision model scores **0.295** five-field exact match
  (best published VLM 0.543); room-label counts from OCR alone reach 0.708
  bedrooms. With the opt-in AI count on GPT-6.1 Sol: **0.585**, against
  0.572 for the same model on the benchmark's own prompt, so most of that
  gain is the model, not our prompt.
- **ResPlan** (external, CC BY 4.0, 200 real vector plans): 94.1% of rooms
  recovered, median area error -1.8%.
- **Shipped in the last five days:** the opt-in AI count; inventory items
  and counting presets (`propose_items` / `count_items` MCP tools); a
  compiled CLI and MCP server installable with npx; six performance fixes
  with identical outputs; an outside contributor's legend-guided takeoff
  experiment with a real-PDF review and pricing workspace (under
  `experiments/`, not in the core app); a redesigned site with trade pages.
- **Eval infra:** run logs with pre-scoring hashes, an exact-polygon room
  scorer, a detector bench with per-miss attribution, a CI baseline ratchet
  on every push, published failures. In a market scan of published evidence
  we scored 2.5/5 on trust against OpenTakeoff's 5 before this suite
  existed.
- **Users:** [MAINTAINER: fill in what any estimator has said or done with
  it; if none, write 'no estimator has used it on a live tender yet']

## What reviewer 1 said, and what we decided

Reviewer 1 declined our six research problems (opening leaks,
class-agnostic counting, legend supervision, a small quantized detector, a
real-drawing golden set, beating AEC-Geometric-Bench) and reframed: *don't
make automation smarter, make verification and correction nearly free.*
Five points: every quantity carries inspectable evidence; seconds-to-repair
for failed fills (highlight the leak, user draws a temporary barrier) and
rejected-lookalike examples for counting; vector fingerprints for symbol
search; a revision re-review queue; a product scorecard
(time-to-reviewed-takeoff, corrections per 100 symbols).

**Our disposition: reframe accepted, with two corrections.** (1) Repair UX
cannot score on the benchmark, which requires unassisted runs, so opening
research stays a parallel track; the two meet at a "flywheel" where every
human-drawn barrier is a labelled opening, i.e. free training data. (2) The
five points reduce to two foundations: a per-markup **sidecar** record (V1)
and the existing revision-diff machinery. The plan sequenced **V1 sidecar
plus V2 fill-repair UX first**, then evidence in exports, then the re-review
queue, with a timeboxed vector-fingerprint spike in parallel.

**What actually happened:** neither V1 nor V2 was built. The following five
days went to the AI count, presets, npx packaging, performance, the legend
experiment and the site. The bench track moved too: the polygon-validity
fix and the partition design.

**A conflict we have not resolved:** the flywheel assumes barriers become
training data, but under zero telemetry they never leave the user's
machine. They only become data if a user explicitly exports and shares a
correction. As stated, the flywheel does not turn.

## The three tensions to adjudicate

1. **Priority drift.** We planned verify-first (V1 + V2) and built other
   things. Was that drift away from the right plan, or did the work reveal
   a better priority (the room score, agent-facing tools, distribution)?
   What should the next month be, and is the sidecar a trust
   differentiator or infrastructure nobody yet depends on? Do not assume
   either answer.
2. **The AI count, privacy and the server line.** The product promise is
   "nothing uploaded", and the browser app keeps it. The CLI now offers an
   opt-in path that sends page images to a cloud model with the user's own
   key, and it scored roughly double our deterministic engine on AECV-Bench.
   Is this a clean extension of "models propose, code measures, people
   review", or the start of quietly abandoning the privacy moat? Should it
   reach the browser app, stay CLI-only, or go? Does browser-only
   permanently cap quality against server pipelines like Kamai's, and if
   you would change constraint 1 or 6, argue it explicitly.
3. **Adoption.** What gets an estimator to use this on one real tender,
   and which single signal tells us within 30 days whether the direction
   works? Product telemetry is off the table, and local-only measurement
   tells us about one person, so name a signal from what we can see in
   aggregate: npm downloads once published, GitHub traffic and clones,
   cookie-free page analytics on the static site, MCP/CLI installs, or
   named pilot conversations. Say what threshold means pivot.

## Required output

1. **Verdict on direction:** agree / disagree / modify, with the evidence
   that would change your mind, not a restatement of ours. Include a short
   list of where you agree with us and with reviewer 1.
2. **Where reviewer 1 was wrong, and where our disposition was wrong,**
   separately; at least one candidate each, or say explicitly that you
   cannot find one and why.
3. **Your ruling on each of the three tensions,** with one recommended
   action per tension: why now, cost (S/M/L), kill criteria, and the
   failure mode if it is the wrong bet.
4. **A stop-doing list:** what to cut or freeze, including anything we
   maintain that earns its keep only sentimentally.
5. **A 90-day sequence** for one person, honouring the constraints, ending
   in something demonstrable, with the 30-day checkpoint from tension 3
   placed in it.

Rules: no literature surveys without a decision attached; fewer, committed
recommendations beat option lists; every recommendation names its kill
criteria; if you have web access, verify factual claims before relying on
them, otherwise flag confidence.
