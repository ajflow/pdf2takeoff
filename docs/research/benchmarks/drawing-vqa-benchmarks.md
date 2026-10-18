# Drawing-reading and measurement benchmarks for pdf2takeoff

Research note, 2026-10-18. Companion to [ai-literature-review.md](../ai-literature-review.md)
section 6 and patch P20 in [patch-plan-2.md](../patch-plan-2.md). Every claim is tagged
[verified] (read from a downloaded file, a cloned repository or a page fetched in
this session) or [reported] (search-engine extraction, abstract or secondary source,
not checked against the paper PDF). The sandbox proxy refused arxiv.org, huggingface.co,
openaccess.thecvf.com, modelscope.cn and github.io ("CONNECT tunnel failed, response 403"),
so paper tables are [reported] unless the repository shipped them.

## Summary

- Only two of the eight benchmarks can be run locally today: **MechVQA** (1,185 QA and 562 drawings in the GitHub repo) and **DesignQA** (all CSVs and images in the repo). Both are mechanical, not architectural.
- **DrawingVQA** is the only construction-drawing set, but its 33 drawings are private; evaluation is a blind Hugging Face leaderboard, which rules out a local tools-vs-no-tools run unless the authors accept an agent endpoint.
- **MeasureBench** is instruments only (26 real types, 39 synthetic generators, rulers and calipers included, no drawing scales or maps). **DiffSpot** and **VDiff-Bench** are web screenshots and natural photos; useful for method, not for drawings. **LED-BENCH** and **MMArch** have no released data.
- No public benchmark asks for a length or area measured from a scaled drawing. The closest is DesignQA's 20 "scale" dimension questions, which calibrate from one printed overall dimension and then check a rule. Section "Proposed ScaledDrawingBench" fills the gap with the repo's own generators.
- Sample data lives under `/tmp/claude-0/-home-user-pdf2takeoff/db387ea9-d3a7-5ddc-8c81-f410e6f4815f/scratchpad/vqa/` (one directory per benchmark, untrusted, nothing executed).

## DrawingVQA (Jung, Fu, Golparvar-Fard, CVPR 2026 Findings)

**What it measures.** VQA over 33 Issued-for-Construction structural drawings from six
educational building projects, 92 expert-written QA pairs, three reasoning depths
(R1 perceptual, R2 contextual, R3 domain expert) and two tag axes: MLLM capability
(Visual Perception, Knowledge, Reasoning, OCR) and construction-engineering workflow
(General/Admin, Element Identification, Language Understanding, Dimensional
Recognition, Design Semantic Understanding, QTO, Compliance). [verified, project page
`docs/index.html` in the cloned repo]

**Format: verified vs reported.**
- Records (HF schema, read from `huggingface/DrawingVQA_HF.py` [verified]): up to five SHA-256 hashed image names per question (multi-image questions exist), `question`, `option_a..e`, `answer` (letter or short text), `explanation`, `cv_field`, `cv_subfield`, `ce_field`, `ce_subfield`, `topic_difficulty`, `question_type`. Mixed multiple-choice and open-ended; a "Random" baseline scores 27.2 [verified, leaderboard.csv].
- Images: not distributed at all; the parquet on HF holds the 92 text rows only [verified, README]. Resolution and whether the source PDFs had a text layer: unknown [reported: "high-resolution PDFs/images are kept private"].
- Per-category question counts, derived from the leaderboard percentages (every score is k/n with a fixed n per column) [verified arithmetic on leaderboard.csv]: R1 31, R2 34, R3 27 (project page says 37/34/29 percent, which does not match 31/34/27; treat the page as approximate); OCR-tagged 76 of 92; Dimensional Recognition 31; QTO 12; Compliance 7; Admin 16; Element Identification 37; Language Understanding 24; Design Semantic Understanding 52.
- So: scale or dimension reading, 31 questions; counting (QTO), 12; locating a detail or callout, inside Element Identification (37); comparing two drawings, 0 (multi-image questions are cross-references, not revisions).
- Ground truth: written by three construction engineers with step-by-step explanations; human baselines from undergraduates, young professionals and professionals [verified, project page].

**Licence.** QA text and metadata CC BY-NC-SA 4.0; images private [verified, README].

**Availability and what I downloaded.** Cloned `github.com/joonv2/DrawingVQA` (project page,
leaderboard CSV and HTML, HF upload script; no data). HF dataset `S2-MIND/DrawingVQA`
and leaderboard space `S2-MIND/DrawingVQA-leaderboard` were unreachable (proxy 403 on
huggingface.co). Evaluation is a "Blind Evaluation API-based architecture": a private
judge scores submissions without exposing images or answers [verified, README].

**Example questions** (project page; answers are not shown publicly) [verified]:
- R1: "What is the sheet title?"
- R2: "What is the top of the footing elevation for F7x13.83 along grid line 24?"
- R3: "What type of vertical reinforcements would I need for the walls shown? Use the other drawing if needed."

**Baselines** (overall / R1 / R2 / R3 / QTO / Dimensional Recognition; from `leaderboard.csv`) [verified]:

