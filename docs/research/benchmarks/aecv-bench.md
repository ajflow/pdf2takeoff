# AECV-Bench: can pdf2takeoff be evaluated on it?

Research note, 2026-10-18. Tags: [verified: I saw it] means I inspected the file, code, page or output myself in this session; [reported: ...] means the claim comes from the paper, the site, a blog or a search snippet that I could not open directly (arxiv.org, aecv-bench.com and aecfoundry.com are blocked by this session's egress proxy).

## Summary

- AECV-Bench (AECFoundry, arXiv 2601.04819, Jan 2026) has two parts: object counting on 120 raster floor-plan images (doors, windows, spaces, bedrooms, toilets, one integer each per plan) and 192 free-text QA pairs over 21 drawing images, judged by GPT-4o. [verified]
- The whole dataset ships inside the public GitHub repo (114 MB clone, no gating); it cloned fine and I inspected it. The code and data carry no licence at all (open issue #1 since 2026-08-02 asks for one), and most plans derive from CubiCasa5K (CC BY-NC 4.0), so a commercial or Apache-2.0 project can run it privately and report numbers, but should not redistribute the images. [verified]
- Scoring is exact match per field and MAPE per field, averaged over the five fields including "Space" (the README lists four). Best published mean exact match is 0.54 (Gemini 3.5 Flash, Aug 2026 run); doors and windows sit at 0.39 or below for every model. [verified from the repo's own CSVs and heatmaps]
- pdf2takeoff can target the counting task only; the QA task is a language task. The headless engine accepts PDFs only and its Node raster path segfaults on image-only PDFs, while the CV scan fed the PNG directly rejects door-arc clicks (arcs are fused to walls) and found 1 of 2 toilets on one sample. [verified]
- Effort for a publishable run: about 2 to 4 weeks, dominated by (a) a raster input path, (b) a door/window detector or vector-free opening detection, and (c) OCR for room labels. Without those, pdf2takeoff would score well below the VLMs on this benchmark.

## What it measures

Two "use cases", both single-image, no PDF, no scale, no measurement. [verified: repo README and code]

1. Object counting (Use Case 1). One image per plan; the model returns a JSON object with five integers: `Door`, `Window`, `Space`, `Bedroom`, `Toilet`. The ground truth follows written counting rules that are also given to the model in the prompt (`src/analyzers/prompts.py`) [verified]:
   - Doors: only swing doors drawn with an arc; each leaf counts (double leaf = 2); sliding closet doors, pantry sliders and garage entrances are not doors.
   - Windows: all sliding openings and French doors count as windows; adjacent window units without a gap count as one window group; tiny toilet windows count.
   - Spaces: every enclosed space, labelled or not; WC next to Bath counts as two.
   - Bedrooms: any space labelled Bedroom, Chambre, Zimmer, Camera or equivalent.
   - Toilets: WC, W.C., Bath, Bain, Douche, Shower, SDB, Bathroom, Toilet, each counted individually; "Lavatory" is not counted.
   So the benchmark's door and window definitions are symbol-centric and its bedroom and toilet definitions are label-centric (read the room name).
2. Drawing understanding QA (Use Case 2). 192 questions over 21 images in four categories: `ocr_qa` 65, `spatial_qa` 41, `comparison_qa` 44, `counting_qa` 42 [verified: counted from the label JSONs]. Free-text answers, judged by an LLM. Examples: "what is the size of the GARAGE on the left?" (answer "39.37 m²"), "Which room is directly connected to the GARAGE with an internal door?", "How many bedrooms are there on the floor plan?" [verified].

Scoring code [verified: `src/benchmark/visualizer.py`, `src/benchmark/evaluator.py`, `src/benchmark/qa_evaluator.py`]:

- Accuracy ("recall" in the code) per field = fraction of the 120 plans where predicted integer == ground truth integer. A missing or unparsable field counts as 0.
- MAPE per field = mean of |pred - gt| / gt over plans; plans with gt == 0 contribute 0 when pred == 0 and are skipped when pred != 0.
- "Mean Accuracy" and "Mean MAPE" = plain mean over all five fields including `Space`, even though the heatmaps hide the Space column. I confirmed this: my recomputation over five fields reproduces every published number (for example Claude Fable 5 0.515, Gemini 3.5 Flash 0.543 and 15.3 percent), while a four-field mean does not.
- QA: `run_qa_llm_judge_evaluation.py` sends question, ground truth and model answer to `openai/gpt-4o` via OpenRouter at temperature 0 and parses a 1/0 verdict with keyword heuristics ("correct", "incorrect", "yes", "no"). Score = mean of the binary verdicts. The paper additionally reports human adjudication of ambiguous cases [reported: search snippet of the paper]; the repo also contains a Flask app for manual marking (`qa_evaluation_app/`) [verified].

## Data and format (verified vs from paper)

Verified on disk (clone at commit e6f9364, 2026-08-04):

- Counting set: `data/Use Case 1 - Object Counting/1 - Full Datasets/<id>/` with exactly one image per folder plus `metadata.json` (ground truth) and one JSON per model prediction. 120 folders. The sibling `all-images/` folder holds 120 symlinks that are broken (they point at the author's Mac path `/Users/alexbest/...`), so scripts must read the per-folder images.
- Image formats: 100 PNG, 19 JPG, 1 JPEG. No PDFs, no vector data, no text layer anywhere. Colour modes: RGB 68, RGBA 45, greyscale 6, palette 1.
- Size: width 517 to 3840 px (median 1266), height 432 to 3579 px (median 1003). DPI tags: 41 files at ~120 dpi, 17 at ~300 dpi, 12 at 120, 39 with no DPI tag, a few at 72 and 200. No scale bar or scale is given; the benchmark never needs one.
- Six id families by prefix: `0000` (5 plans, scanned French plans, ~1600x1500 px), `2000` (15, US residential CAD exports, ~840x850 px), `3000` (8, ~870x920 px), `4000` (17, ~2480x3508 px, A4 at 300 dpi), `5000` (35, ~2045x1500 px, CubiCasa-style Finnish plans), `6000` (40, ~1090x750 px, the smallest). So roughly a third of the set is below 1100 px wide; door arcs there are a handful of pixels.
- Ground-truth distribution (120 plans): Door min 0 median 9 mean 9.3 max 34 (one plan with 0); Window min 1 median 8 max 34; Space min 1 median 9 max 39; Bedroom min 0 median 2 max 6 (11 plans with 0); Toilet min 0 median 1 max 4 (4 plans with 0).
- Metadata files are UTF-8 with BOM (`json.load` needs `encoding='utf-8-sig'`); the repo's own CSVs already contain the parsed values.
- Three inspected samples:

| id | pixels | mode, dpi tag | style | ground truth (Door, Window, Space, Bedroom, Toilet) |
|---|---|---|---|---|
| 0000-0001 | 1479 x 1486 | greyscale PNG, 118.6 dpi | scanned French house plan "VUE EN PLAN", room labels in French (CHAMBRE, W.C., TOIL., CUISINE), areas printed in m², dimension strings, thick poché walls, swing doors as quarter-arc + leaf, two WC pans drawn as plan symbols | 10, 11, 13, 2, 2 |
| 2000-0003 | 838 x 950 | RGBA PNG, 120 dpi | clean US CAD export, "2ND FLOOR - DIMENSION 1/4in = 1ft-0in", BEDROOM 2/3/4, BATHROOM 2, STORAGE, door arcs thin and attached to wall ends, numbered door tags in hexagons, imperial dimension strings | 6, 6, 5, 3, 1 |
| 5000_0010 | 2197 x 2624 | RGB PNG, no dpi | Finnish duplex, two floors on one sheet, labels MH, WC, TUPA, AULA, KUISTI with areas, hatched walls, window codes like "MSE 12x14", furniture drawn | 30, 26, 39, 6, 4 |

  Doors and windows are drawn in ordinary architectural convention (swing arc plus leaf; windows as breaks in the wall with parallel lines), not as isolated repeated symbols. Door arcs touch the wall, so a connected-component view fuses them with the wall mass. Bedrooms and toilets are only identifiable through the printed room labels, in at least French, English and Finnish.

- QA set: `data/Use Case 2 - Drawing Understanding/01 - Full Dataset/images/` (21 PNG, 777x920 up to 7383x5671 px; eleven residential plans reused from the counting ids, four "Apple-headquarter-plan" sheets at 3309x2339, four "House-Floor-Plans" sheets at 3600x2400, two "Rinker" sheets) and `labels/<id>.json` with `ocr_qa`, `spatial_qa`, `comparison_qa`, `counting_qa` lists; each item has `id`, `task`, `question`, `answer`, optional `evidence`, and an unfilled `bbox` placeholder.

From the paper and site (not verifiable here):

- "120 high-quality floor plans" and "192 question-answer pairs" [reported: arXiv abstract via search snippets]; matches disk.
- Plans come mainly from CubiCasa5K and CVC-FP plus publicly available drawings; "all drawings were freely available at the time of collection"; "each drawing is manually analyzed and annotated" [reported: paper via snippet]. An earlier AECFoundry blog post described a 150-plan round sampled from CubiCasa5K with manual relabelling because of label inconsistencies in the original data [reported: blog via snippet].
- No inter-annotator agreement figure surfaced in any snippet; the repo has none. [verified: absent from repo]

## Licence

- AECV-Bench code: no LICENSE file, no licence statement in README or source headers [verified: repo tree and grep]. GitHub issue #1 "Add explicit LICENSE for this repository" (apipoj, 2026-08-02) has no reply and no commits since [verified: GitHub issue page]. Under GitHub's terms, unlicensed public code may be viewed and forked but no further rights are granted.
- AECV-Bench data: no licence either. The paper's data availability statement says code and data are "openly available in the AECFoundry GitHub repository" [reported: paper via snippet], which is a statement of access, not a grant of rights.
- Upstream sources: CubiCasa5K is "licensed under a Creative Commons Attribution-NonCommercial 4.0 International License" [verified: CubiCasa5k LICENSE file on GitHub]. CVC-FP is announced as Creative Commons without the variant named [reported: paper abstract via snippet]. The `5000` and `6000` families (75 of 120 plans) look like CubiCasa material.
- Practical reading for pdf2takeoff (Apache-2.0, free, no revenue): running the benchmark locally and publishing a results table (numbers, not images) is the same thing every listed model vendor did and is low risk. Do not copy the images into this repo, do not use them for training, and credit AECFoundry and CubiCasa5K when publishing. A commercial company evaluating internally is in the same position; commercial redistribution or training on the CubiCasa-derived plans would conflict with CC BY-NC. This is not legal advice.

## Availability and what I downloaded

- `git clone --depth 1 https://github.com/AECFoundry/AECV-Bench` succeeded through the session proxy: 114 MB, HEAD e6f9364 (2026-08-04, "Merge pull request #2 ... patch-conditional-api-keys"). Location: `/tmp/claude-0/-home-user-pdf2takeoff/db387ea9-d3a7-5ddc-8c81-f410e6f4815f/scratchpad/aecv/repo` (scratch, not committed). [verified]
- Commit history (from the GitHub commits page): 2025-12-31 initial + pipeline; 2026-01-07 "updated publication year"; 2026-03-06 and 03-10 "updated benchmark with latest models", "gpt5.4 is added"; 2026-08-04 "Add 12 new models, parallelize benchmarks, track cost and latency". [verified: GitHub page]
- Blocked: arxiv.org (abs, pdf, html), aecv-bench.com, aecfoundry.com, researchgate.net, emergentmind.com, alphaxiv.org, huggingface.co, semanticscholar.org, zenodo.org, web.archive.org all returned connect_rejected / ENOTFOUND from the proxy. GitHub REST API via `gh` returned 403 (repo not attached to the session); github.com HTML pages fetched fine. So every paper and site number below is from search snippets, cross-checked against the repo's own result files where possible.
- What I ran on the data: image statistics (PIL, `python3 -I`), ground-truth statistics, a recomputation of the counting leaderboard from the 29 result CSVs using the repo's metric, a summary of the QA judge CSV (3264 rows = 17 models x 192), and the pdf2takeoff experiments in the section after next.

## Published baselines (table)

Object counting, exact-match accuracy (EM) per field, Mean = mean over five fields including Space, MAPE in percent. All rows recomputed by me from `benchmark_result_object_counting/*.csv` with the repo's own formula; they reproduce the repo's heatmaps and `results/new_models_batch_results.json` to the printed precision. [verified]

| model (CSV name) | n | EM Door | EM Window | EM Space | EM Bedroom | EM Toilet | Mean EM (5 fields) | Mean EM (4, no Space) | MAPE Door | MAPE Window | Mean MAPE (5) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Gemini 3.5 Flash | 120 | 0.43 | 0.39 | 0.14 | 0.93 | 0.82 | 0.543 | 0.644 | 12.4 | 16.6 | 15.3 |
| Gemini 3 Pro Preview | 120 | 0.40 | 0.34 | 0.14 | 0.89 | 0.83 | 0.522 | 0.617 | 15.0 | 21.3 | 16.4 |
| Claude Fable 5 | 120 | 0.36 | 0.29 | 0.17 | 0.93 | 0.82 | 0.515 | 0.602 | 16.8 | 20.6 | 16.5 |
| Gemini 3.1 Pro | 120 | 0.34 | 0.33 | 0.15 | 0.91 | 0.82 | 0.512 | 0.602 | 15.3 | 20.6 | 16.1 |
| OpenAI GPT-5.5 | 120 | 0.30 | 0.28 | 0.14 | 0.93 | 0.77 | 0.483 | 0.569 | 18.4 | 22.5 | 20.4 |
| OpenAI GPT-5.2 | 120 | 0.28 | 0.27 | 0.23 | 0.91 | 0.76 | 0.487 | 0.552 | 20.1 | 24.6 | 19.4 |
| MiniMax M3 | 120 | 0.23 | 0.17 | 0.21 | 0.92 | 0.84 | 0.473 | 0.540 | 25.7 | 32.1 | 19.9 |
| OpenAI GPT-5.4 | 120 | 0.33 | 0.13 | 0.23 | 0.90 | 0.72 | 0.460 | 0.519 | 22.3 | 34.5 | 22.1 |
| Kimi K2.6 | 109 | 0.21 | 0.16 | 0.15 | 0.93 | 0.78 | 0.444 | 0.518 | 25.8 | 31.9 | 22.3 |
| Qwen 3.7 Plus | 120 | 0.16 | 0.14 | 0.27 | 0.89 | 0.84 | 0.460 | 0.508 | 31.4 | 39.1 | 21.6 |
| OpenAI GPT-5.3 | 120 | 0.18 | 0.17 | 0.11 | 0.93 | 0.74 | 0.427 | 0.506 | 31.3 | 29.5 | 25.3 |
| Claude Opus 4.6 | 120 | 0.22 | 0.17 | 0.18 | 0.88 | 0.76 | 0.440 | 0.504 | 28.8 | 34.5 | 22.9 |
| Claude Opus 4.7 | 120 | 0.13 | 0.14 | 0.15 | 0.93 | 0.78 | 0.428 | 0.498 | 30.3 | 36.7 | 23.1 |
| Claude Opus 4.5 | 120 | 0.16 | 0.16 | 0.13 | 0.91 | 0.76 | 0.423 | 0.496 | 30.7 | 37.3 | 24.9 |
| Claude Opus 4.8 | 120 | 0.15 | 0.15 | 0.21 | 0.88 | 0.77 | 0.432 | 0.487 | 29.0 | 33.1 | 22.7 |
| Gemma 4 31B IT | 120 | 0.22 | 0.13 | 0.13 | 0.80 | 0.78 | 0.412 | 0.481 | 32.9 | 35.8 | 25.8 |
| OpenAI GPT-4 Vision (GPT-4o in reports) | 120 | 0.16 | 0.12 | 0.23 | 0.87 | 0.77 | 0.427 | 0.477 | 29.3 | 40.5 | 23.0 |
| Qwen 3.5 Plus | 120 | 0.17 | 0.12 | 0.27 | 0.88 | 0.74 | 0.435 | 0.477 | 31.1 | 41.6 | 24.1 |
| StepFun Step 3.7 Flash | 120 | 0.16 | 0.11 | 0.20 | 0.84 | 0.77 | 0.415 | 0.469 | 33.5 | 37.4 | 24.6 |
| Claude Sonnet 4.6 | 120 | 0.21 | 0.12 | 0.22 | 0.74 | 0.72 | 0.402 | 0.448 | 35.5 | 46.5 | 31.6 |
| Qwen3-VL 8B Instruct | 120 | 0.09 | 0.10 | 0.18 | 0.76 | 0.81 | 0.388 | 0.440 | 46.2 | 53.5 | 30.5 |
| GLM-4.6V | 120 | 0.09 | 0.03 | 0.23 | 0.79 | 0.82 | 0.390 | 0.431 | 50.5 | 69.6 | 35.4 |
| NVIDIA Nemotron Nano 12B V2 VL | 119 | 0.13 | 0.16 | 0.11 | 0.68 | 0.72 | 0.360 | 0.422 | 40.1 | 41.0 | 30.0 |
| Grok 4.1 Fast | 120 | 0.09 | 0.17 | 0.17 | 0.72 | 0.68 | 0.368 | 0.417 | 35.2 | 42.4 | 28.3 |
| Grok 4.3 | 120 | 0.17 | 0.11 | 0.13 | 0.82 | 0.55 | 0.358 | 0.415 | 32.1 | 43.4 | 35.2 |
| Amazon Nova 2 Lite v1 | 120 | 0.07 | 0.06 | 0.12 | 0.70 | 0.72 | 0.335 | 0.390 | 60.4 | 61.4 | 39.8 |
| Mistral Large 2512 ("Mistral Large 3") | 120 | 0.10 | 0.09 | 0.19 | 0.74 | 0.46 | 0.317 | 0.348 | 39.9 | 51.7 | 38.4 |
| Cohere Command A Vision | 120 | 0.10 | 0.08 | 0.12 | 0.60 | 0.55 | 0.290 | 0.333 | 69.0 | 61.4 | 50.8 |
| NVIDIA Nemotron 3 Nano Omni 30B (partial run) | 26 | 0.04 | 0.04 | 0.04 | 0.38 | 0.23 | 0.146 | 0.173 | 92.5 | 91.5 | 82.5 |

Notes on the counting table [verified]: the GLM-4.6V CSV has 6 rows where the model echoed the JSON schema instead of counts (scored as zeros); Kimi K2.6 and Nemotron 12B have missing plans (109 and 119 rows) and the code divides by rows present. The best door EM anywhere is 0.43 and the best window EM 0.39. Bedroom and toilet EM (label reading) is 0.7 to 0.93 for most models.

Document QA, LLM-judge accuracy (binary GPT-4o verdicts), from `results/qa_llm_judge_results/complete_evaluation_results.csv` (17 models, March 2026 run) and `results/new_models_batch_results.json` (11 newer models, August 2026 run). [verified]

| model | overall | ocr | spatial | comparison | counting |
|---|---|---|---|---|---|
| Claude Fable 5 (Aug run) | 0.901 | 0.969 | 0.854 | 0.932 | 0.810 |
| Gemini 3.5 Flash (Aug run) | 0.885 | 0.985 | 0.878 | 0.955 | 0.667 |
| OpenAI GPT-5.5 (Aug run) | 0.870 | 0.939 | 0.805 | 0.864 | 0.833 |
| Gemini 3.1 Pro | 0.865 | 0.985 | 0.829 | 0.886 | 0.690 |
| Claude Opus 4.7 (Aug run) | 0.854 | 0.954 | 0.805 | 0.841 | 0.762 |
| Gemini 3 (Pro Preview) | 0.839 | 0.954 | 0.683 | 0.955 | 0.690 |
| Qwen 3.5 Plus | 0.823 | 0.923 | 0.805 | 0.773 | 0.738 |
| Qwen 3.7 Plus (Aug run) | 0.818 | 0.908 | 0.805 | 0.795 | 0.714 |
| OpenAI GPT-5.4 | 0.812 | 0.923 | 0.805 | 0.795 | 0.667 |
| OpenAI GPT-5.2 | 0.797 | 0.877 | 0.780 | 0.727 | 0.762 |
| Kimi K2.6 (Aug run) | 0.792 | 0.939 | 0.707 | 0.750 | 0.690 |
| MiniMax M3 (Aug run) | 0.755 | 0.877 | 0.732 | 0.750 | 0.595 |
| OpenAI GPT-5.3 | 0.734 | 0.785 | 0.707 | 0.818 | 0.595 |
| Claude Sonnet 4.6 | 0.729 | 0.892 | 0.780 | 0.705 | 0.452 |
| Claude Opus 4.6 | 0.724 | 0.862 | 0.707 | 0.727 | 0.524 |
| Claude Opus 4.5 | 0.719 | 0.877 | 0.707 | 0.705 | 0.500 |
| Grok 4.3 (Aug run) | 0.719 | 0.862 | 0.683 | 0.705 | 0.548 |
| GLM-4.6V | 0.714 | 0.877 | 0.732 | 0.636 | 0.524 |
| StepFun Step 3.7 Flash (Aug run) | 0.693 | 0.923 | 0.537 | 0.636 | 0.548 |
| Qwen3 VL 8B Instruct | 0.604 | 0.769 | 0.585 | 0.545 | 0.429 |
| Mistral Large 3 | 0.594 | 0.662 | 0.561 | 0.705 | 0.405 |
| Amazon Nova 2 Lite v1 | 0.573 | 0.738 | 0.537 | 0.523 | 0.405 |
| Nemotron 3 Nano Omni 30B (Aug run) | 0.573 | 0.769 | 0.463 | 0.477 | 0.476 |
| Nvidia Nemotron Nano 12B | 0.568 | 0.662 | 0.561 | 0.545 | 0.452 |
| GPT-4o | 0.568 | 0.631 | 0.610 | 0.591 | 0.405 |
| Cohere Command A Vision | 0.557 | 0.600 | 0.634 | 0.545 | 0.429 |
| Gemma 4 31B IT (Aug run) | 0.531 | 0.646 | 0.512 | 0.500 | 0.405 |
| Grok 4.1 Fast | 0.297 | 0.185 | 0.390 | 0.455 | 0.214 |

Paper (v1, 2026-01-08) and site figures, and discrepancies:

- Paper counting table [reported: search snippets of arXiv 2601.04819]: Gemini 3 Pro mean EM 0.51, mean MAPE 16.0 percent, doors 0.39, windows 0.34; GPT-5.2 0.49 and 19.4 percent (doors 0.28, windows 0.27); Claude Opus 4.5 0.42 and 24.9 percent (doors 0.16, windows 0.16); GLM-4.6V 0.39 and 29.5 percent; Grok 4.1 Fast 0.37 and 28.4 percent; Mistral Large 3 0.32. The repo CSVs give Gemini 3 Pro 0.522 and 16.4 and GLM-4.6V 35.4 percent MAPE, so the Gemini and GLM rows in the repo come from a later or re-parsed run than the paper (the GLM difference is explained by the 6 schema-echo rows). Everything else matches to two decimals.
- Paper QA [reported: snippet]: Gemini 3 Pro 0.854, GPT-5.2 0.792, Claude 4.5 0.719. Repo: 0.839, 0.797, 0.719. Small drift, consistent with re-judging.
- Site aecv-bench.com [reported: snippet]: top object-counting model Gemini 3.5 Flash at "about 54.3 percent mean exact-match accuracy and 15.3 percent MAPE", "best open-source model reaches about 47 percent". The 54.3 and 15.3 match the repo's Gemini 3.5 Flash row exactly; 47 percent matches MiniMax M3 (0.473). The site therefore reflects the August 2026 run. No submission process is described anywhere I could reach; results appear to be produced only by the maintainers running `run_object_counting_benchmark.py` with OpenRouter keys.
- The README still lists the ten January-2026 models and "four" counting fields; both are stale relative to the code. [verified]

## How pdf2takeoff would run on it (step list)

Target: the Use Case 1 counting task only, reporting the same per-field EM and MAPE. The QA task is a free-text language task and is out of scope for a deterministic engine (pdf2takeoff could at most serve as a tool for an agent answering the 42 `counting_qa` and some `ocr_qa` items; that would benchmark the agent, not pdf2takeoff).

Per plan, two possible harnesses:

A. Agent-driven (matches "numbers come from tools", benchmarks the MCP loop):

1. `open_document` on a one-page PDF wrapping the image (the MCP and CLI accept only PDFs; see blockers). Page size = image pixels in points.
2. `render_page` to look at the sheet.
3. For doors: pick one door exemplar, call `scan_symbol` at its centre, read `count` from the result. Repeat with a second exemplar if hits look partial (opposite swing, different leaf width), and let the agent de-duplicate by coordinates. Each leaf is a door, so double doors need two hits.
4. For windows: same with a window exemplar. The benchmark counts adjacent units as one group, so hits closer than a wall thickness need merging.
5. For bedrooms and toilets: `read_text` for room labels and match the label lists from the prompt (CHAMBRE, Bedroom, MH, Zimmer; WC, Bath, SDB, Douche, Toilet, KPH ...). On these images `read_text` returns nothing (no text layer), so this needs OCR (step C below). Alternatively `fill_area` per label point to confirm it is an enclosed room.
6. For spaces: count enclosed regions, for example `fill_area` from each label point plus unlabeled closed regions; this is the field the VLMs also fail (best EM 0.27).
7. Write `{Door, Window, Space, Bedroom, Toilet}` to `<id>/pdf2takeoff.json` in the benchmark's folder layout and a `benchmark_result_object_counting/pdf2takeoff.csv` with `name, original, extracted` columns, then run the repo's `generate_heatmaps.py` (or the recomputation script I used) to get EM and MAPE.

B. Scripted (deterministic, no agent, reproducible in CI): a Node script that loads each PNG into a `RasterPage` (I did this with `@napi-rs/canvas` `loadImage` + `getImageData`, 1 px = 1 pt, plus `toPdf`/`toRaster` closures), runs an opening detector for doors and windows, OCR for labels, and writes the same CSV. This removes the agent's exemplar-picking variance and is the version worth putting in `npm run bench`.

Metrics to compute: per-field EM and MAPE exactly as `visualizer.py` does (zero ground truth handled as above), Mean EM over five fields, and also the four-field mean, which is what the README implies and what the heatmaps show. Report n = 120 and the commit hash of the data.

What I actually ran (step 6 of the brief) [verified]:

- `npm install` was already satisfied (147 packages); Node v22.22.0.
- Wrote `png2pdf.mjs` (pdf-lib embedPng/embedJpg, 1 px = 1 pt) and wrapped `0000-0001.png` and `2000-0003.png`. `npm run cli -- info` on the wrapped PDF works (1 page, 1479 x 1486 pt, 1.3 s).
- `npm run cli -- scan <wrapped.pdf> --page 1 --at x,y` exits 139 (segmentation fault) for both samples; `compare` on the wrapped PDF also segfaults. The control run on `public/examples/sample-floor-plan.pdf` returns 8 hits via the vector provider in under 2 s. A probe script isolated the crash: `vectorDocPage` succeeds (returns segs/paths/forms/layers), `renderRasterNode` crashes. So pdf.js v5 legacy + `@napi-rs/canvas` crashes while drawing an embedded image XObject, the same family of native crashes documented in `specs/headless-engine.md` section 11b. This means the headless engine currently cannot rasterize any image-only PDF (scanned sheets included), not just this benchmark.
- Bypassing pdf.js and feeding the PNG into `cvScan` directly: ~100 ms per scan. On 0000-0001 a click on the W.C. pan symbol returned 1 hit (itself); a click on the TOIL. pan returned 1 hit; ground truth is 2 toilets, drawn in two different orientations. A click on a door arc returned "click directly on a symbol to teach the scan" on 0000-0001 (one of two attempts) and on all three attempts on 2000-0003, because the arc stroke is part of the same connected component as the wall. The tier-1 scan is built for isolated repeated symbols (downlights, GPOs), and door arcs on these plans are not that.

## Effort and blockers

Blockers, in order of severity [verified unless noted]:

1. Raster input. CLI and MCP open PDFs only (`openPdf(readFileSync(path))`), and the Node rasterizer segfaults on image-only pages. Fix options: (a) add a `RasterPage` adapter that loads PNG/JPG directly (what my probe did; roughly a day including an `open_document` path for images and a `--image` flag), or (b) debug the pdf.js image-drawing crash (unknown, native). Option (a) is also what scanned PDFs will eventually need via a pdf.js-free image extraction path.
2. Door and window detection on raster plans. The click-exemplar CV scan does not segment door arcs or wall-break windows. Realistic routes: the trained ONNX detector the repo already has a training pipeline for (`training/`, classes would need door leaf and window group, on data that is not CubiCasa if training data must stay commercially clean), or a geometric opening finder (wall mask from thick strokes, gaps in walls = openings, arc presence = door, parallel thin lines in the gap = window). Dynamic Fill's door-gap bridging (`fill-vector.ts`, `dynamicfill.ts`) already locates door gaps on vector sheets; the raster variant would be the seed. Estimated 1 to 3 weeks to get door EM near the 0.4 the best VLMs reach; windows are harder (the one-group rule needs merging logic).
3. Room labels without a text layer. `read_text` is text-layer only in headless; `tesseract.js` is a dependency but is wired only in `src/app/ocr.ts` (browser). Node OCR via tesseract.js is a few days plus a multilingual label dictionary (French, English, Finnish, German, Italian from the rules; the `5000` family uses Finnish abbreviations like MH, KPH, WC, TUPA). Bedroom and toilet EM is the cheap win here: VLMs are at 0.9 and 0.8 and OCR plus a dictionary could match them. The `Lavatory` exclusion and the "Bath counts as a toilet" rule are label rules, not geometry.
4. Space counting. Needs an enclosed-region count; Dynamic Fill from every label point gives labelled rooms, unlabelled closets and halls need an unlabeled-region pass. Every VLM is below 0.27 EM on this field, so the bar is low but the field drags Mean EM down for everyone.
5. Data and licence hygiene. Keep the clone out of the repo, run from a path argument, never train on it (CC BY-NC upstream), publish numbers and the harness only.
6. Small-image regime. Forty plans are around 1090 x 750 px; door arcs are 6 to 10 px. Upsampling before CV is cheap but detection quality at that size is the real limit; the VLMs see the same pixels, so the comparison is fair.

Effort estimate: harness plus raster input plus OCR labels (bedroom, toilet) about one week; door/window opening detection to a defensible level two to three more weeks; space counting one week. A first honest publication (bedroom and toilet near the VLM ceiling, doors and windows below it) is reachable in about two weeks; a run that beats the VLM table on doors and windows is the three to four week version and is not guaranteed.

What a result would be worth: this is the only public counting benchmark with VLM baselines on real plans, and the headline finding of its authors ("doors and windows remain unsolved, 0.40 to 0.55") is the exact claim pdf2takeoff's tool-first design makes. A deterministic engine at or above 0.5 door EM with 100 ms latency and zero cost would be a strong, citable line against the table above (Claude Fable 5 spends 9.2 USD and 29 s per plan on this task per the repo's cost logs).

## Open questions

1. Does AECFoundry intend to add a licence (issue #1)? Until then, publishing numbers is customary but redistribution of any image is not possible.
2. Does the maintainers' site accept third-party submissions, or only their own OpenRouter runs? Nothing visible says so; the harness has no "external predictions" entry point, only model configs. A PR adding a "predictions directory" model type would be the clean way in.
3. Which of the 120 plans are CubiCasa5K versus CVC-FP versus web? The ids do not say; the paper might. Matters for any training decision.
4. Ground-truth reliability: double-leaf doors count as two and adjacent windows as one; a quick spot check on 0000-0001 (10 doors, 11 windows) looked plausible but I did not audit it. No agreement figure exists.
5. Should pdf2takeoff report the four-field mean (README definition) or the five-field mean (code definition)? Report both and say which.
6. Can the pdf.js image-XObject segfault be fixed, or should image-only pages route around pdf.js permanently? It affects scanned PDFs in production, not only this benchmark.

## Sources (URLs)

- https://github.com/AECFoundry/AECV-Bench (repo, README, code, data; cloned at e6f9364) [verified]
- https://github.com/AECFoundry/AECV-Bench/issues/1 (licence request, 2026-08-02) [verified]
- https://github.com/AECFoundry/AECV-Bench/commits/main (commit dates) [verified]
- https://arxiv.org/abs/2601.04819 and https://arxiv.org/pdf/2601.04819 (paper, blocked; content via search snippets) [reported]
- https://aecv-bench.com/ (site, blocked; content via search snippets) [reported]
- https://www.aecfoundry.com/blog/can-ai-really-read-your-building-plans-introducing-aecv-bench and https://www.aecfoundry.com/blog/can-ai-really-read-your-building-plans-aecv-bench-gets-a-major-upgrade (blog, blocked; via snippets) [reported]
- https://www.emergentmind.com/topics/aecv-bench (secondary summary, blocked; via snippets) [reported]
- https://github.com/CubiCasa/CubiCasa5k/blob/master/LICENSE (CC BY-NC 4.0) [verified]
- https://zenodo.org/record/2613548 (CubiCasa5K data host, blocked) [reported]
- Related, not the same benchmark: AEC-Bench by Nomic (arXiv 2603.29199, Apache-2.0, agentic tasks) https://github.com/nomic-ai/aec-bench [reported]
- Local artefacts from this session (scratch, not committed): clone at `/tmp/claude-0/-home-user-pdf2takeoff/db387ea9-d3a7-5ddc-8c81-f410e6f4815f/scratchpad/aecv/repo`; wrapped PDFs in `/tmp/claude-0/-home-user-pdf2takeoff/db387ea9-d3a7-5ddc-8c81-f410e6f4815f/scratchpad/aecv/wrapped`; helper scripts `stats.py`, `leaderboard.py`, `png2pdf.mjs`, `probe.mjs`, `png-scan.mjs` in `/tmp/claude-0/-home-user-pdf2takeoff/db387ea9-d3a7-5ddc-8c81-f410e6f4815f/scratchpad/tools`.

## Status 2026-10-18: scripted harness and raster opening detector (WP3)

Built, on branch `worktree-agent-a326235b864df9b25` (based on `enhance/benchmark-sweep`):

- `src/engine/openings.ts`: environment-agnostic raster opening detector. `detectOpenings(raster)` returns door leaves, Window groups, open passages and a wall summary; `countEnclosedSpaces(raster)` bridges every detected gap and counts enclosed regions above a minimum area, exterior excluded. Pipeline: binarize; length-weighted stroke-width histogram restricted to long runs, with a floor at 1.6x the pen weight, picks the thinnest wall class t; an optional small closing (kept only when it clearly raises the share of ink in long wall-class bands) solidifies hatched and double-line walls; walls under 7 px work at an integer upsample; morphological opening just under t gives the wall mask; gaps are non-wall runs between a wall end and wall ink, stacked across the wall thickness; each gap is classified by thin ink (ink minus walls): an arc from one jamb with its hinge on the other jamb or inside the gap, counted only where the ink is a lone thin curve (hatch, text and stair treads score nothing), plus a leaf line, is a door; parallel lines along an otherwise empty band between two wall ends are a Window group (merged across mullions under one wall thickness); the rest are passages. Every tunable sits in `DEFAULT_OPENING_OPTIONS`.
- `scripts/aecv-bench.mjs`: `node --experimental-strip-types scripts/aecv-bench.mjs --data <AECV-Bench clone> [--limit N] [--ids a,b] [--labels words.json] [--debug-dir dir] [--out f.csv] [--json f.json] [--opt key=value] [--verbose] [--probe x,y]`. Loads each PNG/JPG with @napi-rs/canvas at 1 px = 1 pt, writes the benchmark's `name,original,extracted` CSV and prints per-field exact match and MAPE exactly as `visualizer.py` computes them (zero ground truth: a zero prediction counts as a perfect row, anything else is skipped), plus the five-field and four-field means. Bedroom and Toilet go through `labelsFor(planId)`, which reads the optional `--labels` JSON and returns `[]` today; the headless OCR pass (WP2) plugs in there, and `countLabels` already applies the benchmark's word rules (Bedroom/Chambre/Zimmer/Camera/MH..., WC/Bath/Bain/Douche/SDB/Toilet/KPH..., Lavatory excluded). The data stays out of the repo.
- `scripts/check-openings.mjs`, wired into `typecheck:engine`: a pdf-lib sheet at 1:100 with 0.2 m outer walls, 0.1 m partitions, four rooms, five door gaps (one double door, six leaves), four Window gaps (two adjacent across a 0.08 m mullion, one group), a bare passage, furniture and labels, rendered through the Node raster path, must count exactly 6 doors, 4 Window groups, 4 spaces and 1 passage. It fails without the detector and passes with it.

Result on the 120 counting plans (clone e6f9364, default options, 518 s total, median 3.4 s per plan on one core):

| field | pdf2takeoff EM | pdf2takeoff MAPE | best VLM EM (Gemini 3.5 Flash) | best VLM MAPE |
|---|---|---|---|---|
| Door | 0.117 | 72.9% | 0.43 | 12.4% |
| Window | 0.092 | 184.5% | 0.39 | 16.6% |
| Space | 0.058 | 221.4% | 0.14 (best anywhere 0.27) | n/a |
| Bedroom | 0.092 | 90.8% | 0.93 | n/a |
| Toilet | 0.033 | 96.7% | 0.82 | n/a |
| mean (5 fields, visualizer.py) | 0.078 | 133.3% | 0.543 | 15.3% |
| mean (4 fields, README) | 0.083 | 111.2% | 0.644 | n/a |

Bedroom and Toilet are label fields and the harness has no OCR yet, so those rows are exactly the share of plans whose ground truth is zero (11 and 4 plans); they are reported, not claimed. Door and Window are within +-1 of the truth on 32 and 31 plans; Space on 19.

Per family (Door / Window / Space EM, then Door / Window MAPE): `2000` US CAD exports, 15 plans: 0.07 / 0.07 / 0.00, 47% / 32%. `3000` hatched-floor residential, 8: 0.00 / 0.00 / 0.13, 45% / 28%. `4000` A4 300 dpi French plans, 17: 0.12 / 0.24 / 0.00, 44% / 19% (the cleanest family: 4000-0001 counts 12/11 doors, 12/12 windows, 12/13 spaces). `5000` CubiCasa-style Finnish scans, 35: 0.03 / 0.00 / 0.06, 84% / 279%. `6000` rendered plans, 40: 0.25 / 0.15 / 0.10, 86% / 218%. `0000` scanned French plans, 5: 0 everywhere, 115% / 527%. The ten worst plans are all `5000` and `0000`.

Main failure modes seen in the overlays:

1. Wall thickness on hatched scans. The `5000` and `0000` families draw walls as hatched bands; the estimator must close the hatch first, and the closing only wins when the closed histogram shows a wall-class peak. On about a third of the `5000` plans the thinnest "wall" peak is the 4 to 5 px hatch pen or closed furniture outlines, the kernel stays at 3 px, every thin line becomes wall, and hundreds of junk gaps follow (5000_0025: 166 doors, 61 windows, 243 spaces against 22, 18, 30). This single stage explains the whole tail of the error distribution.
2. Over-counted windows. Furniture pairs, kitchen counters, stair stringers and bed outlines between two wall ends read as glazing; the clutter test and the two-wall-ends rule removed roughly half of them (Window MAPE 423% to 185%), the rest are indistinguishable from a window by lines alone.
3. Doors. Half-open doors (45 degree leaf, short arc: `2000`, `3000`) and doors sharing a gap with an opening or a second door (`6000`) are handled; doors drawn over a continuous wall line with no gap (some `6000` plans), doors whose jamb detail boxes break the wall band, and arcs crossed by dense text are missed; false doors come from round fixtures and furniture arcs at a wall end. Door errors split evenly (49 plans over, 57 under).
4. Spaces are over-counted on 90 plans: any leftover wall-mask junk cuts rooms into pieces, and stair blocks, shafts and the white boxes of jamb details survive the minimum-area filter. On clean plans the count is within one or two (4000-0001 12/13, 6000-0024 9/10).
5. Ground-truth quirks: 6000-0001 shows eight door arcs and a dozen windows but is annotated 3 and 5, so even a perfect reading would miss there.

Honest reading: the deterministic detector is nowhere near the VLM table on this benchmark (0.08 mean EM against 0.54). It is exact on a minority of clean CAD-export plans and collapses on hatched scans. The harness, metrics and overlay tooling are the reusable part; the next lever is the wall-thickness stage (a hatch-aware wall model, or using Dynamic Fill's room regions to validate wall classes), then OCR for the two label fields, which alone would add about 0.35 to the five-field mean if it matched the VLMs.
