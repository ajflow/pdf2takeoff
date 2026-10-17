# Raster symbol detection and counting on large construction sheets: tiled inference, cross-tile fusion, and one-click class-agnostic counting

Scope: gaps beyond `docs/research/ai-literature-review.md` (65 papers) and `docs/research/patch-plan.md`. Papers already covered there (FloorPlanCAD, ArchCAD-400K, CADSpotting, Rezvanifar 2020, Elyan 2020, SESYD, Bickel 2024, Jamieson few-shot 2024, Hain 2025, FamNet, LOCA, CounTR, CountGD, CountSAM, OS2D, DE-ViT, DINOv2, SAM family) are not re-reported except where newer work supersedes or quantifies them.

Method note: arxiv.org, export.arxiv.org, huggingface.co, semanticscholar.org, alphaxiv.org, openaccess.thecvf.com, mdpi.com and ceur-ws.org were blocked by this session's egress policy (proxy 403 / DNS failure). Claims about arXiv-hosted papers therefore come from search-engine abstracts and snippets, not from reading full text; these are flagged "(abstract/snippet only)". GitHub was reachable, so code-level facts (SAHI defaults, merge rules, PlanSpot results, GeCo/DAVE licences) were read from the repos directly. Repo-specific facts about pdf2takeoff were read from `src/engine/scan-onnx.ts` and `specs/detector-tiling.md`.

## 1. Sliced/tiled inference on huge images: how to fuse detections across tiles (NMM vs NMS, IoS, edge filtering)

### Takeaway
The reference implementation (SAHI) does not fuse cross-tile detections with plain IoU-NMS: its default is greedy non-maximum *merging* (GREEDYNMM) with the **intersection-over-smaller (IoS)** metric at 0.5, which is exactly the metric that collapses a truncated box into the full box that contains it. There is no peer-reviewed AP comparison of NMS vs NMM vs IoS on drawings. The one 2026 paper that targets objects cut by tile seams (TA-TM, PCB defects) adds tile-adjacency-aware rescoring before NMS. Practitioner and vendor tooling adds a third tool: drop boxes touching an *interior* tile edge, which is only safe when the overlap is at least the largest object size.

### Cited Findings