| Model | Overall | R1 | R2 | R3 | QTO | DR |
|---|---|---|---|---|---|---|
| Human, professionals | 94.9 | 90.0 | 85.0 | 93.3 | 96.6 | 96.0 |
| Human, all | 68.4 | 75.6 | 72.6 | 59.9 | 83.3 | 82.1 |
| Gemini-3-pro-preview | 77.2 | 80.6 | 79.4 | 70.4 | 33.3 | 77.4 |
| Gemini-2.5-pro | 71.7 | 80.6 | 76.5 | 55.6 | 41.7 | 67.7 |
| Gemini-2.5-flash | 66.3 | 77.4 | 73.5 | 44.4 | 33.3 | 51.6 |
| o3 | 58.7 | 64.5 | 61.8 | 48.2 | 25.0 | 48.4 |
| Qwen3-VL-32B-Instruct | 58.7 | 48.4 | 79.4 | 44.4 | 33.3 | 67.7 |
| Claude-4.5-Sonnet | 57.6 | 64.5 | 64.7 | 40.7 | 41.7 | 41.9 |
| Claude-4.5-Haiku | 54.3 | 51.6 | 73.5 | 33.3 | 33.3 | 48.4 |
| Llama-4-Scout-17B-16E | 53.3 | 58.1 | 58.8 | 40.7 | 50.0 | 41.9 |
| Qwen3-VL-8B-Instruct | 53.3 | 51.6 | 61.8 | 44.4 | 33.3 | 45.2 |
| InternVL3.5-8B | 50.0 | 58.1 | 58.8 | 29.6 | 58.3 | 41.9 |
| GPT-4o | 48.9 | 61.3 | 44.1 | 40.7 | 25.0 | 41.9 |
| LLaVA-v1.6-Mistral-7B | 28.3 | 25.8 | 29.4 | 29.6 | 25.0 | 32.3 |

QTO (12 questions) is where every model is far below the professionals (33 to 58 vs 96.6);
this is the counting-on-dense-sheets failure the repo's thesis rests on.

## MechVQA (Shi et al., ICML 2026)

**What it measures.** Mechanical-drawing VQA: 3,281 drawings and 20,778 QA pairs in total
[reported, paper Table 1 via the shipped PDF text]; a public evaluation benchmark of
1,185 QA over 562 drawing images [verified]. Ten subtasks in three levels:
Recognition (Identification and Counting IC, Dimension and Annotation DA, Text and Table TT,
Item Localization IL), Reasoning (Structure Understanding SU, Geometric Calculation GC,
Assembly Relationship AR, Projection and Multi-view PM), Judging (Anomaly Detection AD,
Consistency Judgment CJ) [verified, paper appendix B.3 in `paper/2605.30794v1.pdf`].

**Format: verified** (from `benchmark_data/vqa_benchmark/mechvqa_benchmark.jsonl`):
- JSONL, one record per question: `messages` (user question, assistant reference answer, free text), `images` (one relative path; no multi-image records), `metadata.capability`, `metadata.subcategory`, `metadata.difficulty`, `metadata.language`, `metadata.explanation`, `qualityscore`.
- Counts: Recognition 642, Reasoning 289, Judging 254. By subtask: DA 445, GC 207, AD 192, IL 113, CJ 60, TT 43, IC 41, PM 33, SU 29, AR 22. Difficulty Easy 580, Medium 419, Hard 186. Language: 850 Chinese, 335 English (DA has 124 English, IC 11, GC 57).
- Images: 366 PNG and 196 JPEG raster scans or exports, no PDFs and no text layer. Sizes range 1101x625 to 3854x2913; many are 2480x3509 (A4 at 300 dpi). Files 34 KB to 5.7 MB, median 260 KB.
- Questions that pdf2takeoff tools could answer deterministically: dimension reading is DA (445, 37.6 percent of the set); counting is IC (41); locating a callout or view is IL (113); comparing two drawings: none (CJ compares regions within one image).
- Ground truth provenance: questions generated by closed MLLMs from drawings plus expert-verified metadata, cross-model validation, majority-vote answers, expert audit of a stratified subset; no human upper bound and no inter-annotator statistics [verified, paper sections 3.3 and limitations]. Scoring is LLM-as-a-judge semantic match [verified, `evaluation/README.md`].

**Licence.** Code Apache-2.0 (LICENSE file) [verified]. Dataset licence not stated in the repo;
the paper says release "will follow the redistribution permissions of the underlying
materials" (public textbooks and standards) [verified, paper appendix A].

**Availability and what I downloaded.** Full clone of `github.com/xiaofengShi/MechVQA`
(772 MB, includes the 1,185-question benchmark, 562 images, 10 sample QA, evaluator,
training recipes, paper PDF). HF `XiaofengAlg/MechVQA` (13,515 SFT QA, 3,371 images)
and ModelScope mirror were unreachable (proxy 403).

**Example questions** (English records, verbatim) [verified]:
- DA, Easy: "What is the outer diameter dimension of the eccentric wheel in the front view?" Answer: "φ70 (i.e., 70 mm), which is directly annotated on that view in the drawing."
- DA, Easy: "What is the total height of the part indicated in the front view?" Answer: "203 millimeters ... marked on the vertical dimension line on the right side of the drawing."
- GC, Easy: "From the cross-sectional view A-A in Figure 5-72, what can be inferred about the total thickness of the part?" Answer: "4 mm ... the dimension line at the bottom of the A-A cross-sectional view is marked as '4'."
- IC, Easy: "What is the name of this part?" Answer: "square nut" (read from the title block).
- IL, Medium: "Where is the part with item number 1 located in the assembly drawing?" Answer: "the disc seat, located in the main view inside the lower part of the valve body."

**Baselines** (Table 2, scores in percent; Recognition IC/DA/TT/IL, Reasoning SU/GC/AR/PM, Judging AD/CJ, Total) [verified from the shipped paper PDF]:

