# AEC-Bench (Nomic AI) and pdf2takeoff

Research note, 2026-10-18. Every claim is tagged [verified] (read from a
cloned repo, a repo asset, or run in this sandbox) or [reported] (taken from
search snippets of the paper, the Nomic blog or press; the arXiv, Hugging Face
and nomic.ai hosts were blocked by this session's egress proxy, so the paper
itself could not be fetched).

Companion: [takeoffbench-handoff.md](takeoffbench-handoff.md).

## Summary

- 196 Harbor tasks over real public-sector construction PDFs; every task is a document review question (broken callouts, sheet index errors, spec conflicts), none is a quantity takeoff. [verified]
- Agents get raw PDFs in an Ubuntu container and must write `/workspace/output.jsonl`; a keyword grep scores it. [verified]
- Published baselines: Nomic Agent 70.6 / 88.3 / 62.0 (intra-sheet / intra-drawing / intra-project); Claude Code base harness 44.3 / 68.8 / 38.1; Codex base harness 45.6 / 82.3 / 46.0. [verified from the repo's results plot]
- pdf2takeoff can plausibly help the three intra-drawing families (89 tasks) and the two title/callout families through `read_text`; `compare_revisions` has no legitimate task, and `measure`, `scan_symbol`, `fill_area` are irrelevant here. [verified by reading every task family]
- Running "H + pdf2takeoff" needs a new agent class in `aec_bench/agents/`, Docker, an Anthropic key, and the 271 PDFs from `nomic-public-data.com`; this sandbox has no Docker daemon and that host is blocked. [verified]

## What it measures

AEC-Bench evaluates whether an agent can review construction documents the
way a design or construction professional does. Three scopes, nine task
families, 196 instances [verified, counted from `tasks/`]:

| Scope | Family | Instances | What the agent must do | Scoring (from `tests/test.sh`) |
|---|---|---|---|---|
| Intra-sheet | detail-technical-review | 14 | Open-ended constructability or performance review of one detail on one sheet | Required keyword (for example "8 layers") plus at least one contextual keyword; binary |
| Intra-sheet | detail-title-accuracy | 15 | Say whether each view title matches what is drawn | At least one `eval_keywords` hit per planted defect; reward = found / planted |
| Intra-sheet | note-callout-accuracy | 14 | Trace each leader to its endpoint and check the note text | Same keyword rule |
| Intra-drawing | cross-reference-resolution | 51 | On one named page, verify every "3/A501" style callout resolves to an existing sheet and detail | Keyword per planted defect (for example "5/T7.1.1" or "T7.1.1" plus "detail 5") |
| Intra-drawing | cross-reference-tracing | 24 | Find every sheet that references detail N on sheet X | Keyword per known reference; minus 0.25 per extra line beyond the expected count |
| Intra-drawing | sheet-index-consistency | 14 | Compare the cover sheet index against every title block | Keyword per planted mismatch (for example "RISER DIAGRAMS") |
| Intra-project | drawing-navigation | 12 | Given a natural-language query, find the PDF, sheet number and title in an 89-file repository | All of: exact sheet number, PDF filename substring, one keyword, on one output line |
| Intra-project | spec-drawing-sync | 16 | Find conflicts between a spec section and the drawings | Keyword combination per planted conflict (for example "1/2" and "5/8" and "gyp") |
| Intra-project | submittal-review | 36 | Review a product submittal against spec and drawings; output MET / NOT_MET / CANNOT_VERIFY lines | "approved" instances: reward 1.0 only if no NOT_MET or CANNOT_VERIFY line; others: keyword per expected finding |

Difficulty tags: 95 easy, 58 medium, 43 hard [verified from `task.toml`].
Ground-truth variants: 114 `broken`, 34 `clean` (reward 1.0 only for "No
issues found"), 12 `navigation`, and the 36 submittal instances carry an
`expected_determination` (8 approved, 8 approved_as_noted, 11 rejected, 9
revise_and_resubmit) [verified from `gt.json`].

The README scoring prose promises partial credit (0.5 for the right sheet but
wrong reason); the shipped `test.sh` scripts are keyword-presence checks and
give no partial credit except the tracing penalty [verified, compared the
family README to the test scripts].

Paper headline [reported]: mean reward on a 0 to 100 scale; Nomic's tools
raise detail-technical-review by about +32.2 points, spec-drawing-sync by
+20.8 and drawing-navigation by +18.75 averaged over models, while
note-callout-accuracy (-3.6), cross-reference-resolution (-2.4),
sheet-index-consistency (-0.1) and cross-reference-tracing (-0.5) do not
benefit. Nomic also reports that 77 percent of agent trajectories used
`pdftotext` as the primary extraction strategy and that Codex agents used Bash
for 100 percent of interactions [reported, Nomic blog via search].

## Data and format (verified vs reported)

How a task reaches the agent [verified, `tasks/<scope>/<family>/<instance>/`]:

- `instruction.md`: the prompt. The Claude harness prepends an AEC preamble that says the drawings are "fully visible" and forbids OCR tools (`aec_bench/agents/claude_agent.py`, `_AEC_PREAMBLE`).
- `environment/Dockerfile`: identical across all 196 instances: `FROM ubuntu:24.04`, `apt-get install python3 jq`, `COPY <files> /workspace/`. No poppler, no Node, no Python PDF libraries.
- `environment/manifest.jsonl`: one `{key, dest}` line per input file; files are downloaded from `https://nomic-public-data.com/data/aec-bench-v1/...` before the image build.
- `task.toml`: agent timeout 900 s, verifier 120 s, 1 CPU, 4096 MB RAM, 10 GB storage, `allow_internet = true` (deprecated in current Harbor in favour of `network_mode`).
- `gt.json` (not copied into the container): the planted defects with `original_text`, `replacement_text`, `bbox`, `edit_mode`, `eval_keywords`.
- `tests/test.sh`: writes `/logs/verifier/reward.json`.

Inputs are always PDFs: 1,341 manifest entries, 1,340 `.pdf` and one `.json`,
271 unique URLs, all on `nomic-public-data.com` [verified]. Per family: one
sheet or set per instance for the intra-sheet and intra-drawing families
(sheet-index uses 1 or 2), two files (spec + drawings) for spec-drawing-sync,
three for submittal-review (shared `rees-project-manual.pdf` and
`rees-drawings.pdf` plus one submittal), and the same 89-file corpus for every
drawing-navigation instance [verified]. Page images are never supplied; the
agent must render pages itself [verified: no instruction mentions PNG input].

Contradiction worth knowing: 86 of 196 instructions state that "poppler-utils
is pre-installed" and recommend `pdftotext` then `pdftoppm -scale-to 1800`;
no Dockerfile installs it, so the agent has to `apt-get install poppler-utils`
over the internet first [verified].

Vector or scanned? The sample PDFs could not be downloaded here (host
blocked), so this is inferred:

- Defects were planted by editing the original PDFs: 80 of 82 bbox-carrying defects use `edit_mode: redact_replace` with `style_fidelity: exact`, one `region_rewrite`, one `stream_patch`, and bbox coordinates like `[1871.99, 699.31, 1900.40, 708.96]` on 2,400 pt wide sheets [verified]. Redact-and-replace of a text run with exact style only works on a text layer, so the edited sheets are born-digital vector PDFs with text [inferred from verified data].
- Every intra-drawing instruction tells the agent to run `pdftotext` on the whole set to build a sheet-number to page map [verified]; Nomic reports 77 percent of trajectories did so [reported]. That strategy only works with a text layer.
- At least one corpus file is an OCR'd scan: `Greenback Sewer Lift Station No3 ... Full Set OCR.pdf` sits next to its non-OCR twin in the navigation corpus [verified from filenames]. Expect a minority of scanned sheets, mostly in the 89-file navigation corpus.
- Source projects are public bid sets and Habitat for Humanity house plans (ten `*HabitatForHumanity*` / `*Habitat*` files, UCCS, USU, WCU, Darrington Library, Lear Theater, OMD Rees EB6, North Macon, WPL) [verified from filenames]; Nomic describes them as real documents from public-sector projects [reported].

Whether a given sheet has a text layer can be checked offline once the files
are fetched: `pdffonts file.pdf` (no fonts means no text) or
`pdf2takeoff mcp` `read_text`, which reports "few or no words on scanned
sheets" [verified, `src/headless/mcp.ts`].

## Licence

- Code, task definitions, ground truth and harness: Apache-2.0 (`LICENSE` at the repo root) [verified].
- The PDFs themselves carry no licence file in the repo and are served from Nomic's bucket; the README says only that "large documents are not checked into this repository" [verified]. The underlying drawings are copyrighted by their design firms even when posted as public bid documents; treat them as research-use data and do not redistribute them inside pdf2takeoff [assessment].
- Paper: arXiv 2603.29199, CC BY 4.0 per a search snippet [reported].

## Availability and what I downloaded

Downloaded [verified]:

- `github.com/nomic-ai/aec-bench` at commit `3f50ae80516422138ea643236cf145f978245cbb` (2026-05-19), 1,201 files, 9.1 MB, into `/tmp/claude-0/-home-user-pdf2takeoff/db387ea9-d3a7-5ddc-8c81-f410e6f4815f/scratchpad/aecbench/repo/`.
- `github.com/harbor-framework/harbor` at commit `7331d8a3e23cb72e8277522059ff7c9ab9435d90` (2026-10-18) into `/tmp/claude-0/-home-user-pdf2takeoff/db387ea9-d3a7-5ddc-8c81-f410e6f4815f/scratchpad/harbor/repo/`, to read the MCP plumbing.
- `harbor` 0.24.0 CLI installed with `uv tool install harbor` (PyPI reachable); `harbor trials start --help` lists `--agent-import-path`, `--agent-kwarg`, `--mcp-config`.

Not reachable from this sandbox (proxy returned 403 on CONNECT): `arxiv.org`,
`huggingface.co` (dataset `nomic-ai/aec-bench`), `nomic-public-data.com`,
`nomic.ai` [verified]. No sample PDF could be inspected.

Files read, all under the clone above [verified]:

- `README.md`, `LICENSE`, `pyproject.toml` (`harbor>=0.1.44`), `uv.lock` (pins harbor 0.3.0), `.env.sample`, `.gitignore` (`jobs/`, `trials/` ignored: no results are shipped).
- `aec_bench/agents/base_agent.py`, `claude_agent.py`, `codex_agent.py` (skimmed), `response_parser.py`, `nomic_agent.py` (skimmed).
- `assets/plot.png` (the only published results artefact in the repo).
- Family READMEs: `tasks/*/*/README.md` (9) and `tasks/intradrawing/cross-reference-tracing/REVIEW_NOTES.md`.
- One full instance per family: `note-callout-accuracy/03addendum-joist-beam-mismatch`, `cross-reference-resolution/2021-0525_uccs-cybersecurity-broken`, `sheet-index-consistency/1bb649-mechanical`, `drawing-navigation/easy-darrington-sections`, `detail-technical-review/03add-constructability-01`, `detail-title-accuracy/03-addendum1-office-a700-foundation-mislabel`, `cross-reference-tracing/darr-2-a851-easy`, `spec-drawing-sync/nmacon-gypsum-board-easy`, `submittal-review/easy-approved-accessories` (each: `task.toml`, `instruction.md`, `environment/manifest.jsonl`, `environment/Dockerfile`, `gt.json`, `tests/test.sh`).
- Aggregates computed with `python3 -I` over all 196 `task.toml`, `manifest.jsonl`, `Dockerfile`, `gt.json`.
- Harbor: `src/harbor/models/task/config.py` (`EnvironmentConfig.mcp_servers`, `MCPServerConfig`, `merge_mcp_servers`), `src/harbor/agents/installed/claude_code.py` (`_build_register_mcp_servers_command`), `src/harbor/trial/trial.py` (capability gate), `src/harbor/agents/capabilities.py`, `src/harbor/cli/trials.py` (`--mcp-config`).

A fork `github.com/agentic-labs/aec-bench` exists with the same description
[reported, search result]; not inspected.

## Published baselines (table)

Scope means from `assets/plot.png` in the repo (the figure the README embeds)
[verified as the repo's own asset; the numbers are Nomic's results]. H = base
harness (Claude Code CLI or Codex CLI inside the container), H+N = base
harness plus Nomic tools, N = Nomic Agent.

| Agent configuration | Intra-sheet (43) | Intra-drawing (89) | Intra-project (64) |
|---|---|---|---|
| Nomic Agent (N) | 70.6 | 88.3 | 62.0 |
| Claude Code (H) | 44.3 | 68.8 | 38.1 |
| Codex (H) | 45.6 | 82.3 | 46.0 |
| Claude Code (H+N) | 62.5 | 72.3 | 57.8 |
| Codex (H+N) | 50.0 | 77.2 | 57.2 |

The plot does not name the model ids; the README's example commands use
`anthropic/claude-opus-4-6`, `anthropic/claude-sonnet-4-6` and
`openai/gpt-5.4` [verified], so those are the likely models [inferred].

Per-task rows of the paper's Table 2 surfaced in search snippets with eight
values each but the column order (which model, H or H+) could not be
recovered; they are listed here only so a later reader with paper access can
place them [reported, column order unknown]:

| Task | Eight values as extracted |
|---|---|
| note-callout-accuracy | 28.6, 28.6, 28.6, 14.3, 0.0, 35.7, 42.9, 35.7 |
| cross-reference-resolution | 84.3, 77.5, 61.0, 67.6, 79.0, 72.5, 73.9, 68.6 |
| sheet-index-consistency | 97.6, 81.9, 82.1, 85.0, 71.4, 85.5, 72.6, 76.0 |
| cross-reference-tracing | 89.2, 77.1, 79.5, 73.8, 56.4, 62.0, 59.2, 69.3 |
| submittal-review | 15.0, 19.0, 11.8, 19.0, 17.1, 16.7, 6.5, 23.1 |

Third parties (Structured AI, AECFoundry) have published their own runs with
different numbers [reported, not fetched]; they are not comparable without
the harness details.

## How pdf2takeoff would run on it (step list)

What the engine offers against each family (from `src/headless/mcp.ts` tool
descriptions [verified] and the task definitions [verified]):

| Family | pdf2takeoff tool | Plausible gain | Why |
|---|---|---|---|
| sheet-index-consistency | `read_text` with a title-block `region` per page | high | Positioned words beat `pdftotext` for isolating the title block; sheet number and title come back as exact strings with coordinates |
| cross-reference-resolution | `read_text` (whole page, then target sheets) | medium | Finds every "N/Axxx" token with position on the reviewed page and confirms target sheet and detail-number strings exist; still needs `render_page` to see bubble geometry |
| cross-reference-tracing | `read_text` across all pages | medium | Text search over the set with positions; the agent still renders candidates to confirm |
| drawing-navigation | `open_document` + `read_text` of page 1 and title blocks | low to medium | 89 PDFs, many over 100 pages; `pdftotext` on all files is cheaper than opening each through pdf.js, so gain is in precision of the title-block read, not speed |
| detail-title-accuracy, note-callout-accuracy | `read_text` (titles, note text with baseline angle) + `render_page` | low | The judgement is visual (what is drawn versus what the text says); exact text helps spelling of the keywords the grader expects |
| spec-drawing-sync | `read_text` on wall-type legends | low | The spec side is a text PDF; the drawing side benefits a little |
| submittal-review, detail-technical-review | none | none | Pure domain reasoning over text and product data |
| any | `compare_revisions` | none legitimately | No task is a revision pair. The planted defects were made by editing originals that also sit in the navigation corpus (for example `2021-0525_UCCS BID SET - Drawings.pdf`); diffing an instance file against that original would reveal the planted edits, which is contamination, not a result. Do not do this, and keep the navigation corpus out of the other families' containers |
| any | `measure`, `fill_area`, `scan_symbol`, `set_scale`, `export` | none | AEC-Bench has no quantity, count, area or scale task |

Harness changes [verified against the code]:

1. Fetch inputs: loop over every `environment/manifest.jsonl`, `curl` each `key` into `environment/<dest>` (271 unique files; sizes unknown, expect several GB because drawing-navigation alone has 89 full sets).
2. Add `aec_bench/agents/claude_pdf2takeoff_agent.py` subclassing `ClaudeAgent`:
   - `setup()`: after the Claude CLI install, `apt-get install -y nodejs` (Node 22.6 or newer via nodesource; the repo already falls back to nodesource for npm), `apt-get install -y poppler-utils` so H and H+ are matched on that, then install pdf2takeoff into `/opt/pdf2takeoff` (clone plus `npm ci`; `@napi-rs/canvas` ships a `linux-x64-gnu` binary so no compiler is needed [verified in `node_modules/@napi-rs`]).
   - Register the MCP server exactly as Harbor's built-in agent does: write `{"mcpServers": {"pdf2takeoff": {"type": "stdio", "command": "node", "args": ["/opt/pdf2takeoff/bin/pdf2takeoff.js", "mcp"]}}}` to `$CLAUDE_CONFIG_DIR/.claude.json` (user scope loads without a trust prompt; `--permission-mode bypassPermissions` is already set) [verified, `claude_code.py` `_build_register_mcp_servers_command`].
   - Extend `_AEC_PREAMBLE` with two sentences: text values must come from `read_text`, and coordinates are PDF points, bottom-left origin.
   - Set `capabilities.mcp_servers = True` on the class if you prefer passing servers through Harbor (`--mcp-config` or `[environment] mcp_servers` in `task.toml`); Harbor refuses MCP servers on an agent that does not declare the capability [verified, `trial.py`]. Writing `.claude.json` in `setup()` sidesteps this.
3. Upgrade the project to the Harbor you run: `uv.lock` pins harbor 0.3.0 while PyPI is at 0.24.0; `allow_internet` is now a deprecated alias and `BaseAgent.__init__` grew `mcp_servers` and `skills_dir` kwargs, so run `uv sync --upgrade-package harbor` and smoke-test one task with the unmodified `ClaudeAgent` first.
4. Pilot (same model, `-n 4`): `harbor jobs start -p tasks/intradrawing/sheet-index-consistency --agent-import-path aec_bench.agents.claude_agent:ClaudeAgent -m anthropic/<model>` and the same with `claude_pdf2takeoff_agent:ClaudePdf2takeoffAgent`. 14 tasks x 2 harnesses x 3 repeats = 84 trials.
5. Full run: all nine families (Harbor does not recurse, so loop over the nine family directories) x 2 harnesses = 392 trials per model and repeat; add `--agent-kwarg max_turns=60` to bound cost.
6. Analyse: `reward.json` per trial, plus `trajectory.json` tool-call names to report MCP adoption (share of trials that called `read_text` at least once) and token counts (`n_input_tokens`, `n_output_tokens` are recorded by the agent).

Cost estimate [estimate, not measured]: a trial reads 10 to 15 page images at
1,800 px (roughly 2,500 to 3,000 tokens each) plus `pdftotext` output that can
run to 100k tokens on a full set, so 100k to 300k input tokens and 5k to 20k
output tokens per trial. 392 trials lands at roughly 40M to 120M input tokens
per model and repeat; three repeats triple that. Price it at the current rate
of the chosen model. Wall clock: 900 s cap per trial, 4 concurrent, so about
one day per 392 trials.

## Effort and blockers

- Engineering: 2 to 3 days (agent class, container install script, prefetch script, a results notebook).
- Compute and API: Docker host with roughly 10 GB free per concurrent task (10 GB storage is requested per container) and an Anthropic key; the Claude installer returns 403 from some cloud IPs and the repo already falls back to `npm install -g @anthropic-ai/claude-code` [verified in `claude_agent.py`].
- This sandbox: Docker client present, no daemon socket; `nomic-public-data.com`, `arxiv.org`, `huggingface.co` blocked. Nothing can be executed here beyond reading [verified].
- Harbor version drift (0.3.0 pinned versus 0.24.0 current) may break `AECBaseAgent`; budget half a day.
- pdf2takeoff on large sets: `open_document` walks every page to report sizes [verified], and drawing-navigation sets run to hundreds of pages; measure the latency on a 200-page set before the pilot, and consider a lazy page-size path.
- Memory: 4,096 MB per container; pdf.js plus `@napi-rs/canvas` rendering a 42 inch sheet at high DPI can exceed that. `render_page` should default to a capped long edge for this experiment.
- Comparability: results are only comparable to the published numbers if the same model, the same `max_turns` and the same preamble are used; Nomic's exact settings are not in the repo [verified: no job config or results shipped].

## Open questions

- Which model ids and `max_turns` produced the published plot? Not in the repo; ask Nomic or read the paper.
- What fraction of the 271 PDFs lack a text layer? Needs `pdffonts` over the downloaded corpus.
- Does the submittal-review grader accept "No issues found" lines, or only an empty NOT_MET set? The `approved` script only checks for the absence of NOT_MET and CANNOT_VERIFY lines [verified], so an agent that writes only MET lines scores 1.0.
- Should pdf2takeoff add a `sheet_index` convenience tool (page to sheet-number map from title-block regions)? That is the single operation every intra-drawing task starts with and would make the MCP variant a one-call improvement.
- The project's literature review (`docs/research/ai-literature-review.md`) does not currently mention AEC-Bench or TakeoffBench; this note is the first coverage. The brief for this research assumed otherwise.

## Sources

- Repo: https://github.com/nomic-ai/aec-bench (commit 3f50ae8, cloned 2026-10-18) [verified]
- Paper: https://arxiv.org/abs/2603.29199, Mankodiya, Gallik, Galanos, Mulyar, 2026 [reported; not fetched]
- Nomic announcement: https://www.nomic.ai/news/aec-bench-a-multimodal-benchmark-for-agentic-systems-in-architecture-engineering-and-construction [reported via search snippets]
- Dataset page: https://huggingface.co/datasets/nomic-ai/aec-bench [reported; blocked]
- Harbor framework: https://github.com/harbor-framework/harbor (commit 7331d8a) and https://harborframework.com [verified repo; site blocked]
- Local clones: `/tmp/claude-0/-home-user-pdf2takeoff/db387ea9-d3a7-5ddc-8c81-f410e6f4815f/scratchpad/aecbench/repo/` and `/tmp/claude-0/-home-user-pdf2takeoff/db387ea9-d3a7-5ddc-8c81-f410e6f4815f/scratchpad/harbor/repo/`
- pdf2takeoff tool surface: `/home/user/pdf2takeoff/src/headless/mcp.ts`, `/home/user/pdf2takeoff/specs/headless-engine.md` [verified]
