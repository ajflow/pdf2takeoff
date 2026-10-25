# Evals — the numbers, the method, the failures

We publish what our engine actually scores, how every number was produced,
and what we are still bad at. As far as we know (checked 2026-10-19 against
every serious open-source takeoff project — see
[docs/research/market-scan.md](../docs/research/market-scan.md) §7), no other
project in this category publishes an owned benchmark with committed results,
an external benchmark run, per-run environment stamps, and an improvement log
— and only one other publishes anything at all.

Everything below regenerates from this repository. Nothing requires a GPU,
an account, or our servers.

## Headline numbers

| What | Score | Context | Reproduce |
|---|---|---|---|
| **ScaledDrawingBench v0.1** (ours) — vector half, 980 questions | **99.8%** overall accuracy, 100% on scale/length/area/perimeter | born-digital PDFs with a text layer | `npm run bench:scaled -- generate && npm run bench:scaled -- reference --half vector` |
| **ScaledDrawingBench v0.1** — raster half, 968 questions | **37.3%** overall (was 23.0% ten commits earlier — see the improvement log) | 100 degraded scans: blur, speckle, photocopy, skew, contrast; no text layer; OCR is the only input | `npm run bench:scaled -- reference --half raster` |
| **ScaledDrawingBench** — hallucinations | **0 of 92** | questions that are unanswerable by design (NTS sheets): the engine abstained every time, never invented a number | scored as part of either half |
| **AECV-Bench** (external, public) — five-field mean exact match | **0.295** EM, **53.9%** mean MAPE | MAPE was 107.7% before the hatch-aware opening-detector round; best published VLM 0.543 EM / 15.3% MAPE | harness in `scripts/aecv-bench.mjs`; notes in [docs/research/benchmarks/aecv-bench.md](../docs/research/benchmarks/aecv-bench.md) |
| **AECV-Bench** — windows / spaces | **0.117 / 0.083** exact match, 52.4% / 89.6% MAPE | windows 184.5%→52.4% and spaces 221.4%→89.6% MAPE in one detector round (extended closing ladder + wall-network and exterior-facing gates); still below the best VLM EM | same |
| **AECV-Bench** — bedroom / toilet counts | **0.708 / 0.458** exact match | with a room-label dictionary + OCR and **no vision model at all**; published VLMs sit at 0.7–0.93 | same |
| **AEC-Geometric-Bench** (external, released scorer) — wall pixel F1 | **0.519** | frontier VLMs 0.18–0.29 on the identical 15 sheets; Kamai's purpose-built pipeline 0.931 | `scripts/aec-geometric-bench.mjs --bench <clone>`; notes in [docs/research/benchmarks/aec-geometric-bench.md](../docs/research/benchmarks/aec-geometric-bench.md) |
| **AEC-Geometric-Bench** — area pixel precision | **0.941** | when the engine claims a room it is one; recall 0.230 after the spaces-only half-thickness kernel (was 0.196) | same |
| **ResPlan room areas** (external, CC BY 4.0) — 200 real plans | **94.1%** of rooms recovered, median area error **−1.8%** | run log in [docs/research/benchmarks/room-area-datasets.md](../docs/research/benchmarks/room-area-datasets.md); ledger line pending the next scheduled run | `npm run bench:rooms` (downloads ResPlan) |
| **Internal takeoff bench** (in CI, every push) | **23/24** fill (1 documented open: diagonal door without a vector layer) · **2/2** count · **9/9** scale · **3/3** doorcheck | regression gate; a dropped case fails the build | `npm run bench` |
| **Scan latency / size** | **~100 ms** CV tier · **1.6 s** cached in-browser ONNX scan · **76 MB** model | in-browser (WASM), nothing uploaded | open the app, press `S`, click |

The full per-type tables (length, perimeter, dimension-read, revision
compare, MAPE over answered questions, per-notation breakdowns) live in
[bench/scaled-drawing-bench/results/](../bench/scaled-drawing-bench/results/)
and in the research notes under
[docs/research/benchmarks/](../docs/research/benchmarks/).

## Method

- **ScaledDrawingBench** is generated from a seed: every sheet, question and
  answer is exact by construction, and the generator, scorer and reference
  solver are all in this repo (Apache-2.0; the data is CC BY 4.0 — usable by
  anyone, including our competitors). Each run's manifest carries an
  environment stamp (node, pdfjs-dist, @napi-rs/canvas, tesseract.js)
  because raster scores are comparable only within one rendering stack; the
  vector half is pure geometry and reproduces byte-for-byte everywhere.
- **The reference solver is our own engine** — text-layer reading, OCR, the
  CV/ONNX scan tiers, Magic Fill for areas, the revision-diff path — with
  no model download and no network beyond a one-time OCR language pack.
  Answers are stripped from the questions before solving; the solver sees
  only the sheet's identity, never the key.
