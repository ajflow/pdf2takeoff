# AI literature review for pdf2takeoff

Deep-research sweep (October 2026) mapping academic work onto the product's
sub-problems. Papers verified against arXiv/journal pages during research;
links are primary sources where possible. Organized by the feature the work
informs. Companion file: [patch-plan.md](patch-plan.md) — what we do with this.

Headline: the product's problems are all studied fields. "Press S, click one
symbol, count them all" is **class-agnostic few-shot counting**; the Scan tool
is **symbol spotting**; the dimension reader is **text spotting on technical
drawings**; the room fill sits on **seeded region growing** with a known fix
(**opening detection**); and three 2026 VLM benchmarks all conclude that
measurement and numbers should stay in deterministic code — which is already
this tool's architecture.

---

## 1. Symbol spotting on drawings (Scan tool, YOLOX training)

- **FloorPlanCAD: A Large-Scale CAD Drawing Dataset for Panoptic Symbol Spotting**
  Fan, Zhu, Li, Chen, Zhu, Tan — ICCV 2021 — <https://arxiv.org/abs/2105.07147>
  (site: <https://floorplancad.github.io>)
  15,663 vector drawings from ~100 AEC projects, entity-level labels, ~76M
  entities. Defines "panoptic symbol spotting". Central result: a GCN over the
  CAD-primitive graph beats pure raster segmentation (weighted F1 0.798 vs
  0.714); raster detectors (Faster R-CNN / FCOS / YOLOv3) land around mAP
  0.41–0.45. Already our ground-truth source; the paper's ablations quantify
  exactly where a raster detector loses (thin/long entities, lookalikes) and
  that injecting geometry features buys ~+8 F1. Licence: CC BY-NC 4.0 →
  research checkpoints only, not shipped weights (consistent with
  `training/README.md`).

- **ArchCAD-400K: A Large-Scale CAD Drawings Dataset and New Baseline for Panoptic Symbol Spotting**
  Luo et al. — NeurIPS 2025 — <https://arxiv.org/abs/2503.22346>
  (data: <https://huggingface.co/datasets/jackluoluo/ArchCAD>)
  413,062 auto-annotated chunks from 5,538 standardized drawings (~26×
  FloorPlanCAD), annotated by mining intrinsic CAD attributes — the same
  "blocks are free ground truth" trick as our `floorplancad-convert.py`,
  at scale. Dual-pathway baseline (vector + raster fusion) wins again.

- **CADSpotting: Robust Panoptic Symbol Spotting on Large-Scale CAD Drawings**
  Yang, Mu, Zhang et al. — arXiv 2024 / Computational Visual Media —
  <https://arxiv.org/abs/2412.07377>
  Current SOTA line: CAD primitives as coordinate-only point clouds + sliding
  window aggregation with weighted voting across huge sheets. Introduces
  LS-CAD. Relevant as the recipe for "count every instance on an A0 robustly".

- **Text-Enhanced Panoptic Symbol Spotting in CAD Drawings**
  Liu, Gong, Li et al. — BESC 2025 — <https://arxiv.org/abs/2510.11091>
  Fuses geometric and textual primitives (type-aware attention); electrical
  sheets are dense with tiny text tags ("SD", "GPO") next to symbols —
  text fusion raises recall exactly where shape alone fails.

- **Symbol Spotting on Digital Architectural Floor Plans Using a Deep Learning-based Framework**
  Rezvanifar, Cote, Branzan Albu — CVPR 2020 Workshop —
  <https://arxiv.org/abs/2006.00684>
  The closest methodological sibling of our detector: YOLO-family detector
  with tile-based training/inference for small symbols on born-digital plans,
  evaluated on synthetic + degraded real plans. Tiling recipe and degradation
  eval protocol are liftable. Companion: *Symbol Spotting for Architectical
  Drawings: State-of-the-Art and New Industry-Driven Developments* (survey,
  Visual Intelligence 1, 2019, <https://link.springer.com/article/10.1186/s41074-019-0055-1>)
  and *Geometry-based Symbol Spotting in Born-Digital Architectural Floor
  Plans* (J. Electronic Imaging 30(4), 2021) — the training-free
  vector-geometry counterpart.

- **Deep Learning for Symbols Detection and Classification in Engineering Drawings**
  Elyan, Jamieson, Ali-Gombe — Neural Networks 129, 2020 —
  <https://www.sciencedirect.com/science/article/abs/pii/S0893608020301957>
  P&ID digitization; GAN-generated synthetic symbols to attack class
  imbalance and lookalike confusion. Canonical demonstration that synthetic
  symbol augmentation improves detection on engineering drawings.

- **SESYD: Generation of Synthetic Documents for Performance Evaluation of Symbol Recognition & Spotting Systems**
  Delalandre, Valveny, Pridmore, Karatzas — GREC 2013 —
  <https://hal.science/hal-01022594>
  The 20-year-old ancestor of our synthetic-sheet generator, including
  degradation models (noise, line degradation) we have not yet implemented.

- **Symbol Detection in Mechanical Engineering Sketches: Synthetic Data Generation and Deep Learning**
  Bickel, Goetz, Wartzack — Applied Sciences 14(14):6106, 2024 —
  <https://www.mdpi.com/2076-3417/14/14/6106>
  Methodical sim-to-real study for exactly our training strategy; identifies
  which randomization axes matter (degradation, clutter, overlap, line
  weight). Read before the next Kaggle run.

- **Few-Shot Symbol Detection in Engineering Drawings**
  Jamieson, Elyan, Moreno-García — Applied Artificial Intelligence 38(1), 2024 —
  <https://doi.org/10.1080/08839514.2024.2406712>
  New/variant symbols with almost no labels are the norm; few-shot head over
  detector proposals extends detection to unseen classes. Our click is
  literally one labeled example.

- **Legend-Informed Symbol Recognition in Engineering Diagrams with Self-supervised Learning**
  Hain, Gölzhäuser, Réhault, Brox, Demant — ECML PKDD 2025 —
  <https://doi.org/10.1007/978-3-662-72243-5_23>
  Uses each diagram's legend as free supervision; contrastive symbol
  embeddings adapt per diagram with zero manual annotation. The zero-click
  version of the S-key; the best answer to "every firm's blocks look
  different".

- **Automatic Detection and Classification of Symbols in Engineering Drawings**
  Sarkar, Pandey, Kar — arXiv 2022 — <https://arxiv.org/abs/2204.13277>
  Legend-table parsing to propose symbol palettes/prototypes before any
  click.

- Classic lineage: Rusiñol & Lladós, *Symbol Spotting in Technical Drawings
  Using Vectorial Signatures* (GREC 2006; extended PRL 2010) —
  query-by-one-example retrieval on vectorized drawings; CVC-FP +
  ground-truthing tool (de las Heras et al., IJDAR 18(3), 2015,
  <https://doi.org/10.1007/s10032-014-0236-5>).

Dataset note: "R3DEF/DISTO" datasets often cited alongside FloorPlanCAD could
not be verified to exist. CubiCasa5k (below) and CVC-FP are the real
alternatives.

## 2. Click-one-count-all (few-shot / class-agnostic counting, interactive segmentation)

- **Learning To Count Everything (FamNet) + FSC-147**
  Ranjan, Sharma, Nguyen, Hoai — CVPR 2021 — <https://arxiv.org/abs/2104.08391>
  Defines the task: 1–3 exemplar boxes → density map → count + peak
  localization. The formal statement of our Scan interaction.

- **LOCA: A Low-Shot Object Counting Network With Iterative Prototype Adaptation**
  Đukić, Kristan et al. — ICCV 2023 — <https://arxiv.org/abs/2211.08217>
  Iteratively adapts the prototype from the single exemplar to cover sibling
  variation — the exact failure mode of naive click-to-count. ResNet-50
  scale → browser-feasible quantized.

- **CounTR: Transformer-based Generalised Visual Counting**
  Liu, Hu, Guo et al. — ECCV 2022 — <https://arxiv.org/abs/2208.13721>
  Token-level matching; accuracy ceiling of the FSC-147 line; too heavy for
  WASM without distillation.

- **CountGD: Multi-Modal Open-World Counting**
  Amini-Naieni, Han, Zisserman — NeurIPS 2024 — <https://arxiv.org/abs/2407.04619>
  Visual exemplar + text → boxes + count. Defines the ideal UX; server-class
  (GroundingDINO) → distillation teacher, not browser model.

- **Training-free Object Counting with Prompts (CountSAM)**
  Shi, Sun, Zhang — WACV 2024 — <https://arxiv.org/abs/2307.00038>
  Counting as iterative SAM re-prompting from one reference object — "mark
  one, SAM finds the rest", composable client-side; latency-exposed on
  hundreds of instances.

- **OS2D: One-Stage One-Shot Object Detection**
  Osokin, Sumin, Lomakin — ECCV 2020 — <https://arxiv.org/abs/2003.06800>
  The classic exemplar→all-boxes detector (retail motivation; needs
  fine-tune + ONNX port for line art).

- **DE-ViT: Detect Everything with Few Examples**
  Zhang, Liu, Wang, Boularias — CoRL 2024 — <https://arxiv.org/abs/2309.12969>
  Frozen DINOv2 region features + prototype matching detect novel classes
  with zero test-time training — the most credible no-retrain recipe.

- **DINOv2: Learning Robust Visual Features without Supervision**
  Oquab, Darcet, Moutakanni et al. — TMLR 2024 — <https://arxiv.org/abs/2304.07193>
  Off-the-shelf patch features for retrieval/matching. With CACViT
  (*Vision Transformer Off-the-Shelf…*, arXiv:2305.04440) supports a
  training-free browser matcher: page features once, cosine-match per click.
  Apache-2.0.

- **SiamFC** — Bertinetto et al., ECCVW 2016 — <https://arxiv.org/abs/1606.09549>
  Fully-convolutional correlation as the architectural blueprint for
  exemplar→response-map matching; tiny, ONNX-friendly, milliseconds on WASM.

- **SAM / SAM 2** — Kirillov et al., ICCV 2023, <https://arxiv.org/abs/2304.02643>;
  Ravi et al., ICLR 2025, <https://arxiv.org/abs/2408.00714>.
  Promptable segmentation foundations; do not find all instances by
  themselves. Edge variants: **MobileSAM** (arXiv:2306.14289 — ~40 MB,
  official ONNX path, runs in browsers today), **EdgeSAM**
  (arXiv:2312.06660, ~14 FPS on iPhone), **TinySAM** (AAAI 2025,
  arXiv:2312.13789), **EfficientViT-SAM** (CVPRW 2024,
  arXiv:2402.05008, CPU real-time). **SAM 3** (arXiv:2511.16719, Nov 2025)
  adds "concept prompts" (image exemplars → masks for all matching
  instances) — exactly our task definition, but server-class.
  Document-graphics adaptations: **Hi-SAM** (arXiv:2401.17904, text/layout),
  **MapSAM** (repeated graphical elements in historical maps, 2025),
  **FloorSAM** (arXiv:2509.15750).

- **Learning Gaussian Data Augmentation in Feature Space for One-shot Object Detection in Manga**
  Taniguchi, Furuta — ACM Multimedia Asia 2024 — <https://arxiv.org/abs/2410.05935>
  Closest domain match: repeated **line-art** symbols from one example;
  feature-space augmentation of the exemplar against monochrome graphics.

- **Few-Shot Learning with Large Foundation Models for Automated Segmentation… in Architectural Floor Plans**
  Zhang & Zhang — Results in Engineering 2024/25 —
  <https://www.sciencedirect.com/science/article/pii/S2772991524000562>
  SAM + few-shot prompting on floor plans — the closest published analogue to
  click-prompted, class-agnostic matching on plans.

- Context: Michaelis et al., *A Broad Dataset is All You Need for One-Shot
  Object Detection* (arXiv:2011.04267) — one-shot matchers overfit context;
  category diversity, not metric-learning sophistication, closes the gap.
  Survey: *Class-Agnostic Counting* (arXiv:2501.19184, 2025).

## 3. OCR: dimension & scale auto-read, schedules, title blocks

- **Deep learning-based text detection and recognition on architectural floor plans**
  Schönfelder, Stebel, Andreou, König — Automation in Construction 158, 2024 —
  <https://www.sciencedirect.com/science/article/abs/pii/S0926580523004168>
  Detect-then-recognize on plans with released annotated datasets; the
  fine-tuning/eval source for a dimension-text detector.

- **An efficient deep learning framework for text detection and recognition in engineering drawings**
  Ying et al. — Frontiers in Built Environment, 2026 —
  <https://www.frontiersin.org/journals/built-environment/articles/10.3389/fbuil.2026.1839808/full>
  3.8M-param enhanced DBNet + 15.6M Transformer-CTC recognizer reading
  rebar/dimension strings *for quantity takeoff*; 96.3% accuracy, beats
  TrOCR/PARSeq/eDOCr. Essentially our dimension-reader as published
  research; blueprint for the in-browser architecture.

- **Extraction of dimension requirements from engineering drawings…**
  Scheibel, Mangler et al. — Computers in Industry 129, 2021 —
  <https://mediatum.ub.tum.de/doc/1624520/1624520.pdf>
  A dimension is a compound of text + extension/leader lines; DBSCAN-based
  association binds number to line. Reference for validating our
  clicked-segment-to-number binding.

- **Text Detection on Technical Drawings for the Digitization of Brown-field Processes**
  Schlagenhauf, Netzer, Hillinger — arXiv 2022 —
  <https://arxiv.org/abs/2205.02659>
  Synthetic-drawing generation to train a text detector because no public
  labeled drawing text exists — the cold-start pattern we already follow for
  symbols.

- **Fletcher & Kasturi, A Robust Algorithm for Text String Separation from Mixed Text/Graphics Images**
  IEEE TPAMI 10(9), 1988; consolidated by Tombre et al., *Text/Graphics
  Separation Revisited* (DAS 2002).
  Classic connected-component + collinearity text/graphics separation: a
  millisecond, zero-ML pre-filter that kills digit-vs-tick-mark confusion
  before recognition.

- **PP-OCR: A Practical Ultra Lightweight OCR System**
  Du et al. (Baidu) — arXiv 2020 — <https://arxiv.org/abs/2009.09941>
  (successors through PP-OCRv5)
  The canonical lightweight det → **direction classification** → rec
  pipeline; the rotation stage is exactly what our rotated dimension text
  needs, mobile models are single-digit MB and run under ONNX Runtime Web.
  Apache-2.0.

- **TrOCR** — Li et al., AAAI 2023 — <https://arxiv.org/abs/2109.10282>
  Best drop-in recognition head for small crops ("12.00", "1:100",
  "φ8@200"); tiny quantizable checkpoints.

- **GOT-OCR 2.0** — Wei et al. (StepFun), 2024 — <https://arxiv.org/abs/2409.01704>
  Region-level interactive OCR ("read exactly this box") — our interaction
  model; 580M params is the edge of browser feasibility.

- **DeepSeek-OCR** — 2025 — <https://arxiv.org/abs/2510.18234>;
  **dots.ocr** — 2025 — <https://arxiv.org/abs/2512.02498>;
  **MinerU** — <https://arxiv.org/abs/2409.18839>;
  **olmOCR** — <https://arxiv.org/abs/2502.18443>;
  **Docling** — <https://arxiv.org/abs/2408.09869>;
  **Donut** — ECCV 2022 — <https://arxiv.org/abs/2111.15664>
  The modern document-VLM stack — relevant mainly server-side (schedule
  ingestion, MCP OCR tools), not to the in-browser reader. olmOCR's
  unit-test-style exact-match rewards are the recipe if we ever fine-tune a
  small VLM for dimension strings.

- **Title block detection and information extraction for enhanced building drawings search**
  Lombardi, Duan et al. — EC3 2025 — <https://arxiv.org/abs/2504.08645>
  Lightweight CNN detects title-block regions + GPT-4o extracts structured
  metadata — our "read 1:100 from the title block" feature, published;
  the hybrid local-detector + LLM-fields design maps onto our MCP plan.

- **TableFormer** — Nassar et al. (IBM), CVPR 2022 — the table-recognition
  engine inside Docling; the component to borrow when schedule extraction
  lands.

## 4. Room fill, walls, vectorization

- **DeepFloorplan** — Zeng et al., ICCV 2019 — <https://arxiv.org/abs/1908.11025>
  (code: <https://github.com/zlzeng/DeepFloorplan>)
  Doors/windows predicted as an explicit **boundary class** gating room
  segmentation — the published fix for our door-gap leak; datasets double as
  benchmarks for click-to-fill accuracy.

- **CubiCasa5K** — Kalervo et al., SCIA 2019 — <https://arxiv.org/abs/1904.01920>
  (code: <https://github.com/CubiCasa/CubiCasa5K>)
  5,000 open plans, 80+ classes, doors/openings labeled as polygons — the
  data bottleneck for an opening detector, already solved. Licence CC
  BY-NC-SA → research-only.

- **HEAT: Holistic Edge Attention Transformer for Structured Reconstruction**
  Chen et al., CVPR 2022 — <https://arxiv.org/abs/2111.15143>
  Raster in → planar graph (corners + classified edges) out; the cleanest
  published route from PDF pixels to wall geometry; junction closing is
  inherent to graph prediction.

- **RoomFormer** — Yue et al., CVPR 2023 — <https://arxiv.org/abs/2211.15658>;
  **PolyRoom** — Liu et al., ECCV 2024 — <https://arxiv.org/abs/2407.10439>;
  **MonteFloor** — Stekovic et al., ICCV 2021 — <https://arxiv.org/abs/2103.11161>
  The polygon-room-prediction line (3D-scan input mostly); PolyRoom's
  failure-mode list (missing corners, broken edges) is the checklist for any
  learned room-fill upgrade.

- **Raster-to-Vector: Revisiting Floorplan Transformation**
  Liu et al., ICCV 2017 —
  <https://openaccess.thecvf.com/content_iccv_2017/html/Liu_Raster-To-Vector_Revisiting_Floorplan_ICCV_2017_paper.html>
  The foundational learning-based raster→vector paper.

- **Deep Vectorization of Technical Drawings**
  Egiazarian et al., ECCV 2020 — <https://arxiv.org/abs/2003.05471>
  Deep **cleaning/gap-filling stage** before primitive emission, trained
  largely on synthetic renderings — purpose-built for broken scanned
  linework; candidate pre-processing stage before both fill and
  vectorization. Follow-up: Xing et al., Automation in Construction 2025
  (sparse-point vectorization).

- **Seeded Region Growing** — Adams & Bischof, IEEE TPAMI 16(6), 1994.
  The canonical formulation our flood fill descends from;
  similarity-ordered growth offers principled leak arrest, not just
  morphological closing.

- **Automatic Room Detection and Room Labeling from Architectural Floor Plans**
  Ahmed et al., DAS 2012 — structural reasoning + topology validation over
  imperfect linework; the pre-deep toolbox (gap bridging, boundary
  completion, plausibility checks) — cheapest robustness upgrade for a
  browser tool that ships no model.

- **Pizarro et al., Automatic floor plan analysis and recognition (survey)**
  Automation in Construction 140, 2022 — the map of the whole field.

- Scale calibration specifically: **Shen et al., SPIE AOPC 2022**
  (122570Y) — DL detection + morphology including scale recognition and
  area computation; **Schönfelder et al. 2024** (above) is the enabling
  component. Academically under-published; the state of practice is
  commercial (Kreo's "AI Scale" write-up describes closing openings by
  replacing doors/windows with solid lines — the same trick we need).

## 5. Revision compare

Thin literature — two relevant papers, the rest is commercial (Bluebeam
Compare):

- **Cao et al., Using engineering drawing interpretation for automatic detection of version information in CADD drawings**
  Automation in Construction, 2005 —
  <https://www.sciencedirect.com/science/article/abs/pii/S0926580504001098>
- **Monnier Weil, Ensuring the consistency of information between two versions of a mechanical drawing**
  ACM/IEEE MODELS 2024 (doctoral) — <https://hal.science/hal-04717933>
  Geometry-vs-annotation separation + graph matching to report
  added/removed/changed entities — the transferable design if revision diff
  grows beyond image overlay.

## 6. VLMs / agents on drawings (the MCP roadmap)

- **ArchPlanVQA** — Li et al., ASCE J. Computing in Civil Engineering, 2026 —
  <https://ascelibrary.org/doi/10.1061/JCCEE5.CPENG-7571>
  VQA benchmark on architectural CAD; quantifies where off-the-shelf VLMs
  fail on plans.
- **DrawingVQA** — Jung, Fu, Golparvar-Fard, 2026 —
  <https://arxiv.org/abs/2607.15418>
  QA over real Issued-for-Construction drawings at three reasoning depths;
  model-vs-expert gap grows with depth; dense-annotation perception is the
  bottleneck.
- **FloorplanQA** — Rodionov et al. (KAUST), 2026 —
  <https://arxiv.org/abs/2507.07644>
  Even with structured (JSON) plan input, LLMs violate spatial/physical
  constraints; validates plan→structured-data→LLM-reasoning, with guardrails.
- **From Concept to Manufacturing: Evaluating VLMs for Engineering Design**
  Picard, Edwards et al. (MIT) — <https://arxiv.org/abs/2311.12668>
  Documents GPT-4V *forgetting dimensions it had just extracted*.
- **Visual Language Model as a Judge for Object Detection in Industrial Diagrams**
  Ghosh, 2025 — <https://arxiv.org/abs/2510.03376>
  VLM-as-verifier pass over digitization output — cheap QA loop after
  counting ("are these 24 boxes really downlights?").
- **LLM-Guided Agentic Floor Plan Parsing** — Ayanzadeh & Oates, 2026 —
  <https://arxiv.org/abs/2604.23970>
  Multi-agent parse→verify→retry beats single-call VLM; the orchestration
  pattern for an MCP takeoff agent.

**Design rule all four converge on:** let the LLM plan and parse semantics,
but force every dimension, scale and count to come from deterministic
geometry/OCR tools — VLMs demonstrably misremember drawing numbers. This is
already the tool's architecture; keep it that way.

## 7. Automated quantity takeoff (construction domain)

- **Towards Automated Construction Quantity Take-Off: Information Extraction from Work Descriptions**
  Tang et al. — Buildings 12(3):354, 2022 — <https://www.mdpi.com/2076-5309/12/3/354>
  BERT-based NLP over specs/work descriptions — the text side that pairs
  with our geometry side (quantity numbers + spec-derived item names).
- **Automatic Quantity Takeoff for Irregular Areas of Architectural Drawings**
  Li et al. — CIB W78 2025 —
  <https://docs.lib.purdue.edu/cgi/viewcontent.cgi?article=2098&context=cib-conferences>
  ML detection + rules measuring irregular deck areas from 2D drawings —
  a rare paper doing exactly our job, without BIM.
- MEP context: Yin et al., *Adaptive detection of equipment components in
  MEP drawings* (2025); Michalak et al., *Explainable AI for Symbol
  Detection in Construction Drawings* (TUHH 2024).
