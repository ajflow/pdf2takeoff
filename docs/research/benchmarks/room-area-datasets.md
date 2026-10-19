# Public floor-plan datasets as a Dynamic Fill room-area benchmark

Scope: extends `docs/research/ai-literature-review.md` section 4 and `research_notes/AI research for PDF takeoff/room_segmentation_door_gaps.md` (Q1 dataset notes). Those already cover what CubiCasa5K, ResPlan and MSD are for learned parsing; this note is about using them as ground truth for the click-to-fill area tool. Every claim is tagged [verified] (read from files on disk or run in this session) or [reported] (from a web page, search snippet or README not independently checked). Session constraint: only github.com and raw.githubusercontent.com were reachable through the proxy; zenodo.org, arxiv.org, huggingface.co, kaggle.com, data.4tu.nl, Google Drive and Google Forms all answered 403 at CONNECT. Dates: 2026-10-18.

## Summary

1. ResPlan is the best first target and it already works: the full 17,000-plan dataset is a 100 MB zip inside the GitHub repo, licence CC BY 4.0 (with one metadata conflict, see below), rooms, walls, doors and windows are shapely polygons, and a per-plan metric area lets us recover a scale. [verified]
2. End-to-end trial on one ResPlan plan rendered to a 1:100 PDF: with door leaves drawn, Dynamic Fill measured 8 of 9 rooms with IoU 0.91 to 0.98 and a systematic area underestimate of 2 to 9 percent; the balcony leaked (outside the envelope). With door openings left as bare gaps, 6 of 9 rooms failed as unbounded. [verified]
3. The underestimate has a measurable cause: ResPlan room polygons extend 2 to 6 percent of their area into the wall polygons (toward the centreline), and the raster fill stops about one pixel inside the ink. Any benchmark must state which convention it scores against. [verified]
4. CubiCasa5K (CC BY-NC 4.0, 5.5 GB on Zenodo) has room, wall, door and window polygons in SVG but no metric scale and was not downloadable here; MLSTRUCT-FP has walls and slabs only (no rooms, no doors), so it tests exterior and wall geometry, not room fill; MSD (CC BY 4.0, 4TU or Kaggle, blocked here) has room polygons with real coordinates but is a 512 px generation benchmark; RPLAN is raster-only, request-gated and research-only. [verified where files were read, otherwise reported]
5. Effort to a repeatable ResPlan bench: about one day (scripts from this session are in the scratchpad and listed below). Blockers: scale derivation relies on the undocumented `area` field, and the realism gap (synthetic clean renders, no text, no furniture, no dimension strings) means it measures geometry handling, not real-PDF robustness.

## CubiCasa5K (Kalervo et al., SCIA 2019)

### What it has
- 5,000 Finnish floor plan rasters (mostly scans) with per-image SVG annotation; 4,200 / 400 / 400 train / val / test split; over 80 object categories. [reported, paper abstract and Zenodo description via search]
- Folder layout per plan: `F1_original.png`, `F1_scaled.png`, `model.svg`. [verified, read from `floortrans/loaders/svg_loader.py` in the cloned repo at `/home/user/cubicasa/cubicasa5k`]
- SVG schema, as consumed by the official loader (`floortrans/loaders/svg_utils.py`, `get_labels`): `<g id="Wall">`, `<g id="Window">`, `<g id="Door">` each containing a `<polygon points="...">`; rooms are `<g class="Space <RoomType>">` with a polygon child; fixtures are `<g class="FixedFurniture <Type>">` inside a `FixedFurnitureSet`. Point coordinates are image pixels (the loader rounds them and rasterises with `skimage.draw.polygon`). [verified]
- Room taxonomy (`floortrans/loaders/house.py`): 65 raw room names (Alcove ... Utility, plus Wall, Railing, Stairs) collapsed to 12 training classes; icon classes include Window, Door, Closet, Toilet, Sink, Sauna, Fireplace, Bathtub, Chimney. [verified]
- Doors and windows are polygons covering the opening in the wall; the loader derives a door end-point pair from the polygon. [verified from `house.py` door_rep construction]
- Scale: no metric scale or pixel size is stored in the SVG or used by the loader; `F1_scaled.png` is only a resized copy and the loader keeps a width ratio between the two PNGs. Real dimensions appear only as printed text on some scans. [verified absence in loader; printed dimensions reported]
- Room polygon boundary convention: not documented. The paper says walls are used as boundaries for rooms in the annotation protocol, which implies rooms stop at the wall face, but this could not be checked without a sample. [reported]

### Format verified vs reported
- Verified: file names, SVG group ids and class strings, class lists, pixel coordinates, no scale field.
- Reported: `cubicasa5k.zip` 5.5 GB, MD5 `0ce0b203d1e3c125b51087b219bd23b9`, single file on Zenodo record 2613548; subfolders named `high_quality_architectural`, `high_quality`, `colorful`.
- Also in the repo: `Difference in Room Annotation.pdf` explaining that for the R2V (Liu et al. 2017) annotations the room shape is inferred from junctions and the CubiCasa authors re-derived it after fixing merged L joints and unsplit walls. [verified]

### Licence
- `LICENSE` in the repo: "CubiCasa5K is licensed under a Creative Commons Attribution-NonCommercial 4.0 International License." [verified]. Research and internal benchmarking are fine; nothing derived from it can ship in a commercial product, and numbers published from it should credit the dataset.

### Availability and what I downloaded
- Zenodo record 2613548 refused at the proxy (`CONNECT tunnel failed, response 403`, logged as `connect_rejected` for `zenodo.org:443`). The Hugging Face mirror `phungpx/cubicassa5k-coco` was also blocked (403). GitHub repo cloned (code only, `data/` is empty). No plan sample obtained. [verified]
- Nothing in `/tmp/claude-0/-home-user-pdf2takeoff/db387ea9-d3a7-5ddc-8c81-f410e6f4815f/scratchpad/rooms/` for this dataset.