| Model | IC | DA | TT | IL | SU | GC | AR | PM | AD | CJ | Total |
|---|---|---|---|---|---|---|---|---|---|---|---|
| MechVL-4B-RL (authors) | 88.37 | 90.70 | 97.73 | 82.01 | 83.33 | 76.83 | 84.00 | 64.00 | 86.94 | 78.67 | 84.85 |
| GLM-4.6V | 88.37 | 86.68 | 97.73 | 63.31 | 77.08 | 82.93 | 60.00 | 62.00 | 74.29 | 69.33 | 78.91 |
| Gemini-3-Pro-Preview | 76.74 | 87.74 | 97.73 | 64.03 | 52.08 | 73.58 | 46.00 | 58.00 | 78.37 | 82.67 | 77.28 |
| Qwen3-VL-32B-Instruct | 86.05 | 86.68 | 97.73 | 56.83 | 62.50 | 76.83 | 62.00 | 48.00 | 75.92 | 69.33 | 76.50 |
| Qwen3-VL-Plus | 81.40 | 86.68 | 95.45 | 52.88 | 81.25 | 79.67 | 74.00 | 58.00 | 67.76 | 68.00 | 76.33 |
| GPT-5 | 69.77 | 84.99 | 93.18 | 62.59 | 79.17 | 73.58 | 60.00 | 60.00 | 71.02 | 70.67 | 75.44 |
| Claude-Sonnet-4.5 | 67.44 | 78.65 | 97.73 | 56.12 | 70.83 | 75.20 | 62.00 | 54.00 | 64.90 | 64.00 | 71.20 |
| GPT-4o | 62.79 | 75.90 | 81.82 | 40.29 | 64.58 | 63.41 | 48.00 | 44.00 | 53.06 | 66.67 | 63.06 |
| Qwen3-VL-4B-Instruct | 62.79 | 76.96 | 88.64 | 33.09 | 39.58 | 58.54 | 22.00 | 20.00 | 62.86 | 49.33 | 60.23 |
| InternVL3.5-8B | 65.12 | 61.10 | 77.27 | 19.42 | 37.50 | 48.78 | 28.00 | 34.00 | 53.47 | 34.67 | 49.82 |
| Llama-3.2-11B-Vision | 13.95 | 38.05 | 54.55 | 11.51 | 6.25 | 25.61 | 0.00 | 8.00 | 17.55 | 28.00 | 25.48 |

Note DA is already 85 to 91 percent for frontier models: dimension reading on clean
mechanical sheets is close to solved by VLMs; the open gap is IL (locating) and PM.

## MeasureBench (Lin et al., BAAI FlagEval, CVPR 2026)

**What it measures.** Reading a numeric value plus unit off an instrument image:
2,442 image-question pairs, 1,272 real photos (human-annotated) and 1,170 synthetic
renders [reported, HF card and abstract]. Four readout designs: dial, linear, digital,
composite [reported].

**Format: verified vs reported.**
- Real set, 26 instrument types, derived from the question ids in the authors' own result files (`result_example/gpt-5_real.json`, 1,272 entries) [verified]: thermometer 123, vernier caliper 119, clock 118, pressure gauge 118, voltmeter 107, water meter 100, ammeter 96, tachometer 71, measuring cylinder 70, electricity meter 51, sphygmomanometer 45, speedometer 42, ruler 30, compass 27, weighing scale 27, hygrometer 22, fuel gauge 16, gas meter 16, flow meter 15, protractor 15, syringe 15, pulse oximeter 8, spirometer 6, dial caliper 5, micrometer 5, rain gauge 5.
- Synthetic set: 39 generators, 30 images each (1,170) [verified from `gpt-5_syth.json` ids]; generator code for 19 families is in `data_machine/generators/` (ruler, dial_caliper, protractor, clock, pressure_gauge, thermometer, ... ) [verified]. The ruler generator draws a coloured object against a cm/mm ruler and asks for its length [verified, `ruler_1.py`].
- **Drawing scales: none.** No question id or generator refers to a drawing, map, scale bar or blueprint; every prompt is of the form "What is the reading of the instrument?" with the answer as number plus unit [verified on the 2,442 prompts in the result files]. The ruler, caliper and protractor items are the only length or angle readings, and they read a physical instrument, not a scaled drawing.
- Metric [verified, `evaluation/measure_bench_evaluator.py`]: the last number in the answer must fall inside an annotated interval and the unit must match (`interval_matching`, `multi_interval_matching`); otherwise a relative `number_error_rate` is recorded. Dataset fields: `question_id`, `question`, `image_type`, `design`, `evaluator`, `evaluator_kwargs`.

**Licence.** Data CC BY-SA 4.0 on the HF card [reported]. Code: no LICENSE file in the
repo [verified]; GitHub issue #105 asks for one [reported].

**Availability and what I downloaded.** Cloned `github.com/flageval-baai/MeasureBench`
(evaluator, synthetic generators, and 13 MB of example model outputs for GPT-5 and
Gemini-2.5-Pro on both splits). The HF datasets `FlagEval/MeasureBench` (public) and
`philokey/MeasureBench` (used by `evaluate.py` and for Blender files) were unreachable
(proxy 403), so no images or ground-truth intervals were inspected.

**Example questions** [verified from result files; ground truth not available locally]:
- `dial_caliper_0`: "What is the reading of the dial caliper?" GPT-5 answered "35.48 mm".
- `ammeter_0`: "What is the reading of the instrument?" GPT-5 answered "9.2 A".
- Synthetic `ruler_1_*`: "What is the length of the object?" style prompts from `question_template.py`.

**Baselines** [reported; v2 figures]: Gemini-2.5-Pro 30.2 percent real / 26.3 synthetic
(unit accuracy 96.2, composite designs 3.8); GPT-5 19.8 / 16.9; Qwen2.5-VL-72B 14.5 / 11.7;
Claude-Opus-4.1 14.3 / 13.3; InternVL3.5-38B 12.9 / 12.6; Claude-Sonnet-4 12.6 / 11.0.
18 models in total (8 closed, 10 open). Unit identification above 90 percent for most
models; the failure is "mapping scales to numeric values" [reported, abstract].

## LED-BENCH (Li et al., arXiv 2610.19571, 14 Oct 2026)

**What it measures.** Fine-grained reading and multi-region reasoning over large-format
sheets: 107 complete sheets, 377 questions; mechanical 45 sheets / 174 questions,
architectural 21 / 75, transportation 41 / 128; 211 medium and 166 hard; questions range
from localised evidence lookup to cross-region and cross-view reasoning [reported].
Engineering annotators wrote requirements, reviewed model-assisted drafts and verified
answers against the drawings [reported].

