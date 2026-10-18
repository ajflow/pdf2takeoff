# TakeoffBench-V1 (Handoff-H1) and pdf2takeoff

Research note, 2026-10-18. Every claim is tagged [verified] (read from the
cloned harness repo or run here) or [reported] (search snippets of the arXiv
paper, Handoff's blog or press; `arxiv.org` and `handoff.ai` were blocked by
this session's egress proxy, so the paper was not fetched directly).

Companion: [aec-bench.md](aec-bench.md).

## Summary

- The public harness is `github.com/handoffai/residential-takeoff-benchmark`: a Harbor task generator, a single-shot vision "agent", an LLM judge, and a read-only leaderboard viewer. No blueprints, ground truth or run data ship with it. [verified]
- "OpenHarbor" in the paper is the Harbor framework (harborframework.com); no repo or org named OpenHarbor exists. [verified for the repo; reported for the paper wording]
- Metric: per (blueprint, trade) task, `score = coverage^0.4 * precision_at_25^0.6` over primary-tier materials, with an OpenAI tier classifier and judge. [verified from `harbor/shared/scoring.py`, `judge.py`, `tiers.py`]
- Published: Handoff-H1 81.6, human estimator 77.6, claude-fable-5 61.4, gpt-5.6 58.6, claude-opus-4-8 54.6, Kimi-K2.6 54.5, claude-sonnet-4-6 53.9, GLM-5.2 41.6, DeepSeek-V4-Pro 34.7; nine trades. [verified from the repo's leaderboard SVGs; results are Handoff's]
- pdf2takeoff cannot run on it as published (agents receive PNG pages, not the PDF, and the data needs a research request); a local variant that also copies the PDF into the task is a one-file change to `build-tasks.py`. [verified]

## What it measures

Material quantity takeoff from residential blueprints, scored per trade
[verified, `harbor/README.md` and code]:

- A task is one (blueprint set, trade) pair. `build-tasks.py` enumerates the distinct `Group` values of the case's `gt.csv` and writes one Harbor task per value, so the trade list is whatever the ground truth uses, not a fixed enum.
- The agent receives every page of the set as a PNG (150 DPI, long edge capped at 1,568 px by `shared/pdf_to_images.py`) plus `metadata.json`, and must write `/workspace/predictions.json` as `{"rows": [...]}` with rows of `label, qty, uom, rateUsd, category (m|l|lm|o), sectionName, roomName?, description?`.
- The verifier (separate container, GT hidden from the agent) loads the trade-filtered `gt.csv` (columns `Group, Item Title, Quantity, UoM`, optional `Category`) and runs the judge.

Metric definitions, exactly as implemented [verified, `harbor/shared/judge.py`]:

1. Material filter: GT rows with `Category` in {empty, material} are kept; prediction rows with `category` in {m, lm, *material*, empty} are kept. Labor and "other" rows are dropped on both sides.
2. Tier classification: one OpenAI call per section (`TIER_MODEL`, default `gpt-5.4-2026-03-05`, temperature 0, prompt in `shared/prompts.py`) splits GT and predicted items into PRIMARY and SECONDARY; only PRIMARY items are judged. The prompt carries per-trade lists (for example Framing PRIMARY = studs, plates, joists, rafters, trusses, sheathing, posts, beams; SECONDARY = hangers, nails, blocking, house wrap). Fail-open: if the call errors, everything is PRIMARY.
3. Judge: one OpenAI call per section (`JUDGE_MODEL`, default `gpt-5.5`, `response_format json_object`) returns `matched_comparisons` (N:M groups by material category with `gt_total_qty`, `pred_total_qty`, `pct_error`, `abs_pct_error`), `unmatched_gt_indices`, `unmatched_pred_indices`. Incompatible UoMs give `abs_pct_error = null`.
4. Aggregation over the task: `coverage = matched_primary_GT / total_primary_GT` where GT items that appear only in null-UoM comparisons count as unmatched; `precision_at_25 = share of scoreable comparisons with abs_pct_error <= 25`, null-UoM comparisons excluded from the denominator; also `mape`, `within_10`, `within_25`, `within_50`.
5. `score = coverage^0.4 * precision_at_25^0.6`, and 0 if either factor is 0 (`shared/scoring.py`). The README's justification: GT is not fully validated, so misses are partially forgivable and wrong quantities on matched items are not.
6. Reporting: `metric.py` averages `reward` over trials and by trade, model, case; `scripts/harbor-to-runs.mjs` instead pools counts (`matched_gt`, `comparisons`, `within25`) per model and recomputes the score, folding free-text sections into 12 canonical trades via keyword rules in `src/lib/trades.ts`.

Trades: the viewer defines 12 major trades (Concrete, Framing, Roofing,
Siding, Insulation, Drywall, Windows & Doors, Painting, Flooring, Plumbing,
Electrical, HVAC) [verified]; the published heatmap shows nine (no Painting,
Flooring or HVAC) [verified from `docs/images/trade-breakdown.svg`]. The
paper's "nine trades" therefore means the nine with enough GT rows in the ten
sets [inferred].

Paper headline [reported, search snippets of arXiv 2608.15032]: Handoff-H1 is
a three-layer system (purpose-built CV models that recover typed primitives
per sheet, vision agents calling image, counting, detection and
framing-decomposition tools, and a persistent project foundation with a
construction knowledge base, followed by an independent verification pass).
TakeoffBench-v1 has 10 real, permissioned, PII-stripped residential sets,
about 100 pages in total, 2,009 verified line items of which 1,348 primary-tier
materials are scored, with a consensus-validated expert gold standard.
Handoff-H1 scores 81.6 composite (86.1 coverage, 78.8 P@.25); independent
professional estimators 77.6 (65.5 coverage, 87.9 P@.25); seven frontier and
open-weight models run "as tool-using agents from the same raw PDFs" span 34.7
to 61.4.

Discrepancy between the paper and the public harness [verified harness,
reported paper]: `run_inference.py` is a single model call per trade with all
page images attached and a JSON-schema response, not a tool-using agent loop.
Either the paper's baselines used a different, unpublished runner, or
"tool-using" refers to the structured-output call. Treat the public harness as
the scoring protocol, not as a faithful reproduction of the baselines.

## Data and format (verified vs reported)

- Per case: `inputs/iN/pdf.pdf`, `gt.csv`, `metadata.json` (`caseId`, optional `fileId`, `pdfFile`, `gtFile`). `inputs/` is gitignored and contains only `.gitkeep` [verified].
- Rendered pages are cached in `inputs/iN/pages/page_NNN.png` and copied into each task's `environment/pages/`; the PDF itself is never copied into the agent container [verified, `AGENT_DOCKERFILE` in `scripts/build-tasks.py`].
- Verifier container gets `tests/gt.csv` filtered to the one trade [verified].
- Task resources: agent 2 CPU, 4,096 MB, 1,800 s; verifier 1 CPU, 2,048 MB, 600 s; `allow_internet = true`; `mcp_servers = []` placeholders in both sections [verified, `TASK_TOML_TEMPLATE`].
- Whether the blueprints are vector or scanned: unknown here; the harness rasterises everything to PNG so it does not care, and the paper calls them raw PDFs [reported]. Residential plan sets handed to estimators are frequently flattened or scanned, so do not assume a text layer [assessment].
- Set count: paper and repo say 10 cases [verified repo, reported paper]; the July 2026 press release and the Foundamental write-up say 15 residential sets and "8 major AI models" [reported]. The repo's leaderboard shows 7 models plus Handoff-H1 and the human estimator [verified]. The 15 figure is probably a later or internal suite; only 10 are requestable [inferred].
- Model registry includes `google/gemini-3.1-pro-preview`, `anthropic/claude-opus-4-7`, `anthropic/claude-haiku-4-5`, `openai/gpt-5.5` and `together/zai-org/GLM-5.1` that are absent from the leaderboard; the sweep script's `ALL_MODELS` (the 2026-07 roster) is exactly the seven published models [verified].
- Judge and tier models are OpenAI only; running the benchmark on any model still needs `OPENAI_API_KEY` [verified].

## Licence

- The harness repo has no `LICENSE` file, and neither `README.md`, `package.json` (`"private": true`) nor `harbor/pyproject.toml` declares one [verified]. The paper states TakeoffBench-V1 is packaged for the open Harbor framework under Apache-2.0 [reported]. Until a licence file lands, treat the code as "all rights reserved, published for reproduction" and do not vendor it.
- Blueprints and ground truth: gated. Email `research@handoff.ai`; requests are reviewed before data is provided [verified README, reported paper]. The README says they are PII-stripped and shared on request; no terms of use are published [verified].
- Harbor itself: Apache-2.0 [verified, `LICENSE` in the harbor clone].

## Availability and what I downloaded

Downloaded [verified]:

- `github.com/handoffai/residential-takeoff-benchmark` at commit `f5e3f6509685a65bba5746c3c6a40c60f818ad9e` ("benchmark publish release", 2026-07-21), 79 files, 3.8 MB, into `/tmp/claude-0/-home-user-pdf2takeoff/db387ea9-d3a7-5ddc-8c81-f410e6f4815f/scratchpad/handoff/repo/`.

Files read [verified]: `README.md`, `Makefile`, `package.json`,
`.env.local.example`, `harbor/README.md`, `harbor/pyproject.toml`,
`harbor/metric.py`, `harbor/shared/{scoring,judge,tiers,schemas,prompts,
estimator,describer,models,pdf_to_images,csv_utils}.py`,
`harbor/agents/handoff/{agent.py,verify.py,run_inference.py,Dockerfile}`,
`harbor/scripts/{build-tasks.py,run-sweep.py,run-offline.sh}`,
`scripts/harbor-to-runs.mjs`, `src/lib/{trades.ts,scoring.ts}`,
`docs/images/README.md`, and the two SVG charts
`docs/images/leaderboard.svg` and `docs/images/trade-breakdown.svg` (parsed
with `python3 -I` to recover the numbers).

Searched for and not found: any GitHub repository or organisation named
"OpenHarbor"; any public sample blueprint or `gt.csv`; any committed run data
(`runs/` and `baseline/` hold only `.gitkeep`) [verified].

Not reachable here: `arxiv.org` (abs, html, pdf), `www.handoff.ai`
(technical report and blog), `pith.science`, `alphaxiv.org` [verified, proxy
403].

## Published baselines (table)

Mean takeoff score over the 10-case suite, from `docs/images/leaderboard.svg`
[verified as the repo asset; the values are Handoff's claims]:

| System | Score |
|---|---|
| Handoff-H1 | 81.6 |
| human-estimator | 77.6 |
| claude-fable-5 | 61.4 |
| gpt-5.6 | 58.6 |
| claude-opus-4-8 | 54.6 |
| Kimi-K2.6 | 54.5 |
| claude-sonnet-4-6 | 53.9 |
| GLM-5.2 | 41.6 |
| DeepSeek-V4-Pro | 34.7 |

Paper components [reported]: Handoff-H1 86.1 coverage, 78.8 P@.25; human
65.5 coverage, 87.9 P@.25. Kimi, GLM and DeepSeek are text-only in the
registry and were fed a Gemini 3.1 Pro page transcription instead of images
[verified, `shared/models.py`, `shared/describer.py`].

Per-trade composite, from `docs/images/trade-breakdown.svg` [verified as the
repo asset; cell to model and trade mapping recovered from SVG coordinates]:

| Trade | Handoff-H1 | human | claude-fable-5 | gpt-5.6 | claude-opus-4-8 | Kimi-K2.6 | claude-sonnet-4-6 | GLM-5.2 | DeepSeek-V4-Pro |
|---|---|---|---|---|---|---|---|---|---|
| Concrete | 72 | 72 | 54 | 51 | 45 | 43 | 46 | 30 | 25 |
| Framing | 82 | 71 | 54 | 49 | 38 | 53 | 39 | 31 | 29 |
| Roofing | 79 | 69 | 64 | 60 | 62 | 55 | 56 | 34 | 32 |
| Siding | 65 | 82 | 51 | 48 | 42 | 50 | 49 | 38 | 26 |
| Insulation | 76 | 62 | 68 | 65 | 53 | 51 | 46 | 44 | 33 |
| Drywall | 85 | 61 | 52 | 54 | 56 | 57 | 45 | 33 | 29 |
| Windows & Doors | 88 | 89 | 69 | 66 | 68 | 58 | 66 | 57 | 47 |
| Plumbing | 94 | 89 | 90 | 89 | 89 | 70 | 82 | 63 | 42 |
| Electrical | 81 | 85 | 70 | 69 | 68 | 68 | 72 | 65 | 57 |

Reading: the human wins Siding, Windows & Doors and Electrical; Handoff's
margin is largest on derivation-heavy trades (Drywall +24, Framing +11,
Insulation +14 over the human). Plumbing and Electrical are count-dominated
fixture lists, where frontier VLMs are already close to 90 [assessment of the
verified numbers].

## How pdf2takeoff would run on it (step list)

Constraint first: the published task hands the agent PNGs only, so none of
pdf2takeoff's tools can be used without changing the task build. The honest
framing is a second track, "H + pdf2takeoff (PDF access)", scored with the
unchanged verifier.

1. Request the cases: email `research@handoff.ai` describing the project (open-source, Apache-2.0, local-only takeoff engine; intent to publish a reproducible harness variant). Expect `pdf.pdf` + `gt.csv` + `metadata.json` per case, ten cases.
2. Set up: Python 3.11+, `uv sync` in `harbor/`, `OPENAI_API_KEY` (judge and tier classifier, mandatory), `ANTHROPIC_API_KEY`. Docker and `harbor` CLI for the full flow, or `scripts/run-offline.sh` without Docker.
3. Reproduce one baseline: `python scripts/build-tasks.py` then `scripts/run-offline.sh <case>-framing anthropic/claude-sonnet-4-6`. This checks keys, the judge and the GT format before anything is modified.
4. Patch `scripts/build-tasks.py` (local branch): add `COPY pdf.pdf /workspace/pdf.pdf` to `AGENT_DOCKERFILE` and `shutil.copy(pdf_path, env / "pdf.pdf")`. Nothing else in the task changes, so the verifier, GT and metric stay identical.
5. Add an agent. Two options:
   - Minimal: a new provider `shared/providers/pdf2takeoff_provider.py` that calls the Claude API in an agentic loop with pdf2takeoff's MCP tools exposed as tool definitions. More code, but stays inside the harness's `call(model, pages, trade) -> list[EstimateRow]` contract.
   - Simpler: a Harbor agent that installs Node 22.6+ and pdf2takeoff in the container, registers the MCP server in `$CLAUDE_CONFIG_DIR/.claude.json` (stdio: `node /opt/pdf2takeoff/bin/pdf2takeoff.js mcp`), runs the Claude Code CLI with `SYSTEM_PROMPT + TRADE_FOCUS_SUFFIX` from `shared/prompts.py` as the instruction, and requires it to write `/workspace/predictions.json` in the `EstimateOutput` schema. The verifier already looks in `/workspace/predictions.json` [verified, `verify.py` `PREDICTION_CANDIDATES`].
6. Prompt rules for the pdf2takeoff track: `set_scale` from the printed scale (`read_text` returns `scaleNotes`), `fill_area` for room areas feeding drywall, flooring and paint, `measure` length for plates, siding runs and trim, `scan_symbol` with one click for outlets, fixtures, windows and doors, `read_text` for schedules (window and door schedules are text on the sheet). Every `qty` must come from a tool result; the `provenance` field can be copied into `description` for audit.
7. Run `scripts/run-sweep.py --tasks-file tasks.txt --models anthropic/<model> --reps 3` once for the stock harness and once for the pdf2takeoff track; convert with `node scripts/harbor-to-runs.mjs <out>/rep1 --tag pdf2takeoff` and compare on the viewer or with `metric.py`.
8. Report coverage, P@.25 and composite per trade, and the share of predicted rows carrying tool provenance.

Size: 10 cases x about 9 trades = roughly 90 tasks per track and repeat.
Each stock call sends about 10 pages at 1,568 px (about 1,500 tokens per
image); the agentic track will use more turns. Judge cost: two OpenAI calls
per section per trial [verified].

## Effort and blockers

- Data: everything waits on Handoff approving the research request; no public sample exists [verified]. Allow weeks.
- Licence of the harness code is unstated in the repo [verified]; ask Handoff to add the Apache-2.0 file the paper promises before vendoring anything.
- OpenAI dependency for scoring: the judge and tier classifier are hard-wired to `openai.OpenAI` [verified]; a local-only project either accepts this or writes a second judge (see lite below).
- Models named in the harness (`gpt-5.5`, `gpt-5.4-2026-03-05`, `claude-opus-4-7`) will age; the published numbers are tied to those judge versions, so later runs are not strictly comparable [verified defaults, assessment].
- PNG-only input means the fair comparison is between the two tracks you run yourself, not against the leaderboard [verified].
- Engineering: 1 day to reproduce a baseline, 2 to 4 days for the pdf2takeoff agent track, plus prompt iteration.

## Open questions

- Are the ten blueprints born-digital PDFs with a text layer? This decides whether `read_text` and `scan_symbol` (vector-aware) work, or only raster `scan_symbol` and `fill_area`.
- Does the research licence allow publishing per-case scores and trajectories, or only aggregates?
- How did the paper run "tool-using agents" when the public runner is single-shot? If an agent runner exists, is it available on request too?
- Why do press materials say 15 sets and 8 models while the paper and repo say 10 and 7?
- Was the LLM judge validated against human adjudication? A third-party review flags that the "above human" claim depends on it [reported, pith.science via search].

## TakeoffBench-lite (what the project could build itself)

Goal: the same per-trade coverage and P@.25 metrics on sets the project can
redistribute, so the MCP agent track has a public, reproducible number.

1. Sets (target 5 to 10 residential sets, 5 to 15 sheets each):
   - `public/examples/sample-floor-plan.pdf`, `sample-floor-plan-rev-b.pdf`, `detector-demo.pdf` (synthetic, already in the repo) as the smoke set [verified they exist].
   - The ten Habitat for Humanity house sets in AEC-Bench's navigation corpus (`2013-06-28_SPSCC_LaceyWA_HabitatForHumanity.pdf` and nine siblings) are residential, born-digital bid sets already used in a public benchmark [verified filenames]; confirm redistribution terms with Nomic or the originating affiliates before bundling, otherwise reference them by URL and manifest exactly as AEC-Bench does.
   - Any further sets must be permissioned and PII-stripped (owner names, addresses, stamps).
2. Ground truth needed, per set, in the Handoff CSV shape (`Group, Item Title, Quantity, UoM, Category`):
   - Two independent takeoffs by estimators (or one estimator plus a second pass by the project), reconciled line by line; keep both raw files so inter-annotator agreement can be published, which is the validation step Handoff is criticised for not reporting.
   - Primary-tier items only need to be complete; mark `Category` for labor rows so the material filter works unchanged.
   - Minimum useful size: about 60 to 100 primary items per set across the nine trades; Handoff averages 135 primary items per set (1,348 / 10) [arithmetic on reported numbers].
   - Also record per-item evidence (sheet, region) so a reviewer can check a disputed line; pdf2takeoff's annotated-PDF export is the natural container for this, and it doubles as training labels.
3. Scoring: reuse `harbor/shared/scoring.py` semantics verbatim (coverage^0.4 x P@.25^0.6, null-UoM handling, within_10/25/50). Two judges:
   - Reference judge: the Handoff OpenAI judge and tier prompts, so numbers line up with theirs.
   - Deterministic judge for CI: a fixed material-category dictionary per trade (the PRIMARY lists in `shared/prompts.py` are a good seed) plus UoM normalisation; matching becomes category equality and the score is reproducible without any API key. Report both and the gap between them.
4. Harness: build tasks the same way (one per set and trade), but copy the PDF into the agent container and let the agent choose between pixels and tools. Keep a stock track (PNG only, single call) as the baseline so the delta is attributable to the tools.
5. Deliverable: `docs/research/benchmarks/takeoffbench-lite/` with the manifest, GT CSVs, the judge scripts, and a results table in the same nine-trade layout as above.

Effort: GT creation dominates, roughly 4 to 8 estimator hours per set for two
passes plus reconciliation; harness and judges 3 to 5 days.

## Sources

- Harness repo: https://github.com/handoffai/residential-takeoff-benchmark (commit f5e3f65, 2026-07-21) [verified]
- Paper: https://arxiv.org/abs/2608.15032, "Handoff-H1: An Orchestrated Vision-Agent System for Material Quantity Takeoff from Construction Blueprints" [reported; blocked]
- Technical report: https://www.handoff.ai/tech/h1-model-release and blog https://www.handoff.ai/blog/handoff-h1-ai-takeoffs [reported; blocked]
- Press release (15 sets, 8 models): https://www.prnewswire.com/news-releases/handoff-launches-h1-the-first-ai-model-for-autonomous-blueprint-takeoffs-302830287.html and https://www.foundamental.com/perspectives/handoff-launches-h1-the-first-ai-model-for-autonomous-blueprint-takeoffs [reported]
- Third-party review flagging judge validation: https://pith.science/paper/2608.15032 [reported]
- Harbor framework: https://github.com/harbor-framework/harbor [verified]
- Local clone: `/tmp/claude-0/-home-user-pdf2takeoff/db387ea9-d3a7-5ddc-8c81-f410e6f4815f/scratchpad/handoff/repo/`
- pdf2takeoff tool surface: `/home/user/pdf2takeoff/src/headless/mcp.ts`, `/home/user/pdf2takeoff/specs/headless-engine.md` [verified]