### Baselines
- Kalervo et al. Table 4 per-class IoU (val / test): Outdoor 62.6 / 64.4, Kitchen 71.6 / 65.0, Living Room 68.2 / 66.6, Bedroom 80.0 / 74.2, Window 67.3 / 66.8, Door 56.7 / 53.6. The table extraction was garbled in the snippet; check against the PDF before quoting. [reported]
- Later numbers already in the door-gap notes: Raster2Seq room F1 88.7, window and door F1 77.8; structural-line segmentation 89.12 mIoU; PCP-Net room mIoU about 71.3. A 2026 vectorisation paper reports raw mIoU 0.739 (95 percent CI 0.727 to 0.750) on the CubiCasa5K test split. [reported]
- No published number is a room-area error; all are pixel IoU or polygon F1, so a pdf2takeoff area benchmark on CubiCasa5K would be a new metric, comparable only in the IoU sense.

## ResPlan (Abouagour and Garyfallidis, arXiv 2508.14006)

### What it has
- 17,000 single-floor residential plans from South Asian real-estate listings; splits 13,053 / 1,632 / 1,632 plus 683 augmented. [verified, README and `split.json`]
- One pickle, `ResPlan.pkl` (258 MB unzipped), a Python list of 17,000 dicts. Keys present in every plan: `id`, `inner`, `wall`, `door`, `living`, `bathroom`, `garden`, `parking`, `land`, `area`, `net_area`, `neighbor`, `wall_depth`; nearly always: `pool`, `bedroom`, `front_door`, `window`, `kitchen`; sometimes `balcony` (13,066), `storage` (1,781), `stair` (685), `area_change_sqft` (683, the augmented plans). [verified by key census over all 17,000 plans]
- Geometry values are shapely Polygon or MultiPolygon objects serialised as WKB (the pickle references only `shapely.io.from_wkb`, `numpy.dtype` and numpy scalars). Rooms of one type are one MultiPolygon with one part per room. [verified]
- Excerpt, plan index 0 (id 14433): `inner` 1 part, bounds (0, 19.0, 256, 237.0), area 46,029 units squared; `wall` 10 parts; `door` 8 parts; `window` 7 parts; `living` 1 polygon; `kitchen` 1 polygon; `area` 120.77; `net_area` 95.66; `wall_depth` 4.50. [verified]
- Units: the README says "metric-scale coordinates in metres", but the coordinates are a normalised canvas: the `inner` bounding box is 256 units wide in the median plan (`DEFAULT_CANVAS_SIZE = (256, 256)` in `resplan_utils.py`). The metric information is the `area` float. Taking `k = sqrt(inner.area / area)` as units per metre gives k between 6.0 and 42.6 (median 18.3) and puts `wall_depth / k` between 0.115 and 0.61 m with 99.3 percent in 0.10 to 0.40 m, which reproduces the README's own wall-thickness statistic exactly, so `area` is the area of `inner` in square metres. [verified over 3,000 plans]
- `net_area` is not the sum of room polygons (ratio median 1.42, and it is 0 for some plans, including test ids 8 and 59). Treat it as undocumented. [verified]
- Room boundary convention: room polygons lie inside `inner`, abut the walls, and overlap the wall polygons by 2 to 6 percent of their own area (plan id 1: living 2.3 percent, bedrooms 3.0 to 3.2, bathrooms 5.5 to 5.9, kitchen 0.0). So the polygons sit between the inside face and the centreline, closer to the face. `inner` minus (rooms union walls) is under 1 percent of `inner`, so `inner` is the inside face of the external wall. [verified]
- Doors: polygons that fill the opening; door area overlapping wall polygons is 0 in the median plan (max 15 percent), 84 percent of door area lies inside `inner` in the median plan. Walls therefore have a real gap wherever a door is, which is the door-gap case Dynamic Fill must bridge. Windows are separate polygons in the external wall band. [verified]
- Also ships `plan_to_graph` (via_door, via_window, adjacency, direct) which gives "which rooms connect through which door" for free. [verified, code read]

### Format verified vs reported
- Everything above under "What it has" was read from the files. The README's claim "coordinates in metres" is wrong as stated; the metric scale is only recoverable through `area`.
- Kaggle version 6 (`croissant.json`) is reported to carry a populated `plan["graph"]`; not checked (Kaggle blocked).

### Licence
- `LICENSE`: data (ResPlan.pkl, split.json, croissant.json) under CC BY 4.0; code under MIT. The grant text claims the spatial arrangement is fact, not expression, and that no source images or listing data are included. [verified]
- Conflict: `croissant.json` in the same commit declares `"license": {"name": "CC BY-NC-SA 4.0"}` for the Kaggle archive. [verified]. Which licence governs the Kaggle copy is unclear; the GitHub copy's LICENSE file is CC BY 4.0. The door-gap notes already flag that the listing provenance needs a legal check before training a shipped model; for a benchmark used internally this does not matter.
- Repo also has `TAKEDOWN.md` (30-day removal commitment, removed ids tracked in `REMOVED.md`). [verified]

### Availability and what I downloaded
- Cloned `https://github.com/m-agour/resplan` (shallow, 192 MB) to `/home/user/m-agour/resplan`; commit e2b78fe, 2026-07-28 "per review commit". [verified]
- Unzipped to `/tmp/claude-0/-home-user-pdf2takeoff/db387ea9-d3a7-5ddc-8c81-f410e6f4815f/scratchpad/rooms/resplan/ResPlan.pkl`.
- The pickle was loaded with a restricted `pickle.Unpickler` that allows only `shapely.io.from_wkb`, `numpy.dtype` and `numpy._core.multiarray.scalar` and raises on anything else, after first scanning opcodes with `pickletools` to confirm those are the only globals. Do not `pickle.load` it directly.
- Five test-split plans (ids 1, 8, 59, 69, 71) dumped as WKT JSON in `.../scratchpad/rooms/resplan/sample/resplan_<id>.json`; plan 1 rendered to `.../scratchpad/rooms/resplan/pdf/resplan_1_A.pdf` (walls only) and `resplan_1_B.pdf` (walls plus door-leaf and window outlines) at 1:100, page 439 x 434 pt.