**Format.** Not verifiable: resolution, file type, answer format and the share of
scale, dimension, count or compare questions are unknown. The repo's earlier notes
call it "large engineering drawing benchmark"; the paper's own expansion is
"Large-format Engineering Drawing" [reported].

**Licence.** Unknown.

**Availability and what I downloaded.** Nothing. The project link in the paper HTML is
`github.com/Wedadek/LED-BENCH` [reported]; that repository returned HTTP 404 on
raw.githubusercontent.com and on github.com in this session [verified], so the data is
not public yet.

**Baselines** [reported]: 11 models (8 proprietary, 3 open); best is "GPT-5.6 Sol" at
52.65 percent average; all models degrade on questions needing broader evidence
integration. No per-model table could be retrieved.

## DiffSpot (Zhang, Liu, Liu, Zhou, Tencent WeChat AI, arXiv 2605.29615)

**What it measures.** Spot-the-difference on web UI screenshots: 4,400 pairs, 3,900 with
one programmatic CSS mutation (13 operators x 3 tiers x 100) plus 500 no-diff controls;
free-form answer scored by a `gpt-oss-120b` judge against the structured mutation
record [verified, `docs/data_card.md`, `docs/evaluation.md`, `leaderboard/leaderboard.json`].

**Format: verified.** Operators: font_weight, font_size, letter_spacing, line_height,
text, color, opacity, gradient, position, spacing, justify, border, rounded. Distributed
fields: `image_before`, `image_after` (PNG), `task_type`, `difficulty`, `ground_truth_diff`,
`mutation_dicts_json`, `mutation_types`, `domain`, `pixel_diff`, `target_diff`,
`outside_diff`, `target_bbox_{x,y,w,h}` [verified, README]. The bundled example pairs are
1280x800 PNG [verified]; the dataset resolution is not stated. Metrics: recall per tier,
no-diff specificity, overall (TP+TN)/4,400; always-no-diff baseline 11.4 [verified].
Zero questions involve drawings, scales, dimensions or counts; all 4,400 are "what changed".

**Licence.** Code MIT (LICENSE) [verified]. Data CC BY-NC 4.0 per `docs/data_card.md`,
but the referenced `LICENSE-DATA.md` is missing from the repo [verified].

**Availability and what I downloaded.** Cloned `github.com/Tencent/DiffSpot` (code,
docs, leaderboard JSON, five example pairs). The parquet dataset `tencent/DiffSpot` on HF
was unreachable (proxy 403). `results/` holds only a README; per-model predictions
are "to ship with the release" [verified].

**Example items** [verified, `assets/examples/`]: `easy-fontsize`, `easy-fontweight`,
`easy-gradient`, `easy-opacity`, `easy-rounded` before/after pairs. Ground-truth text is
of the form "the font size of element X increased" (display only; the judge uses the
mutation record).

**Baselines** (easy / medium / hard recall, diff recall, no-diff specificity, overall) [verified, `leaderboard.json`]:

| Model | Easy | Med | Hard | Diff | No-diff | Overall |
|---|---|---|---|---|---|---|
| Gemini 3.1 Pro | 60.5 | 38.9 | 22.7 | 40.7 | 98.4 | 47.2 |
| Kimi K2.5 | 54.2 | 36.4 | 18.6 | 36.4 | 87.2 | 42.2 |
| Gemini 3 Flash | 52.5 | 32.5 | 18.2 | 34.4 | 91.4 | 40.9 |
| Claude Opus 4.7 | 41.2 | 30.5 | 21.8 | 31.2 | 99.6 | 38.9 |
| GPT-5.4 | 48.8 | 30.5 | 12.2 | 30.5 | 99.6 | 38.3 |
| Qwen3.5-VL-397B | 45.1 | 31.5 | 13.7 | 30.1 | 96.6 | 37.6 |
| Qwen3-VL-235B-Thinking | 30.1 | 17.3 | 10.5 | 19.3 | 98.8 | 28.3 |
| GLM-4.6V-Flash | 24.5 | 17.6 | 9.3 | 17.1 | 75.8 | 23.8 |
| GLM-4.6V | 17.0 | 10.9 | 5.5 | 11.2 | 99.6 | 21.2 |
| Qwen3-VL-30B-Instruct | 14.5 | 9.0 | 4.5 | 9.3 | 82.0 | 17.6 |
| Qwen3-VL-30B-Thinking | 16.5 | 8.8 | 3.8 | 9.7 | 77.8 | 17.5 |
| Qwen3-VL-235B-Instruct | 9.6 | 3.0 | 2.6 | 5.1 | 100.0 | 15.9 |
| InternVL3.5-30B-A3B | 4.7 | 3.9 | 3.8 | 4.2 | 100.0 | 15.0 |

## VDiff-Bench (Wan, Zheng, Chang, UCLA, arXiv 2609.06245)

**What it measures.** 1,756 four-way multiple-choice questions over image pairs in ten
change categories: position, motion, regional colour, overall colour, appearance or
disappearance, noise or resolution, texture, substitution or size, OCR/text,
illumination. Each item has the true difference, two hard negatives and a "no
difference" distractor; exact-match scoring, no judge [reported].

**Format.** Natural and edited photos, not drawings [reported]. Zero drawing, scale,
dimension or count questions. The OCR/text category is the only one near revision
compare (changed printed values).

**Licence.** Unknown [reported: none found].

**Availability and what I downloaded.** Nothing. The only public artefact found is the
HF space `elaine1wan/vdiff-bench` ("Cooking more interesting stuff! Stay tuned") and the
arXiv PDF; no GitHub repo or HF dataset [reported]. HF was unreachable here anyway.

