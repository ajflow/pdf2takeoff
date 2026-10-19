---
title: "We Benchmarked Our Takeoff Engine. It Scored 23 Percent."
draft: true
date: 2026-10-19
author: "AJ Wawan"
tags: [pdf2takeoff, benchmarks, construction-tech, open-source, ocr]
---

# We Benchmarked Our Takeoff Engine. It Scored 23 Percent.

Last week we did something most tools in our category avoid: we built a
benchmark for the thing we claim to do, ran our engine against it, and
published the number. On born-digital drawings the engine scored 99.8
percent. On degraded scans — blurred, speckled, photocopied, skewed, no text
layer, OCR as the only input — it scored **23 percent**.

We shipped that number. Then we spent a day fixing the biggest reason for
it, re-ran the same benchmark from the same seed, and got it to **37.3
percent** — with the hallucination count still at zero. This post is how,
and why we think publishing this stuff is the right kind of marketing.

## The benchmark: ScaledDrawingBench

We surveyed what exists first (that survey is
[here](../docs/research/benchmarks/README.md), with per-benchmark notes) and
found nothing public that asks what a takeoff tool is actually for: *read
the scale off a drawing, then measure real quantities.* So we generated one.
200 sheets from a seed — A3/A1/ARCH D, five scale notations (ratio,
architectural, engineer, graphic scale bar, dimensions-only), one degradation
recipe per raster sheet, revision B for every tenth sheet — and 2,040
questions with exact answers by construction: the scale, wall lengths, room
areas and perimeters, symbol counts, printed dimensions, what changed
between revisions.

About one sheet in fifteen says `SCALE: NTS` and prints nothing measurable.
Those questions are unanswerable by design, and answering them is scored as
hallucination. This is the number we watch most closely, because a takeoff
tool that invents quantities is worse than one that abstains.

The whole thing — generator, scorer, and a reference solver built on our own
engine — is in the repo, Apache-2.0 like the rest of pdf2takeoff, and the
data is CC BY 4.0. Anyone can run it, including our competitors, including
to beat us. If you do, send the predictions file and we'll link it.

## Where 23 percent actually was

The aggregate hid a clean structure. On the 100 degraded sheets:

- Sheets whose scale note survived OCR: measured fine downstream. Everything
  else gated behind the scale — no scale, no length, no area, no perimeter.
  The solver abstains rather than guess (that's where the zero-hallucination
  number comes from, and it costs accuracy points every time).
- Imperial notes were the worst kind of failure: `1/4" = 1'-0"` scanned with
  the fraction slash dropped reads as `14" = 1'0"` — which still parses as a
  scale, just a nonsense one (1:0.86). The engine wasn't abstaining on those;
  it was confidently wrong.
- Engineer notes (`1" = 20'`) failed outright on letter-for-digit OCR slips
  (`2O'` for `20'`).
- Graphic scale bars were read from the two farthest-apart number pairs —
  which a stray dimension string nearby could fake.

## What fixed it

Four changes, each born from looking at what the OCR actually produced on
the failing sheets (the cache stores the raw words; we read them):

1. **The benchmark now uses the product's OCR, not a stand-in.** The solver
   had been using a simplified single-pass reader while the real product
   pipeline — windowed reads, a 3–4× second pass on small print, Sauvola
   cleaning — sat unused. Wiring it in took the title blocks from shattered
   fragments to readable text. (Embarrassing that the benchmark measured the
   wrong thing; that's exactly why you publish method.)
2. **Damage repair, gated to reality.** Dropped fraction slashes are mended
   (`14"` → `1/4"`), digit slips are repaired (`2O'` → `20'`), whole notes
   fused into one token are split again (`"=10` → `1" = 10'`). But every
   imperial or engineer vote must now land within 2.5 percent of a scale
   anybody actually prints. If the repair can't reach a real scale, the
   engine abstains. This is why wrong answers collapsed: mean absolute error
   over the questions we do answer fell from 38.7 to 12.9 percent.
3. **Scale bars from a least-squares fit** over three or more consistent
   ticks, which a stray number can't fake.
4. **A re-read of the note beside any surviving `SCALE:` keyword** at 4× with
   single-line segmentation — the right half of the equation is the smallest
   print in a title block and the first thing a bad scan destroys.

Net, on the same 100 sheets: scale 30.1 → 49.5%, area 21.7 → 40.4%,
perimeter 24.7 → 43.0%, counts exact 30.1 → 43.4%, revision-compare F1
36.5 → 66.7%. Hallucinations: 0 before, 0 after.

## What's still broken (the list we work from)

- Dimensions-only sheets — no scale note anywhere, scale derivable only from
  printed dimensions — score zero: the worst recipes destroy the dimension
  strings before OCR sees them.
- Engineer notes on photocopy and blur recipes: illegible at any pass we run.
- Count MAPE on degraded symbol renders is 18.8 percent.
- On the external AECV-Bench, our doors/windows counts are bad (0.117/0.092
  exact match) — the raster opening detector exists but isn't wired into
  that harness yet.

Each of those is a real work item with a number attached, and every one of
them is in [evals/README.md](../../evals/README.md) with the reproduction
command next to it.

## Why publish this

Because "trust me, it's accurate" is what every takeoff tool says, and the
field's serious entrants have converged on the same conclusion we did:
demonstrate it. The full disclosure — per-type tables, environment stamps,
run ledger, CI gates, the improvement log — lives in
[evals/](../../evals/README.md) and regenerates with one command per table.
The benchmark is free to reuse. If your engine beats ours on it, that number
is yours and we'll say so.

We also ran someone else's. AEC-Geometric-Bench (KamaiEnterprises, MIT)
releases fifteen construction sheets with ground truth and a scorer, and
publishes six systems on them — a purpose-built production pipeline and five
frontier vision-language models. We pointed our click-free deterministic
engine at it: no model, no clicks, no training against their data, ~23
seconds a sheet on a laptop CPU. Walls: **0.519 pixel F1 — more than double
every frontier VLM** on the identical sheets (they score 0.18–0.29). Areas:
0.943 precision, second only to the production pipeline. Objects: 0.031 —
statistically tied with the best VLM, and we say exactly why (our door
classifier over-fires on real drawings; we don't attempt fixtures at all).
That's the whole story of this post in one table: classical CV where it's
strong, honest zeros where it isn't.

A takeoff tool that shows its work. That's the pitch.

## Epilogue: the part where the benchmark kept us honest twice more

Two more things happened before this post shipped, and both belong in it.

First, the evals became the gate. Every claim above now runs in CI on every
push — the ten behavioural checks, the takeoff bench, the MCP smoke test —
and the gate caught *us* twice in one day: two assertions asserted exact
OCR output of rendered pixels, which shifts with the platform's raster
library. On one Linux builder `W.C.` read `W.C` at confidence 74 — which our
two-letter floor correctly excludes — and on another the same code read
digits only, no letters at all. The pins now assert the semantics (BATH is a
toilet, LAVATORY never is, no third toilet invented) and skip with a visible
notice where a builder's OCR cannot read, instead of gating a deploy on a
container that can't. That's the evals mindset turning inward: the tests
themselves are claims, and claims get method.

Second, the benchmark branch had to merge with a parallel Dynamic Fill
rewrite that shipped meanwhile — two engines that solved the same doorway
problems differently. The merged suite (both sides' tests, unioned) is what
runs in CI today: 23 of 24 fill cases, with the one open case — a diagonal
door with no vector layer to help — documented in the bench output itself.
When you run `npm run bench` and see that `known` line, that's not a failure
hiding. That's the list we work from.
