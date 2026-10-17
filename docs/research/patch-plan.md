# Patch plan: applying the research

> **Status 2026-10-17:** patches 1, 2, 4 and the deterministic half of 3
> shipped (see git log). Patch 3's model half (PaddleOCR-class det/cls/rec
> ONNX behind the same `OcrWord[]` port) and patch 5 (embedding-matcher scan
> tier) are still open — both need model artifacts prepared outside this
> repo. Patch 6 waits on the next Kaggle run; the generator now emits the
> degraded + wall-touching mix it should train on.

Findings summary and a file-level plan derived from
[ai-literature-review.md](ai-literature-review.md). Each patch names the
papers it is based on, the files it touches, and a licence note where
relevant. Effort figures assume familiarity with the codebase.

## Findings in one screen

1. **Our Scan interaction has a name and a literature** — class-agnostic
   few-shot counting (FamNet/FSC-147, LOCA, CountSAM) plus one-shot
   detection (OS2D, DE-ViT/DINOv2). The fixed-5-class YOLOX ceiling is a
   solved problem class: prototype matching over frozen features detects
   arbitrary symbols from one click with no retraining.
2. **The OCR upgrade path is clear** — PP-OCR's det → direction-cls → rec
   pipeline (mobile models, single-digit MB, Apache-2.0, ONNX-ready) is
   purpose-built for rotated dimension text; a 2026 paper (Ying et al.)
   ships essentially our dimension reader with a 3.8M-param detector.
   Our known trick: the clicked segment's angle is known, so crops can be
   pre-rotated deterministically.
3. **The door-gap leak has a published fix** — doors/openings predicted as
   an explicit boundary class (DeepFloorplan, CubiCasa5k data). Before any
   model: adaptive morphological closing + topology validation (Adams &
   Bischof 1994, Ahmed DAS 2012) is the cheap tier.
4. **Our synthetic generator is missing the degradation axis** — SESYD
   (2013) and Bickel (2024) both say scan-like degradation is what makes
   synthetic-trained detectors survive real sheets; we currently render
   crisp vector-style art only, and symbols are rejection-sampled clear of
   walls (the detector's declared blind spot).
5. **The agent architecture is validated** — ArchPlanVQA / DrawingVQA /
   FloorplanQA / Picard all show VLMs misreport drawing numbers; our
   "agent plans, deterministic tools produce every number" MCP design is
   exactly what the evidence prescribes. One gap: the agent needs a
   sanctioned text-read tool so it never OCRs from screenshots.

## Patches

| # | Patch | Basis | Effort | Priority |
|---|-------|-------|--------|----------|
| 1 | Synthetic degradation + overlap in the generator | SESYD '13, Bickel '24, Rezvanifar '20 | ~1 day | high |
| 2 | Dynamic Fill gap-closing + topology validation | Adams & Bischof '94, Ahmed '12, DeepFloorplan '19 | 1–2 days | high |
| 3 | OCR engine: PaddleOCR-class pipeline behind the same `OcrWord[]` port | PP-OCR '20, Ying '26, TrOCR '23 | 2–3 days | high |
| 4 | MCP: `read_text` tool + numeric-provenance rules in tool docs | DrawingVQA '26, Picard '23 | hours | medium |
| 5 | Scan tier 3: class-agnostic embedding matcher | DE-ViT '24, DINOv2, LOCA '23, FamNet '21 | 3–5 days | medium |
| 6 | Training scale-up: ArchCAD-400K mix + text-fusion awareness | ArchCAD-400K '25, Liu '25 | later | low |

### Patch 1 — Synthetic dataset: degradation + symbol-on-line overlap

**Files:** `scripts/generate-synthetic-dataset.mjs`,
`training/kaggle-train-yolox.ipynb` (retrain).

- Add post-render degradation passes, each togglable and seeded: Gaussian
  blur + resample (simulate 200/300 dpi scans), speckle/salt-pepper noise,
  contrast/gamma jitter, ±0.5° rotation + skew, JPEG re-encode artifacts,
  photocopy shadow along one edge. These are SESYD's degradation axes;
  Bickel 2024's finding is that degradation and clutter are the axes that
  dominate sim-to-real transfer.
- Stop rejection-sampling every symbol clear of walls: allow a configurable
  fraction (start 20–30%) to touch/cross line work. "Symbols touching
  lines" is the declared blind spot of tier-1 and the motivation for the
  whole detector tier — the training data currently never shows it.
- Emit a mixed dataset: ~50% crisp, ~50% degraded (one degradation recipe
  per sheet, not stacked, so the detector sees each artifact in isolation).
- Keep `--debug` overlay verification; add one degraded sample to visual
  checks.
- Re-run the Kaggle notebook; watch val mAP on a held-out degraded split.

### Patch 2 — Dynamic Fill: close small gaps, validate the polygon

**Files:** `src/engine/dynamicfill.ts` (+ a case in whatever drives it in
`src/app/`, sample drawings for manual QA).

Tier A, pure geometry, ships without any model:

1. Extract the ink mask once (the existing luminance threshold,
   `tolerance = 150`).
2. Before flooding, dilate the ink mask by k px (gap-bridging). Flood
   against the dilated mask, but trace the boundary of the filled region —
   then snap the traced polygon back onto the original undilated ink where
   it is within a few px, so reported areas don't inflate by the dilation.
3. Adaptive k: start at 0; if the fill hits `MAX_FILL_FRACTION` (leak),
   retry with k = 2, 4, 8 px. This is a small search, not a model — the
   classic morphological-close trick, which is also what the commercial
   state of practice does (Kreo describes closing openings by replacing
   doors/windows with solid lines).
4. Topology validation (Ahmed 2012): after the trace, sanity-check the
   polygon — closed loop, area within plausible bounds, no wild aspect
   spikes from a leaked tendril. On failure return the existing
   "not bounded" error rather than a wrong area.

Tier B (later, separate decision): a tiny door/opening detector trained on
CubiCasa5k/FloorPlanCAD gating the fill — DeepFloorplan's
doors-as-boundary-class finding. Licence note: both datasets are
CC BY-NC / BY-NC-SA → research checkpoint only; a shipped gate would need
to train on our synthetic generator's door symbols (it already draws door
gaps) — which is licence-clean.