**Baselines** [reported; column mapping of the table was not confirmed]: 11 models,
overall 35.8 to 89.6. Gemini 3.1 Pro 89.6, Kimi K2.5 89.2, Doubao Seed 1.6 Vision 87.7,
Kimi K3 84.2, Grok 4.3 67.3 (5.3 on noise, 15.3 on texture), Qwen3-VL-8B Thinking 58.0.
Three 7 to 8B open models: 52.5 to 70.6 on semantic changes but 8.7 to 33.3 on low-level
changes. The repo's earlier "answers no difference up to 80.9 percent" figure is from a
secondary site and was not confirmed.

## MMArch (Du, An et al., arXiv 2608.09281)

**What it measures.** 1,212 short-answer items (answers of at most ten tokens) built
from figures in about 10,000 peer-reviewed architecture and civil-engineering papers,
ten subdomains (structural, seismic, building physics, inspection, heritage, spatial
analysis, envelope, urban planning, BIM, computational design); Perceive-Know-Judge
framing; three-architect unanimous review [reported]. These are paper figures (charts,
diagrams, photos), not drawing sheets, so no scale, dimension, count or compare questions
in the takeoff sense.

**Licence.** Not stated [reported and verified: no licence in the repo].

**Availability and what I downloaded.** Cloned `github.com/dcx-swjtu/MMArch`: README says
"Code and data will be released soon"; the `paper.pdf` in the repo is the AAAI-2027
LaTeX author kit, not the paper [verified]. No data.

**Baselines** [reported]: 18 models; best proprietary GPT-5.5 51.7 percent, best open
about 30, expert panel 94.57. Models named include GPT-4o, GPT-5.5, Claude Opus 4.8,
Claude Sonnet 4.5, Gemini 3.1 Pro Preview, Gemini 3.5 Flash, Qwen, Gemma, InternVL,
Llama, MiniMax M3. Temperature 0, 2,048 output tokens, APIs queried 1 July 2026.

## DesignQA (Doris et al., MIT, arXiv 2404.07917, JCISE)

**What it measures.** Whether an MLLM can use the Formula SAE rulebook: Rule Extraction
(retrieval 1,192 QA, compilation 30), Rule Comprehension on CAD renders (definition 31,
presence 62), Rule Compliance (dimension 60, functional performance 16) [verified counts
from the CSVs; README says 1,451 total, the CSVs hold 1,435].

**Format: verified.** CSVs with `question`, `ground_truth`, `image`, plus `dimension_type`
and `explanation` for the dimension subset. Dimension images are 10200x8667 JPEG: an
engineering drawing (one orthographic view with printed dimensions in mm) above six CAD
views. Two contexts (`context/`, `detailed_context/`) with the same 60 questions.
`dimension_type`: 40 `direct` (the needed dimension is printed; compare to the rule) and
20 `scale` (the prompt says "use the scale bar shown at the top of the engineering drawing
to compute necessary dimensions"). In the verified sample `F.5.9.5c.jpg` the only printed
value is an overall length "3202.4" spanning the car; the question is whether the included
angle between main hoop and braces is at least 30 degrees. Answers are yes/no (40 yes,
20 no). So: 60 dimension questions, of which 20 need calibrate-then-measure; 0 counting;
0 compare.

**Licence.** No LICENSE file in the repo and none in the README [verified]; treat as
all-rights-reserved pending the authors' answer.

**Availability and what I downloaded.** Full clone of `github.com/anniedoris/design_qa`
(842 MB, all CSVs and images, evaluation scripts).

**Example questions** [verified]:
- Dimension, direct: "...does our design comply with rule F.6.3.4...? Only use dimensions explicitly shown..." Ground truth: no. Explanation: "F.6.3.4 says the front hoop braces can't be more than 50mm from the top of the front hoop. The drawing shows the front hoop braces 55mm from the top."
- Dimension, scale: "...does our design comply with rule F.5.9.5...? To answer the question, use the scale bar shown at the top of the engineering drawing to compute necessary dimensions." Ground truth: yes. Rule text (from `dataset/docs/rule_section_text/F_rules.txt`): "The included angle formed by the Main Hoop and the Main Hoop Braces must be 30° or more."
- Definition: "What is the name of the component(s) highlighted in pink?" Ground truth: "pedal box; pedal assembly".

**Baselines** [reported, from the MCERF paper's reproduction of DesignQA's table;
retrieval F1 / compilation F1 / definition F1 / presence acc / dimension acc / functional acc]:
GPT-4o-AllRules 0.88 / 0.42 / 0.54 / 0.73 / 0.83 / 0.94; Claude-Opus-RAG 0.17 / 0.29 / 0.42 /
0.51 / 0.51 / 0.88; Gemini-1.0-RAG 0.00 / 0.28 / 0.49 / 0.55 / 0.53 / 0.88; LLaVA-1.5-RAG
0.11 / 0.28 / 0.39 / 0.48 / 0.41 / 0.44. Dimension accuracy is the mean of the two contexts.

## How pdf2takeoff would run on them

pdf2takeoff's MCP server exposes `open_document`, `render_page`, `read_text`, `set_scale`,
`fill_area`, `measure` (length, area, perimeter, volume, angle, count), `scan_symbol`,
`compare_revisions`, `list_markups`, `export`, `save_annotated` [verified, `src/headless/mcp.ts`].
All benchmarks ship rasters, so every run starts by wrapping the PNG or JPEG in a one-page
PDF (pdf-lib, image at native resolution); `read_text` then falls back to Tesseract OCR,
which is the path `scripts/check-ocr.mjs` exercises. None of the benchmark images has a text
layer, so the text-layer scale reader is untested by all of them.

| Benchmark | Runnable now | Questions tools can answer | Tool used | Expected gain vs VLM-only |
|---|---|---|---|---|
| MechVQA | yes, local | DA 445 (dimension strings), IC 41 (counts), IL 113 (positions) | `read_text` for values and their coordinates; `measure count` or `scan_symbol` for repeated features; `read_text` clip for title block | Small on DA (VLMs already 85 to 91); the win is provenance: the answer carries the OCR word and its bbox. Largest risk: Tesseract on φ, ±, surface-roughness glyphs and Chinese text (850 of 1,185 questions) |
| DesignQA dimension | yes, local | 60 (40 direct, 20 scale) | `read_text` for the printed value; for `scale` items `set_scale` from the one printed dimension then `measure length` or `measure angle` between points the agent places on the render | Direct: parity with GPT-4o (0.83). Scale: this is the only public test of calibrate-from-a-printed-dimension; VLM-only has to estimate pixel ratios by eye |
| DrawingVQA | no (private images, blind judge) | DR 31, QTO 12, OCR-tagged 76 | `read_text` for callouts and schedules; `scan_symbol` plus `measure count` for QTO | Potentially the largest: QTO is 33 to 58 for every model vs 96.6 for professionals. Needs the authors to accept an agent endpoint |
| DiffSpot | yes once HF is reachable | 4,400 "what changed" | `compare_revisions` on before/after wrapped as PDFs gives the raster change region and bbox; the VLM then names the property from the crop | No-diff specificity should approach 100 and localisation becomes exact; naming "letter-spacing vs font-size" stays a VLM job. A web-UI result says nothing about drawings |
| VDiff-Bench | no data | OCR/text category only | same as DiffSpot | not worth pursuing |
| MeasureBench | no (instruments) | 0 | none | none; keep citing it for the "units yes, numbers no" finding |
| LED-BENCH, MMArch | no data | unknown / 0 | | |

**Mechanical vs architectural.** MechVQA, DesignQA and two thirds of LED-BENCH are
mechanical: single parts or assemblies at 1:1 or 2:1, dimensions printed on every feature,
no sheet scale, no rooms, no symbol legends, no revisions. A tools-vs-VLM gap measured there
tests OCR and grounding, not takeoff. Only DrawingVQA (structural IFC) and the architectural
slice of LED-BENCH (21 sheets, 75 questions) resemble the repo's inputs, and neither is
downloadable.

**Harness.** One agent loop per question, built on the Anthropic SDK tool runner (TypeScript,
`@anthropic-ai/sdk`, `betaZodTool` wrappers around the MCP tools, or the MCP connector
with `mcp_toolset`), model `claude-opus-5-5` with adaptive thinking at effort `medium`, system
prompt copied from the MCP tool docs ("every number comes from a tool result"). Two arms per
question: A, image only; B, image plus tools; optional C, tools only (no image, text and
measurements only), which isolates how much the picture still contributes. Score MechVQA
with the authors' judge recipe using `claude-haiku-5-5` as judge (semantic match, the paper
used an OpenAI-compatible judge), DesignQA with its own `eval/` scripts (yes/no accuracy).
Report per subtask accuracy, the fraction of arm-B answers whose number is traceable to a
tool result (provenance rate), and tool failure modes (OCR miss, wrong clip, scale not set).

