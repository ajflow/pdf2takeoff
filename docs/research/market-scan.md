# Market scan: the open-source field around pdf2takeoff — external idea roadmap

**Scan date: 2026-10-19.** Every repo below was verified live against its GitHub
page and/or the GitHub API (stars, licence, last push are point-in-time
snapshots). Companion documents: [ai-literature-review.md](ai-literature-review.md)
(academic work) and [patch-plan.md](patch-plan.md) (what we're doing with it);
public positioning lives in [../feature-comparison.md](../feature-comparison.md).

Purpose: find similar GitHub projects, evaluate their approaches against ours,
and harvest the ideas worth adopting, adapting — or deliberately ignoring —
into a prioritized external idea roadmap.

---

## TL;DR

1. **The "no real open-source Bluebeam" window has closed.** Three serious
   projects all launched in 2026 and are moving fast:
   [opentakeoff](https://github.com/Kentucky-ai/opentakeoff) (~613★, browser
   takeoff + MCP, run by a working flooring estimator),
   [open-pdf-studio](https://github.com/OpenAEC-Foundation/open-pdf-studio)
   (~928★, desktop "open Bluebeam" with its own Rust PDF engine), and
   [OpenConstructionERP](https://github.com/datadrivenconstruction/OpenConstructionERP)
   (~988★, takeoff as one module of a self-hosted ERP). Six months ago this
   scan would have found only dead 3–12★ demos.
2. **MCP/AI-agent support has become table stakes** — three of the serious
   entrants ship MCP servers. Our headless H3 plan is no longer unique; it
   needs to be *better*, and shipping it sooner matters more now.
3. **Our Apache-2.0 licence is now a genuine differentiator.** Every serious
   competitor is AGPL-3.0 (opentakeoff even switched from Apache to AGPL).
   For vendors and contractors who want to embed or bundle a takeoff engine,
   we would be the only permissive option in the category. Worth saying
   loudly in the README.
4. **The field is converging on a trust thesis:** AI/CV output lands as
   *proposals* with provenance that a human accepts (opentakeoff's
   pencil/seal model, Takeoff-Lens's accepted/uncertain/rejected buckets).
   Our Scan tool should adopt this — it's cheap for us and it is where every
   serious player agrees the product category is going.
5. **The adjacent categories are full of adoptable, permissively-licensed
   building blocks:** DXF import (MIT parser that resolves symbol blocks
   deterministically), PP-OCR pipeline (Apache-2.0 ONNX), few-shot counting
   (MIT research code), P2P sync with zero hosting cost (MIT), and a
   PDFium-WASM render path that avoids the MuPDF AGPL trap.

---

## 1. The direct field: open-source takeoff / estimating

| Repo | ★ | Licence | Created | Last push | What it is |
|---|---|---|---|---|---|
| [OpenAEC-Foundation/open-pdf-studio](https://github.com/OpenAEC-Foundation/open-pdf-studio) | ~928 | LGPL-3.0 (custom arrangement per API) | 2026-01 | 2026-10 | Desktop (Tauri) AEC PDF editor, own Rust/PDFium engine |
| [Kentucky-ai/opentakeoff](https://github.com/Kentucky-ai/opentakeoff) | ~613 | AGPL-3.0 | 2026-06 | 2026-10 | In-browser flooring/construction takeoff + MCP (53 tools) |
| [datadrivenconstruction/OpenConstructionERP](https://github.com/datadrivenconstruction/OpenConstructionERP) | ~988 | AGPL-3.0 | 2026-04 | 2026-10 | Self-hosted ERP: BOQ + PDF/CAD/BIM takeoff + 4D/5D |
| [braedonsaunders/bidwright](https://github.com/braedonsaunders/bidwright) | ~64 | AGPL-3.0 | 2026-03 | 2026-10 | AI-native estimating platform, MCP with 150+ tools |
| [DynMEP/YOLOplan](https://github.com/DynMEP/YOLOplan) | ~26 | AGPL-3.0 (Ultralytics) | 2025-07 | 2026-08 | YOLO11 symbol counting for MEP; paid hosted tier |
| [manuvarkey/GEstimator](https://github.com/manuvarkey/GEstimator) | ~73 | GPL-3.0 | 2017 | 2026-02 | Civil estimator with bundled govt rate schedules (no PDF) |
| [anekhirun/Takeoff-Lens-Plugin](https://github.com/anekhirun/Takeoff-Lens-Plugin) | ~6 | MIT | 2026-07 | 2026-08 | Codex plugin: traceable AI takeoff with detector self-benchmarking |

Plus a long tail of tiny/dead projects (HexNinja555/opentakeoff — an unrelated
7★ repo with the same name, elstruck/pdf-takeoff, plan-measure, plansight):
the *name* "opentakeoff" is already contested, and the category floor is
crowded with one-day demos. Curated lists worth monitoring:
[Awesome-Construction-Takeoff](https://github.com/ishandutta2007/Awesome-Construction-Takeoff),
[Awesome-Construction-Estimating](https://github.com/ishandutta2007/Awesome-Construction-Estimating).

### The three that matter

**opentakeoff** is the closest competitor — same architecture bet as us
(browser, client-side, IndexedDB autosave, MCP server on the official
registry). Their interesting approaches:

- **Provenance-first AI governance.** Every shape records scale, method
  (flood / raster trace / hand-drawn / agent-proposed) and whether a human
  corrected it. Agent output lands as dashed "pencil" proposals; only a human
  can mint the APPROVED seal. Best answer in the field to "can I trust AI
  takeoff".
- **Graded scale verification.** "Check a dimension (K)" returns green
  (<1% error) / amber (<5%) / red — and *unscaled sheets refuse measurement
  outright*. Auto-detects drawn scale notes.
- **Flooring-trade depth + data flywheel.** Seam layout with cut diagrams,
  waste %, coverage rates, schedule OCR import with disagreement flags; an
  opt-in "Contribute" bank that turns user markups into training rows.

*Vs us:* they have scale-note auto-detection, graded calibration verdicts,
provenance seals, DXF export and a training-data flywheel. We have
multi-scale viewports, volume, markups as *standard PDF annotations*
(theirs are internal), geometric revision overlay, Yjs CRDT live sessions,
and the friendlier licence.

**open-pdf-studio** is the "open Bluebeam" desktop play: Tauri 2 + Rust, a
multi-process PDFium worker pool with progressive tile rendering, DWG/DXF
import with layer selection and *viewports that carry measuring scales*, DXF
export with markups on their own layers, XFDF import/export, **automatic
change detection in revision compare** (added/removed/modified list +
dx/dy/rotation alignment), crowd-sourced regional symbol/stamp libraries, a
one-click MCP installer, and "quick scale" (right-click any drawn dimension →
type the real value → recalibrated). Marketed head-on at Revu with a
vs-Bluebeam page.

*Vs us:* their compare and calibration UX beat ours; their quantity side is
thinner (count tool + tally schedule, no formula columns/reports). We are
browser-native, zero-install, quantity-first, and permissively licensed.

**OpenConstructionERP** proves demand by bundling: "WordPress for
construction" with 190+ modules, 120k priced cost items across 40+ markets,
browser PDF measuring flowing into hierarchical BOQ with **GAEB X83 / DIN
276 / NRM / MasterFormat exports**, PaddleOCR + YOLOv11 CV pipeline, and
LLM estimating with cost-matching against a real price database. Heavyweight
self-hosted stack (FastAPI + Postgres); takeoff is one module of many.

*Vs us:* they own the estimating downstream (cost DBs, BOQ standards) and
BIM 3D. We own zero-install, privacy and embeddability. Don't chase them;
be the layer they *could* embed.

**Takeoff-Lens-Plugin** (6★ but the most stealable idea in the scan):
detections are *candidates*, not quantities — review buckets
accepted / rejected / uncertain / unresolved, "OCR is context, not proof",
and it **benchmarks its own detector** (precision/recall/F1 + miss
attribution per run). GEstimator shows the other end: a non-AI desktop
estimator surviving 9 years on bundled government rate schedules — content
is what keeps estimating tools alive.

---

## 2. PDF annotation / viewers (generic)

| Repo | ★ | Licence | Note |
|---|---|---|---|
| [Stirling-Tools/Stirling-PDF](https://github.com/Stirling-Tools/Stirling-PDF) | ~94.5k | custom open-core | 50+ server-side PDF tools, no-code pipelines |
| [embedpdf/embed-pdf-viewer](https://github.com/embedpdf/embed-pdf-viewer) | ~4.6k | Apache-2.0 core | **PDFium fork in WASM** — the MuPDF escape hatch |
| [pdfme/pdfme](https://github.com/pdfme/pdfme) | ~4.9k | MIT | JSON-template PDF generation, pdf-lib based |
| [OpenSignLabs/OpenSign](https://github.com/OpenSignLabs/OpenSign) | ~7.1k | AGPL-3.0 | signing workflow state machine + audit certificates |
| [agentcooper/react-pdf-highlighter](https://github.com/agentcooper/react-pdf-highlighter) | ~1.4k | MIT | minimal selection→annotation model, slowing |
| [annotorious/annotorious](https://github.com/annotorious/annotorious) | ~869 | BSD-3 | W3C Web Annotation data model, deep-zoom tools |
| [hypothesis/client](https://github.com/hypothesis/client) | ~738 | BSD-2 | document fingerprinting + anchoring gold standard |
| [ArtifexSoftware/mupdf.js](https://github.com/ArtifexSoftware/mupdf.js) | ~610 | **AGPL-3.0** | fast WASM render + structured text — licence trap |
| [Submitty/pdf-annotate.js](https://github.com/Submitty/pdf-annotate.js) | ~296 | MIT | StoreAdapter persistence abstraction |
| [Laomai-codefee/pdfjs-annotation-extension](https://github.com/Laomai-codefee/pdfjs-annotation-extension) | ~329 | Apache-2.0 | native-type round-trip + review statuses; archived |

Adoptable ideas: **XFDF import/export** as the universal Bluebeam/Acrobat
sidecar next to our embedded annotations; **PDFium-WASM as an optional
render engine** (Apache-licensed via embedpdf — mupdf.js is faster to adopt
but would force AGPL on us); **annotation review semantics** (reply threads,
Accepted/Rejected/Completed statuses — extends our flag/confirm pills);
**Hypothesis-style document fingerprinting** to auto-match "same sheet across
revisions" in compare; a **StoreAdapter-shaped persistence seam** (local /
Yjs / future relay behind one interface); pdfme-style **JSON templates** for
generated quantity sheets.

## 3. Construction-drawing CV / AI

(Full academic treatment in the
[literature review](ai-literature-review.md); this is the code side.)

| Repo | ★ | Licence | Why it matters |
|---|---|---|---|
| [PaddlePaddle/PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) | ~91k | Apache-2.0 | det→cls→rec pipeline = our OCR upgrade path (patch 3), ONNX-ready |
| [docling-project/docling](https://github.com/docling-project/docling) | ~69k | MIT | layout/reading-order/table structuring for title blocks & schedules |
| [huggingface/transformers.js](https://github.com/huggingface/transformers.js) | ~16.4k | Apache-2.0 | WebGPU+WASM execution layer for everything "in-browser ONNX" |
| [CubiCasa/CubiCasa5k](https://github.com/CubiCasa/CubiCasa5k) | ~612 | **CC BY-NC** | icon taxonomy + heatmap-per-category approach; research only |
| [grebtsew/FloorplanToBlender3d](https://github.com/grebtsew/FloorplanToBlender3d) | ~630 | GPL-3.0 | classical OpenCV wall/room/door pipeline — our spiritual ancestor |
| [art-programmer/FloorplanTransformation](https://github.com/art-programmer/FloorplanTransformation) | ~682 | MIT | door-to-wall snapping via optimization — dynamic fill upgrade |
| [ywyue/RoomFormer](https://github.com/ywyue/RoomFormer) | ~339 | MIT | rooms as ordered-corner polygons, not masks |
| [zlzeng/DeepFloorplan](https://github.com/zlzeng/DeepFloorplan) | ~417 | GPL-3.0 (MIT reimpl exists) | boundary-guided attention; TFLite export path |
| [niki-amini-naieni/CountGD](https://github.com/niki-amini-naieni/CountGD) | ~337 | MIT | exemplar-box-as-query open-world counting = learned click-to-teach |
| [Verg-Avesta/CounTR](https://github.com/Verg-Avesta/CounTR) | ~127 | MIT | copy-paste synthetic pretraining (we already generate this data) |
| [ChaoningZhang/MobileSAM](https://github.com/ChaoningZhang/MobileSAM) | ~5.9k | Apache-2.0 | ~10 ms prompt-decoder for browser; interactive boundary assistant |
| [Azure-Samples/…P&ID digitization](https://github.com/Azure-Samples/digitization-of-piping-and-instrument-diagrams) | ~143 | MIT | association + rule-validation stage after detection; superb design docs |
| [yangfy2023/CADspotting](https://github.com/yangfy2023/CADspotting) | 6 | **none** | SOTA on FloorPlanCAD; read for augmentations, can't ship |

Adoptable ideas: **PP-OCR pipeline shape** (small ONNX text-detector per tile
→ angle classifier on boxes → recognize crops only — order-of-magnitude
cheaper than whole-page Tesseract on dense sheets); **exemplar-query few-shot
detection** as the learned tier above our 100 ms CV matcher (patch 5);
**RoomFormer-style polygon fitting** to turn flood-fill blobs into
dimensionable room outlines with R2V door-snapping; **MobileSAM as a lazy
"magic wand"** for noisy scans where binarize+flood-fill fails; the
**Azure P&ID association + rule-validation blueprint** for wiring recognized
dimension text to counted symbols and parsing schedules/title blocks.

## 4. Local-first / CRDT collaboration

| Repo | ★ | Licence | Note |
|---|---|---|---|
| [yjs/yjs](https://github.com/yjs/yjs) (+ ecosystem) | ~23k | MIT | our engine; y-webrtc dormant since 2024 = the gap |
| [dmotz/trystero](https://github.com/dmotz/trystero) | ~2.8k | MIT | P2P signaling over nostr/MQTT/torrent — **no server we pay for** |
| [cloudflare/agents](https://github.com/cloudflare/agents) | ~5.8k | MIT | Yjs sync on Durable Objects; **free tier fits our relay** |
| [excalidraw/excalidraw](https://github.com/excalidraw/excalidraw) | ~134k | MIT | no-CRDT LWW-per-element collab; self-hosted relay swap |
| [tldraw/tldraw](https://github.com/tldraw/tldraw) | ~51k | **custom, paid for production** | presence/camera-follow gold standard — copy ideas, never code |
| [jamsocket/y-sweet](https://github.com/jamsocket/y-sweet) | ~1k | MIT | doc-level client tokens as ACLs; bring-your-own-infra |
| [automerge/automerge-repo](https://github.com/automerge/automerge-repo) | ~715 | MIT | network/storage adapters as symmetric seams |
| [local-first-web/auth](https://github.com/local-first-web/auth) | ~327 | MIT | decentralized team auth — signed membership, no accounts |

Adoptable ideas for phase 4 (cross-machine relay on a zero-cost static
host): **Trystero rooms keyed by file-hash + share code** (signaling *and*
data encrypted end-to-end over public nostr/MQTT — "not even we can see your
session" and zero hosting); **Cloudflare Durable Objects as the fallback
relay** (hibernating WebSockets, outgoing WS messages unbilled, 100k req/day
free — deploys beside our Pages site; encrypt payloads with the room key so
the DO only sees ciphertext); **tldraw's presence schema** — put
`{cursor, selection, camera, following}` into Yjs Awareness now so
follow-mode ("watch where the senior estimator is looking") is a schema
decision already made; **room key = ACL** (share link carries the secret; no
accounts ever); **session-file export/import** (excalidraw lesson) — our Yjs
doc merges cleanly after email/USB transfer between job-site laptops, a
differentiator CRDTs hand us for free.

## 5. BIM / IFC / DXF

| Repo | ★ | Licence | Note |
|---|---|---|---|
| [IfcOpenShell/IfcOpenShell](https://github.com/IfcOpenShell/IfcOpenShell) (incl. Bonsai) | ~2.9k | LGPL-3.0 | IfcCostItem ↔ quantity parametric cost model; selector query language |
| [ThatOpen/engine_web-ifc](https://github.com/ThatOpen/engine_web-ifc) | ~1.1k | MPL-2.0 | WASM-kernel-in-browser pattern (drawer, not roadmap) |
| [ThatOpen/engine_components](https://github.com/ThatOpen/engine_components) | ~714 | MIT | Classifier → Quantities → schedule, client-side |
| [mozman/ezdxf](https://github.com/mozman/ezdxf) | ~1.5k | MIT | round-trip doctrine + `view/audit/browse/info` CLI grammar |
| [skymakerolof/dxf](https://github.com/skymakerolof/dxf) (transferred bjnortier/dxf) | ~402 | MIT | JS DXF parser that **resolves nested INSERT blocks**; no MTEXT/DIM/HATCH |
| [gdsestimating/dxf-parser](https://github.com/gdsestimating/dxf-parser) | ~559 | MIT | parse-only alternative, dormant, huge npm reach |
| [opensourceBIM/BIMserver](https://github.com/opensourceBIM/BIMserver) | ~1.8k | AGPL-3.0 | revision discipline on shared models; plateauing |

The two decisions this category forces:

- **DXF import: yes, scoped.** DXF is 2D-vector-native and maps one-to-one
  onto what we already are. The killer detail: **a DXF block table is a
  ready-made symbol catalog — counting INSERTs by block name is
  deterministic symbol counting, no CV needed.** MIT, browser-capable parser
  exists (skymakerolof/dxf); budget for its MTEXT/DIMENSION/HATCH gaps and
  its dormancy (fork-able; dxf-parser as alternate core). Do **not** promise
  DWG — the entire OSS world punts to ODA File Converter.
- **IFC: no — seam, not feature.** 3D geometry kernels and a competitive
  field (IfcOpenShell, ThatOpen, FreeCAD, ERP aggregators) that will always
  out-invest us. The cheap move is publishing a portable `takeoff.json`
  schema an ifcopenshell-based CLI could emit.

---

## 6. Cross-cutting themes

1. **Trust is the battleground.** Every serious 2026 entrant independently
   arrived at: AI/CV results are proposals; humans seal them; provenance
   rides along; the tool self-reports accuracy. (opentakeoff seals,
   Takeoff-Lens buckets + F1, plansight citations, OpenConstructionERP
   anti-hallucination cost-matching.)
2. **MCP is table stakes; the agent story is the marketing.** opentakeoff's
   tagline is literally "the first engine an AI agent drives natively" —
   which was *our* headless-engine pitch. Ship H2/H3 and lead with it.
3. **Licence is positioning.** We are the only permissive-licence (Apache-2.0)
   takeoff engine in a field of AGPL. Embeddability is the wedge.
4. **Content compounds.** open-pdf-studio crowd-sources stamp libraries,
   GEstimator bundles rate schedules, YOLOplan ships a pretrained model.
   Our equivalent: crowd-sourced *working detectors* (click-to-teach
   templates packs) — nobody else's counting is teachable enough to share.
5. **Nobody has real collaboration.** No competitor ships CRDT live sessions.
   Our phase 4, done p2p-first, stays a genuine differentiator instead of
   parity.

---

## 7. Benchmarks: what competitors publish, and how they score

Follow-up scan (2026-10-19), prompted by our own bench push (val mAP on the
synthetic detector set, in-browser scan latency, CI correctness gates).
Question: does anyone else in the field publish numbers? **Mostly, no — and
that absence is an opportunity.**

| Repo | Publishes numbers? | Detection accuracy | Measurement accuracy | Performance | CI correctness gates |
|---|---|---|---|---|---|
| [Kentucky-ai/opentakeoff](https://github.com/Kentucky-ai/opentakeoff) | **Yes — extensive** | F1 (external bench) | Yes (% error) | Yes (ms) | Yes (strong) |
| [OpenAEC-Foundation/open-pdf-studio](https://github.com/OpenAEC-Foundation/open-pdf-studio) | **Yes — perf only** | No | No | Yes (ms, GB RSS) | Yes (pixel render regression) |
| [datadrivenconstruction/OpenConstructionERP](https://github.com/datadrivenconstruction/OpenConstructionERP) | Partially (honest zero baseline) | Retrieval only | No | No | Yes (eval ratchet in CI) |
| [braedonsaunders/bidwright](https://github.com/braedonsaunders/bidwright) | Nothing | No | No | No | Conventional tests |
| [DynMEP/YOLOplan](https://github.com/DynMEP/YOLOplan) | **Nothing** (despite being a detection product) | No | No | No | None evident |
| [manuvarkey/GEstimator](https://github.com/manuvarkey/GEstimator) | Nothing | No | No | No | None |
| [anekhirun/Takeoff-Lens-Plugin](https://github.com/anekhirun/Takeoff-Lens-Plugin) | Harness yes, numbers private | (private) | No | No | Yes (bench tests) |

**opentakeoff** is the rigorous one and treats evals as marketing: a public
`evals/` tree with runnable harnesses, raw run logs and *published failures*.
Detection is scored as end-to-end **F1 on someone else's external bench** —
[KamaiEnterprises/aec-geometric-bench](https://github.com/KamaiEnterprises/aec-geometric-bench)
(312 sheets, 15 released with ground truth + scorer): Claude + their MCP
harness scored **area-instance F1 0.667 / area-pixel F1 0.887** on sheet_02
first pass (paper's frontier VLM raster-only arms: 0.078–0.227; Kamai's own
production pipeline: 0.930/0.924 corpus-wide), with a stated target of
F1 ≥ 0.85 across all 15 sheets. Measurement accuracy is published on real
VA sheets: **400.00 LF measured against a printed 400′ (0.00% error)** and
**98.26 LF against 100′ (1.74%)** — alongside their failures (43 false rooms
at confidence 1.0; schedule reader got 2 of 21 rows). Perf: MCP sessions of
32 steps / ~6 s tool time; a 44 MB model-size note; a text-search median
2.45 → 1.40 ms optimization log. Their CI runs a SHA-256-pinned conformance
bench — synthetic PDF, analytic ground truth, exact polygon-intersection
scoring, missing/duplicate/extra/invalid/holed-shape failure cases — which is
the direct peer of our tiling/NMS/fill-tolerance/round-trip gates.

**open-pdf-studio** publishes performance engineering only (commit-referenced
docs, medians, outliers kept): heavy sheet opens in 13,425 ms; sharp zoom at
150/200/300% in 1,072/941/1,169 ms (down from a reproducible 120-second
timeout); worker RSS 1.33 GB (from a 5.16 GB peak); light sheet opens in
1,013 ms. Plus a pixel-level render-regression CI workflow. No accuracy
numbers anywhere.

**OpenConstructionERP** ships an eval baseline that is honestly all zeros
("populated on first clean run"), a retrieval recall@1 ~0.62 → ≥0.67 gate,
and a CI ratchet that fails on >5% absolute drops — infrastructure without
results. **Takeoff-Lens** builds exactly the right harness (precision/recall/
F1 in PDF points, SHA-pinned ground truth, `--fail-on-threshold`) but keeps
its drawings and numbers private. **YOLOplan** — a detection product —
publishes no mAP, precision, recall, latency or model-size number at all.

### How they score against our three bench axes

- **Detection accuracy:** only opentakeoff publishes, and theirs is
  end-to-end F1 on an external bench, not training val mAP. Our
  2,000-sheet / 56k-symbol / 5-class val mAP disclosure is unique in the
  cohort. The gap: they have an *external, comparable anchor* (Kamai's
  bench) — we don't.
- **Latency + model size:** nobody publishes the pair. Our
  100 ms tier-1 CV / 1.6 s ML scan (cached) / 76 MB disclosure is
  uncontested; open-pdf-studio owns the *rendering* perf axis instead.
- **Correctness gates:** we and opentakeoff are the only two projects in the
  category that can make this claim at all.

**Raster-comparable reference numbers** for contextualizing our detector
bench (from the literature; see the
[literature review](ai-literature-review.md) for the papers). The only fair
raster rows — FloorPlanCAD Table 4, real rasterized CAD, 28 classes,
COCO-style: Faster R-CNN R101 **mAP 0.452 / AP50 0.602**; FCOS R101 0.453;
YOLOv3 0.413. Everything scoring above ~0.5 mAP on FloorPlanCAD/ArchCAD-400K
(CADspotting PQ 87.4, wF1 93.2, mAP 66.3) is a *vector-entity method with
layer/colour priors* — not comparable to a raster detector on scanned PDFs.
For the few-shot roadmap, the field's currency is counting **MAE/RMSE** on
FSC-147 (CounTR 3-shot 11.95 → CountGD text+exemplar 5.74), not F1 — if we
ever bench click-to-teach against user-verified counts, MAE is the
comparable metric. Browser-ballpark refs: PP-OCRv5 mobile det+rec ≈ 1.75 s
/image on a server CPU (our 1.6 s full-page ML scan is already at that
speed, in-browser); MobileSAM ≈ 12 ms GPU / ~3 s desktop CPU per image.

### What this adds to the roadmap

1. **Publish our three axes with method** (hardware, cache state, sheet
   type) — val mAP + latency + model size + the CI gate list. We would be
   the only project in the category disclosing all of them together.
2. **Adopt an external anchor:** run our CLI/MCP against Kamai's
   AEC-Geometric-Bench (open, 15 sheets, released scorer) for a comparable
   end-to-end number. opentakeoff already scored there — arriving with a
   reproducible run of our own turns "unique axes" into "contested and
   won/lost honestly".
3. **Add a per-run accuracy readout to Scan** (the Takeoff-Lens pattern
   with public numbers): accept/reject decisions against hit confidence is
   a live precision/recall signal we get for free from users, and publishing
   it would be a first in the category.

All three are specced as buildable patches — with the competitor harness
mechanics they borrow and licence constraints — in
[bench-patch-plan.md](bench-patch-plan.md).

---

## 8. Head-to-head scorecard: where pdf2takeoff ranks

Method: nine axes weighted for what an estimator choosing a tool in 2026
cares about (and what STRATEGY.md says we optimize: the estimator's hour,
local-first, permissive licence). Scores 0–5 from everything verified in
this scan + our shipped features. A different weighting — e.g. pure
community momentum — orders the field differently; that caveat is below.

| Axis (weight) | pdf2takeoff | opentakeoff | open-pdf-studio | OpenCon.ERP | bidwright | Takeoff-Lens | YOLOplan | GEstimator |
|---|---|---|---|---|---|---|---|---|
| Takeoff & measurement depth (20%) | **5** | 4 | 3 | 4.5 | 4 | 1.5 | 1 | 3 |
| Symbol detection & automation (15%) | 3 | 3.5 | 2 | 3 | 2.5 | 3 | 3.5 | 1 |
| Trust, evals & benchmarks (10%) | 2.5 | **5** | 2.5 | 2 | 1.5 | 4 | 1 | 1 |
| Performance & footprint (10%) | 4.5 | 3.5 | **5** | 2 | 2 | 1.5 | 2.5 | 2 |
| Collaboration (10%) | **4** | 1 | 1 | 3 | 2 | 1 | 1 | 1 |
| AI & agent capability (10%) | 4 | **5** | 3.5 | 3.5 | 5 | 4.5 | 2 | 1 |
| Interoperability (10%) | **5** | 3 | 5 | 4.5 | 4 | 2 | 2.5 | 3 |
| Privacy & deployment (7.5%) | **5** | 4 | 3.5 | 2 | 2 | 3 | 2 | 3 |
| Licence & community traction (7.5%) | 3 | **4** | 4 | 3.5 | 2 | 3.5 | 2 | 2 |
| **Weighted total** | **4.05** | 3.68 | 3.16 | 3.26 | 2.93 | 2.54 | 1.93 | 1.93 |

(Bluebeam, unranked commercial reference: would lead takeoff depth,
collaboration and interop; fails privacy, price and openness — that gap is
why this whole field exists.)

**Ranking: 1. pdf2takeoff (4.05) · 2. opentakeoff (3.68) · 3.
OpenConstructionERP (3.26) · 4. open-pdf-studio (3.16) · 5. bidwright ·
6. Takeoff-Lens · 7–8. YOLOplan, GEstimator.** OCE vs open-pdf-studio is
within noise (0.1). The top two are clear of the field; the gap between us
and opentakeoff is one trust/evals axis.

**The honest reading.** We rank #1 on *product capability for the core
estimator job* — nothing else ships multi-scale viewports, formula columns,
volume, in-PDF annotation round-trip, any CRDT collaboration, and a
permissive licence together. But two caveats matter more than the decimal:

1. **On momentum we are last of the serious four.** Our GitHub repo is days
   old with ~0 stars; opentakeoff gathered 613★ in four months,
   open-pdf-studio 928★, OCE 988★. The scorecard says "best product today",
   not "winning the market". Awareness, not capability, is our binding
   constraint.
2. **The single weakest cell that a buyer can check is Trust (2.5) — and
   it is the axis our closest rival scores 5 on.** opentakeoff's public
   evals, external benchmark anchor, published failures and provenance
   seals are exactly what a skeptical estimator (or their IT buyer) will
   find. Every other gap is a roadmap item; this one is a publishing task.

### Recommendations to rank higher, in score-per-effort order

1. **Publish the benchmarks** (Trust 2.5 → ~4). An `evals/` directory:
   val mAP with method (data, split, hardware), the 100 ms / 1.6 s / 76 MB
   latency-size pair, and the CI gate list — then a reproducible run of our
   CLI/MCP against Kamai's AEC-Geometric-Bench for the external anchor.
   The numbers already exist; only the publishing is missing. (§7,
   roadmap-adjacent.)
2. **Publish the blog draft and say the licence loudly** (Traction 3 → 4).
   `draft-open-symbol-detector.md` is a genuinely good honest-engineering
   story sitting unpublished; pair it with a README line stating we are the
   only Apache-2.0 takeoff engine in a field of AGPL, and submit to the
   Awesome lists. Cheapest stars we will ever get.
3. **Widen and register the MCP surface** (AI 4 → 5). 12 tools vs
   opentakeoff's 53 (registry-listed) and bidwright's 150+. Add batch
   operations (all-pages scan/export, set-status ranges), a schedule/title
   -block reader, page ops; ship an `npx pdf2takeoff-mcp` entry on the
   official registry; make agent output land as *proposals* (also feeds
   Trust).
4. **Graded scale verification + refuse-on-unscaled** (Trust, Takeoff).
   Roadmap #1 — opentakeoff's flagship trust feature; our OCR already
   reads the printed dimension, so the check itself is nearly free.
5. **Ship cross-machine Live** (Collab 4 → 5). We are the only project
   with any live collaboration; finishing phase 4 (Trystero p2p, DO
   fallback — roadmap #6) makes that moat durable instead of partial.
6. **Quantize the model to ≤ 25 MB** (Performance). Fits the Pages asset
   limit (no model-branch workaround), roughly halves first-scan wall
   time, and gives benchmark #1 a better number to publish.
7. **XFDF + DXF import** (Interop, defends vs open-pdf-studio).
   Roadmap #3 and #10 — DXF block counting is deterministic and counters
   their DWG/DXF headline at browser weight.
8. **Measure and publish rendering perf on a heavy sheet** (Performance
   4.5 → 5). We publish scan latency but not render latency; open-pdf-
   studio set that bar (941 ms zoom). Tile-render off-main-thread before
   considering the PDFium-WASM engine.
9. **Few-shot tier with an MAE readout** (Detection 3 → 4). Roadmap #13,
   scored the field's way: counting MAE against user-verified counts, not
   mAP.

Deliberately not done to "rank higher": chasing OCE's cost databases or
BIM depth, or open-pdf-studio's desktop install base — those are their
lanes; our score leads because we don't spend score cells outside our
strategy.

---

## 9. External idea roadmap

Prioritized; mapped to existing roadmap items (README roadmap 1–5,
[patch-plan.md](patch-plan.md) patches, specs/headless-engine.md phases H1–H3).
Licences noted where they constrain (everything proposed below is
Apache/MIT-compatible unless flagged).

### Horizon 1 — cheap, high-trust, near-term

| # | Idea | Source repos | Maps to |
|---|---|---|---|
| 1 | **Graded scale verification**: "check a known dimension" → green <1% / amber <5% / red; refuse measurement on unscaled sheets; auto-read scale notes (we already have the OCR); right-click a drawn dimension → type real value → recalibrate | opentakeoff, open-pdf-studio | extends calibration + OCR (shipped) |
| 2 | **Scan output as proposals with provenance**: hits land flagged, user accepts/rejects; keep an *uncertain* bucket; record method (CV/ONNX/template) + human corrections per shape; surface accept-rate as the detector's own accuracy metric | opentakeoff, Takeoff-Lens-Plugin | extends Scan + flag/confirm statuses (shipped) |
| 3 | **XFDF import/export** alongside embedded annotations: export a sidecar any Bluebeam/Acrobat consumes; import existing Revu markups into a live session | open-pdf-studio, pdfjs-annotation-extension | the "Bluebeam markups CSV import" roadmap line, done properly |
| 4 | **Presence upgrade now, relay later**: put `{cursor, selection, camera, following}` into Yjs Awareness today; follow-mode = camera-sync to another estimator's viewport; 20 Hz broadcast + local interpolation | tldraw (ideas only — licence), cloudflare/agents | phase 4, front-loaded cheap half |
| 5 | **Session-file export/import**: serialize the Yjs takeoff doc to a file that merges cleanly on the other side (USB/email between job sites) | excalidraw, automerge | phase 4 offline lane; IndexedDB persistence already shipped |

### Horizon 2 — feature gaps the field exposed

| # | Idea | Source repos | Maps to |
|---|---|---|---|
| 6 | **Cross-machine relay, p2p-first**: Trystero rooms (nostr signaling, key from file-hash + share code, E2E encrypted) as phase 2a; Cloudflare Durable Objects free tier (hibernating WS, payloads encrypted with the room key) as phase 2b fallback | trystero, cloudflare/agents, y-sweet (token model) | phase 4 core |
| 7 | **PP-OCR pipeline**: small ONNX text-detector per tile → angle classifier → recognize crops only; kills whole-page Tesseract cost and handles rotated dimension strings | PaddleOCR (Apache-2.0 ONNX models) | patch-plan patch 3 (model half, still open) |
| 8 | **Compare upgrades**: automatic change detection (added/removed/modified list with counts) + dx/dy/rotation alignment for shifted sheets; surface the `run --prev` quantity-delta inside the UI, not just CLI | open-pdf-studio; opentakeoff (quantity delta) | overlay compare (shipped, weakest vs peers) + run --prev |
| 9 | **Community symbol template packs**: shareable per-trade/region packs where one taught click = a working detector (crop + tolerance + label); a folder format + import/export + a curated seed set | open-pdf-studio libraries, YOLOplan pretrained model, CubiCasa taxonomy (NC — taxonomy only) | Scan + tool library (shipped); plugin API roadmap 5 |
| 10 | **DXF import**: skymakerolof/dxf parse → denormalize INSERTs → world-space vector layer; count INSERTs by block name deterministically; CV stays the fallback for exploded geometry and PDFs | skymakerolof/dxf, ezdxf (doctrine), gdsestimating/dxf-parser (alt) | the "DXF import is a possible later step" line in feature-comparison |
| 11 | **Revision set auto-matching by content fingerprint** (not filename) before pairing sheets in compare | hypothesis/client | CLI `compare`/`set` (shipped) |
| 12 | **Association + validation stage**: wire recognized dimension text to nearest counted symbol; parse schedules/title blocks with layout structure; rule-validate before display | Azure-Samples P&ID (MIT), docling (ideas) | OCR + Scan convergence |

### Horizon 3 — strategic bets

| # | Idea | Source repos | Maps to |
|---|---|---|---|
| 13 | **Exemplar-query few-shot detection**: click box becomes a query embedding for a lightweight head above our frozen features; copy-paste synthetic pretraining we already generate | CountGD, CounTR (both MIT) | patch-plan patch 5 (open) |
| 14 | **MobileSAM boundary assistant**: lazy-loaded (~10 ms decoder) click-prompted masks to snap walls/rooms on noisy scans where binarize+flood-fill leaks; combine with RoomFormer-style polygon fitting for dimensionable room outlines | MobileSAM (Apache-2.0), RoomFormer (MIT), FloorplanTransformation (MIT door-snapping) | dynamic fill gap-closing (shipped, known limits) |
| 15 | **Portable `takeoff.json` schema + estimating handoff exports**: group-by classifications (layer/label/symbol/sheet) over quantified line items; emit BOQ-shaped XLSX, GAEB X83, MasterFormat/UniFormat-coded CSV — be the feeder for ERP-class tools, not a mini-ERP | OpenConstructionERP, GEstimator, ThatOpen Classifier→Quantities | custom columns + exports (shipped); plugin API |
| 16 | **PDFium-WASM optional render engine** for huge vector sheets (tiled, off-main-thread); explicit *avoid* on mupdf.js (AGPL) | embedpdf/embed-pdf-viewer (Apache-2.0), open-pdf-studio worker-pool pattern | viewer performance; check:deploy budget still applies |
| 17 | **Review semantics on markups**: reply threads + Accepted/Rejected/Completed states extending our flag/confirm pills, riding in the PDF comment | pdfjs-annotation-extension, OpenSign (audit certificate pattern) | statuses (shipped) → drawing-review workflows |

### Deliberately not adopting (consistent with STRATEGY.md)

- **AGPL components** (mupdf.js, y-webrtc forks of GPL stacks) — licence trap.
- **tldraw code** — custom licence, paid for production; ideas only.
- **CubiCasa5k / CADspotting weights** — NC / no licence; research reference.
- **IFC viewing/auth** — out-invested field; integration seam only (#15).
- **Cloud project hosting / cost databases** — contradicts local-first; the
  ERPs can have that. We feed them.
- **Desktop app** — open-pdf-studio owns that lane; browser-any-OS is ours.

---

## 10. Licence landmine register

| Component | Licence | Verdict |
|---|---|---|
| ArtifexSoftware/mupdf.js | AGPL-3.0 / commercial | never ship |
| tldraw | custom, production requires paid key | copy ideas, not code |
| CubiCasa5k dataset/models | CC BY-NC 4.0 | research/pretraining care only |
| yangfy2023/CADspotting | none declared | read-only reference |
| datalab-to/surya | code Apache-2.0, weights OpenRAIL-M | avoid weights |
| PaddleOCR models | Apache-2.0 | shippable (unlike Tesseract's Apache — fine too, just slower) |
| Ultralytics YOLO (YOLOplan's stack) | AGPL-3.0 | confirms our YOLOX choice |
| skymakerolof/dxf, trystero, cloudflare/agents, MobileSAM, CountGD/CounTR, RoomFormer, PaddleOCR, docling, ezdxf, embedpdf core | MIT / Apache-2.0 / MPL-2.0 | shippable |

## 11. Watchlist

Monthly check: **opentakeoff** and **open-pdf-studio** (direct pace),
**OpenConstructionERP** (bundle pressure), **embedpdf** (PDFium-WASM
maturity), **trystero** + **cloudflare/agents** (phase-4 transport),
**transformers.js** (WebGPU path for our ONNX),
**KamaiEnterprises/aec-geometric-bench** (external eval anchor — watch for
new released sheets), and the two Awesome lists (category temperature).
Re-run this scan if any of them cross ~2× current stars or ship a
permissive-licence pivot.

---

*Verification note: stars/push dates/licences pulled from GitHub REST API on
2026-10-19; headline competitors re-verified independently the same day.
Stars move; the strategic reads are the durable content.*