- **Every fast-bench run appends a line to
  [bench/results/ledger.jsonl](../bench/results/ledger.jsonl)** — commit,
  branch, node version, timings — so any number we quote can be traced to
  the commit that produced it.
- **CI gates correctness on every push**: a chain of ten behavioural checks
  (fill, detector, detector-in-Node, OCR, scale, vector, raster input, scan,
  openings, scaled-bench sample) plus the takeoff bench, the MCP smoke test,
  a PDF round-trip check and a revision-diff check. Several of those checks
  were born as regressions: they pin the exact bug they were written
  against.

## The improvement log

We treat the benchmark as a ratchet, and we publish the movement:

| Raster half of ScaledDrawingBench | intake | after the OCR/scale round |
|---|---|---|
| scale | 30.1% | **49.5%** |
| area | 21.7% | **40.4%** |
| perimeter | 24.7% | **43.0%** |
| count (exact) | 30.1% | **43.4%** |
| dimension read | 10.8% | **22.6%** |
| revision compare (set F1) | 36.5% | **66.7%** |
| **overall** | **23.0%** | **37.3%** |
| MAPE over answered | 38.7% | **12.9%** |
| hallucinations | 0/55 | **0/55** |

What moved it: the solver now OCRs through the product pipeline (windowed
reads, small-print 3–4× pass, Sauvola cleaning) instead of a single-pass
stand-in; degraded scale notes are repaired (dropped fraction slashes,
letter-for-digit slips, fused tokens) and gated to printed standards so
unrepairable damage abstains instead of answering wrong; the graphic scale
bar is read from a least-squares fit over consistent ticks. Full story in
[docs/research/benchmarks/drawing-vqa-benchmarks.md](../docs/research/benchmarks/drawing-vqa-benchmarks.md).

| AECV-Bench geometry fields | intake | after the hatch-aware detector round |
|---|---|---|
| window EM / MAPE | 0.092 / 184.5% | **0.117 / 52.4%** |
| space EM / MAPE | 0.058 / 221.4% | **0.083 / 89.6%** |
| door EM / MAPE | 0.117 / 72.9% | **0.108 / 63.6%** |
| five-field mean | 0.295 EM / 107.7% MAPE | **0.295 EM / 53.9% MAPE** |

What moved it: the raster opening detector learned hatched and double-line
walls — the closing ladder now climbs to cavity scale under two guards (a
closing may not multiply the enclosed cells of every smaller radius, nor
outgrow the unclosed mask), doors and windows must anchor to a band-like
wall component, windows must face the exterior (one side reaches the page
edge without crossing a room), and spaces must span 3% of the largest room.
Total absolute error over the three geometry fields fell from 5239 to 2228;
the ten worst plans went from 2247 to 568. Full story in
[docs/research/benchmarks/aecv-bench.md](../docs/research/benchmarks/aecv-bench.md), round 3.

## Published failures

The parts we are still bad at, so nobody has to find out the hard way:

- **Dimension-only sheets** (no scale note, scale derivable only from printed
  dimensions): 0/12 on the raster half — the dimension strings are destroyed
  by the worst degradation recipes before our OCR sees them.
- **Engineer-scale notes on photocopy/blur recipes**: mostly illegible at any
  OCR pass we run; ratio- and bar-notation sheets read at 17/21 and 16/19.
- **Raster count MAPE 18.8%** over answered counts — degraded symbol renders
  still confuse the template matcher.
- **AECV-Bench doors/windows/spaces**: 0.108/0.117/0.083 exact match against
  best-VLM 0.43/0.39/0.14 — the deterministic detector is at or above the VLM
  floor on spaces but far behind on doors; hatched CubiCasa scans still
  over-count texture as walls (worst ten plans are all that family).
- **AEC-Geometric-Bench**: object F1 0.031 (frontier-VLM range; doors
  over-fire on real drawings, fixtures not attempted — no click-free
  detector), area recall 0.239 behind the VLMs' 0.55–0.80. The full reading
  is in [docs/research/benchmarks/aec-geometric-bench.md](../docs/research/benchmarks/aec-geometric-bench.md).
- The scope limits of the benchmark itself are stated in
  [bench/scaled-drawing-bench/README.md](../bench/scaled-drawing-bench/README.md):
  the generator draws inside our design assumptions, and CI enforces 100% on
  the committed sample's vector half — the full 200-sheet set is where
  honest failures live.

## Licence, deliberately

The whole engine — including the benchmark generator, scorer and reference
solver — is Apache-2.0. To our knowledge that makes pdf2takeoff the only
permissively licensed takeoff engine in a field of AGPL competitors, and the
benchmark itself (CC BY 4.0) usable by anyone, including to beat us. If you
score higher on ScaledDrawingBench, open a PR with your predictions file and
we will link it here.