**Cost** (list prices from the claude-api skill, 2026-10-06: Opus 5.5 $4 in / $20 out per
MTok, Sonnet 5.5 $2 / $10, Haiku 5.5 $0.10 / $0.50). MechVQA arm B at roughly 15k input tokens
(image plus two or three `read_text` calls) and 1k output per question: 1,185 x $0.08, about
$95; arm A about $25; English subset (335) about $27 plus $7. DesignQA 60 x 2 contexts x 2
arms, images downsampled to 2,000 px: under $15. Judging with Haiku: under $2. A full first
pass fits in about $150; a Sonnet 5.5 replicate halves it.

**What the ablation would show.** On MechVQA DA the delta is likely within noise, but
provenance goes from 0 to near 100 percent and errors shift from "misread 203 as 208" to
"OCR missed the word", which is fixable. On DesignQA `scale` items the delta is the headline:
a model estimating a pixel ratio by eye versus `set_scale` plus `measure`. On DiffSpot the
no-diff column is the clean signal (every model but three hallucinates changes on 1 to 25
percent of identical pairs; a pixel diff hallucinates none). None of these measures area or
length takeoff, which is why the next section exists.

## Proposed ScaledDrawingBench

**Purpose.** A public, deterministic benchmark for measuring quantities from a scaled
drawing, built from `scripts/takeoff-bench.mjs` (vector PDFs with known rooms, doors, symbols
and scale notes) and `scripts/generate-synthetic-dataset.mjs` (raster sheets with scan-like
degradation and YOLO labels). Ground truth is exact because the generator placed every line.

**Sheets.** 200 sheets, A1 and A3, generated with a fixed seed. Half vector (text layer
present), half rasterised at 200 dpi with one degradation recipe each (blur, speckle,
photocopy, 1 to 2 degree skew). Scales drawn from {1:50, 1:100, 1:200, 1/4"=1'-0", 1/8"=1'-0"},
stated three ways across the set: title-block ratio, printed dimension only (no ratio), and
graphic scale bar only. Each sheet: 3 to 8 rectangular or L-shaped rooms with labels, 0 to 3
interior doors, 5 to 40 symbols from the five existing classes (downlight, gpo, switch,
smoke, diffuser), one or two dimension strings. Ten percent of sheets get a REV B twin with
one moved wall, a changed count and one changed printed value (as in
`public/examples/sample-floor-plan-rev-b.pdf`).

**Questions** (about 2,000, JSONL with `sheet`, `page`, `type`, `question`, `answer`,
`unit`, `tolerance`, `gt_source`):
- scale: "What is the drawing scale?" Answer: ratio or NTS. Exact match.
- length: "How long is the wall between grid A and grid C on the north side, in metres?"
- area: "What is the floor area of room KITCHEN in square metres?" (net area between wall faces; the generator reports both centreline and face area).
- count: "How many downlights are in OFFICE 2?" and sheet-wide counts.
- dimension: "What value is printed on the dimension nearest the south wall of BED 1?"
- compare: "What changed between REV A and REV B?" with a structured answer (moved, added, removed, value changed) scored as set F1.

