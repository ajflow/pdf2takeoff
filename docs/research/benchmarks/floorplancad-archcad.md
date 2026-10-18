# FloorPlanCAD and ArchCAD-400K as benchmarks for pdf2takeoff

Research note, 18 Oct 2026. Companion to `docs/research/ai-literature-review.md`
(paper summaries) and `research_notes/AI research for PDF takeoff/vector_cad_symbol_spotting.md`
(method lineage and PQ table). This note covers what those two do not: the data as it is
actually distributed today, the annotation schema, licences, whether
`scripts/floorplancad-convert.py` applies, and how pdf2takeoff would be scored.

Tags: [verified] = read directly from code, a downloaded file, or a command run in this
session. [reported] = taken from search-engine extracts of pages this sandbox could not open
(Hugging Face, arXiv, CVF, Voxel51 docs, Google Drive and GitHub Pages were all refused by the
egress proxy with CONNECT 403). [inferred] = my reading of code, not stated anywhere.

## Summary

1. FloorPlanCAD is distributed as SVG (plus PNG rasters on the Hugging Face mirrors), never as DXF: `scripts/floorplancad-convert.py` (DXF INSERT based) cannot run on it and a small SVG converter is needed instead [verified from three official loaders].
2. Ground truth is per primitive: `semanticId` 1..35 and `instanceId` on every `<path>`, `<circle>`, `<ellipse>`; per-class instance counts (what pdf2takeoff produces) fall out by counting distinct `instanceId` per class [verified].
3. ArchCAD-400K is only 10 percent public (a gated 40K-slice subset on Hugging Face, CC BY-NC 4.0); the full 413K set, official splits, DPSS weights and the CADParser tool are not released as of Oct 2026 [verified from repo issues, reported for HF].
4. Both datasets are non-commercial; fine for a published accuracy study, not for shipped weights (consistent with `training/README.md`).
5. No sample could be downloaded from this sandbox (every data host is policy-blocked); the converter was exercised on a synthetic DXF instead and works, which is moot for these datasets.

## What they measure

Both benchmarks define **panoptic symbol spotting** on vector drawings: every graphical
primitive (line, arc, circle, ellipse) gets a semantic class, and primitives of countable
("thing") classes also get an instance id. Uncountable ("stuff") classes such as walls get
no instance id. Nothing is measured at the pixel or bounding-box level.

**Panoptic Quality as implemented** [verified, read from the SymPointV2-derived evaluator
that the ArchCAD repo ships at `svgnet/evaluation/point_wise_eval.py`, and from VecFormer's
`model/vecformer/evaluator/evaluator.py`]:

- Every primitive carries a weight `log(1 + length)`, so very long lines do not dominate (VecFormer's comment says this follows the FloorPlanCAD paper).
- For each ground-truth instance, each predicted instance with score >= 0.1 is tested: `IoU = sum(weights of primitives in both) / sum(weights in either)`.
- IoU >= 0.5 and same label: TP (and the IoU is accumulated for SQ). IoU >= 0.5 and different label: one FP charged to the predicted label. No prediction reaching IoU 0.5: one FN.
- `RQ = TP / (TP + 0.5 FP + 0.5 FN)`, `SQ = sum(IoU of TPs) / TP`, `PQ = RQ x SQ`, reported overall, for thing classes and for stuff classes.
- Quirk worth knowing before comparing anything: in this evaluator a prediction that overlaps no ground truth at all is never counted as a false positive. Hallucinated symbols on empty areas are free. A pure count comparison (below) does penalise them.
- Semantic metrics (mIoU, fwIoU, pACC over primitives) are computed from a confusion matrix of primitive labels, also length-agnostic.

Thing and stuff membership differs between the two datasets' configs [verified]:

- FloorPlanCAD (SymPoint config, 35 classes): things = ids 1..30, stuff = 31..35, background = 36.
- ArchCAD (ArchCAD repo config, 30 classes): things = `[1..11, 14..18, 21, 22, 25, 27, 29]` (21 classes), stuff = `[0, 12, 13, 19, 20, 23, 24, 26, 28]` (9 classes). This matches the class table below exactly.

## Data and format

### FloorPlanCAD

Verified facts (from the official loaders of SymPoint `parse_svg.py`, VecFormer
`data/floorplancad/preprocess.py`, CADTransformer `preprocess/*.py`, all cloned from GitHub):

- One drawing = one `.svg` file under `<split>/<split>/svg_gt/*.svg` after unzipping the official `train.zip`, `val.zip`, `test.zip` [verified from `download_data.py` and `svg2png.py` paths].
- Root `<svg viewBox="minx miny width height">`. Primitives sit inside `<g>` groups; every loader uses the group index as the CAD layer id, so layers survive in the SVG [verified]. CADTransformer's reader also expects `<text>` elements, so annotation text is present in some files [verified].
- Primitive elements: `<path d="...">` whose first segment is a `Line` or an `Arc` (svgpathtools), `<circle cx cy r>`, `<ellipse cx cy rx ry transform="rotate(...)">`. SymPoint's primitive vocabulary is exactly `[Line, Arc, circle, ellipse]` and it raises on anything else [verified].
- Attributes on every primitive: `stroke="rgb(r,g,b)"`, `stroke-width`, and the labels `semanticId` (1..35; absent means background, which loaders map to 36) and `instanceId` (>= 1 for a countable instance; absent or -1 for stuff and background) [verified]. Attribute names are camelCase `semanticId` / `instanceId` in the code; the Voxel51 card describes them as `semantic-id` / `instance-id` [reported], so a converter should accept both spellings.
- Coordinates: SymPoint divides all coordinates and lengths by 140 and CADTransformer rasterises at scale 7, which is the ArchCAD config's `img_size: 980`. The tiles are therefore 140 drawing units square [inferred]; whether that is 14 m at 10 units per metre is not stated in any code.
- Class list (35, FloorPlanCAD-V2) [verified from SymPoint `svg.py` and CADTransformer `anno_config.py`]:
  1 single door, 2 double door, 3 sliding door, 4 folding door, 5 revolving door, 6 rolling door,
  7 window, 8 bay window, 9 blind window, 10 opening symbol,
  11 sofa, 12 bed, 13 chair, 14 table, 15 TV cabinet, 16 Wardrobe, 17 cabinet, 18 gas stove, 19 sink, 20 refrigerator, 21 airconditioner, 22 bath, 23 bath tub, 24 washing machine, 25 squat toilet, 26 urinal, 27 toilet,
  28 stairs, 29 elevator, 30 escalator (things);
  31 row chairs, 32 parking spot, 33 wall, 34 curtain wall, 35 railing (stuff).
- The "30 categories" of the ICCV 2021 paper is the V1 label set (28 things plus wall and parking as stuff) [reported]. CADTransformer ships a `RemapDict` that folds the 35 V2 ids into the V1 numbering, confirming the two label sets coexist [verified]. pdf2takeoff's converter docstring and `training/README.md` say "30 categories"; the current release has 35.
- No DXF anywhere. The repo converter's premise ("symbols are INSERT block references") does not hold for the distributed data; the equivalent signal is `instanceId`.

Reported facts (not openable from here):

- Size and splits: V1 = 10,094 drawings, 6,382 train / 3,712 test (ICCV PDF text, repeated on the Voxel51 card). V2 = 15,663 drawings, 10,161 train (800 held out as val) / 5,502 test (arXiv version). A 2026 paper re-splits V2 as 9,533 / 4,597 / 1,533 [all reported].
- Voxel51 card: drawings were cropped into 20 m x 20 m blocks with 50 percent retention and sensitive text removed; the project was shut down in January 2023 (one passage says 2022) and most participants left the company [reported].
- Hugging Face `Voxel51/FloorPlanCAD`: FiftyOne-format dataset, 5,308 samples, described as the test split, "SVG with corresponding PNG rasterizations", 30 categories (28 things, stuff = wall and parking, stuff instance_id = -1) [reported]. 5,308 does not equal either 3,712 or 5,502; unexplained.
- Hugging Face `tilak1114/FloorPlanCAD`: a parquet export (`data/train-00000-of-00001.parquet`) of the same 5,308 drawings with 1000 x 1000 PNGs and per-object `bbox` (0..1000 frame), `category` string and `mask`; despite the file name it is the test split. Categories include names not in the official list (`bedside_cupboard`, `half_height_cabinet`, `high_cabinet`, `class_31`, `class_32`) [reported, via the matchline project's loader docs which say they checked the dataset viewer on 2026-10-06].
- Hugging Face `guruprasad-hegde/FloorPlanCAD` exists in search results; contents unknown [reported].
- Hugging Face model `mudasir13cs/floorcad-yolov8n-detect`: YOLOv8n trained on a 35-class YOLO conversion of FloorPlanCAD, training images not redistributed [reported]. Shows someone already did the SVG to YOLO conversion this repo planned; AGPL Ultralytics, so not reusable here.

### ArchCAD-400K

Verified facts:

- Code repo `ArchiAI-LAB/ArchCAD` (mirror `Lulzx/ArchCAD` is byte-identical in README) contains DPSS model code, but not the `svgnet/data` loader, not the `dataset/` folder, not the FloorPlanCAD parser it tells you to run, and its only "pretrained weights" script downloads the HRNet-OCR COCO-Stuff backbone from GitHub, not DPSS [verified from the clone]. Open issues #1, #4, #6, #9 report exactly this; #2 (weights) and #8 (cannot reproduce) have no maintainer reply [verified from GitHub].
- Config: 30 semantic classes, `img_size: 980`, HRNet48 raster branch plus point-transformer vector branch, 800 queries, batch 8 [verified].
- Class table (30 ids plus `100 Others`) as transcribed from the gated dataset card by the matchline project and consistent with the repo's thing/stuff id lists [verified consistency; names reported]:
  0 Axis & Grid (stuff), 1 Single Door, 2 Double Door, 3 Parent-Child Door, 4 Other Door, 5 Elevator, 6 Staircase, 7 Sink, 8 Urinal, 9 Toilet, 10 Bathtub, 11 Squat Toilet, 12 Other Fixtures (stuff), 13 Drain (stuff), 14 Table, 15 Chair, 16 Bed, 17 Sofa, 18 Hole, 19 Glass (stuff), 20 Wall (stuff), 21 Concrete Column, 22 Steel Column, 23 Concrete Beam (stuff), 24 Steel Beam (stuff), 25 Parking Space, 26 Foundation (stuff), 27 Pile, 28 Rebar (stuff), 29 Fire Hydrant, 100 Others.
- Code licence: "ACADEMIC USE LICENSE", copyright Arcplus East China Architectural Design & Research Institute, commercial use "strictly prohibited" [verified from LICENSE].

Reported facts:

- Paper: 5,538 drawings validated out of 11,917 industry drawings, 413,062 annotated chunks, 27 categories of which 14 have over 1 M primitives, 7 countable instance categories; labels mined from layer names plus block structure and then expert-reviewed; furniture types consolidated [reported]. The 27 / 7 of the paper versus 30 / 21 of the code and card is an open question (probably paper v1 versus release).
- Each sample is a 14 m x 14 m slice; five "strictly aligned" modalities per slice: PNG, SVG, JSON, point cloud, caption (Q&A) [reported, HF card via search].
- Hugging Face `jackluoluo/ArchCAD`: gated (institution plus non-commercial confirmation, approval up to 3 business days), licence cc-by-nc-4.0, 40K first batch; 41,097 JSON files; zips under `data/`: `json` about 393 MB, `png` about 1.8 GB, `svg`, `point`, `caption` [reported via matchline PRs #676, #726 and issue #11].
- JSON schema per slice: a list of primitives, each `{"type": "LINE", "start": [x,y], "end": [x,y], "linetype": ..., "rgb": [r,g,b], "semantic": <id or name>, "instance": <id shared by one object>}`; `CIRCLE` has `center`, `radius`; `ARC` adds `start_angle`, `end_angle`; `ELLIPSE` (about 1 percent of primitives) uses DXF fields `center`, `major_axis`, `ratio`, `start_param`, `end_param`, `is_ccw`. Only countable classes carry `instance`; some countable primitives in the real files have none [reported, matchline loader built against the card and then run on 500 real slices: 4,492 symbols, most often concrete columns 1,183, piles 811, holes 575, single doors 432].
- Conflicting report: issue #8 (Mar 2026) says the first 100 JSON files had zero `semantic_labels` and zero `instance_labels`. The key names differ from the card's `semantic` / `instance`, so this may be a different file family or a misread; unresolved.
- No official train/val/test split is published for the 40K subset (issue #5) and nobody has answered whether tiles can be stitched back into sheets.
- Third-party weights `mohansshf/dpss-archcad` on Hugging Face claim to be DPSS trained on the 40K subset; not from the authors, unverified [reported].

### How ArchCAD differs from FloorPlanCAD (for pdf2takeoff)

- Structural and notation classes (columns, beams, piles, foundation, rebar, axis grid, holes, fire hydrants) in addition to architectural symbols; furniture coarser. These are closer to the sheets a QS counts (columns, piles, hydrants are real takeoff items) than FloorPlanCAD's residential furniture.
- Same 980 px raster convention and primitive-level labels, so one evaluation harness serves both.
- Explicitly built to be evaluated without layer and colour priors, which is the PDF situation.
- Access is slower (gated) and the public subset is unlabelled for stuff in places and lacks splits; FloorPlanCAD is a direct zip download if the Drive links still work.

## Licence

| Dataset | Licence | Source of claim | Consequence |
|---|---|---|---|
| FloorPlanCAD | CC BY-NC 4.0 (Voxel51 docs, lit review); one HF zoo listing shows CC-BY-SA-4.0 | [reported], conflict unresolved | Eval and papers fine; weights trained on it are research checkpoints only, as `training/README.md` already states |
| ArchCAD-400K data | CC BY-NC 4.0, gated | [reported] | Same; plus you sign a non-commercial statement to get access |
| ArchCAD / DPSS code | Academic use only, commercial use prohibited | [verified] | Do not vendor any of it into pdf2takeoff (Apache-2.0) |
| SymPoint code | LICENSE.txt present; eval code copied by ArchCAD carries a note that SymPointV2 "does not specify a license" | [verified] | Re-implement the PQ evaluator rather than copy it |
| CADTransformer code | MIT | [verified] | Safe to borrow the SVG reader and rasteriser pattern |
| VecFormer code | Apache-2.0 | [verified] | Safe to borrow `preprocess.py` parsing logic |

## Availability and what I downloaded

Reachable from this sandbox: `github.com`, `raw.githubusercontent.com`, PyPI. Refused with
`CONNECT tunnel failed, response 403` (policy denial, recorded by the agent proxy):
`huggingface.co`, `hf.co`, `cdn-lfs.huggingface.co`, `hf-mirror.com`, `drive.google.com`,
`docs.google.com`, `drive.usercontent.google.com`, `1drv.ms`, `arxiv.org`, `export.arxiv.org`,
`www.arxiv.org`, `web3.arxiv.org`, `ar5iv.labs.arxiv.org`, `openaccess.thecvf.com`,
`docs.voxel51.com`, `voxel51.com`, `floorplancad.github.io`, `archiai-lab.github.io`,
`hyper.ai`, `www.alphaxiv.org`, `themoonlight.io`, `researchgate.net`, `semanticscholar.org`,
`paperswithcode.com`, `web.archive.org`, `api.openalex.org`, `r.jina.ai`, `neurips.cc`,
`openreview.net`, `platform.ultralytics.com` [verified, curl exit 56 on each].

Consequently `/tmp/claude-0/-home-user-pdf2takeoff/db387ea9-d3a7-5ddc-8c81-f410e6f4815f/scratchpad/floorplancad/`
is empty: not one SVG, PNG or JSON of either dataset was obtained, and the schema above comes
from the official loaders rather than from files. What was downloaded instead (shallow git
clones, untrusted, read only, in
`/tmp/claude-0/-home-user-pdf2takeoff/db387ea9-d3a7-5ddc-8c81-f410e6f4815f/scratchpad/repos/`):
`nicehuster/SymPoint`, `VITA-Group/CADTransformer`, `WesKwong/VecFormer`, `Lulzx/ArchCAD`
(mirror of `ArchiAI-LAB/ArchCAD`), `anchapin/matchline` (third-party loaders for both datasets).

Download sources to use from an unrestricted machine [verified from code, liveness not verified]:

- FloorPlanCAD official zips on Google Drive, ids from `download_data.py` (SymPoint and CADTransformer carry identical ids): train `16McNNY_-Y2uVnq42ntZTdYKPWgOZxwp3`, val `1xgLqcj91i13_3vhfsUYcRYh3PhFYB9LJ`, test `1Hc4-ggsUMoB_5uqJdqYRn9K73QS8rOgG` (`gdown "https://drive.google.com/uc?id=<id>"`). VecFormer's README points at a single `FloorPlanCAD.zip`, id `1wsOQxIXjsqYzMlUpPNRjyQiMnwgVbtJG`. Expect `train/train/svg_gt/`, `val/val/svg_gt/`, `test/test/svg_gt/`.
- FloorPlanCAD test split via Hugging Face: `Voxel51/FloorPlanCAD` (FiftyOne: `fiftyone.utils.huggingface.load_from_hub("Voxel51/FloorPlanCAD")`, or `huggingface_hub.snapshot_download`), or the parquet `tilak1114/FloorPlanCAD` [reported].
- ArchCAD 40K: request access at `huggingface.co/datasets/jackluoluo/ArchCAD`, then `huggingface_hub.hf_hub_download(repo_id="jackluoluo/ArchCAD", repo_type="dataset", filename="data/json.zip", token=...)` and likewise `data/svg.zip` [reported].
- SymPoint weights on OneDrive (`1drv.ms` link in README) [verified link exists, not opened].

## Converter test result

`scripts/floorplancad-convert.py` was run, as requested, with `python3 -I` from the venv
(`ezdxf 1.4.5`, `matplotlib 3.11.2`, installed from PyPI) on a synthetic DXF I generated
(two files, each with 4 `single door` INSERTs at rotations 0/90/180 and 3 `toilet` INSERTs,
plus wall LINEs):

```
[2/2] drawings=2 symbols=14 empty=0
{"classes": {"0": "single door", "1": "toilet"}, "drawings": 2, "symbols": 14, "skipped": 0, "empty": 0}
real 0m1.419s
```

Output: `images/train/plan_a.png`, `labels/train/plan_a.txt` (7 rows, normalised boxes
0.048..0.106 wide, all inside the frame), `classes.txt`, `dataset.yaml` [verified]. So the
converter works on DXF input, as `training/README.md` claims.

It does not apply to FloorPlanCAD or ArchCAD, because neither distributes DXF and the script
only globs `*.dxf`. Running it on the real data would exit 1 with `no .dxf files under ...`.
The fix is a sibling script, roughly 100 lines, that reads the SVG attributes instead:

- parse `<g>` / `<path>` / `<circle>` / `<ellipse>`, read `semanticId` (or `semantic-id`) and `instanceId` (or `instance-id`), sample 4 points per primitive like `parse_svg.py` does (or use svgpathtools bbox), union the points of each `(instanceId, semanticId)` for the box;
- rasterise with `cairosvg` (present at `/usr/local/bin/cairosvg`; wheel also downloadable) at scale 7 for 980 px, optionally after forcing every stroke to `rgb(0,0,0)` like CADTransformer's `--cvt_color`, since real PDF exports are usually monochrome;
- emit the same YOLO layout and `classes.txt`, with the 35-name table above as the class map instead of block names.
For ArchCAD, the JSON modality is easier than its SVG: group primitives by `instance`, bbox from `start/end`, `center +- radius`, polyline points, ellipse samples.

## Published baselines

FloorPlanCAD test set, panoptic PQ, as self-reported or re-tabulated by later papers.
Numbers are [reported]; the full table with SQ/RQ and parameter counts is already in
`vector_cad_symbol_spotting.md` Q1, so only the columns that matter for us are repeated.
"Prior" = the model consumes CAD layer ids and stroke colours, which a PDF usually lacks.

| Method | Venue | PQ with layer/colour prior | PQ without prior | ArchCAD-400K PQ (no prior) | Code / weights |
|---|---|---|---|---|---|
| PanCADNet (dataset baseline) | ICCV 2021 | 56.1 (SQ 83.8, RQ 66.0) | n/a | n/a | none found |
| CADTransformer | CVPR 2022 | 68.5 (68.9 in later tables) | n/a | n/a | code MIT, no weights link |
| GAT-CADNet | CVPR 2022 | 73.7 | n/a | n/a | none |
| SymPoint | ICLR 2024 | 83.3 | 83.3 (uses no layer feature) | 47.6 | code + OneDrive weights [verified link] |
| SymPoint-V2 | arXiv 2024 | 90.1 | 83.2 | 60.5 | code repo exists; licence unspecified |
| CADSpotting | arXiv 2024 / CVM 2026 | 87.4 (setting unclear) | n/a | listed in DPSS table, value not retrieved | n/a |
| DPSS (ArchCAD baseline) | NeurIPS 2025 | n/a | 86.2 | 70.6 (Stuff-PQ 77.6 vs 52.8 for SPv2) | code academic-only, weights not released [verified issue #2] |
| VecFormer | NeurIPS 2025 | 91.1 | 88.4 | n/a | code Apache-2.0, no weights link [verified] |

Caveats: the DPSS and ArchCAD-400K figures come from a secondary overview (alphaxiv) and
from the paper abstract as quoted in search, not from the paper's own tables; CADSpotting's
87.4 may be a with-prior number; FloorPlanCAD raster detector baselines in the ICCV paper
(Faster R-CNN, FCOS, YOLOv3) land around mAP 0.41 to 0.45, which is the only published
number comparable to a box detector like the ONNX tier [reported, lit review].

## How pdf2takeoff would run on them

pdf2takeoff is a one-shot counter: given one click on an exemplar it returns every hit of that
symbol on the page (`scan_symbol` in `src/headless/mcp.ts`, `pdf2takeoff scan --page N --at x,y`
in `src/headless/cli.ts`, both via `scanDocAt` in `src/headless/ops.ts`). Headless order is
`vectorScan` (exact geometry match over the 8 right-angle rotations and mirrors, size tolerance
in points, `src/engine/scan-vector.ts`) then `cvScan` (raster connected components). The ONNX
tier (`detectorScan`) is wired only in the browser `scanForSimilar`; `ops.ts` never imports it
[verified]. The benchmark therefore has to be re-expressed as per-class counting, not PQ.

1. **Get data** on a machine without the proxy: FloorPlanCAD test zip (5,502 or 5,308 SVGs depending on mirror) and, after approval, ArchCAD `data/json.zip` plus `data/svg.zip`. Keep them out of the repo (NC licence, size).
2. **Ground truth per drawing** (`scripts/fpc-gt.py`, new): for each SVG, `counts[class] = number of distinct instanceId among primitives with that semanticId in 1..30`; also store per instance the union bbox and centroid in viewBox units. For ArchCAD use `semantic`/`instance` from the JSON, things only (the 21 ids above). Write one JSON per drawing. Expect stuff classes and background to be ignored.
3. **Make PDFs** (`scripts/fpc-to-pdf.py`, new): `cairosvg.svg2pdf` keeps paths as vector strokes, so pdf.js `getOperatorList` sees them and `vectorize()` in `src/engine/vector.ts` gets lines and curves (arcs, circles and ellipses arrive as Bezier segments, which `check-vector.mjs` already covers). Two variants per drawing: (a) as-is (coloured strokes, layer groups), (b) "PDF realistic": all strokes black, `<g>` flattened, text removed. Page size: map the 140-unit viewBox to 140 mm (1:100 of a 14 m tile) so symbol sizes are realistic for the raster tier's `RASTER_SCALE`. For ArchCAD JSON, either render its SVG the same way or draw the primitives with pdf-lib the way `scripts/takeoff-bench.mjs` already builds synthetic sheets. Drop the `semanticId`/`instanceId` attributes before rendering so the PDF carries no labels.
4. **Exemplar policy**: for each class present on a page pick one GT instance and click its centroid (convert viewBox to PDF points with the y flip). Run three policies and report all three, because one-shot results depend on the exemplar: the first instance in file order, the median-size instance, and the instance with the most primitives. Record which tier answered (`vector` or `cv`; `ScanResult` carries it).
5. **Score** per (page, class): predicted = `hits.length`, truth = GT count. Report exact-match rate, MAPE over pages with truth >= 1, signed bias (under- vs over-count), and an instance-level precision/recall by matching each hit box to a GT bbox of the same class (centre inside box, one-to-one). That last number is the closest analogue of thing-RQ for a single class under an oracle exemplar. Aggregate per class and over classes weighted by instance count; separate tables for variant (a) and (b), and for drawings where only the raster tier fired (this isolates "symbols touching walls", the known blind spot).
6. **Harness**: a Node script modelled on `scripts/takeoff-bench.mjs` that calls `scanDocAt` directly (no process spawn), reads the GT JSONs, and writes a CSV plus a summary JSON; a `--limit` flag so CI can run 20 drawings as a smoke test while the full 5k run stays manual. Runtime estimate: vectorize plus up to 30 scans per page is tens of milliseconds to a few seconds per page [inferred from the `check-vector.mjs` A1 timing guard], so the test split is well under an hour.
7. **ONNX detector path**: `public/models/symbols.json` points at a 5-class electrical model (downlight, gpo, switch, smoke-alarm, diffuser) hosted on the `model-v1` branch [verified]. None of those classes exist in FloorPlanCAD or ArchCAD, so running it as-is can only measure false positives. To evaluate the tier properly: (i) build the SVG-based YOLO converter from the section above, (ii) train YOLOX-nano on the FloorPlanCAD train split with the Kaggle notebook, (iii) add a Node entry point that calls `detectorScan` with `onnxruntime-node` (today only `check-detector.mjs` drives it, with a fake session), (iv) score it two ways: class-aware mAP@0.5 against the GT boxes (comparable to the ICCV raster baselines at mAP 0.41 to 0.45), and the same one-click count protocol as the other tiers (the detector counts "the class nearest the click").
8. **Optional PQ bridge**: for the vector tier only, hits can be turned back into primitive sets (the matched path group is known), so a length-weighted IoU against the GT instance's primitives is computable for the clicked class. That yields a per-class "one-shot RQ/SQ/PQ" and is the only number that can sit in the same table as the literature, with the caveats below.

What the comparison proves and does not prove:

- Proves whether deterministic vector matching counts CAD-exported symbols correctly when every instance of a class is the same block (the Bluebeam "Auto Count" promise), and quantifies the cost of class heterogeneity: FloorPlanCAD classes such as `single door` or `window` span many geometric variants and sizes, so one exemplar will under-count by construction; the measured per-class recall tells how many exemplars a user needs per class. It also quantifies how much the raster tier loses on symbols that touch walls, and how much colour stripping (variant b) changes nothing for us but removes the prior the literature leans on.
- Does not prove parity with PQ 86 to 91 models: those label every primitive of 35 classes with no exemplar, including stuff; pdf2takeoff gets an oracle click, ignores stuff, and is scored only on classes present. A high one-click count accuracy is a different claim ("counts what you point at") and should be written up as such. The input also differs: SVG with layers versus a PDF re-rendered from it, so any curve-approximation loss is on our side.
- Does not test real-world PDF export quirks (exploded blocks, dashed lines split into pieces, SHX text as geometry) because the SVGs are already clean primitives; that remains the job of the repo's own sample PDFs.

## Effort and blockers

Effort (one engineer):

- SVG to GT + PDF converters, both datasets: 1 to 2 days (parsers exist to crib from under MIT and Apache-2.0).
- Bench harness and scoring: 1 day; first full run and write-up: 1 day.
- ONNX retrain on FloorPlanCAD and Node inference entry point: 2 to 3 days plus GPU time; it is a research checkpoint only.
- Total for the deterministic tiers: about one week; detector adds another.

Blockers:

- This sandbox cannot reach any of the data hosts; the download must happen elsewhere. Whether the 2021 Google Drive ids still resolve is unknown (the project shut down in 2023); the Hugging Face mirrors are the fallback and carry only the test split.
- ArchCAD is gated with a manual review, its 40K subset has no splits and may have label gaps (issue #8 versus the matchline run), and the full 413K set is not public; treat it as a secondary benchmark.
- Non-commercial licences: fine for an accuracy report, but anything trained on them cannot ship, and the DPSS code cannot be vendored at all.
- Class count drift: the repo's docs say 30 classes, the release has 35 (FloorPlanCAD) and 30 plus Others (ArchCAD); `training/README.md` and the converter docstring need updating when the SVG converter lands.
- 5,308 versus 5,502 test drawings between mirrors and paper: pick one and state it.
- pdf2takeoff's vector tier expects same-size symbols (size tolerance in points); FloorPlanCAD instances of one class vary in size, so expect low recall there by design rather than by bug. Decide up front whether scale-invariant matching is in scope before reading the numbers.

## Open questions

- Are the Google Drive zips still live, and is the Drive "test" the 5,502-drawing V2 split or the 3,712-drawing V1 split? (The CADTransformer pipeline builds val from train with a 5 percent random split, which suggests the original Drive release had only train and test; the later `val.zip` id suggests V2 added val.)
- Is the viewBox unit 0.1 m (140 units = 14 m)? The ArchCAD card's 14 m x 14 m slice and the 980 px convention point that way; the Voxel51 card says 20 m x 20 m blocks for FloorPlanCAD.
- Why does ArchCAD's paper say 27 categories and 7 countable while the released config and card have 30 classes and 21 countable?
- Are ArchCAD's 40K JSON labels present (`semantic`/`instance`, matchline) or empty (`semantic_labels`/`instance_labels`, issue #8)? Needs one real file.
- Did the Voxel51 FiftyOne export keep `semanticId`/`instanceId` in its SVGs, or only FiftyOne label fields with V1's 30 classes? Determines whether the HF path or the Drive path is the right source for a 35-class study.
- FloorPlanCAD licence: CC BY-NC 4.0 (Voxel51 docs) or CC BY-SA 4.0 (HF zoo listing)?

## Sources

Verified in this session (cloned or executed):

- `nicehuster/SymPoint` (`download_data.py`, `parse_svg.py`, `svgnet/data/svg.py`, `svgnet/evaluation/point_wise_eval.py`, `configs/svg/svg_pointT.yaml`, README with OneDrive weights link): https://github.com/nicehuster/SymPoint
- `VITA-Group/CADTransformer` (`config/anno_config.py`, `preprocess/download_data.py`, `preprocess/svg2png.py`, `preprocess/preprocess_svg.py`, MIT LICENSE): https://github.com/VITA-Group/CADTransformer
- `WesKwong/VecFormer` (README with Drive id, `data/floorplancad/preprocess.py`, `dataclass_define.py`, `model/vecformer/evaluator/evaluator.py`, Apache-2.0): https://github.com/WesKwong/VecFormer
- `ArchiAI-LAB/ArchCAD` and mirror `Lulzx/ArchCAD` (README, LICENSE, `configs/svg/svg_pointT.yaml`, `svgnet/evaluation/point_wise_eval.py`, `svgnet/pretrained/download.sh`); issues #2, #5, #6, #8, #11 and the issue list: https://github.com/ArchiAI-LAB/ArchCAD
- `anchapin/matchline` (`datasets_adapter.py` ArchCAD and FloorPlanCAD loaders, `docs/datasets_adapter.md`, `scripts/archcad_smoke.py`; PRs #676, #726, #727): https://github.com/anchapin/matchline
- Local: `scripts/floorplancad-convert.py` run on a synthetic DXF; `src/headless/ops.ts`, `src/headless/cli.ts`, `src/headless/mcp.ts`, `src/engine/scan.ts`, `src/engine/scan-vector.ts`, `scripts/takeoff-bench.mjs`, `scripts/check-detector.mjs`, `public/models/symbols.json`.

Reported (search-engine extracts only; hosts refused by the proxy):

- FloorPlanCAD paper, Fan et al., ICCV 2021: https://arxiv.org/abs/2105.07147 and https://openaccess.thecvf.com/content/ICCV2021/papers/Fan_FloorPlanCAD_A_Large-Scale_CAD_Drawing_Dataset_for_Panoptic_Symbol_Spotting_ICCV_2021_paper.pdf
- Project site (shut down): https://floorplancad.github.io/
- Voxel51 dataset card and zoo page: https://docs.voxel51.com/dataset_zoo/datasets_hf/floorplancad.html and https://huggingface.co/datasets/Voxel51/FloorPlanCAD
- Parquet mirror: https://huggingface.co/datasets/tilak1114/FloorPlanCAD ; other HF entries: https://huggingface.co/datasets/guruprasad-hegde/FloorPlanCAD , https://huggingface.co/mudasir13cs/floorcad-yolov8n-detect
- hyper.ai listing: https://hyper.ai/datasets/21303
- ArchCAD-400K paper, Luo et al., NeurIPS 2025: https://arxiv.org/abs/2503.22346 ; project page https://archiai-lab.github.io/ArchCAD.github.io/ ; dataset https://huggingface.co/datasets/jackluoluo/ArchCAD ; third-party weights https://huggingface.co/mohansshf/dpss-archcad
- DPSS numbers (secondary): https://www.alphaxiv.org/overview/2503.22346v1
- SymPoint https://arxiv.org/abs/2401.10556 ; SymPoint-V2 https://arxiv.org/abs/2407.01928 ; CADSpotting https://arxiv.org/abs/2412.07377 ; VecFormer https://arxiv.org/abs/2505.23395 ; Text-aided PSS (V2 split numbers) https://arxiv.org/abs/2607.12678