**SAHI: paper (foundational) and library behaviour (2024-2026)**
- SAHI, "Slicing Aided Hyper Inference and Fine-tuning for Small Object Detection", Akyon, Altinuc, Temizel, ICIP 2022, pp. 966-970. Slicing at inference raised AP by 6.8 / 5.1 / 5.3 points for FCOS / VFNet / TOOD on VisDrone and xView. Adding slice-aided fine-tuning brought the cumulative gains to 12.7 / 13.4 / 14.5 AP. Patch sizes were 640x640 and 400x400 — [arXiv 2202.06934](https://arxiv.org/pdf/2202.06934) (abstract/snippet only)
- In the same paper, 25% patch overlap raised small- and medium-object AP and overall AP but slightly lowered large-object AP. The authors attribute the drop to extra false positives on large ground-truth boxes. The paper itself reports no NMM-vs-NMS ablation — [arXiv 2202.06934](https://arxiv.org/pdf/2202.06934) (snippet)
- **SAHI library defaults** (`get_sliced_prediction`, current main): `overlap_height_ratio=0.2`, `overlap_width_ratio=0.2`, `postprocess_type="GREEDYNMM"`, `postprocess_match_metric="IOS"`, `postprocess_match_threshold=0.5`, `postprocess_class_agnostic=False` (per-class), `perform_standard_pred=True` (it also runs one full-image pass and fuses it with the slices). If the model confidence threshold is below 0.1, it switches to NMS + IOU unless forced. No step filters boxes by position at slice edges — [obss/sahi predict.py](https://github.com/obss/sahi/blob/main/sahi/predict.py)
- **SAHI IoS definition:** intersection divided by "the area of the smaller bounding box" (element-wise minimum of the two areas) — [obss/sahi postprocess/utils.py](https://github.com/obss/sahi/blob/main/sahi/postprocess/utils.py)
- **SAHI merge rule:** when two predictions match, the merged box is their **union** (min of top-left corners, max of bottom-right corners). Score is the **max** of the two, and the category comes from the higher-scored prediction — [obss/sahi postprocess/utils.py](https://github.com/obss/sahi/blob/main/sahi/postprocess/utils.py)
- SAHI offers four postprocessors:
  - NMS keeps the best box and discards the rest.
  - NMM merges matches transitively (A~B and B~C merges all three).
  - GREEDYNMM merges only boxes that directly overlap each keeper (no transitive chains).
  - LSNMS (experimental, spatial index) supports IoU only, not IoS.

  — [obss/sahi postprocess/combine.py](https://github.com/obss/sahi/blob/main/sahi/postprocess/combine.py)
- SAHI maintainer guidance (fcakyon, 18 Oct 2024): "if you aim for academic map score based benchmarks, NMS works best", but "In practical use cases NMS creates lots of duplicate and false positives so non-maximum-merging (NMM) works better." This is informal guidance, not a measured result, and the thread does not cover IoU vs IoS or truncated boxes — [SAHI Discussion #1086](https://github.com/obss/sahi/discussions/1086)
- SAHI 0.12.5 (4 Aug 2026) rewrote NMS/greedy-NMM to fetch matches on demand from an STRtree:
  - Peak memory is now O(N + max_degree).
  - Crowded 33,337-box case: 47,180 ms → 135 ms and 3,416 MB → 4 MB. Crowded 10,000 boxes: 2,717 ms → 25 ms.
  - Transitive `nmm` on crowded input still takes about 95 s at 33k boxes.

  This is relevant because a dense A0 electrical sheet can produce thousands of raw boxes — [SAHI Discussion #1420](https://github.com/obss/sahi/discussions/1420)

**Quantitative comparisons of merge strategies (thin)**
- A CEUR workshop study compared NMS, NMM and GREEDYNMM on sliced detection and found they "yield very similar results for most classes". LSNMS gave slightly more detections, and the torchvision pipeline left "a lot of duplicate detections, which are difficult to remove with the existing post-processing algorithms". It is a detection-count analysis, not an AP ablation — [CEUR-WS Vol-3909 Paper 31](https://ceur-ws.org/Vol-3909/Paper_31.pdf) (snippet only; host blocked)
- No peer-reviewed source found that reports AP or count error for IoU vs IoS merging on tile seams. See Gaps.

**2024-2026 work on objects cut by tile boundaries**
- "From Full Boards to Tiny Defects: Scale-Aware Tile Inference with Topology-Aware Merging for High-Resolution PCB Defect Detection", Shalmani et al., arXiv May 2026 — [arXiv 2605.24726](https://arxiv.org/pdf/2605.24726) (abstract/snippet only):
  - Problem: when a defect straddles a tile boundary, each tile yields a lower-confidence partial box, and standard NMS can discard the complementary box.
  - TA-TM builds a tile-adjacency graph from grid coordinates. It boosts boundary-sensitive detections whose neighbour tile has a complementary detection, then runs global NMS. It is training-free and architecture-agnostic.
  - A detector trained on full images collapses to mAP@50 = 0.01 under tile inference. The same architecture trained on 640x640 tile crops reaches 0.72 (PCB-Defect) and 0.94 (HRIPCB).
  - 128 px overlap "lifts boundary-zone recall substantially", and TA-TM gives the best mAP@50 on both sets.
- The same paper notes that standard NMS "does not explicitly consider the spatial relationship between neighboring tiles" — [arXiv 2605.24726](https://arxiv.org/pdf/2605.24726) (snippet)
- "Enhancing Instance Segmentation in High-Resolution Images Using Slicing-Aided Hyper Inference and Spatial Mask Merging Optimized via R-Tree Indexing", Mathematics 13(19):3079, 2025. It observes that adjacent fragments of one object "may have minimal overlap despite representing the same object, leading to missed merges", and proposes merging over suppression with an R-tree index — [MDPI Mathematics 13(19):3079](https://www.mdpi.com/2227-7390/13/19/3079) (snippet only; host blocked)
- Adaptive SAHI (ASAHI), arXiv Apr 2026, argues that fixed-size slicing wastes compute in a resolution-dependent way, and that "boundary slices frequently extend beyond the image boundaries or overlap excessively with neighboring patches" — [arXiv 2604.19233](https://arxiv.org/html/2604.19233v1) (snippet only)
- "ROI-Gated SAHI: Content-Adaptive Slicing-Based Inference for Efficient Object Detection", arXiv Aug 2026. As the title says, it gates which slices are run based on content — [arXiv 2608.23923](https://arxiv.org/html/2608.23923v1) (title/snippet only; no numbers verified)
- Kyrychuk et al. (CEUR-WS Vol-4222) study scale mismatch when using SAHI with YOLOv10 and reach conclusions similar to TA-TM's about matching training scale to tile scale — [CEUR-WS Vol-4222 short10](https://ceur-ws.org/Vol-4222/short10.pdf) (snippet only)

**Practitioner / vendor techniques (not peer-reviewed)**
- Vendor docs (DeGirum, Hailo tiling guide) describe a seam fusion step that runs "1-D IoU fusion inside an edge band", so boxes split across a tile border are merged rather than duplicated — [DeGirum tiling guide](https://docs.degirum.com/hailo/intermediate-guides/tiling) (vendor documentation)
- A practitioner tiled-inference PR drops boxes that touch an inner tile edge, because the neighbouring tile sees that object whole. It also requires a higher IoU to merge boxes of different classes — [GitHub PR #5, Computer-Vision-For-Object-History-Tracking](https://github.com/benoyj20/Computer-Vision-For-Object-History-Tracking-/pull/5) (practitioner code)
- Practitioner write-ups name the two seam error types: (a) one object seen whole in two tiles survives twice through a loose merge; (b) too little overlap bisects an object into fragments that the merge cannot reassemble — [TechnoLynx SAHI+YOLO](https://www.technolynx.com/post/sahi-yolo-slicing-aided-inference-for-small-object-detection/); [Roboflow edge tiling](https://blog.roboflow.com/edge-tiling-during-inference/) (blogs)
- Foundational alternatives to hard NMS (brief):
  - Soft-NMS (Bodla et al., ICCV 2017) decays scores instead of deleting boxes — [arXiv 1704.04503](https://arxiv.org/abs/1704.04503)
  - Weighted Boxes Fusion (Solovyev, Wang, Gabruseva, Image and Vision Computing 2021) averages matched boxes weighted by score — [arXiv 1910.13302](https://arxiv.org/abs/1910.13302)

  Neither addresses truncation specifically.

**pdf2takeoff's current fusion (read from code)**
- One per-class greedy IoU-NMS runs over all windows' detections (`nmsPerClass`, IoU denominator `a1 + a2 - inter`). Windows overlap by `overlapPx` (spec example: 32 raster px at RASTER_SCALE = 3 px/pt). A global `MAX_DET = 500` cap is applied inside NMS across all classes, before the click picks a class. `MAX_WINDOWS = 512` makes the scan throw and fall back to the CV scan — [src/engine/scan-onnx.ts](../../src/engine/scan-onnx.ts); [specs/detector-tiling.md](../../specs/detector-tiling.md)

### Inferences
- **Why IoU-NMS fails at seams, numerically.** Suppose a symbol is cut so that tile A sees 40% of it and tile B sees all of it. The truncated box is about 0.4x the full box's area and lies inside it, so IoU ≈ 0.4. That is below a typical 0.45-0.65 NMS threshold, so both survive and the symbol is double-counted. IoS = 0.4 / 0.4 = 1.0, so the two merge. This is why SAHI defaults to IoS.
- **IoS has a failure mode.** It merges a small box nested inside any larger same-class box. Examples: a real small symbol inside an over-sized false-positive box, or two touching downlights where one box is clipped. Per-class matching (already pdf2takeoff's behaviour, and SAHI's default `class_agnostic=False`) limits this. Applying IoS only to pairs from *different* windows, and keeping IoU within a window, limits it further.
- **Overlap must be at least the largest symbol in raster px.** Otherwise a symbol straddling a seam is never fully inside any tile, and both tiles report truncated boxes that even IoS cannot reliably merge (two complementary halves have IoS ≈ 0). The spec itself cites 9 mm symbols:
  - 9 mm ≈ 25.5 pt ≈ 76 raster px at 3 px/pt.
  - The example `overlapPx: 32` is less than half of that.
  - So straddling symbols can be split into two non-overlapping halves. This is fragment error type (b) above.

  This is my calculation from the spec's numbers, not a measured result.
- With overlap ≥ max symbol size, "drop boxes touching an interior tile edge" becomes safe by construction: every symbol is wholly inside at least one tile. Edge-dropping then removes truncated boxes before NMS ever sees them. This is the cheapest correct fix, and it is independent of the merge metric.

### Gaps
- No peer-reviewed quantitative comparison of NMS vs NMM vs GREEDYNMM, or IoU vs IoS, at tile seams. The SAHI paper does not ablate it, and the CEUR study only reports detection counts. TA-TM's full tables could not be read (arXiv blocked).
- No study found that measures seam double-count rates for symbol spotting on drawings specifically.

## 2. Detectors and papers targeting symbol spotting on raster floor plans / engineering drawings (2023-2026, beyond the existing review)

### Takeaway
The 2024-2026 raster work on *electrical/MEP* sheets is small-data and YOLO/Mask R-CNN-based:
- Typical scores are ~76-83% mAP@50, and up to 98.5% AP50 on narrow lighting-only tasks.
- Datasets are tens of plans, mostly private or non-commercial.
- None report a tile-fusion method or sheet-level count accuracy.

The SOTA for large CAD sheets remains vector/point-based panoptic spotting (SymPoint line, CADSpotting). The most transferable new raster result for one-click counting is an MEP few-shot Siamese detector (2025).

### Cited Findings
- **SkeySpot / DELP**, "SkeySpot: Automating Service Key Detection for Digital Electrical Layout Plans in the Construction Industry", IIT Gandhinagar (Dosi et al.), IEEE SMC 2025, DOI 10.1109/SMC58881.2025.11343634 — [arXiv 2508.10449](https://arxiv.org/html/2508.10449v1); [IITGN HAIx lab page](https://labs.iitgn.ac.in/haix/?p=1424) (abstract/lab page):
  - Dataset: DELP, 45 **scanned** electrical layout plans with 2,450 instances across **34 service-key classes**.
  - Results: YOLOv8 was best at 82.5% mAP@50 (average mAP ≈ 81.1% per secondary summary). The SkeySpot web tool detects, classifies and counts symbols.
  - Licence: dataset is non-commercial and forbids redistributing modified versions.
- **Jamieson, Moreno-García, Elyan**, "Towards fully automated processing and analysis of construction diagrams: AI-powered symbol detection", IJDAR, published online 25 Jul 2024, DOI 10.1007/s10032-024-00492-9. Tested on high-resolution industry plumbing and HVAC drawings: YOLO-based reached 79% mAP and Faster R-CNN-based 83% mAP. The dataset is private, and the authors name material takeoff as the target use — [Springer IJDAR](https://link.springer.com/article/10.1007/s10032-024-00492-9); [RGU repository](https://rgu-repository.worktribe.com/output/2418851/towards-fully-automated-processing-and-analysis-of-construction-diagrams-ai-powered-symbol-detection)
- **"Adaptive detection of equipment components in MEP construction drawings via graph-enhanced siamese vision"** (Yin et al., 2025; ScienceDirect PII S2352710225027639, i.e. Journal of Building Engineering — journal inferred from the ISSN in the PII). The existing review only names it in passing.
  - Method: a graph-based step proposes regions, then a **self-supervised Siamese network** detects equipment.
  - On **5 unseen object types (99 instances)**: precision 98.9%, recall 90.9%, F1 0.95.
  - The authors note prior MEP work focuses on linear objects (pipes, ducts).

  This is the closest published analogue to "click one unseen symbol, find the rest" on MEP sheets — [ScienceDirect](https://www.sciencedirect.com/science/article/pii/S2352710225027639) (abstract via search)
- **"Intelligent Detection of Mechanical, Electrical, and Plumbing (MEP) Metrics Based on 2D Floor Plans"**, Mandhiratta, Zaman, Mawlood-Yunis (Wilfrid Laurier), arXiv Aug 2026. A Mask R-CNN detects lighting symbols, identifies light type and extracts nearby text. Bbox mAP 0.7596, segmentation mAP 0.7111, bbox AP@50 0.9850, segmentation AP@75 0.9219. It is a preprint; peer review not confirmed — [arXiv 2608.14317](https://arxiv.org/pdf/2608.14317) (abstract/snippet only)
- **"Improving Symbol Detection on Engineering Drawings Using a Keypoint-Based Deep Learning Approach"** (2023 preprint) recasts symbol detection as keypoint pose estimation (Keypoint R-CNN) across classes, on bridge and residential drawings. This is relevant to rotation-variant symbols — [ResearchGate](https://www.researchgate.net/publication/372110051_Improving_Symbol_Detection_on_Engineering_Drawings_Using_a_Keypoint-Based_Deep_Learning_Approach) (snippet only)
- **LLM-integrated floor plan analysis** (Applied Sciences 16(13):6290, 2026) — [doi:10.3390/app16136290](https://doi.org/10.3390/app16136290) (snippet only):
  - YOLOv8 reached 92.3% mAP50 vs 87.2% for Faster R-CNN, on a 10-plan validation split with unequal training epochs.
  - A YOLOv8-nano baseline on CubiCasa5K icons reached 71.3% mAP50.
- Community model card (not peer-reviewed): YOLOv8n on a FloorPlanCAD-derived raster set reports mAP50 0.770 and mAP50-95 0.671 — [HF mudasir13cs/floorcad-yolov8n-detect](https://huggingface.co/mudasir13cs/floorcad-yolov8n-detect)
- **Vector-side SOTA, which supersedes the GCN baselines in the existing review:**
  - "Symbol as Points: Panoptic Symbol Spotting via Point-based Representation" (SymPoint), ICLR 2024, beats GAT-CADNet by +9.6 PQ and +10.4 RQ on FloorPlanCAD — [arXiv 2401.10556](https://arxiv.org/pdf/2401.10556); [ICLR 2024 poster](https://iclr.cc/virtual/2024/poster/18367)
  - SymPoint-V2 adds a Layer Feature-Enhanced module and Position-Guided Training, and claims new SOTA PQ and faster convergence. Exact numbers were not retrieved — [Moonlight review](https://themoonlight.io/en/review/sympoint-revolutionized-boosting-panoptic-symbol-spotting-with-layer-feature-enhancement) (secondary)
  - "Text-Aided Multi-Modal Panoptic Symbol Spotting for CAD Floor Plan Drawings", arXiv Jul 2026 — [arXiv 2607.12678](https://arxiv.org/pdf/2607.12678) (title only)
- A 2024 review of deep learning for digitising engineering diagrams summarises the earlier raster baselines:
  - Rezvanifar's YOLOv2 with tiling: 0.26 → 0.31 mAP on one floor-plan set, 0.86 on a more standardised set.
  - Class imbalance is inherent in real drawings.

  — [Artificial Intelligence Review, Springer 2024](https://link.springer.com/article/10.1007/s10462-024-10779-2)

### Inferences
- Reported raster mAPs (76-92%) are on small, mostly single-firm datasets and are not comparable across papers. None measures what a takeoff user needs, which is per-sheet count error after tile fusion. pdf2takeoff should evaluate with count MAE per class per sheet in addition to mAP.
- Licensing blocks reuse:
  - SkeySpot is built on YOLOv8, which is Ultralytics/AGPL and excluded by pdf2takeoff policy.
  - DELP and FloorPlanCAD are non-commercial.
  - The Jamieson data is private.

  The papers are useful for protocol and class lists, not for weights.
- The Yin et al. Siamese result (unseen MEP types, F1 0.95) supports Patch 5's premise that one-click matching can generalise without retraining on MEP sheets. Its graph-based proposals play the role of pdf2takeoff's tier-1 CV candidates.

### Gaps
- No 2023-2026 raster paper found that reports sheet sizes (A0/A1) and the tiling/fusion details together with count accuracy.
- SymPoint-V2's and the text-aided paper's exact numbers were not retrieved (arXiv blocked).
- No public, commercially licensed raster electrical-symbol dataset found.

## 3. Few-shot / exemplar-based class-agnostic counting and detection (2024-2026), tiny line-art symbols, and browser feasibility

### Takeaway
The detection-based counters from the Ljubljana group lead exemplar-only counting with boxes: DAVE (CVPR 2024) → GeCo (NeurIPS 2024) → GeCo2 (AAAI 2026). GeCo2 explicitly targets small, dense objects without tiling. Open-world prompt models (CountGD++, CVPR 2026; T-Rex2 / T-Rex-Omni; DINO-X) add negative and external exemplars, which suits near-duplicate symbols (GPO vs switch). All are GPU/server-class: SAM/SAM2, Swin or GroundingDINO backbones, or API-only. On actual floor-plan line art, the only public evaluation found (PlanSpot, an unreviewed repo) shows **pixel NCC beating frozen DINOv2-S on small symbols**, with recall about 0.4 for both. That matters directly for Patch 5.

### Cited Findings

**Detection-based low-shot counters (exemplar boxes → boxes + count)**
- **DAVE: A Detect-and-Verify Paradigm for Low-Shot Counting**, Pelhan, Lukežič, Zavrtanik, Kristan, CVPR 2024. It first generates a high-recall detection set, then verifies detections to remove outliers. The authors claim it beats density-based counters by ~20% total-count MAE and detection-based counters by ~20% in detection quality. The demo uses a ResNet-50 (SwAV) backbone; MIT licence — [GitHub jerpelhan/DAVE](https://github.com/jerpelhan/DAVE); [CVPR 2024 paper](https://openaccess.thecvf.com/content/CVPR2024/papers/Pelhan_DAVE_-_A_Detect-and-Verify_Paradigm_for_Low-Shot_Counting_CVPR_2024_paper.pdf)
- **GeCo: A Novel Unified Architecture for Low-Shot Counting by Detection and Segmentation**, Pelhan, Lukežič, Zavrtanik, Kristan, NeurIPS 2024. A single-stage add-on to a SAM backbone (trained from SAM-HQ weights) with dense object queries and a counting loss that optimises detection directly. It also outputs masks. The authors claim ~25% lower total-count MAE than leading detection-based counters. MIT licence; the authors recommend GeCo2 for new projects — [GitHub jerpelhan/GeCo](https://github.com/jerpelhan/GeCo); [NeurIPS 2024 poster](https://neurips.cc/virtual/2024/poster/93724); [arXiv 2409.18686](https://arxiv.org/html/2409.18686v2)
- **GeCo2: Generalized-Scale Object Counting with Gradual Query Aggregation**, Pelhan, Lukežič, Kristan, AAAI 2026 (vol. 40, no. 10, pp. 8314-8321) — [GitHub GECO2](https://github.com/katsugtgz/GECO2) (fork of jerpelhan/GECO2); [arXiv 2511.08048](https://arxiv.org/pdf/2511.08048):
  - It builds a generalized-scale dense query map aggregated across backbone resolutions, and "avoids heuristic upscaling/tiling" for small, dense objects.
  - Scale-specific query encoders combine exemplar appearance and shape prototypes, with a lightweight SAM2 mask refinement step.
  - Claimed ~3x faster with a smaller GPU footprint (baseline unstated).
  - Evaluated on FSCD147, FSCD-LVIS and MCAC; listed as SOTA on FSCD-147.
- **Third-party head-to-head**: CountVid ("Open-World Object Counting in Videos", Amini-Naieni & Zisserman, 2025/2026) reports on the FSCD-147 *validation* split, exemplar prompts only:
  - GeCo: AP 33.51 / AP50 62.51
  - DAVE: 24.20 / 61.08
  - CountGD: 15.16 / 47.96

  The authors call GeCo "the superior model in the exemplar-only setting". The table text was partly garbled in extraction — [arXiv 2506.15368](https://arxiv.org/pdf/2506.15368); [Oxford VGG PDF](https://www.robots.ox.ac.uk/~vgg/publications/2026/AminiNaieni26/amininaieni26.pdf) (snippet)

**Open-world / prompt-based counters (2025-2026)**
- **CountGD++: Generalized Prompting for Open-World Counting**, Amini-Naieni & Zisserman, CVPR 2026 (arXiv Dec 2025) — [arXiv 2512.23351](https://arxiv.org/pdf/2512.23351); [CVPR 2026 poster](https://cvpr.thecvf.com/virtual/2026/poster/36500) (abstract/snippet):
  - Adds **negative prompts** (text and/or visual exemplars of what *not* to count).
  - Adds **pseudo-exemplars**: top boxes from a text-only pass are fed back as visual exemplars, which "significantly improves" accuracy.
  - Accepts external exemplars from natural or synthetic images, and can act as a vision tool for an LLM agent.
- MixCount (arXiv May 2026) evaluates CountGD++ with positive and negative prompts. In-image exemplars beat external ones: MAE 2.81 vs 5.53 on the MixCount test set — [arXiv 2605.18063](https://arxiv.org/pdf/2605.18063) (snippet)
- **CountEx: Fine-Grained Counting via Exemplars and Exclusion**, arXiv Feb 2026. Positive plus exclusion exemplars for fine-grained (lookalike) counting — [arXiv 2602.19432](https://arxiv.org/pdf/2602.19432) (title only; no numbers verified)
- **T-Rex2: Towards Generic Object Detection via Text-Visual Prompt Synergy**, IDEA Research, ECCV 2024. Evaluated on few-shot counting with three exemplar boxes per image on FSC147 and FSCD-LVIS, which contain dense, small objects. It beats T-Rex on AP but not on MAE — [arXiv 2403.14610](https://arxiv.org/pdf/2403.14610) (snippet)
- **T-Rex-Omni: Integrating Negative Visual Prompt in Generic Object Detection**, arXiv Nov 2025. It scores 43.27 AP on FSCD-LVIS multi-target vs 43.35 for T-Rex2, and FSC147 MAE 13.76 vs 8.72 for T-Rex — [arXiv 2511.08997](https://arxiv.org/pdf/2511.08997) (snippet)
- **DINO-X** (IDEA Research technical report, 2024) lists visual-prompt counting and uses a Grounding-DINO-1.5-style encoder-decoder. It is distributed as a cloud API, so it is a vendor model, not client-side — [arXiv 2411.14347](https://arxiv.org/html/2411.14347v2); [GitHub IDEA-Research/DINO-X-API](https://github.com/idea-research/dino-x-api)
- **YOLOE: Real-Time Seeing Anything** (Tsinghua THU-MIG, ICCV 2025 per listings). A real-time YOLO with text prompts, **visual prompts** (SAVPE encoder) and a prompt-free mode. ONNX exports exist (Luxonis). The licence is listed as **AGPL-3.0** by the repo mirror and Luxonis, while one tutorial says Apache-2.0 (conflict noted) — [Ultralytics YOLOE docs](https://docs.ultralytics.com/models/yoloe); [Luxonis model page](https://models.luxonis.com/luxonis/yoloe-v8-l/aim_9yTXadJ3UmNQoahEDwaK6A?backTo=%2F); [science.ecosyste.ms listing](https://science.ecosyste.ms/projects/19320)

**Training-free and efficient counting (2025-2026; titles/abstracts only)**
- "A Simple-but-effective Baseline for Training-free Class-Agnostic Counting", Lin et al., WACV 2025 — [CVF](https://openaccess.thecvf.com/content/WACV2025/papers/Lin_A_Simple-but-Effective_Baseline_for_Training-Free_Class-Agnostic_Counting_WACV_2025_paper.pdf)
- OCCAM: class-agnostic, training-free, prior-free, multi-class counting, arXiv Jan 2026 — [arXiv 2601.13871](https://arxiv.org/pdf/2601.13871)
- CoDi: an exemplar-conditioned diffusion model for low-shot counting, arXiv Dec 2025 — [arXiv 2512.20153](https://arxiv.org/pdf/2512.20153)
- An efficient low-shot class-agnostic counting framework (PLOS ONE 2025) applies self-attention only to high-level features plus iterative exemplar learning, and claims real-time inference. Parameter count and edge benchmarks were not found — [PLOS ONE](https://journals.plos.org/plosone/article?id=10.1371%2Fjournal.pone.0322360)
- Survey: "Object Counting Across Modalities: Taxonomies, Benchmarks, Applications, and Open Challenges", arXiv Aug 2026 — [arXiv 2608.23845](https://arxiv.org/pdf/2608.23845) (title only)

**Evidence on line-art floor plans specifically**
- **PlanSpot** (GitHub, MIT code, no paper, 2 commits; *unreviewed*) runs one-shot symbol spotting on FloorPlanCAD with frozen DINOv2-S/14 — [GitHub dzakybd/planspot](https://github.com/dzakybd/planspot):
  - Setup: input upsampled 2x and processed in overlapping 518 px tiles. 8 dihedral poses. Cosine matching of the exemplar's in-context patch features, then local maxima, then NMS.
  - Thresholds: either a global threshold, or an adaptive "largest gap in sorted scores" cut.
  - Test split: 369 episodes, 1,142 instances, split by source drawing.

  | Method | Cut-off | Precision | Recall | F1 |
  |---|---|---|---|---|
  | Pixel NCC | global 0.90 | 0.502 | 0.434 | 0.466 |
  | DINOv2-S, 2x, tiled | global | 0.776 | 0.357 | 0.489 |
  | DINOv2-S, 2x, tiled | adaptive | 0.717 | 0.401 | 0.514 |
  | Pixel NCC | adaptive | 0.805 | 0.423 | **0.555** |

  - By size: NCC wins on **small symbols (F1 0.767 vs 0.664)**, DINOv2 wins on medium (0.448 vs 0.344), and they tie on large.
  - Count error (MAPE): 1.59 for NCC vs 0.66 for DINOv2.
  - The author identifies recall (~0.4) as the bottleneck for both.
- Matcher (one-shot segmentation via DINOv2 patch matching, training-free) targets natural images, not drawings — [arXiv 2305.13310](https://arxiv.org/pdf/2305.13310)

**Browser feasibility**
- ONNX Runtime Web supports a WebGPU execution provider (`onnxruntime-web/webgpu`). WebGPU has shipped by default in desktop Chrome/Edge since v113 — [Microsoft Open Source blog](https://opensource.microsoft.com/blog/?p=95110)
- A non-peer-reviewed comparison says choosing WebGPU vs WASM can change ONNX Runtime Web performance by 10-15x depending on model and hardware. Its only concrete figure is all-MiniLM-L6-v2 at 8-12 ms on an M2 MacBook Air — [SitePoint](https://www.sitepoint.com/webgpu-vs-webasm-transformers-js/) (blog)
- An OWLv2 checkpoint exported for Transformers.js (`Xenova/owlv2-base-patch16-finetuned`) exists and was run in a WebGPU benchmark harness, but that logged run failed at image load. Image-guided (one-shot) query support in Transformers.js was not confirmed — [transformers.js performance leaderboard commit](https://huggingface.co/datasets/whitphx/transformersjs-performance-leaderboard-results/commit/1b327b1a3e92a247f96f2a286fb6582ffbfd2fbb)

### Inferences
- **Browser-feasible tier.** DAVE and LOCA (ResNet-50, MIT) are the only SOTA-adjacent exemplar counters with a backbone small enough to plausibly quantise for ONNX Runtime Web. GeCo/GeCo2 (SAM/SAM2-based, Deformable-DETR), CountGD++ (GroundingDINO), T-Rex2 and DINO-X (API) are server-class, so treat them as distillation teachers or optional server tools. YOLOE is architecturally the right shape (real-time, visual prompts, ONNX) but likely AGPL, which conflicts with the repo's no-Ultralytics/AGPL policy.
- **PlanSpot implies Patch 5 should be hybrid, not DINOv2-only.**
  - Keep NCC/shape matching for small symbols (most downlights, smoke alarms and GPOs at 1:100 are small).
  - Use DINOv2 features for medium/large symbols and as a **verifier**. This is DAVE's detect-then-verify pattern: run a high-recall template/NCC pass, then reject outliers with feature similarity.
  - Use the adaptive largest-gap threshold. It gave the best NCC F1 and needs no tuning.

  This rests on one unreviewed repo with ~1.1k instances, so it is directional only.
- **Negative exemplars** (CountGD++, T-Rex-Omni, CountEx) map onto a cheap UX addition: a "not this" click (e.g. Alt-click on a switch while counting GPOs) that subtracts a prototype. This targets the lookalike confusion the existing review flags.
- GeCo2's claim that it avoids tiling is the research direction for multi-scale features. For a browser tool constrained to a ~416-640 px model input, tiling remains unavoidable, so the cross-tile fusion fixes in section 1 apply to any exemplar matcher as well (PlanSpot itself tiles at 518 px).

### Gaps
- No FSCD-147 AP numbers for GeCo2, and no parameter counts or latencies for GeCo2, DAVE or LOCA, were retrievable (arXiv blocked; READMEs omit them).
- No paper found that evaluates any class-agnostic counter (FamNet → GeCo2, CountGD++) on technical drawings or line art. FSC-147-style benchmarks are natural images.
- No measured browser (WASM/WebGPU) latency found for any exemplar-counting model.

## 4. Synthetic data and domain randomization for drawing-symbol detectors: evidence of transfer

### Takeaway
The strongest 2026 evidence (SynthPID, P&IDs) finds that synthetic data fails mainly on **structure, not appearance**. Templates scattered at random positions transfer poorly (~33% edge accuracy). Re-rendering perturbed real layouts transfers well (63.8% edge mAP with zero real training drawings, about +30 points). Separately, TA-TM shows the scale seen at training must match the tile scale at inference, or recall collapses.

### Cited Findings
- **SynthPID: P&ID digitization from Topology-Preserving Synthetic Data**, Prasad et al., CVPR 2026 Workshops (AI4RWC); arXiv Apr 2026 — [CVPRW 2026 PDF](https://openaccess.thecvf.com/content/CVPR2026W/AI4RWC/papers/Prasad_SynthPID_PID_digitization_from_Topology-Preserving_Synthetic_Data_CVPRW_2026_paper.pdf); [arXiv 2604.16513](https://arxiv.org/html/2604.16513) (abstract/snippet only; full text blocked):
  - Template-based generators "scatter symbols at random", and synthetic-only training with them gives ~33% edge detection accuracy.
  - SynthPID instead seeds from real P&IDs: it extracts each drawing's component graph, perturbs it and re-renders it.
  - 665 synthetic drawings reach **63.8% edge mAP on OPEN100 with no real P&IDs in training**, about 30 points above template-based synthetic data.

  These are preprint/workshop claims.
- Dataset-P&ID, the common synthetic baseline, has 500 diagrams made by randomly scattering 32 symbol templates. Prior work tested on 100 synthetic and only 12 real private P&IDs, which shows how little real evaluation data exists — [Digitize-PID, arXiv 2109.03794](https://arxiv.org/pdf/2109.03794) (snippet)
- Scale matching: a detector trained on full images scores mAP@50 = 0.01 under tile inference vs 0.72-0.94 when trained on tile crops at the inference scale — [TA-TM, arXiv 2605.24726](https://arxiv.org/pdf/2605.24726) (snippet)
- Practitioner guidance (repo README, not a controlled study): combine real symbol crops with synthetic variants (noise, blur, skew, background), and **split train/val by source diagram** to avoid leakage — [GitHub PID-Vision](https://github.com/Vidyadhar-pothula/PID-Vision)
- PlanSpot also splits FloorPlanCAD by source drawing — [GitHub dzakybd/planspot](https://github.com/dzakybd/planspot)

### Inferences
- For pdf2takeoff's generator (`scripts/generate-synthetic-dataset.mjs`), SynthPID implies that the next lever after Patch 1's degradation axis is **layout realism**:
  - Place downlights on ceiling grids inside room polygons.
  - Put GPOs and switches against walls near doors.
  - Place smoke alarms at room centroids.
  - Seed layouts from real (client-consented) sheets' symbol positions.

  Patch 1 already moves away from rejection-sampling symbols clear of walls; SynthPID suggests going further, toward topology-preserving placement.
- `specs/detector-tiling.md` already documents the pxPerPt training/inference match. TA-TM's 0.01-vs-0.72 result is independent quantitative support that the rule must be enforced at export, for example by asserting `pxPerPt` in the notebook export cell.

### Gaps
- No floor-plan or electrical-sheet sim-to-real study from 2024-2026 was found beyond Bickel 2024 (already in the review). SynthPID is P&ID-only, and its full ablations were not readable.

## 5. Concrete recommendations mapped to pdf2takeoff's tile-edge double-count, tile cap and per-class detection cap

### Takeaway
Fix the double-count with three changes:
1. Make the overlap at least the largest symbol size.
2. Drop boxes that touch an interior tile edge.
3. Merge cross-tile pairs with IoS (SAHI's default), keeping IoU-NMS within a tile.

Replace the hard 512-window throw with blank-tile skipping and a time budget, and apply class filtering before the detection cap. Each step is supported by section 1's sources or by arithmetic on the repo's own spec.

### Cited Findings
- SAHI fuses slices with GREEDYNMM + IoS 0.5, per class, 20% overlap, plus a full-image pass. Matched boxes become the union box with the max score — [SAHI predict.py](https://github.com/obss/sahi/blob/main/sahi/predict.py); [SAHI utils.py](https://github.com/obss/sahi/blob/main/sahi/postprocess/utils.py)
- Dropping boxes that touch an inner tile edge is used in practice, because the neighbour tile sees the object whole — [practitioner PR](https://github.com/benoyj20/Computer-Vision-For-Object-History-Tracking-/pull/5)
- Seam-band fusion is used in vendor tooling — [DeGirum tiling guide](https://docs.degirum.com/hailo/intermediate-guides/tiling)
- Tile-adjacency rescoring helps boundary objects, and 128 px overlap lifts boundary recall — [TA-TM, arXiv 2605.24726](https://arxiv.org/pdf/2605.24726)
- Content-adaptive slice gating is a 2026 research direction — [ROI-Gated SAHI, arXiv 2608.23923](https://arxiv.org/html/2608.23923v1)
- STRtree-indexed greedy merging handles tens of thousands of boxes in ~100 ms, while transitive NMM does not scale — [SAHI Discussion #1420](https://github.com/obss/sahi/discussions/1420)
- Current code: `overlapPx` (spec example 32 px), `MAX_WINDOWS = 512` throws, `MAX_DET = 500` is applied across all classes inside `nmsPerClass` before the clicked class is chosen — [src/engine/scan-onnx.ts](../../src/engine/scan-onnx.ts); [specs/detector-tiling.md](../../specs/detector-tiling.md)

### Inferences

**A. Tile-edge double-count (highest priority)**
1. **Overlap ≥ largest symbol + margin.** Set `overlapPx` from the largest symbol extent in raster px, for example `ceil(1.25 × maxSymbolPt × RASTER_SCALE)`. For a 9 mm symbol that is about 96 px, versus 32 today. Alternatively, express overlap in points in the manifest so it cannot drift from RASTER_SCALE. Without this, steps 2-3 cannot be correct: a seam-straddling symbol yields two half-boxes with IoS ≈ 0 and no full box anywhere. The cost is modest: with ~1,273 px windows (pxPerPt 0.98), going from 32 to 96 px overlap adds about 5% more windows per axis.
2. **Edge-truncation filter (per window, before fusion).** Drop a detection whose box lies within ε (about 2 px) of a window edge, *unless that edge is the sheet border*. Given step 1, a neighbouring window contains the whole symbol, so nothing is lost. This removes the truncated box before NMS rather than relying on a metric to merge it.
3. **Cross-window IoS merge as a safety net.** In `nmsPerClass`, record each detection's window index:
   - For pairs from *different* windows, suppress or merge when IoS > 0.5 (SAHI default).
   - For pairs from the *same* window, keep the current IoU test, so adjacent same-class symbols inside one tile (rows of downlights) are not over-merged.
   - Keep the higher-score box rather than SAHI's union box. The union of a truncated and a full box equals the full box anyway, and keeping the scored box avoids inflating boxes when two near-touching symbols merge by mistake.
4. **Optional TA-TM-style rescoring.** If boundary detections still go missing (low confidence on partial views), give a small score bonus to boundary detections that have a complementary detection in the adjacent window before thresholding. This is training-free.
5. **Test.** Extend `scripts/check-detector.mjs`: have the fake session emit a truncated box in window A and the full box in window B for the same symbol, and assert the count is 1. Add a case with two adjacent same-class symbols in one window and assert the count stays 2.

**B. 512-window cap**
- Arithmetic from the spec's own formula, W = inputSize × RASTER_SCALE / pxPerPt:
  - A0 is 3370 × 2384 pt, or about 10,110 × 7,152 raster px at 3 px/pt.
  - For a crop-trained model (pxPerPt = 3, W = 416, overlap 32, stride 384), that gives 27 × 19 = **513 windows**. The scan throws and silently falls back to the CV scan on exactly the sheets tiling was built for.
  - With pxPerPt 0.98 (W ≈ 1,273), A0 needs only about 9 × 6 = 54 windows.
- **Skip blank windows.** Construction sheets are mostly white paper. Compute ink coverage per window from the raster (cheap integral image) and skip windows below a threshold. This is the "content-adaptive slicing" idea of ROI-Gated SAHI applied with a trivial gate.
- **Replace the count cap with a time/progress budget.** Process windows in order of ink density, stream partial counts to the UI, and allow cancel. Keep a much higher hard ceiling only as a guard against bad configs.
- **Restrict scope when needed.** Offer "scan visible region / selected area" for very large sheets. Batch several windows per `session.run` if the ONNX graph has a dynamic batch dimension; this is worth measuring on WebGPU.

**C. MAX_DET applied before the class filter**
- Today one dense class (for example 600 diffuser-like false positives) can consume the 500-detection budget before the clicked class (say smoke alarms) is kept, so the count is silently capped or starved.
- **Fix:**
  1. Run NMS on all classes only to find the class nearest the click (or decide the class from detections near the click).
  2. Re-run fusion with only that class and no global cap, or a per-class cap.
- **Surface saturation.** If any cap is hit, return a warning in `ScanResult` ("count may be truncated") rather than a silently wrong total. A takeoff count must never be silently capped.
- **Use a spatial index.** Pre-filter by class, then use a uniform grid or STRtree-style index for neighbour lookup so fusion stays near-linear. SAHI 0.12.5 shows that an all-pairs approach blows up on crowded inputs.

**D. Exemplar tier (Patch 5) adjustments from the 2024-2026 evidence**
- Build the embedding tier as **NCC/shape candidates + DINOv2 verification** (DAVE's detect-then-verify) rather than DINOv2 matching alone, since PlanSpot finds NCC better on small symbols.
- Use the adaptive largest-gap threshold.
- Search 8 dihedral poses, because symbols rotate with walls.
- Run the same tiling + edge-filter + IoS fusion as the detector.
- Add a negative-exemplar click (CountGD++ / T-Rex-Omni / CountEx idea) for lookalikes.
- Evaluate with per-sheet count MAE by class, not just mAP.

### Gaps
- None of the A-D recommendations has been validated on pdf2takeoff's own sheets. The arithmetic in B and A.1 uses the spec's example values (overlapPx 32, 9 mm symbols, RASTER_SCALE 3), not the shipped manifest; no `tile` block was found under `public/models/`.
- There is no published quantitative evidence for the exact IoS threshold (0.5) or the edge-ε on line-art symbols. Both should be tuned on a held-out set of real sheets with seam-straddling symbols.