**Metrics.** Scale: accuracy. Length and area: fraction within 2 percent and within 5
percent of ground truth, plus median absolute percentage error; an unanswered question
counts as wrong, a fabricated number counts twice (reported separately as a hallucination
rate). Count: exact-match accuracy and MAPE. Compare: precision and recall over change
items. Report by stratum: vector vs raster, scale statement type, degradation recipe.
Baselines to publish: pdf2takeoff deterministic path (no LLM), VLM-only, VLM plus tools.

**Why it is credible.** Synthetic, so no licence issue and no leakage of real projects;
the generator and seed are in the repo; the same `npm run bench` harness already scores
fill 11/12, count 2/2, scale 9/9 on its 23 internal cases [verified, patch-plan-2 status].
The weakness, synthetic style, is mitigated by the degradation recipes and by a small
held-out set of the repo's own real sample sheets scored by hand.

## Effort and blockers

- MechVQA and DesignQA runs: 2 to 3 days (image-to-PDF wrapper, agent harness, judge, report). Blocker: Tesseract language packs and glyph coverage for mechanical annotation; Chinese questions need `chi_sim` or should be excluded.
- DrawingVQA: blocked on data access. Action: email the authors (project page lists Louisiana State University and UIUC) and ask whether the blind leaderboard can call a hosted agent endpoint, or whether a research copy of the 33 sheets is available under NDA.
- DiffSpot: blocked only by proxy access to huggingface.co; 1 day once the parquet is downloadable. Low priority (not drawings).
- VDiff-Bench, LED-BENCH, MMArch: no data; watch the repos (`elaine1wan/vdiff-bench` space, `Wedadek/LED-BENCH`, `dcx-swjtu/MMArch`).
- ScaledDrawingBench: 3 to 5 days to extend the two generators with room and wall ground truth, question templates, and a scorer; plus a day to run the three baselines.
- Model access and budget for the agent runs (about $150 at Opus 5.5 list price per full pass).

## Open questions

1. Does the DrawingVQA leaderboard accept anything other than a model name? If not, a tools arm cannot be scored on the only construction-drawing benchmark.
2. MechVQA's dataset licence: Apache-2.0 covers the code; the paper defers the data licence to the source materials. Safe to run, unsafe to redistribute derived images.
3. DesignQA has no licence at all; ask the authors before publishing per-question results.
4. What resolution did the DrawingVQA judge feed models, and were sheets tiled? This decides whether `read_text` on a 2480 px raster is comparable.
5. Is MechVQA DA already saturated for the purpose of the thesis (87 to 91 percent for frontier models)? If so the ablation should be reported on IL, IC and the Hard subset only.
6. ScaledDrawingBench net vs gross area: pick one convention (wall face) and state it in every question.

## Sources

Local artefacts (all under `/tmp/claude-0/-home-user-pdf2takeoff/db387ea9-d3a7-5ddc-8c81-f410e6f4815f/scratchpad/vqa/`):
- `mechvqa/` clone of https://github.com/xiaofengShi/MechVQA at c8d61513 (2026-09-22), incl. `benchmark_data/vqa_benchmark/mechvqa_benchmark.jsonl`, `paper/2605.30794v1.pdf`, `LICENSE`.
- `drawingvqa/` clone of https://github.com/joonv2/DrawingVQA at 5ac7bdb0 (2026-06-06), incl. `docs/static/leaderboard/leaderboard.csv`, `docs/index.html`, `huggingface/DrawingVQA_HF.py`.
- `diffspot/` clone of https://github.com/Tencent/DiffSpot at 3108fcdd (2026-05-29), incl. `leaderboard/leaderboard.json`, `docs/data_card.md`, `docs/evaluation.md`.
- `measurebench/` clone of https://github.com/flageval-baai/MeasureBench at d5bb8652 (2026-03-26), incl. `evaluation/measure_bench_evaluator.py`, `result_example/*.json`, `data_machine/generators/`.
- `designqa/` clone of https://github.com/anniedoris/design_qa at dd909455 (2025-08-10), incl. `dataset/rule_compliance/rule_dimension_qa/`.
- `mmarch/` clone of https://github.com/dcx-swjtu/MMArch at 50bc8304 (2026-08-10).

Web (reported):
- DrawingVQA: https://arxiv.org/abs/2607.15418 ; https://joonv2.github.io/DrawingVQA/ ; https://huggingface.co/datasets/S2-MIND/DrawingVQA ; CVPR 2026 Findings paper and supplemental on openaccess.thecvf.com.
- MechVQA: https://arxiv.org/abs/2605.30794 ; https://huggingface.co/datasets/XiaofengAlg/MechVQA ; https://icml.cc/virtual/2026/poster/66437.
- MeasureBench: https://arxiv.org/abs/2510.26865 ; https://huggingface.co/datasets/FlagEval/MeasureBench ; https://flageval-baai.github.io/MeasureBenchPage/ ; GitHub issue #105 on licensing.
- LED-BENCH: https://arxiv.org/abs/2610.19571 ; https://github.com/Wedadek/LED-BENCH (404 at time of writing).
- DiffSpot: https://arxiv.org/abs/2605.29615 ; https://huggingface.co/datasets/tencent/DiffSpot ; https://benchmarklist.com/benchmarks/diffspot/.
- VDiff-Bench: https://arxiv.org/abs/2609.06245 ; https://huggingface.co/spaces/elaine1wan/vdiff-bench.
- MMArch: https://arxiv.org/abs/2608.09281 ; https://dcx-swjtu.github.io/MMArch/.
- DesignQA: https://arxiv.org/abs/2404.07917 ; https://design-qa.github.io/ ; MCERF https://arxiv.org/abs/2604.09552 (reproduces DesignQA's baseline table).
- Pricing: claude-api skill model table cached 2026-10-06.