### Patch 3 — OCR: swap the engine, keep the interface

**Files:** `src/app/ocr.ts` (adapter), no changes needed in
`src/engine/ocr.ts` (heuristics stay — they consume `OcrWord[]`).

Current state: tesseract.js WASM, ~4 MB lang pack, full-page recognition,
no rotation handling (a known weak point — dimension text is aligned to the
line, often vertical).

1. Add a PaddleOCR-style pipeline as the primary engine, lazily loaded like
   the ONNX detector: DBNet-class detection (mobile, ~5 MB) + recognition
   (~5–10 MB), ONNX Runtime Web (already a lazy dependency for scan-onnx).
   Tesseract stays as automatic fallback — same pattern as scan tier-1/2.
2. **Rotate crops deterministically**: `nearestDimensionValue` already
   knows the clicked segment's angle; render the corridor along the segment
   rotated to horizontal, so the recognizer never sees rotated text. This
   alone (no model change) should fix most vertical-dimension misreads.
   Title-block scale reads: crop the four corners at high DPI before
   falling back to full-page.
3. Pre-filter crops with Fletcher–Kasturi-style connected-component
   filtering (drop long thin components = line work) before recognition —
   kills digit-vs-tick-mark confusion cheaply.
4. Recognizer choice: PaddleOCR rec head first (Apache-2.0, purpose-built);
   TrOCR-small quantized as an alternative if digits accuracy lags. All
   Apache-2.0-clean, consistent with `training/README.md` policy.
5. Acceptance: on `sample-floor-plan.pdf`, "12.00"-style values and
   "1:100"/"1:50" title-block scales read correctly at both orientations.

### Patch 4 — MCP: give the agent a sanctioned read path

**Files:** `src/headless/mcp.ts`, `specs/headless-engine.md`.

- Add an `ocr_page`/`read_text` MCP tool wrapping the existing
  `ocrPage`/engine heuristics — positioned near the click or region, in
  PDF-point space. Rationale: DrawingVQA/Picard show agents that read
  numbers off rendered PNGs get them wrong; a tool that returns
  `OcrWord[]` with coordinates keeps numbers tool-sourced.
- Tighten tool descriptions: `measure`, `scan_symbol`, `export` docs state
  that every numeric value in the final answer must come from a tool
  result, never from the model's reading of `render_page` images.
  Cheap, and it is the design rule the benchmarks converge on.

### Patch 5 — Scan tier 3: click-any-symbol embedding matcher

**Files:** new `src/engine/scan-embed.ts` behind the existing
`ScanResult` interface (`src/engine/scan.ts` picks the tier), new lazy
loader beside `src/app/onnx-detector.ts`, model manifest in
`public/models/`.

Goal: today tier-2 only knows the trained 5 classes; tier-1 shape matching
fails on clutter. A class-agnostic matcher makes *any* clicked symbol
countable — the biggest functional gap the literature says is closable
without per-class retraining.

1. Ship a quantized DINOv2-S (or distilled smaller) encoder, ~25–40 MB,
   Apache-2.0, lazy-loaded only when Scan runs and no detector class
   matches the click.
2. Compute the patch-feature grid for the page once, cache per page (same
   lifecycle as raster caches). Click → crop → average its patch tokens →
   cosine-match over the grid → threshold + NMS → hits. SiamFC's
   correlation logic at DE-ViT's feature quality; re-query on every click
   is near-free.
3. Tier order becomes: ONNX detector (if model present and click matches a
   trained class) → embedding matcher → CV shape pass. Same UX, no
   configuration.
4. Iterate later: LOCA-style prototype refinement when the clicked
   exemplar differs from siblings (rotation/size); legend parsing
   (Hain 2025, Sarkar 2022) to propose prototypes before any click.
5. Guardrails: size budget documented in `public/models/` README; WASM
   timing measured on a 300-dpi A3 raster before shipping; degraded-sheet
   behaviour spot-checked against Patch-1 artifacts.

### Patch 6 — Training scale-up (when P1–P5 land)

- Mix ArchCAD-400K chunks (license check first — dataset card on HF;
  research use may require a shipped-weights split like FloorPlanCAD) into
  the Kaggle pipeline; its data engine validates auto-annotation at 26×
  FloorPlanCAD scale.
- Keep the YOLOX-nano + synthetic core; add the text-fusion idea (Liu 2025)
  only if lookalike confusion (gpo vs switch) shows up in val — our
  manifest already round-trips the PDF text layer, so a text-proximity
  feature is cheap at the matching stage before it is cheap at training
  time.

## Non-goals (evidence-backed)

- **Do not** replace the deterministic measure/OCR core with a VLM — three
  2026 benchmarks show frontier VLMs misreport drawing dimensions and
  violate spatial constraints (FloorplanQA, DrawingVQA, ArchPlanVQA).
- **Do not** ship weights trained on FloorPlanCAD/CubiCasa5k — CC BY-NC;
  production models stay synthetic + client-consented (existing policy).
- **No** Ultralytics YOLO (AGPL) — existing policy, unchanged.
- Revision compare: no patch proposed; the literature is thin (Cao 2005,
  Monnier Weil 2024) and our overlay approach matches the commercial state
  of practice. Revisit only if graph-matched entity diff becomes a user
  request.