### Baselines
- Published ResPlan tasks are graph tasks (room labelling accuracy 0.955 with GraphGPS; plan-to-graph F1 0.972 with shared-boundary extraction). No room-area or segmentation baseline exists. [verified, README]
- pdf2takeoff trial on plan 1 (RASTER_SCALE 3, `dynamicFill` called from Node exactly as `scripts/takeoff-bench.mjs` does, click at each room's `representative_point`, ground truth = polygon area / k squared): [verified]

| Room | GT m2 | Variant A (bare door gaps) | Variant B (door leaf drawn) | IoU (B) |
|---|---|---|---|---|
| living | 41.71 | unbounded error | 40.21, -3.6 pct | 0.964 |
| bedroom x3 | 17.81 / 16.77 / 22.03 | unbounded error | -4.6 / -4.7 / -4.5 pct | 0.953 to 0.955 |
| bathroom x3 | 4.84 / 4.79 / 5.55 | -8.5 / -8.1 / -8.1 pct, gapPx 68 to 78 | -8.6 / -8.4 / -8.1 pct | 0.914 to 0.919 |
| kitchen | 14.33 | unbounded error | 14.08, -1.7 pct | 0.983 |
| balcony | 3.96 | unbounded error | 236.21, leak (x60) | 0.017 |

- Reading: bare door gaps in a plan this size (door 0.9 m = 76 px at scale 3) only get bridged for the small bathrooms, where the leak exceeds the 40 percent page fraction trigger; for the larger rooms the fill joins neighbours without crossing that trigger and ends unbounded through the front door. This is exactly problem 1 in the door-gap notes, now reproduced on a real plan. Passing `metersPerPt` made no difference to the outcome in variant A. With door leaves drawn (variant B, closer to what architects draw), all interior rooms succeed. The residual error is negative and proportional to perimeter over area: about 2 percent from the raster trace stopping inside the anti-aliased ink, plus the 2 to 6 percent of the ground-truth polygon that lies inside the wall polygons. The balcony is outside `inner` and open to the page, so leaking there is correct behaviour for a fill, and the bench should mark balconies as expected-leak or draw a railing.
- `npm run cli -- info` on the generated PDF returns page 1, 439 x 434 pt, 0 annotations. Node v22.22.0, node_modules already installed. [verified]

## MLSTRUCT-FP (Pizarro, Hitschfeld, Sipiran, Automation in Construction 156, 2023)

### What it has
- 954 floors of Chilean multi-unit residential buildings; 70,873 wall rectangles ("rect"), 954 slabs, 954 floors. [verified from README in the cloned repo; counts reported, the sample has 7 floors]
- `fp.json` with three dicts: `rect` (each: `angle`, `floorID`, `length`, `line`, `thickness`, `wallID`, `x[4]`, `y[4]` in metres), `slab` (floor outline polygon `x[]`, `y[]` in metres), `floor` (`image` file name, `scale` in px per metre). [verified from `test/data/fp.json`]
- Sample excerpt: floor 302 image `f23ccf42...png` 9500 x 6714 px RGBA, scale 188.445 px/m, 80 rects, wall thickness 0.16 m; floor 966 scale 366.506 px/m, 28 rects; sample scales range 109 to 367 px/m, thicknesses 0.16 to 0.35 m. [verified]
- The PNG is a structural drawing: walls drawn as thin cyan outlined rectangles on a transparent background, no doors, no windows, no room boundaries, no text (viewed floor `7db30954...`). [verified]
- Rooms: not annotated. Doors: not annotated. [verified absence in schema and README]
- Metric scale: yes, both the JSON (metres) and the PNG (px/m) are calibrated. [verified]

### Format verified vs reported
- Verified from the 7-floor sample bundled in the repo tests; the full set is reported to be the same structure.

### Licence
- Repo and loader library: MIT. The dataset's own licence is not stated in the README or on PyPI; the zip is obtained by filling a Google Form (`forms.gle/HigdGxngnTEvnNC37`). [verified absence]. The GitHub repo was archived read-only on 2026-04-29. [reported]

### Availability and what I downloaded
- Cloned `https://github.com/MLSTRUCT/mlstructfp`; copied `test/data` (6 PNG, `fp.json`, 7 floors, 1.5 MB) to `/tmp/claude-0/-home-user-pdf2takeoff/db387ea9-d3a7-5ddc-8c81-f410e6f4815f/scratchpad/rooms/mlstruct-fp/`. The full dataset form is on Google (blocked here, 403). [verified]

### Baselines
- `MLStructFP_benchmarks` repo: U-Net wall segmentation plus Egiazarian-style vectorisation; no metric numbers in its README. [reported]. The paper reports a U-Net wall segmentation baseline; numbers not retrieved (Elsevier page not reachable).
- Relevance to Dynamic Fill: low for room area (no rooms). Useful as a wall-geometry fixture: slab polygon area is a gross-floor-area ground truth for a whole-floor fill, the thin double-line wall style is a realistic stress case for the ink threshold, and apartments are only separable with doors, which are absent, so every room fill will join the whole apartment.

## Modified Swiss Dwellings, MSD (van Engelenburg et al., ECCV 2024)

### What it has
- Derived from Swiss Dwellings v3.0.0 (Archilyse, about 42,500 apartments, geometries as WKT in a site-local coordinate system, manual check that apartment areas deviate at most 5 percent, median 1.2 percent). [reported]
- MSD: over 5,300 multi-unit floor plans covering over 18,900 apartments (paper); 4TU README says the training split is 4,167 plans, test 1,390 with annotations withheld (ICCV 2023 challenge). [reported]
- Per plan (from the challenge data README on GitHub): `struct_in/<id>.npy` float16 [512, 512, 3], channel 0 binary structure mask (0 = structure), channels 1 and 2 are the x and y location of each pixel; `full_out/<id>.npy` float16 [512, 512, 3], channel 0 room-type mask with doors and openings excluded, channels 1 and 2 locations; `graph_in/<id>.pickle` networkx graph with node `zoning` and edge `connectivity` ("door", "entrance door", "passage"); `graph_out/<id>.pickle` networkx graph with node `roomtype`, `centroid`, `geometry` (shapely Polygon) and edge `connectivity`. Room class ids used for submission: Bedroom 0, Livingroom 1, Kitchen 2, Dining 3, Corridor 4, Stairs 5, Storeroom 6, Bathroom 7, Balcony 8, Structure 9, Background 13. [reported, read through WebFetch of `cvaad-workshop/iccv23-challenge`]
- Scale: the location channels are real coordinates, presumably metres from the Swiss Dwellings local frame, which would make the scale recoverable; the pixel size was not stated anywhere I could read. [reported, unresolved]
- Doors: present as edge labels in the graph but excluded from the raster; no door geometry was described. Windows: not mentioned. [reported]
- Room polygons: yes, in `graph_out` (train only). [reported]

### Format verified vs reported
- All reported. No file was obtained.

### Licence
- 4TU.ResearchData record 10.4121/e1d89cb5-6872-48fc-be63-aadd687ee6f9 version 2 (2023-07-11): CC BY 4.0. [reported, search snippet of the 4TU citation metadata]. The upstream Swiss Dwellings licence was not confirmed.

### Availability and what I downloaded
- data.4tu.nl, kaggle.com and zenodo.org (Swiss Dwellings 7788422) all refused at the proxy (403). Nothing downloaded. [verified]

### Baselines
- Challenge metric: mean IoU of the predicted full plan vs ground truth, with and without background, plus structure-only IoU, combined as (2 a + b + 5 c) / 8. The MSD paper baselines are generation models (modified HouseDiffusion with wall cross-attention and GAT), scored on generation metrics. Nothing is a room-area number. [reported]
- Relevance: medium. Multi-unit plans with corridors and stair cores are the layout pdf2takeoff users meet most; but the structure mask is 512 px for a whole building (coarse), doors are not drawn, and the raster is a mask, not a drawing. Rendering `graph_out` polygons plus the structure mask into a PDF is possible but the "drawing" would be synthetic in the same way the ResPlan render is, with worse resolution.

## RPLAN (Wu et al., ACM TOG 2019)

### What it has
- 80,788 plans as 256 x 256 four-channel PNGs: channel encodings differ between secondary sources (one: channel 1 exterior walls and front door, channel 2 room type per pixel plus interior walls and doors, channel 3 room instance index, alpha interior mask). Room shapes are therefore pixel masks, not polygons; rooms mostly rectangular, single-unit. 14 room categories in the original. [reported]
- Scale: no metres-per-pixel value was found in any source; one widely repeated figure (about 18 cm per pixel) could not be sourced and should not be used. [reported, unverified]
- Doors: present as a pixel class. [reported]

### Licence and availability
- Obtained through a Google Form linked from the `rplanpy` package (`docs.google.com/forms/d/e/1FAIpQLSfwteilXzURRKDI5QopWCyOGkeb_CFFbRwtQ0SOPhEg0KGSfw/viewform`). [verified, PyPI README of rplanpy 0.1.1]. Terms as described by a 2026 paper that uses it: restricted access, research only, non-commercial, redistribution prohibited. [reported]. The form host is blocked here, so not obtainable in this session; still obtainable in principle by a person.
- Relevance: low. Raster-only, tiny, and pixel-area ground truth without a documented scale; ResPlan's cross-dataset table shows it is also simpler than real plans. Skip unless a 256 px stress test of the fill is wanted.

## CVC-FP and R2V (brief)

- CVC-FP (Universitat Autonoma de Barcelona, IJDAR 2015): 122 scanned plans in four style subsets with SVG ground truth for rooms, walls, doors, windows, parking doors and room separations, plus Matlab evaluation scripts for wall and room detection; "freely released to the research community", licence text not seen. No metric scale reported. Host `dag.cvc.uab.es` blocked here. [reported]. Small but the only set with real scanned drawings and room SVGs that is not NC-licensed by text; worth a look once reachable.
- R2V (Liu et al., ICCV 2017): LIFULL HOME'S images (counts reported variously as 870, 815 or 4,800), annotation files only on GitHub since the images were withdrawn (confirmed by the CubiCasa note in the repo); images require the LIFULL / NII IDR agreement. Not practical. [reported]

## Recommended evaluation design

Target: ResPlan first, CubiCasa5K second (once Zenodo is reachable from a machine without the proxy), MSD third.

1. Sample selection. Use `split.json` test ids; skip plans with `net_area == 0` only if that field is ever used; keep all room types; mark `balcony`, `garden`, `parking`, `pool` as expected-leak (outside `inner`). Suggested size: 200 plans, about 1,600 rooms, which is enough for percentile tables per room type.
2. Scale. For each plan `k = sqrt(inner.area / area)` units per metre (validated above). Choose a drawing ratio (1:100 default, also 1:50 and 1:200 to test gap-closing against the `metersPerPt` ladder) and set pt per unit = (72 / 0.0254 / ratio) / k. Ground-truth area in m2 = polygon.area / k squared.
3. Rendering to PDF. Build an SVG (walls as filled black paths with even-odd rule, doors as thin outlined door-leaf rectangles or as a leaf line plus quarter-circle arc, windows as outlined rectangles, optional room-label text at the representative point so the `labels` hint path is exercised) and convert with cairosvg (`cairosvg.svg2pdf`, installed from PyPI in this session; `rsvg-convert` is not installed, ImageMagick `convert` is). Keep y-down SVG and flip y when emitting click points (PDF y = page height minus SVG y). Variants to generate per plan: A bare gaps, B door leaf, C door leaf plus arc, D furniture-free scan simulation (rasterise B at 150 dpi, add light noise, embed as image PDF) to compare vector and raster paths.
4. Click point. `polygon.representative_point()` (shapely), which is guaranteed inside and avoids the centroid of an L-shaped room falling in a wall. Reject any click where the rendered pixel is ink and retry with a second interior point.
5. Metrics per room: relative error (fill minus GT) / GT; absolute error in m2; IoU of the fill polygon vs GT polygon (shapely, both in PDF points, after `make_valid`); leak flag when fill area > 1.5 x GT; unbounded flag when `dynamicFill` returns an error; `gapPx` and `bridged` from the result for provenance. Report per room type: median and 90th percentile relative error, IoU median, leak rate, unbounded rate, plus plan-level room count recovered (rooms with IoU >= 0.5 and no leak) over rooms expected.
6. Area convention. Score against three ground truths and report all three: (a) ResPlan polygon as is (between face and centreline); (b) polygon minus wall polygons, which is the inside-face area and the one a floor-finish takeoff wants; (c) polygon buffered by plus half `wall_depth` and clipped to `inner`, an approximation of the centreline area. The trial suggests Dynamic Fill will be closest to (b) with a residual of about minus 2 percent from the ink inset; this is the number to track, and it should shrink if the trace is moved from the first ink pixel to the ink edge.
7. Leak and gap tests. Variant A isolates gap bridging: expected to fail today for rooms whose leak stays under the 40 percent page trigger (reproduced). Record per plan the fraction of rooms where the fill ends unbounded. Add a synthetic diagonal-wall subset by rotating 10 percent of plans by 15 or 30 degrees in the SVG (ResPlan `augment_geom` does this) to measure the axis-aligned-only closing limitation.
8. Scale handling for datasets without scale (CubiCasa5K, RPLAN): compare in pixel or PDF-point area only, report relative error and IoU, never m2; or calibrate from a printed dimension string with `read_text` when one exists, which turns the test into a scale-reading test as well.
9. Automation. A `scripts/room-bench.mjs` that takes a folder of `<id>_tasks.json` plus `<id>.pdf` and emits JSON like `takeoff-bench.mjs --json`; generation stays in Python because of shapely and the pickle. The three scripts from this session are a working skeleton: `.../scratchpad/tools/resplan_to_pdf.py`, `.../scratchpad/tools/resplan_fill.mjs`, `.../scratchpad/tools/resplan_score.py` (all under `/tmp/claude-0/-home-user-pdf2takeoff/db387ea9-d3a7-5ddc-8c81-f410e6f4815f/scratchpad/tools/`).

Why ResPlan first: it is reachable, licence-clean for internal use, polygonal, carries doors as real wall gaps, has a derivable metric scale, and the trial already produced interpretable numbers. CubiCasa5K adds what ResPlan lacks (real scanned drawings with text, furniture and non-rectangular rooms) but needs the 5.5 GB download, an NC licence note, and a pixel-only score. MSD adds multi-unit layouts but at 512 px with no door geometry.

## Effort and blockers

- ResPlan bench to a checked-in script with 200 plans and three variants: about one day. Python dependencies (shapely, cairosvg) must be added to a dev setup note; the restricted unpickler should be kept.
- CubiCasa5K: half a day once the zip is on a machine, plus an SVG-to-PDF path that keeps the scan as an image under the vector annotation (or renders the annotation alone). Blocked here by the proxy.
- MSD: one day; blocked here (4TU, Kaggle). Pixel size in metres needs to be confirmed from the location channels.
- RPLAN: requires a person to submit the form and accept research-only terms; not worth it for this tool.
- General blocker: all polygon datasets produce clean synthetic renders, so the bench measures gap bridging, concave tracing and area convention, not OCR noise, hatching, furniture or dimension strings. Pair it with the existing synthetic `takeoff-bench.mjs` and a small hand-measured set of real PDFs.

## Open questions

1. Is ResPlan `area` really the `inner` area in m2 for every plan, or only on average? The wall-thickness check matches the README statistic to three decimals, but a direct confirmation from the authors (or the Kaggle description) would close it.
2. Which licence governs ResPlan: the repo LICENSE (CC BY 4.0) or the Kaggle Croissant metadata (CC BY-NC-SA 4.0)? Matters only for publishing bench results or redistributing rendered PDFs.
3. CubiCasa5K room polygon convention (inside face vs centreline) and whether any scale text exists in enough scans to calibrate.
4. MSD location-channel units and pixel size.
5. Should Dynamic Fill report the inside-face area or correct toward the centreline for gross-area takeoffs? The trial shows the tool sits at inside face minus about 2 percent; the EasyChair 2026 Togal study's finding that AI underestimates areas while counts match is consistent with the same inset effect plus convention mismatch, and Togal's own docs distinguish net (interior finish) from gross (centreline to centreline) area. [reported]
6. Why did the 76 px door gaps bridge for bathrooms but not for the bedrooms in variant A? Expected from the 40 percent trigger, but worth confirming in `dynamicfill.ts` before using variant A numbers as a regression baseline.

## Sources

- CubiCasa5K repo (cloned): https://github.com/CubiCasa/CubiCasa5k ; Zenodo record https://zenodo.org/records/2613548 (blocked, 5.5 GB per search snippet); paper arXiv:1904.01920.
- CubiGraph5K (SVG parsing with BeautifulSoup and shapely): https://github.com/luyueheng/CubiGraph5K
- ResPlan repo (cloned, includes ResPlan.zip): https://github.com/m-agour/ResPlan ; Kaggle mirror https://www.kaggle.com/datasets/resplan/resplan ; paper arXiv:2508.14006.
- MLStructFP repo (cloned, includes 7-floor test sample): https://github.com/MLSTRUCT/MLStructFP ; PyPI https://pypi.org/project/MLStructFP ; benchmarks https://github.com/MLSTRUCT/MLStructFP_benchmarks ; paper DOI 10.1016/j.autcon.2023.105132.
- MSD: 4TU record https://data.4tu.nl/datasets/e1d89cb5-6872-48fc-be63-aadd687ee6f9 ; Kaggle https://www.kaggle.com/datasets/caspervanengelenburg/modified-swiss-dwellings ; challenge README https://github.com/cvaad-workshop/iccv23-challenge ; paper arXiv:2407.10121 ; Swiss Dwellings https://zenodo.org/record/7788422.
- RPLAN: rplanpy https://pypi.org/project/rplanpy/ (request form link) ; paper DOI 10.1145/3355089.3356556 ; terms as described in arXiv:2605.14117.
- CVC-FP: https://dag.cvc.uab.es/dataset/cvc-fp-database-for-structural-floor-plan-analysis/ ; R2V: https://openaccess.thecvf.com/content_iccv_2017/html/Liu_Raster-To-Vector_Revisiting_Floorplan_ICCV_2017_paper.html
- Area underestimation study: EasyChair preprint https://easychair.org/publications/paper/pkrRp ; Togal net vs gross area definition https://help.togal.ai/en/articles/15602901-ai-powered-area-and-wall-detection
- Session artefacts: `/tmp/claude-0/-home-user-pdf2takeoff/db387ea9-d3a7-5ddc-8c81-f410e6f4815f/scratchpad/rooms/` (resplan, mlstruct-fp) and `/tmp/claude-0/-home-user-pdf2takeoff/db387ea9-d3a7-5ddc-8c81-f410e6f4815f/scratchpad/tools/`.

## Status 2026-10-18

The ResPlan bench is checked in: `scripts/bench/resplan_to_pdf.py` renders
the plans (variants A bare door gaps, B door leaf closed in the opening, C
leaf plus swing arc, D rasterised image PDF) and `npm run bench:rooms`
(`scripts/room-bench.mjs`) scores Dynamic Fill through the headless CLI path
with scale, text-layer labels and vector bridges as hints. Setup in
`scripts/bench/README.md`. Numbers below: 200 test-split plans (seed 1),
1:100 on A3, 3 px/pt, 1,396 rooms of which 1,223 are enclosed (the other
173 are open plan: a doorless opening wider than 1.3 m to another room,
mostly kitchens, which no fill can separate) plus 267 balconies, gardens and
parking bays outside the envelope, scored on their own rows. Variant D is
generated but not scored: the Node renderer cannot open image PDFs yet.
One run of 200 plans x 3 variants takes about 400 s with four jobs.

Two engine changes came out of the trial findings, both in
`src/engine/dynamicfill.ts`:

1. Ink-edge trace. The outline now follows the pixel edges of the filled
   region (crack following) instead of the centres of the last free pixels,
   so the polygon sits on the ink face and its area is the pixel count. On
   `scripts/check-fill.mjs` synthetic rooms the area is now exact (was 1.4
   to 1.5 percent under); on the `npm run bench` fill cases the error fell
   from 0.7 to 1.6 percent to 0.0 to 0.9 percent.
2. Door-width cuts of bounded fills. The closing ladder now climbs past the
   first bounded fill: a rung that closes a gap between wall ends and cuts a
   room-sized part off (15 percent of the fill, or 2 m2 with a scale) wins;
   a rung that cuts less stops the climb (an alcove or niche stays floor).
   With a scale, doorways up to 1.0 m are closed outright as before and
   openings up to 1.3 m may be cut this way (ResPlan wall gaps are 1.0 to
   1.3 m for 57 percent of doors, wider than the door polygons). This closes
   the known bench case `fill/interior-door-no-hints` (bench now 12/12).

Enclosed rooms, before the two fixes (same PDFs, same bench):

| Variant | Median rel err vs inside face | p90 abs err | Median vs polygon as is | Median IoU (as is / face) | Leak rate | Unbounded rate | Recovered (IoU >= 0.5, no leak) |
|---|---|---|---|---|---|---|---|
| A bare gaps | -2.6 pct | 16.8 pct | -7.7 pct | 0.837 / 0.873 | 2.4 pct | 43.4 pct | 53.8 pct |
| B door leaf | -2.1 pct | 24.7 pct | -5.2 pct | 0.923 / 0.972 | 5.7 pct | 0.9 pct | 92.9 pct |
| C leaf plus arc | -4.6 pct | 40.3 pct | -8.9 pct | 0.858 / 0.884 | 5.5 pct | 1.1 pct | 90.6 pct |

After:

| Variant | Median rel err vs inside face | p90 abs err | Median vs polygon as is | Median IoU (as is / face) | Leak rate | Unbounded rate | Recovered (IoU >= 0.5, no leak) |
|---|---|---|---|---|---|---|---|
| A bare gaps | -1.5 pct | 13.2 pct | -5.3 pct | 0.931 / 0.980 | 2.9 pct | 6.5 pct | 89.9 pct |
| B door leaf | -1.7 pct | 6.0 pct | -5.1 pct | 0.944 / 0.981 | 1.6 pct | 0.7 pct | 96.8 pct |
| C leaf plus arc | -5.0 pct | 33.7 pct | -8.5 pct | 0.873 / 0.899 | 2.1 pct | 0.6 pct | 93.9 pct |

Per room type after the fixes (variant B): bedrooms -1.1 pct median, p90
1.8 pct, IoU 0.960; bathrooms -2.3 pct, p90 4.6 pct, IoU 0.918; kitchens
-2.6 pct (leak 4.3 pct, was 45 pct: doorless kitchen openings up to 1.3 m
are now cut); living -1.3 pct, IoU 0.944. Variant A living rooms are the
remaining weak spot (20 pct unbounded: the front door gap is wider than
1.3 m or sits against a corner of a thin wall). Variant C errors are the
door swing sectors the arcs wall off: against the face area minus the
swings the median is -1.5 pct (column `no-swing` in the bench).

Reading the residual: the -1.5 to -1.7 pct median against the inside face
is mostly a convention gap, not a trace bias. ResPlan room polygons include
part of each door opening, which the fill never does (the leaf outline or
the closed gap runs between the jambs). Against the inside face minus door
openings (`gt_face_nodoor_m2`, printed under the table) the median is
-0.9 pct (A) and -1.1 pct (B); the rest is the 0.5 pt window and leaf
strokes and the 150/255 ink threshold. Before the fixes those were -2.0 and
-1.6 pct, so the ink-edge trace recovered about one percent.

Open: distance-transform neck cuts at any angle (diagonal doorways without
a vector layer); front doors wider than 1.3 m; variant D needs the headless
raster path to open image PDFs; CubiCasa5K and MSD as in the plan above.

## Status 2026-10-18, round 2

Same 200 plans, 1,223 enclosed rooms, same bench; variant D (B rasterised
at 150 dpi, embedded as an image PDF) now scores since the headless raster
path opens image PDFs. One run of 200 plans x 4 variants takes about 22
minutes with four jobs (the fills themselves got faster: the median A fill
fell from 889 to 682 ms at 3 px/pt on A3, because the ladder bounds sooner).
JSON outputs and logs of both runs are in the session scratchpad
(`roombench/r2/before.json`, `after.json`, `rot-after2.json`).

Four engine changes, all in `src/engine/dynamicfill.ts`:

1. Arcs are not walls. Thin curvy ink (stroke at most a third of the
   dominant stroke from `estimateStrokeWidth`, on no straight run of 32 px
   or more) is grouped into 8-connected pieces; a piece that fits a circle
   (Kasa least squares, one inlier refit so a leaf drawn off-axis and joined
   to its arc drops out) of door radius (0.35 to 2.5 m with a scale) over
   45 to 200 degrees with ink at its centre is a door swing. It is erased
   and its two chords drawn instead, hinge to leaf tip and hinge to far
   jamb, each stopping on the first ink it meets, so the door line closes at
   any angle and the fill runs to it as for a leaf drawn closed. The arc is
   first grown along its circle through any thin ink joined to it, so no
   tangent stub is left to make a false wall end.
2. Text mask. `FillHints.textBoxes` (raster px) erases the thin curvy ink
   inside word boxes before any closing; a wall through a box is thick or
   straight and stays. `src/headless/ops.ts` `fillHintsFor` builds labels,
   word boxes, vector bridges and the scale in one call for the MCP
   `fill_area` tool (OCR word boxes too with its new `ocr` option) and the
   quantity delta. The bench PDFs carry no text, so this has no effect on
   the tables; `scripts/check-fill.mjs` covers it (a dimension string in a
   doorway stops every rung until masked).
3. Wide front doors. A leak rung (2 m) runs only while every narrower rung
   leaked. Because it closes every gap up to 2 m at once, the fill it bounds
   is redone with only the gaps that face the page exterior sealed (the
   free space reachable from the page border with the gaps closed is the
   outside world), climbing through the closing widths the sheet actually
   has between the door and leak widths, so each interior opening is judged
   on its own by the cut rule. The cut rule itself changed: a cut smaller
   than a room (an alcove) is kept as floor and the climb goes on, since a
   wider doorway to a whole room may lie ahead; the kept alcoves that open
   onto the final fill are put back at the end.
4. Flat wall ends. The side of a wall crossed at a shallow angle is long
   along the run and wall-thick across it, like an end, so on a plan 15
   degrees off the axes the row and column closing cut the corners off every
   room. A wall end now needs a flat face: the free pixels just before it,
   offset across the run by up to half the thickness, must be free too (a
   quarter may fail, for scans skewed a degree or two).

Wide-door failure classification (variant A before, 79 unbounded enclosed
rooms, 24 of them living rooms, by the ResPlan geometry). The causes are
per-room findings, not disjoint classes — a room can touch a wide door and
also have a corner jamb — which is why they sum past 79: 63 rooms touch a
door wider than 1.3 m (21 of the 24 living rooms; of the 54 wide doors on
those living rooms, 23 are the front door, 31 are interior doors of 1.3 to
1.85 m), 6 rooms have a door whose jamb is the side of a wall (a corner), 13
are neither (the wall gap is wider than the door polygon, which ResPlan
draws narrower than its opening). No unbounded room has an exterior wall
thinner than 0.12 m. So the fix chosen is the width one, the exterior-aware
leak rung; a distance-transform neck finder is still the answer for
diagonal gaps (below). Effect on variant A: 53 rooms unbounded to ok, 10
unbounded to a merged fill (the clicked room joins a neighbour through an
interior opening of 1.3 to 2 m that the sheet gives no reason to cut, such
as a 1.5 m wardrobe door into a 1.6 m2 store), 1 to a low-IoU fill, 2 ok
rooms to unbounded. Living rooms: unbounded 20.3 to 2.5 percent, recovered
75.4 to 91.5 percent.

Enclosed rooms before:

| Variant | Median rel err vs inside face | p90 abs err | Median vs polygon as is | Median IoU (as is / face) | Leak rate | Unbounded rate | Recovered (IoU >= 0.5, no leak) |
|---|---|---|---|---|---|---|---|
| A bare gaps | -1.5 pct | 13.2 pct | -5.3 pct | 0.931 / 0.980 | 2.9 pct | 6.5 pct | 89.9 pct |
| B door leaf | -1.7 pct | 6.0 pct | -5.1 pct | 0.944 / 0.981 | 1.6 pct | 0.7 pct | 96.8 pct |
| C leaf plus arc | -5.0 pct | 33.7 pct | -8.5 pct | 0.873 / 0.899 | 2.1 pct | 0.6 pct | 93.9 pct |
| D raster 150 dpi | -1.6 pct | 5.8 pct | -5.1 pct | 0.944 / 0.980 | 1.5 pct | 0.7 pct | 96.9 pct |

After:

| Variant | Median rel err vs inside face | p90 abs err | Median vs polygon as is | Median IoU (as is / face) | Leak rate | Unbounded rate | Recovered (IoU >= 0.5, no leak) |
|---|---|---|---|---|---|---|---|
| A bare gaps | -1.3 pct | 16.6 pct | -4.8 pct | 0.935 / 0.982 | 3.7 pct | 1.4 pct | 94.1 pct |
| B door leaf | -1.4 pct | 4.7 pct | -5.0 pct | 0.947 / 0.983 | 1.4 pct | 0.7 pct | 97.1 pct |
| C leaf plus arc | -1.8 pct | 15.7 pct | -5.1 pct | 0.929 / 0.972 | 1.5 pct | 0.6 pct | 96.7 pct |
| D raster 150 dpi | -1.4 pct | 4.6 pct | -4.9 pct | 0.947 / 0.983 | 1.4 pct | 0.7 pct | 97.1 pct |

Per room type: variant C bedrooms -5.6 to -1.2 pct, bathrooms -4.5 to -2.3
pct (recovered 92.3 to 97.1), kitchens leak 10.4 to 2.6 pct, living rooms
-8.6 to -4.3 pct. Living rooms are where C still trails B (-1.2 pct): their
front door swings are wide and often touch a window outline or another
swing, and a merged piece fits no circle, so the arc stays. Variant B and D
moved a little from the flat-end rule and the kept alcoves (B p90 6.0 to
4.7 pct, bathrooms -2.3 to -2.0). Variant A leak rate rose 2.9 to 3.7 pct:
the ten unbounded-to-merged rooms above. Against the inside face minus
door openings the medians are -0.7 (A), -0.9 (B), -1.2 (C), -0.8 (D) pct.

Variant D exposed no raster-specific weakness: at 150 dpi upsampled to the
216 dpi render the 0.5 pt leaf outlines stay above the 150/255 ink
threshold and D tracks B to 0.1 pct on every row, so no threshold change
was made. The remaining raster risk is thinner strokes or lower dpi (a
0.25 pt leaf at 100 dpi would drop out and the door would be judged as a
bare gap, variant A).

Diagonal-wall subset (`scripts/bench/resplan_to_pdf.py --rotate 15,30`,
every tenth plan of the sample, 20 plans, 132 enclosed rooms, 57 at 15 and
75 at 30 degrees, all four variants), after the changes:

| Variant | Rows | Median rel err vs inside face | p90 abs err | Median IoU (as is / face) | Leak rate | Unbounded rate | Recovered |
|---|---|---|---|---|---|---|---|
| A bare gaps | 15 deg | -2.4 pct | 54.5 pct | 0.789 / 0.810 | 7.0 pct | 24.6 pct | 66.7 pct |
| A bare gaps | 30 deg | -1.1 pct | 337.4 pct | 0.717 / 0.741 | 9.3 pct | 34.7 pct | 56.0 pct |
| B door leaf | 15 deg | -1.3 pct | 8.2 pct | 0.939 / 0.980 | 3.5 pct | 0.0 pct | 96.5 pct |
| B door leaf | 30 deg | -1.0 pct | 15.1 pct | 0.952 / 0.982 | 4.0 pct | 0.0 pct | 96.0 pct |
| C leaf plus arc | 15 deg | -2.3 pct | 30.8 pct | 0.873 / 0.904 | 5.3 pct | 0.0 pct | 93.0 pct |
| C leaf plus arc | 30 deg | -0.7 pct | 30.9 pct | 0.879 / 0.912 | 5.3 pct | 1.3 pct | 93.3 pct |
| D raster 150 dpi | 15 deg | -1.1 pct | 8.1 pct | 0.938 / 0.980 | 3.5 pct | 0.0 pct | 96.5 pct |
| D raster 150 dpi | 30 deg | -1.1 pct | 15.1 pct | 0.951 / 0.981 | 4.0 pct | 0.0 pct | 96.0 pct |

Before the flat-end rule the 15 degree rows read -5.0 pct (B) and -5.5 pct
(C) with IoU 0.896 (B): the corner cuts. With sealed doors (B, C, D) rotated
plans now score as the axis-aligned ones. Bare diagonal gaps (A) stay the
open gap: the row and column closing cannot bridge a doorway at 30 degrees
(a quarter of the rooms unbounded at 15 degrees, a third at 30), and the
vector bridges do not apply because ResPlan walls are filled polygons, not
stroked segments. The next step is the distance-transform neck finder:
constrictions of the free space narrower than the door width whose cut
separates a room-sized region, at any angle.

Verification: `scripts/check-fill.mjs` has three new failing-first sheets
(a door swing arc, glyphs in a doorway with and without a text box, and a
1.6 m front door beside a 1.6 m interior opening and a 1.9 m alcove); `npm
run typecheck:engine` and `npm run bench` pass (fill 12/12), `npx tsc
--noEmit` is clean.

Open: distance-transform neck cuts for diagonal bare gaps; variant C living
rooms (swings merged with other thin ink); the ten A rooms that now merge
with a neighbour through a 1.3 to 2 m interior opening (a label hint or the
text layer splits most of them on a real sheet); CubiCasa5K and MSD as in
the plan above.