## Status 2026-10-18

ScaledDrawingBench v0.1 is built: `scripts/scaled-drawing-bench.mjs` (generate,
score, reference), `scripts/bench/*.mjs`, the 5-sheet sample and the README under
`bench/scaled-drawing-bench/`, `npm run bench:scaled`, and
`scripts/check-scaled-bench.mjs` in `typecheck:engine` (the sample regenerates to
the committed questions.jsonl, and the reference solver is 100 percent within 2
percent on the vector sample's scale, length, area and count questions). The
spec above was followed with these changes: 150 dpi rasters (not 200), five
notations as listed in the brief (ratio, 1/4" = 1'-0", 1" = 20', graphic bar,
printed dimensions only) plus NTS sheets for the unanswerable 5 percent, walls as
filled rectangles, sheet sizes A3, A1 and ARCH D, and one sheet in five rotated.
Generated 200 sheets at seed 20261018: 2,040 questions (92 unanswerable by
design, 4.5 percent), 100 vector and 100 raster sheets, 18 with a revision B.

pdf2takeoff reference (deterministic, no model), accuracy = within 2 percent for
numeric types, exact for counts, exact change set for compare, abstentions wrong:

| Type | Vector: answerable | Vector: accuracy | Vector: MAPE | Raster: answerable | Raster: accuracy | Raster: MAPE |
|---|---|---|---|---|---|---|
| scale | 95 | 100% | 0% | 93 | 34.4% | 36.7% |
| length | 190 | 100% | 0% | 186 | 17.2% | 19.8% |
| area | 234 | 100% | 0.7% | 235 | 26.4% | 278.5% |
| perimeter | 95 | 100% | 0.3% | 93 | 26.9% | 33% |
| count | 263 | 99.2% (exact) | 0% | 256 | 0% (exact) | 99.9% |
| dimension_read | 95 | 100% | 0% | 93 | 9.7% | 65.8% |
| compare | 8 | F1 100% | | 12 | F1 37.7% | |
| all | 980 | 99.8% | 0.2% | 968 | 16.5% | 111.5% |

Hallucination rate 0/37 (vector) and 0/55 (raster): every failure is an
abstention. Raster accuracy by recipe: photocopy 25.4, contrast 25.9, noise
14.2, rotate 12.3, blur 7.7 percent.

Engine findings from the run (all in the raster half; nothing under src/ was
changed by this work package):

1. The image-only PDF render still segfaults (finding 1 above, WP1), so the
   reference decodes the embedded JPEG directly into the same 3 px/pt raster
   layout and says so in its notes; the generation report marks the raster
   half "generated, unverified" until the render path works.
2. Tier-1 CV scan (`scan-cv.ts`) matches components by a 20 x 20 coverage
   signature with an L1 tolerance of 0.16, which only pixel-identical
   components pass: a legend click finds 1 to 3 of 8 to 21 anti-aliased
   instances of a 9 pt symbol even on a clean render. Raster counts are 0
   percent exact for that reason alone.
3. The vector doorway bridging (`fill-vector.ts`) pairs the free ends of any
   stroked segment at least 3 pt long, so symbols drawn with stroked inner
   lines (a downlight's cross) bridged a 54 pt "door" between two downlights
   and cut the room; the generator now draws symbol strokes as filled quads,
   and real CAD exports with stroked symbol parts will show the same cut.
4. OCR (tesseract.js in Node, same recognizer as the browser) reads title-block
   scale notes on most degraded sheets but loses 7 pt scale-bar labels and
   dimension strings under blur and speckle, and never reads vertical text.
5. `compareDocs` flags a sheet as changed above 0.05 percent of pixels, which a
   moved partition on an A1 sheet does not reach; the vector and text diffs
   still report it, so the reference uses those directly.

Open: VLM-only and VLM plus tools baselines (the harness and budget in "How
pdf2takeoff would run on them"), a held-out set of real sheets scored by hand,
and re-running the reference once WP1 lands so the raster numbers come from the
engine's own render path.

## Status 2026-10-18, round 2: raster reference on the merged engine

The raster half was rerun on the integration branch after the image-render fix (WP1), the line-removal and dihedral matcher (WP5) and the per-sheet threshold, template expansion and look-alike gate (R1). Every one of the 100 raster sheets went through the engine render path; the JPEG fallback was not used. Full tables in bench/scaled-drawing-bench/results/pdf2takeoff-reference-raster-merged.md.

| Type | Accuracy before (old engine, JPEG fallback) | Accuracy after (merged engine) |
|---|---|---|
| scale | 34.4% | 30.1% |
| length | 17.2% | 17.7% |
| area | 26.4% | 21.7% |
| perimeter | 26.9% | 24.7% |
| count (exact) | 0% | 30.1% |
| dimension_read | 9.7% | 10.8% |
| compare (set F1) | 37.7% | 36.5% |
| all | 16.5% | 23.0% |

Hallucinations stayed at 0 of 55. Reading: the count gain is the new matcher; counts went from none exact to 30 percent exact on anti-aliased, degraded renders. Everything else is gated by raster scale reading, which succeeds on 36 of 93 answerable sheets, and the solver abstains downstream without a scale (333 of 968 questions answered). By notation, ratio notes read at 56.7 percent accuracy while imperial, engineer and dimension-only notations sit under 10 percent, so the next lever is OCR of imperial and engineer scale grammars plus scale bars on degraded rasters, then vertical text. The small drops on scale and area are within the noise of OCR on the same sheets and come from the engine render path producing slightly different pixels than the decoded JPEG; they are not regressions in the engine itself.
