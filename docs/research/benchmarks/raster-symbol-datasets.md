# Public raster symbol datasets for the Scan tool and the ONNX detector

Research note, 2026-10-18. Every claim is tagged [verified] (file read or run in this session) or [reported] (search snippets; most dataset hosts were blocked by this session's egress proxy, see "Effort and blockers"). Builds on `research_notes/AI research for PDF takeoff/raster_symbol_detection_counting.md` (SkeySpot, SynthPID, Jamieson, tiling) and `docs/research/ai-literature-review.md` (FloorPlanCAD, SESYD paper, Bickel); those parts are not repeated.

Scratch data lives under `/tmp/claude-0/-home-user-pdf2takeoff/db387ea9-d3a7-5ddc-8c81-f410e6f4815f/scratchpad/symbols/` (one empty-at-start directory per dataset) and the helper scripts under `/tmp/claude-0/-home-user-pdf2takeoff/db387ea9-d3a7-5ddc-8c81-f410e6f4815f/scratchpad/scripts/`. Nothing was committed.

## Summary

- Only one of the five targets could be downloaded from here: Dataset-P&ID (Digitize-PID), through a GitHub Git-LFS mirror of the Kaggle re-tiling; one full sheet (7040 x 4480 px, 117 labelled symbols, 30 classes) was reconstructed and its YOLO labels verified. [verified]
- DELP is request-only and CC BY-NC-ND; SESYD's host did not answer; Roboflow Universe is both proxy-blocked here and API-key gated for export; Hugging Face, Zenodo, Kaggle and Google Drive were all refused by the proxy. [verified for the blocks, reported for the licences]
- Trial run: the tier-1 CV scan on the P&ID sheet scored mean recall 0.05 over 30 one-click classes, because 23 of 30 clicks landed on a symbol fused with the pipe network (one 541,854 px connected component). This is the documented "symbols touching linework" blind spot, now quantified. [verified]
- Blocker found on the way: `pdf2takeoff scan` segfaults (exit 139, no message) on image-only PDFs in this container (pdfjs-dist 5.4 + @napi-rs/canvas), while vector PDFs render fine; the trial therefore called `cvScan` directly on the decoded PNG with the same point convention. [verified]
- Best first targets: Dataset-P&ID for the detector (public, 500 sheets, 32 classes, clean YOLO mirror, published comparators) and SESYD floorplans for one-shot counting (free-standing furniture symbols, 16 classes, mAP baselines near 98%); DELP is the right electrical-plan target but needs an email to IIT Gandhinagar first.

## DELP / SkeySpot (electrical layout plans)

What it has [reported, arXiv 2508.10449 and the IITGN HAIx lab page]: 45 scanned electrical layout plans, 2,450 instances, 34 service-key classes (Double Socket, Light Switch, Low Energy Downlighter, Low Energy Pendant Light, Radiator are the frequent ones; Track Light and TV Satellite Multisocket appear a handful of times). Full sheets, real, scanned. Boxes drawn in LabelImg (so VOC XML or YOLO txt at source). 5-fold cross validation, 80/20 per fold. Image resolution not stated in any snippet retrieved.

Format verified vs reported: nothing verified. The official repo README says only that the dataset "will be made available for academic research upon request to the authors" [verified, raw README of github.com/HAIx-Lab/SkeySpot, branch main]. The lab page adds CC BY-NC-ND 4.0, academic and non-commercial only, no modified redistribution, and forbids commercial use of models trained on it [reported].

Licence: CC BY-NC-ND 4.0 [reported]. For an Apache-2.0 project this means evaluation-only use with no shipped weights, and the NoDerivatives clause arguably also blocks publishing converted labels.

Availability and what I downloaded: nothing. `labs.iitgn.ac.in` and `arxiv.org` were refused by the proxy; the GitHub repo is code for a Streamlit app, not data. The SkeySpot app at skeyspot.streamlit.app could be used to sanity-check class names on one of our own sheets, but not to get the data.

Baselines [reported]: YOLOv8 mAP@50 82.5% (abstract) and 81.1% (discussion, averaged over folds); Faster R-CNN 48.6% mAP@50; mAP@75 and mAP@50:95 are in the paper's table but no snippet carried the numbers. No per-class table retrieved. Weak classes are the rare ones (track lights).

## Dataset-P&ID (Digitize-PID, Paliwal et al. 2021)

What it has [reported]: 500 synthetic P&ID sheets with symbol, line and text annotations; 32 symbol classes placed on a grid-style pipe layout; noise and "complex symbol" variants; the paper evaluates on 100 synthetic sheets plus 12 private real sheets. Source is a Google Drive folder linked from the HF cards; original annotation convention is `[x_min, y_min, x_max, y_max]` per the `hamzas/digitize-pid-symbols` card, and `SherifAhmed/digitize-pid-yolo` is a YOLO conversion with 0-indexed classes and a 4:1 train/val split. A 2024 paper notes the class mix is dominated by valves (about 47.5%).

Format verified [verified, from the mirror `github.com/ch-hristov/p-id-symbols`, which the Kaggle page `hristohristov21/pid-symbols` says is "adopted from" arXiv 2109.03794]:

- `labels.zip` (6.65 MB, Git LFS, fetched from media.githubusercontent.com): 30,000 YOLO txt files named `{sheet}_{y}_{x}.txt`, sheets 0 to 499, 60 tiles per sheet. In the first 5,000 files: 32,762 boxes, 809 empty tiles. Excerpt of `134_0_3840.txt` (class cx cy w h, normalised to the tile):

  ```
  21 0.940625 0.40078125 0.025 0.0484375
  11 0.28046875 0.846484375 0.084375 0.04765625
  17 0.598828125 0.940625 0.09453125 0.0359375
  18 0.717578125 0.880859375 0.03828125 0.11796875
  ```

- `images.zip` is 1.50 GB (LFS). Instead of downloading it, 60 tiles of sheet 134 (5.1 MB) were pulled with HTTP Range requests against the zip's central directory. Tiles are 1280 x 1280 RGB JPEG; the filename offsets are (y, x) in 640 px steps, so tiles overlap 50% (pixel diff between overlapping halves is exactly 0.0; the other axis order gives 19 to 20 mean abs diff). Stitching gives a 7040 x 4480 px landscape sheet whose title block reads "SAMPLE_3872.JPG", so the mirror keeps the Dataset-P&ID sheets at native resolution. Sheet 134 after IoU>0.5 de-duplication: 117 symbols, 30 of the 32 classes present, box sizes 32 to 153 px.
- `train.txt` lists 27,000 tiles, `val.txt` about 3,000; the split is by tile, not by sheet (sheet IDs appear in both), so leakage must be fixed before training.
- `dataset.yaml` class names (uploader's, 0 = Not_used): 1 Gate_Valve, 2 Ball_Valve, 3 Globe_valve_NO, 4 Gate_valve_NO, 5 Globe_valve_NO, 6 Butterfly_valve, 7 Plug valve, 8 Check_valve, 9 Diaphragm_valve, 10 Needle_valve, 11 Half_Filled_Gate_Valve, 12 Gate_Valve_NC, 13 Globle_valve_NC, 14 Control_Valve, 15 Rotary_Valve, 16 Ball_valve_NC, 17 Paddle_blind, 18 Spectacle_blind_Closed, 19 Spectacle_blind_Open, 20 Reducer, 21 Flange_or_Nozzle, 22 Rupture_disk, 23 Pipe_Insulation_or_Tracing, 24 Flow_Arrow, 25 sight_glass, 26 and 27 Instrument_Field, 28 and 31 Instrument_Panel, 29 Instrument_Aux_Panel, 30 and 32 box. The duplicate names mean the uploader did not resolve the paper's "Symbol 1..32" table; the paper's own names should replace them before any class-level reporting.

Converted sample in the training layout (images/val, labels/val, classes.txt): `/tmp/claude-0/-home-user-pdf2takeoff/db387ea9-d3a7-5ddc-8c81-f410e6f4815f/scratchpad/symbols/digitize-pid/sheet134/` (`134.png`, `134.pdf`, `labels/val/134.txt`, `134_preview.png`).

Licence: not stated by the paper, the Drive folder card text, or the Kaggle re-upload ("follows the original article's licensing, which does not specify one") [reported]. Treat as research-use until the TCS authors answer.

Availability: `huggingface.co`, `drive.google.com` and `kaggle.com` are refused by the proxy (CONNECT 403). The GitHub LFS mirror works from here and from any machine with plain HTTPS. [verified]

Baselines [reported]: Digitize-PID reports symbol F1 close to 1.0 on the synthetic set; a later comparison table lists Digitize-PID at 92.50 and 91.13 on a "stitched" Dataset-P&ID variant (metric columns not readable in the snippet). PID2Graph (Stürmer et al., DSAA 2025) and SynthPID (CVPRW 2026) both use it as the synthetic comparator. The 2025 "On P&ID Symbol Recognition using Transformers" paper notes one class whose line style flips between dashed and solid.

## Roboflow Universe sets (P&ID, electrical, floor plan, doors)

Format [reported from Roboflow docs]: every project exports to YOLO (v5/v8/v11 txt), COCO JSON, VOC XML and more, but only through the `roboflow` SDK or the web "Download" button, both of which need a free API key; the public page shows only thumbnails. `universe.roboflow.com`, `app.roboflow.com`, `source.roboflow.com` and `roboflow.com` all fail DNS/CONNECT from this session, so nothing below is verified. Licences are per project and set by the uploader.

Candidate projects [reported, search snippets]:

| Project | Size and classes | Licence | Notes |
| --- | --- | --- | --- |
| "PID symbols" (3.75k images, 11 classes: butterfly, check, control, gate, globe, three-way valve; heat exchanger; instrument DCS; instrument tag; page and utility connection) | ~3,800 images | not shown | Used in Roboflow's Aug 2026 RF-DETR post, 99.2% mAP@50; search also lists it as instance segmentation, so check the task type. Slug not found; similarity hit was test-z33cc/p-id-symbols-ubcpn. |
| pid-connect/p-id-symbols and p-id-symbols-r2 | R2 lists 180 classes | CC BY 4.0 | Broad P&ID taxonomy. |
| traindatasetcolab/pid-symbols-ki2yj, pid-symbols-500class | unknown | CC BY 4.0 | |
| pid-vcaab/p-id-dlayt | unknown | CC BY-NC-SA 4.0 | non-commercial |
| pid-smart-reader/pid_dataset | ball, butterfly, check, gate valve, centrifugal pump | unknown | 2023 |
| fyp-hl9hj/electrical-symbol-1 | 4,216 images, numeric class ids only | CC BY 4.0 | closest electrical candidate; class names unknown |
| rehna-ucooc: electric_symbols (45), MEP_FloorPlan_Detection (35), HVAC SYMBOLS (1), Floor plan (1.89k), cubicasa5k-4 (4.98k seg) | tiny for symbols | unknown | |
| revitai/architectural-object-detection-ufmql | unknown | unknown | "architectural symbols" |
| bytetrooper/doors-detection-in-floor-plans, doordetectyolov5/doordetect (1,090 images, Doors) | door only | CC BY 4.0 (doordetect) | |
| student-umikv/sesyd | shows 0 images | unknown | SESYD re-host in VOC XML; unusable as listed |

No Roboflow project was found that matches DELP's scope (electrical plan symbols with named classes at hundreds of images).

## SESYD floorplans (Delalandre et al., IJDAR 2010 / GREC)

What it has [reported]: synthetic floor plans, 1,000 images = 10 layouts x 100 symbol arrangements, 28,065 symbol instances, 16 classes (armchair, bed, door1, door2, sink1 to sink4, sofa1, sofa2, table1 to table3, tub, window1, window2; the list is reconstructed from a partial snippet plus the usual benchmark naming, so verify against the README). Vector-rendered, clean, no occlusion, no intra-class variation (Rezvanifar 2020). Whole collection: 11 archives, 284k images, 190k symbols, 284k characters across floorplans, electrical diagrams and maps. Ground truth produced by the 3gT generator (per-symbol XML with class, position and orientation; the exact schema was not retrieved).

Format verified: none. `mathieu.delalandre.free.fr`, `paperswithcode.com`, `hyper.ai` (torrent mirror, `data/11.zip` is 590 MB) and `web.archive.org` all failed from here.

Licence: no licence text found; the site asks for a citation of the IJDAR 2010 paper. Treat as research-use until confirmed [reported].

Baselines [reported]: SFPI (DFKI, 2021 preprint) 98.1% mAP on SESYD; FloorPlanCAD paper lists SESYD as 16 classes; Rezvanifar's YOLOv2 with tiling reached 0.86 mAP on the more standardised set (already in the existing notes). These are detector numbers; nobody reports one-shot count accuracy on it.

## Other 2024 to 2026 construction-drawing symbol sets

- PID2Graph (Stürmer, Graumann, Koch; DSAA 2025; Zenodo record 14803338): first public P&ID set with graph-level labels; `.graphml` per sheet with node/edge bounding boxes and classes (Valve, Inlet/Outlet, Instrumentation, General, Tank, Arrow, Pump; Solid/Non-solid edges); real-world and synthetic splits; described as small. SynthPID evaluates on "PID2Graph OPEN100" and says the community's public real benchmark is 12 annotated images. Zenodo blocked here. [reported]
- SynthPID (IIT Bombay, CVPRW 2026): 665 synthetic P&IDs seeded from real topology; code and weights at github.com/LatentSpaceIITB/SynthPID (README not on branch `main` via raw; branch unknown). [reported]
- DoorDet (Zhang et al., arXiv 2508.07714, NCAA 2026): 4,991 CubiCasa5K floor plans re-rendered from SVG, 10 functional door classes, 4,200/400/400 split, Co-DETR + GPT-4.1 pre-labels corrected by hand. No download link surfaced. CubiCasa5K itself (Zenodo 2613548, 5,000 plans, 80+ categories incl. icons) remains the public base; YOLOv8n on its icons is 71.3% mAP50 (existing notes). [reported]
- IPVBA-ELEC: an electrical floor plan dataset in the CONICET repository (datosdeinvestigacion.conicet.gov.ar, handle 11336/260283), CC BY-NC-SA 2.5. Only the licence line was seen; worth one follow-up because it may be the only public electrical-plan set besides DELP. [reported]
- BlueprintSymVL (Chalmers, 2025): VLM one-shot symbol recognition benchmark on engineering blueprints; public status unknown. [reported]
- MEP lighting symbols (arXiv 2608.14317): sponsor data, private. ArchCAD-400K (CC BY 4.0, vector, 5,538 drawings) is the large architectural option but needs the FloorPlanCAD-style converter, not a raster download. [reported]
- Nothing public was found for fire protection, plumbing or structural drawing symbols in 2024 to 2026; the MEP datasets that exist (arXiv 2501.09267, Roboflow "MEP Elements In Construction Site", 9.1k images, CC BY 4.0) are site photographs, not drawings.

## Recommended evaluation design

### (a) One-shot counting (Scan tool, tier 1 and detector tiers)

Protocol per test sheet: for each class present, click the centre of the first ground-truth instance (or the median-sized one), run `scan`, and match hits to ground-truth boxes of that class by centre-in-box (IoU is not available because tier-1 hits are centres only). Report per class: precision = matched hits / hits, recall = matched GT / GT, count error = hits minus GT, and across the sheet: fraction of classes with exact count, MAPE over classes with GT >= 3, and which other class the false hits landed in (confusion). Prototype: `/tmp/claude-0/-home-user-pdf2takeoff/db387ea9-d3a7-5ddc-8c81-f410e6f4815f/scratchpad/scripts/cvscan-direct.mts` (reads a PNG plus YOLO labels, calls `cvScan`, prints the table above). Promote it to `scripts/check-scan-dataset.mts` once the CLI's image-PDF path is fixed so it can run through `scanDocAt` instead.

Best first target: SESYD floorplans. Its symbols are free-standing furniture on clean walls, which is the regime tier 1 was built for, so results are interpretable, there are 100 arrangements per layout for cheap repeats, and 16 classes give a confusion matrix (sofa1 vs sofa2, table1 vs table3 are the lookalike pairs the existing review flags). Dataset-P&ID is the stress test (every symbol is fused with the pipe network), not the first target; the trial run below shows why.

### (b) Detector (ONNX path)

Convert to the training layout (`images/{train,val}`, `labels/{train,val}`, `classes.txt`, `dataset.yaml`), split by source sheet (never by tile), tile at the inference scale the app uses (the TA-TM scale-matching result in the existing notes), train YOLOX-nano in `training/kaggle-train-yolox.ipynb`, export to `symbols.onnx` + `symbols.json`, and evaluate mAP@50 and mAP@50:95 on held-out whole sheets through the same tile-and-merge path the browser uses, plus per-class count MAE per sheet.

Best first target: Dataset-P&ID. It is the only one of the five with a working public download from here, it already ships as YOLO tiles, it has 500 sheets (enough to fine-tune without the synthetic generator), and three papers report numbers on it. Converter work is small: regroup tiles by sheet, de-duplicate overlapping-tile boxes (IoU>0.5 within class, done in `dedupe.py`), replace the uploader's class names with the paper's 32, and split 400/50/50 by sheet. For electrical plans, request DELP in parallel: it is the only labelled scanned electrical set and its 34 classes map onto the generator's 5 (downlight, gpo, switch, smoke, diffuser) plus radiators and pendants.

### Turning a PNG or JPG into a PDF the CLI accepts

`src/headless/cli.ts` accepts only PDFs: every command goes through `readPdf()` and `openPdf()` (pdf.js), there is no image branch [verified]. `/tmp/claude-0/-home-user-pdf2takeoff/db387ea9-d3a7-5ddc-8c81-f410e6f4815f/scratchpad/scripts/png2pdf.mjs` (and `jpg2pdf.mjs`) wrap one image with pdf-lib: page size = pixels / k points with k = 3 so that `RASTER_SCALE = 3` reproduces the native pixels; `--at` is then `x_px / 3, (H_px - y_px) / 3` (PDF origin bottom-left; `toRaster` uses pdf.js `convertToViewportPoint`, which flips y). `pdf2takeoff info` reads such a file correctly (2347 x 1493 pt for the P&ID sheet) [verified].

## Trial run result

Sheet: Dataset-P&ID sheet 134 (7040 x 4480 px, 117 GT symbols, 30 classes). First click: Check_valve (class 8) at px (4919, 3541) = `--at 1639.7,313.0`.

1. `npm run cli -- scan 134.pdf --page 1 --at 1639.7,313.0` ran 5.9 s and produced no output, exit 0 through the npm shim; running `node --experimental-strip-types src/headless/cli.ts scan` directly on a 1280 px tile PDF (PNG or JPEG embed) exits 139 (segmentation fault) with nothing on stderr. `renderRasterNode` on the repo's vector sample renders fine (2526 x 1785), so the crash is specific to decoding embedded images in pdfjs-dist 5.4 with @napi-rs/canvas 1.0.x in this container. [verified]
2. Same sheet through `cvScan` directly (identical engine code and point convention):

   | class | GT | hits | TP | note |
   | --- | --- | --- | --- | --- |
   | Check_valve (8) | 6 | 1 | 0 | clicked component = 541,854 px (whole pipe network) |
   | 22 further valve, flange, arrow, instrument classes | 1 to 8 each | 1 | 0 | same 541,854 px component |
   | Rotary_Valve (15), Reducer (20) | 6, 3 | error | | "click directly on a symbol to teach the scan" |
   | Paddle_blind (17), Spectacle_blind_Closed (18), Instrument_Field (27), box (30), box (32) | 3, 4, 4, 7, 3 | 1 | 1 | isolated component (50 to 2,462 px) found only itself |

   Mean recall 0.046, mean precision 0.18, exact count on 1 of 30 classes, 470 to 970 ms per scan on the 31.5 Mpx sheet. [verified; table in `/tmp/claude-0/-home-user-pdf2takeoff/db387ea9-d3a7-5ddc-8c81-f410e6f4815f/scratchpad/symbols/digitize-pid/sheet134/cvscan_all.json`]

Reading: on P&IDs, tier 1 cannot even start, because the symbol and the line are one connected component; the five free-standing classes also missed their siblings, most likely from 90-degree rotations and attached tag text, which the shape matcher does not normalise. This is the quantitative case for the detector tier (and for a line-removal pre-pass before connected components) and matches the Jamieson/Elyan observation that P&ID symbol detection needs learned models.

## Effort and blockers

- Proxy policy refused CONNECT to huggingface.co, arxiv.org, zenodo.org, kaggle.com, drive.google.com, universe.roboflow.com (and app/source/blog subdomains), paperswithcode.com, hal.science, hyper.ai, web.archive.org, data.mendeley.com, figshare.com, link.springer.com, openaccess.thecvf.com, researchgate.net, dspace.library.uvic.ca, labs.iitgn.ac.in, mathieu.delalandre.free.fr. Allowed: raw.githubusercontent.com, media.githubusercontent.com (LFS), registry.npmjs.org, pypi.org. `api.github.com` and `github.com` page views are limited to the session's own repositories. WebFetch fails DNS for every blocked host. [verified]
- Roboflow export needs an API key even for public projects (free account); budget 10 minutes per project once a key exists, and record each project's licence from its "Cite this project" box.
- DELP: email the IITGN authors (Dosi, Meena, Rajpura, Y. K. Meena) with the SMC 2025 citation; expect academic-only terms.
- SESYD: try the official page from an unproxied machine, or the hyper.ai torrent (11 zips, the floorplans one is a few hundred MB). The 3gT XML needs a 30-line converter to YOLO.
- Dataset-P&ID full download: 1.5 GB LFS zip; the range-fetch script pulls any sheet in about 12 s, so a 50-sheet eval set is minutes of work and no full download.
- CLI image-PDF segfault: reproduce outside this container before filing; if it reproduces, try `pdfjs-dist` with `isImageDecoderSupported: false` / `canvasFactory` options or upgrade @napi-rs/canvas, and add an image-PDF case to `scripts/check-engine.mjs`.
- Status 2026-10-18: fixed. Root cause was pdfjs-dist's nested @napi-rs/canvas 0.1.x loading a second skia binary; `openPdf` now passes a `CanvasFactory` on the project's copy. The CLI and MCP also open PNG/JPG directly (no wrapping needed; same `--at` convention as the wrapped PDF). Regression case: `scripts/check-raster-input.mjs`.
- The tile split in the mirror leaks sheets between train and val; re-split by sheet.

## Open questions

- Dataset-P&ID licence: none stated anywhere; ask TCS Research (Paliwal) before publishing weights trained on it.
- Paper's 32 class names vs the mirror's duplicate names (two Globe_valve_NO, two Instrument_Field, two Instrument_Panel, two box): which are open/closed or rotated variants?
- SESYD ground-truth schema (3gT XML) and whether orientation is included; and whether its images are 1-bit or grey, and at what pixel size.
- Is the 3.75k-image Roboflow "PID symbols" project detection or segmentation, and under what licence?
- IPVBA-ELEC (CONICET): what is in it, and is CC BY-NC-SA 2.5 workable for evaluation-only use?
- Does the image-only PDF crash reproduce on a developer machine, and does it also affect `compare --png` on scanned sets?

## Sources

- SkeySpot paper: https://arxiv.org/abs/2508.10449 (blocked here; snippets via search); lab page https://labs.iitgn.ac.in/haix/?p=1424; official repo https://github.com/HAIx-Lab/SkeySpot (README read via raw.githubusercontent.com)
- Digitize-PID paper: https://arxiv.org/abs/2109.03794; HF mirrors https://huggingface.co/datasets/SherifAhmed/digitize-pid-yolo and https://huggingface.co/datasets/hamzas/digitize-pid-symbols; original Drive folder https://drive.google.com/drive/u/1/folders/1gMm_YKBZtXB3qUKUpI-LF1HE_MgzwfeR; GitHub LFS mirror https://github.com/ch-hristov/p-id-symbols (labels.zip, dataset.yaml, train.txt, 60 tiles fetched); Kaggle page https://www.kaggle.com/datasets/hristohristov21/pid-symbols
- PID2Graph: https://arxiv.org/abs/2411.13929, https://zenodo.org/records/14803338; SynthPID: https://arxiv.org/abs/2604.16513
- SESYD: http://mathieu.delalandre.free.fr/projects/sesyd/ (floorplans page .../symbols/floorplans.html), https://paperswithcode.com/dataset/sesyd-dataset, https://hyper.ai/en/datasets/34280, SFPI preprint https://www.preprints.org/manuscript/202110.0089
- Roboflow: https://blog.roboflow.com/pid-symbol-detection/, https://universe.roboflow.com/pid-connect/p-id-symbols-r2, https://universe.roboflow.com/fyp-hl9hj/electrical-symbol-1, https://universe.roboflow.com/rehna-ucooc, https://universe.roboflow.com/student-umikv/sesyd, https://docs.roboflow.com/developer/python-sdk/download-a-dataset
- DoorDet: https://arxiv.org/abs/2508.07714; CubiCasa5K: https://zenodo.org/records/2613548; IPVBA-ELEC: https://datosdeinvestigacion.conicet.gov.ar/handle/11336/260283; BlueprintSymVL: https://research.chalmers.se/en/publication/549362
- pdf2takeoff code read: `src/headless/cli.ts`, `src/headless/ops.ts`, `src/headless/raster-node.ts`, `src/engine/scan-cv.ts`, `src/engine/types.ts`, `scripts/floorplancad-convert.py`, `training/README.md`, `public/models/README.md`

## Status 2026-10-18

Work package WP5 of the benchmark sweep made tier 1 robust to the two failure modes the trial run found. Everything lives in `src/engine` (environment-agnostic, `scripts/check-engine.mjs` clean) and the CLI and MCP pick it up through `cvScan` unchanged. [verified, this session]

What changed:

- `src/engine/line-removal.ts`, a pre-pass before connected components. It measures the dominant stroke width (mode of the run-length histogram), removes every horizontal, vertical and 45 degree run longer than 30 strokes, removes dashed lines (three or more short thin collinear runs with small gaps spanning the same length: instrument signal lines, hidden lines), eats the stubs that are left (a thin run ending on a removed pixel is eaten inward until the ink thickens, four rounds so elbows go leg by leg; kept ink straight through the removed line within four strokes means a nick, not a stub), then restores nicks (1-D gap fill along rows and columns, plus removed pixels within half a stroke of kept ink). Steps after the subtraction run over the removed-pixel list, not the sheet. Returns `cleaned`, `lines` and the pixel counts.
- `src/engine/scan-cv.ts`: `cvScan(raster, click, { removeLines: 'auto' | true | false, dihedral, matchDistance })`. `auto` (default) runs the pre-pass when a bounded flood from the click exceeds 20 strokes in both axes (before the sheet is labelled at all), when the plain pass finds only the clicked symbol, or when the clicked component is glyph-sized (tag text inside an outline); it keeps whichever pass found more, and the plain path is untouched otherwise. The signature is compared under the 8 dihedral transforms (identity first). After line removal, thin appendages are trimmed off the bounding box before the signature is taken (a bar or dash that is thin everywhere is left whole). The signature grid is box-blurred and compared with a relative L1 distance (0 identical, 1 disjoint; threshold 0.15) instead of the old absolute 0.16, which only ever matched pixel-identical renders. A click on the tag text inside an outline symbol resolves to the smallest outline enclosing both. `ScanResult` gained an optional `lineRemoval` report; `note` says which path ran.
- `scripts/check-scan.mjs` (wired into `typecheck:engine`): free-standing symbols count exactly and a look-alike differing by one stroke is excluded; 6 valves on one pipe with two tees count 6; an asymmetric glyph at 0/90/180/270 and mirrored counts 8 (2 with `dihedral: false`); 4 boxes hung off a dashed line count 4; `removeLines` drops the pipe and keeps the circle. Against the previous `scan-cv.ts` the on-pipe, rotation and dashed-line cases all return 1.
- `scripts/check-scan-dataset.mts`: the protocol from "Recommended evaluation design (a)" as a Node script (PNG plus YOLO labels and classes, first instance per class clicked, centre-in-box matching, per-class precision, recall, count error and confusions, mean recall, mean precision, exact-count rate, MAPE over classes with 3 or more instances; flags for the scan options and a JSON dump).

Sheet 134 (7040 x 4480, 117 symbols, 30 classes), same protocol as the trial run, defaults:

| | before | after |
| --- | --- | --- |
| mean recall | 0.046 | 0.659 |
| mean precision | 0.18 | 0.835 |
| exact count | 1 of 30 | 8 of 30 |
| classes erroring ("click directly on a symbol") | 2 | 0 |
| clicks landing on the 541,854 px pipe network | 23 | 0 |
| per scan | 470 to 970 ms | 450 ms on the plain path, 730 ms with line removal, measured at a load average of 3 to 4 (other agents on the box); fused path: mask 130, stroke width 40, line removal 410, components 120, matching 25. Average over the 30 clicks 660 ms |

Per-class highlights (after): all 6 Globe_valve_NO (5) found across both orientations, all 5 Ball_valve_NC (16), all 4 Gate_Valve_NC (12), all 5 Globle_valve_NC (13), 5 of 6 flanges (21, the 32 x 62 and 62 x 33 rotated pair), 6 of 7 boxes (30, through the dashed signal line), 3 of 4 needle valves (10), both plug (7), diaphragm (9) and aux panel (29) valves; the free-standing paddle and spectacle blinds (17, 18) still count exactly on the plain path. Weak: Rotary_Valve 1 of 6 and sight_glass 3 of 8 (instances differ by what passes through them), Half_Filled_Gate_Valve 1 of 5, Instrument_Field 1 of 4 (two of the four are fused with leaders that end on dashed lines or text). Confusions are the valve families that differ by one dot or stroke at this resolution: 12 vs 13 (gate NC vs globe NC, signature distance 0.09 to 0.11 between classes against 0.05 to 0.12 within), and 1/2/4/5. Threshold sweep: 0.20 gives recall 0.727, precision 0.679, exact 6; 0.25 gives 0.759 / 0.560 / 4; `removeLines: true` instead of `auto` gives 0.620 / 0.835 / 6 (the plain path does better on the free-standing classes). MAPE over the 22 classes with 3 or more instances: 49%.

Caveats, honestly: these are one-click shape-signature numbers on the stress case, not detector numbers; the protocol clicks the centre of the first ground-truth box, which lands on tag text for the box and instrument classes (handled by the enclosing-outline rule) and inside hollow symbols (handled by reaching 6 strokes out from the click), neither of which a user clicking on a stroke would hit. `npm run bench` is unchanged (its count cases go through the vector tier). The AECV-Bench door case (arcs fused with walls) is covered in principle by the same pre-pass (thick walls are long runs whatever their thickness) but has not been run here.

What is left: the timing target ("well under a second on 30 Mpx") is met, but not by much on a loaded machine; the line-removal sweep (the dash thinness test is the costliest piece) is the next thing to speed up. Dash chains are detected along rows and columns only. Symbols that touch text (leaders ending in a tag) stay fused. Sight-glass and rotary-valve siblings whose interiors differ need a signature that ignores the interior or a higher-resolution second stage. The threshold could be set per sheet from the distance distribution of the first pass instead of a constant.

## Status 2026-10-18, round 2

Round 2 (package R1) worked the matching stage of the tier-1 scan (`src/engine/scan-cv.ts`) against the misses round 1 left: valve families that differ by one dot, symbols fused with tag text, siblings that sit just outside the clicked one's threshold. Same sheet, same protocol (`scripts/check-scan-dataset.mts`, first instance per class clicked, centre-in-box matching), each feature toggled on its own through the new flags (`--match-distance auto|0.15`, `--expand on|off`, `--look-alike on|off`, `--text-mask words.json|ocr`). [verified, this session]

| configuration | mean recall | mean precision | exact classes | MAPE (22 classes with 3 or more) | per scan |
| --- | --- | --- | --- | --- | --- |
| round 1 (fixed 0.15, single template, no gate) | 0.659 | 0.835 | 8 of 30 | 49% | 657 ms |
| + template expansion only | 0.663 | 0.835 | 8 | 48% | |
| + per-sheet threshold only | 0.669 | 0.846 | 10 | 45% | |
| + per-sheet threshold and expansion | 0.669 | 0.846 | 10 | 45% | |
| + look-alike gate only | 0.659 | 0.879 | 11 | 37% | |
| defaults (threshold auto, expansion, gate) | 0.658 | 0.879 | 11 | 37% | 634 ms (median 617, max 1055) |
| defaults + OCR text mask (385 word boxes) | 0.647 | 0.879 | 10 | 39% | |

Timings are averages over the 30 clicks at a load average of 5 to 8 (other agents on the box), round 1 and round 2 back to back; the new stages add under 30 ms (the matching stage is 25 ms of the 600).

What changed:

- Per-sheet threshold (`matchDistance: 'auto'`, the default). The distances of every candidate to the clicked symbol are sorted (the click itself, at 0, left out); the first gap of at least 0.03 after a member beyond 0.06 (or of 0.08 after a nearer one, since pixel-identical siblings sit at 0) is the edge of the sibling cluster, and the threshold goes half way into that gap, at most 0.03 past the last member, clamped into [0.10, 0.20]. No such gap under 0.20 keeps the constant 0.15. The widest gap, tried first, is the wrong rule on this sheet: the gap between the click and its nearest sibling is usually the widest, and clamping it to 0.10 cost the Gate_Valve, Butterfly, Flange and Reducer siblings (recall 0.588). The first-gap rule gives Check_valve 5 of 6 (threshold 0.20, nothing between 0.17 and 0.39), Reducer 3 of 3 and Rotary 3 of 6, drops 2 of the Ball_Valve and 2 of the Gate_Valve_NC false hits, and costs one Needle valve (its third sibling at 0.13, the plug valves at 0.19, threshold read at 0.11) and one Plug valve false hit. `ScanResult.cv` reports the value and its source.
- Self-expanding templates (`expand`, default on). Hits under 0.6 of the threshold become templates; every candidate is rescored against the set (minimum distance) for up to 4 rounds or until no new hit appears; a template must itself be within the threshold of the clicked symbol, and a round that grows the hit set by more than 50 percent (and by more than 2) is discarded and ends the expansion, reported in `cv.expansionStopped`. On this sheet it adds one sight glass at the fixed threshold and nothing under the per-sheet threshold (the thresholds it reads are tighter than 0.15 exactly where expansion had room); the synthetic case in `scripts/check-scan.mjs` (3 of 8 siblings eroded over a growing part of the symbol) counts 8 with it and 7 without. 0.8 of the threshold instead of 0.6 gave 11 exact classes but precision 0.834; 0.6 stays.
- Look-alike gate (`lookAlike`, default on). This is what moved the sheet. The relative L1 cannot tell the waist dot of a Globle_valve_NC from a Gate_Valve_NC (5 percent of the ink, inside the 0.05 to 0.12 noise between true siblings), but the difference is one concentrated one-sided blob where sibling noise is a plus stripe beside a minus stripe along every edge. `localDifference` takes the raw (unblurred) coverage grids of the pair under the matching dihedral transform and finds the 3 x 3 block (of at least 4 cells of ink) whose one-sided share of the ink, |sum(a - b)| / sum(a + b), is largest; a pair over 0.95 is rejected whatever its distance. On sheet 134 true siblings score 0.30 to 0.75 and the look-alikes 1.00 (Gate_Valve_NC against Globle_valve_NC and Half_Filled, Globe_valve_NO against Ball_Valve): classes 12 and 13 go from 11 and 9 hits to exactly 4 and 5, precision 1.0 both. It also rejects true siblings whose interiors differ by a blob (one Rotary valve, one Reducer), which is the same signal, and it does nothing for Plug against Needle (the plug's handle scores 0.45, inside the sibling range).
- Text mask (`textBoxes`, raster px). Erased from the ink before line removal and components, except the box the click lands in. `scanDocAt` in `src/headless/ops.ts` retries with it when the CV scan returns fewer than 2 hits: text-layer words first (`wordBoxesToRaster`, padded 15 percent of the word height, rotated words through their four corners), OCR of the render only with `ocrTextMask: true` (seconds per sheet), and OCR words only when they read like text (confidence 60 and two alphanumerics, so a valve the recogniser took for a letter is not erased). Sheet 134 has no text layer; the OCR mask (771 words, 385 boxes after the filter, 44 s once, cached by the harness) gains a Butterfly valve and loses two Globe_valve_NO siblings whose tags the recogniser boxed together with the valve, net 0.647 recall against 0.658, so the retry stays conditional. The synthetic case (5 boxed symbols, 4 with glyph tags touching the top edge) counts 1 without the boxes and 5 with them.
- Second-stage verification at 2x, as specified (hits within 0.03 of the threshold re-measured on a 40 x 40 grid from the mask upsampled bilinearly, dropped over the threshold): tried and removed. The fine distance ran 0.01 to 0.07 above the coarse one for true siblings and look-alikes alike (less blur, more shift noise, and a dot is the same fraction of the ink at any resolution): 9 true siblings dropped against 7 look-alikes, recall 0.659 to 0.581, exact 8 to 7. The localized difference above is what a second stage for look-alikes needs; a host-side 2x re-render would not change that, so no render callback was added (pdf.js renders asynchronously and the scan is synchronous).

`scripts/check-scan.mjs` gained the three failing-first cases (look-alikes with one interior dot, 5 and 3, and 8 by the signature distance alone; touching text tags, 1 without boxes and 5 with; graded erosion, 8 with expansion and 7 without, under the per-sheet and a fixed threshold). `npm run typecheck:engine` and `npm run bench` pass; the scan on the 31.5 Mpx sheet stays at 0.4 to 1.1 s per click.

What is left: Half_Filled_Gate_Valve (1 of 5), Rotary (2 of 6), sight glass (2 of 8) and the instrument bubbles are siblings whose interiors or attached leaders differ by more than the gate allows, so a per-class notion of which part of the symbol counts (outline against interior) is the next step; Plug against Needle (0.16 apart, handle versus stem) sits inside the sibling range on every measure here; the 3 "none" flange hits are flange-shaped pipe pairs the labels do not cover. The text mask needs a born-digital P&ID to be measured against its text layer; on this raster sheet OCR boxes are too coarse to be worth the seconds.
