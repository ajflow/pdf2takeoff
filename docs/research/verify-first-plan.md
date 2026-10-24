# Verify-first patch plan: disposition of the frontier-model feedback

> **Status 2026-10-24: none of V1 to V6 has been built.** Between
> 2026-10-19 and 2026-10-24, main shipped instead: the opt-in AI count
> (`ai-count` CLI), inventory items and counting presets, the npm package,
> the legend-guided takeoff experiment and real-PDF workspace, the
> polygon-validity fix and the site redesign. A room-partition pass from
> [room-partition-design-review.md](room-partition-design-review.md) is
> in progress. **Whether V1 and V2 still come first is an open
> maintainer decision**, posed to the second reviewer in
> [frontier-model-prompt-4.md](frontier-model-prompt-4.md).

> **Status 2026-10-19:** feedback received in response to the super prompt
> ([frontier-model-prompt.md](frontier-model-prompt.md)) and dispositioned
> here. The response **reframed rather than answered** — it proposed five
> verification/correction features instead of tackling the six posed
> problems. Verdict: **reframe accepted, with two binding corrections**
> (below); the derived patches are V1–V6. The declined problems
> (class-agnostic matcher, legend supervision, v2 tiled/quantized model,
> golden-set bootstrap) stay open — re-ask each in its own thread; the
> prompt file is structured to excerpt per problem. Companions:
> [patch-plan.md](patch-plan.md) (research line, unchanged),
> bench-patch-plan.md (bench line, unchanged; on the
> `bench/b1-b8-opening-patch` branch, not published on main),
> evaluation-strategy.md (metrics; same branch, not published on main).

## The reframe, and the two corrections that bind

The feedback's position: *don't make automation smarter, make verification
and correction nearly free.* This is consistent with our own evidence —
everywhere we measure, precision ≈ 1.0 and **coverage** is the failure
(fill: 0.99 P / 0.06 R on the external anchor; tier-1: 1.0 P / 0.25 R on
the hostile bench) — and with the north star in evaluation-strategy §1.
Accepted.

1. **Repair UX does not score on AEC-Geometric-Bench.** Milestone 2
   (auto-seeded) requires *unassisted* runs; human barriers are
   disallowed. Opening-detection research (patch-plan patch 2, tier B)
   therefore remains a parallel track — repair is the product track, the
   detector is the bench track. They meet at the data flywheel: **every
   human-drawn barrier is a labelled opening** — the licence-clean
   training set the opening detector needs. The feedback's implicit
   "research can wait" is rejected.
2. **Two foundations, not five features.** Feedback points 1 and 2 need
   one persistence mechanism (the measurement sidecar, V1); point 4
   reuses the compare / `run --prev` diff machinery that already exists.

## Disposition

| Feedback point | Verdict | Note |
| --- | --- | --- |
| 1. Inspectable explanations ("every number leads back to its evidence") | **Accept, modified** | Sidecar record, never PDF annotation comments — that channel stays minimal (`[mpp:…]` + label); comment bloat has already caused round-trip bugs (truncated labels, mm misread — git log). Evidence-in-exports/MCP is the cheap first half (V3). |
| 2. Seconds-to-repair (leak highlight + barriers; rejected lookalikes) | **Accept — highest leverage** | The pragmatic bridge over the b6c blocker; barriers double as opening labels (correction 1). Must ship *with* leak highlighting — bare "draw your own barrier" reads as manual work. |
| 3. Vector fingerprints for symbol search | **Accept as timeboxed spike** | Extends patch-plan patch 1a from walls to symbols. Born-digital PDFs only; producers flatten CAD blocks, so grouping is the experiment. Kill test adopted as proposed. |
| 4. Revision re-review queue | **Accept** | Built on existing compare regions + `run --prev`; bias to flagging — a false "unchanged" is the catastrophic direction. |
| 5. Product scorecard + kept-rate caveat | **Already planned** | evaluation-strategy §3.6 (confirm-rate as *upper bound*, pre-annotation bias) and build-order item 6. One genuine addition: "errors remaining after review" measures what the user didn't catch — expert re-review in pilots, not telemetry. |
| "One complete room workflow" demonstration | **Accept** | click → fill/repair → inspect boundary and scale → confirm → export with evidence; validated on held-out real drawings. |

## Patches

| # | Patch | Basis | Effort | Priority |
| --- | --- | --- | --- | --- |
| V1 | Measurement sidecar | feedback pt 1+2 | M | high (foundational) |
| V2 | Fill repair UX: leak throats + barriers | feedback pt 2, b6c, patch 2 tier B | M | high |
| V3 | Evidence in exports + MCP | feedback pt 1 | S | high |
| V4 | Revision re-review queue | feedback pt 4, `run --prev` | M–L | medium-high |
| V5 | Vector-fingerprint symbol spike | feedback pt 3, patch 1a extension | S–M, timeboxed | medium |
| V6 | L3 telemetry | evaluation-strategy §3.6 / BO 6 | S | medium |

### V1. Measurement sidecar — the foundation

*Files:* `src/app/persistence.ts`, `src/app/state.ts`, engine types,
MCP export path.

- Persistent per-markup record keyed by markup ID, stored beside the
  IndexedDB sessions (same file-hash lifecycle): extraction method
  (fill / scan tier / measure), calibration source and value, engine
  assumptions (gap ladder, ink threshold), review status — and, once V2
  lands, barriers.
- **Never in PDF annotation comments** (see disposition note on point 1);
  the PDF stays the portable interchange, the sidecar stays ours.
- Deterministic and diffable — the substrate for V2 retention, V3
  evidence, V4 invalidation and V6 telemetry. MCP clients need a read
  path (fold into `export` / a `measurement_record`-style result before
  any new tool).

### V2. Fill repair UX: leak-throat highlighting + temporary barriers

*Files:* `src/engine/dynamicfill.ts` (leak localization in the trace
result), `src/app/viewer.ts` + tools (barrier draw, retry), V1 sidecar
(retention).

- On an unbounded fill, localize the escape — the overflow tendril's
  narrow necks, via distance-transform / morphological analysis of the
  filled region against the ink mask — and highlight candidate throats.
- User drags a barrier: an ink segment applied to the mask **for that fill
  only**, never written to the PDF. Immediate retry, resulting boundary
  shown.
- Barriers persist per document in the sidecar; re-fills after a revision
  drop reuse them; Clear/open resets (same lifecycle as kept-rate).
- Each barrier is a labelled opening (position, width, orientation) →
  accumulates the licence-clean dataset for the opening detector
  (patch-plan patch 2 tier B). The repair UX is the flywheel, not just
  the workaround.
- Counting counterpart: negative exemplar ("rejected lookalike") in the
  tier-1 template match, with a live preview of how it changes the
  remaining proposals before applying.
- *Eval:* repair success rate; time-to-reviewed-room (L3); barrier reuse
  rate across revisions; CI regression in `scripts/check-fill.mjs`
  (deterministic: same barriers → same fill).

### V3. Evidence in exports + MCP

*Files:* `src/app/table.ts` (export columns), `src/headless/ops.ts`,
`src/headless/mcp.ts`.

- CSV/xlsx rows and MCP results carry source page, calibration (source +
  value), extraction method, review status per quantity line. Mostly
  wiring over V1; the cheapest trust win in this plan.

### V4. Revision re-review queue

*Files:* engine compare output + a new association pass;
`src/headless/ops.ts` (`run --prev` grows the queue); app UI.

- Calibration change → invalidate every scale-dependent quantity on that
  page (near-free).
- Change-region ∩ markup-geometry → per-markup flags with reasons
  ("review this room: its east boundary changed"); title-block-only
  changes flag nothing.
- Alignment or matching uncertainty → flag anyway; the false-unchanged
  rate is the number that must stay ≈ 0.
- MCP story: agent re-runs the takeoff, the human receives the queue.
- *Eval:* time on second takeoff vs first; false-unchanged ≈ 0; flag
  precision reviewed-but-unchanged tolerated as the cost of safety.

### V5. Vector-fingerprint symbol spike (timeboxed)

*Files:* app-layer operator-list adapter behind a port (engine stays
DOM-free — same pattern as `RasterPage`); prototype script under
`scripts/` or `evals/`.

- Extract local path groups from the PDF.js operator list, normalize
  position/scale/rotation, fingerprint the geometry, match repeats —
  zero download, exact, potentially ms-fast.
- Scope honesty: born-digital only; many plotting pipelines rasterize or
  flatten blocks, so grouping heuristics (proximity, graphics-state
  boundaries, bbox clustering) are the experiment.
- *Kill test (adopted from the feedback, run through the B1 run-log
  convention):* freeze the method; measure precision / recall / latency
  across consented drawings from several PDF producers; keep only if it
  adds detections beyond the current raster matcher.

### V6. L3 telemetry — already specced, implement it

*Files:* `src/app/state.ts` (status-change events → local session log), a
small report script.

- evaluation-strategy build-order item 6: confirm rate, edits per 100
  hits, kept-rate framed as *acceptance* signal (upper bound,
  pre-annotation bias) — never accuracy. "Errors remaining after review"
  stays a pilot artifact (expert re-review), out of telemetry.

## Sequencing

1. **V1 minimal core + V2** — the room workflow becomes survivable on
   messy sheets; opening labels start accumulating.
2. **V3** — evidence everywhere, near-free.
3. **V4** — the re-review queue.
4. **V5** spike in parallel (timeboxed); **V6** whenever pilots start.
5. **Checkpoint — the demonstration:** one complete room workflow (click →
   fill or repair → inspect boundary and scale → confirm → export with
   evidence) on held-out real drawings, published through the evals
   run-log convention with the standing caveat lines.

## Explicitly not adopted

- **Deprioritizing the posed research problems.** The class-agnostic
  matcher (patch 5), legend supervision, the v2 tiled/quantized model and
  the golden-set bootstrap remain open; re-ask each per-problem thread.
- **Any slowdown of the opening-detection research** — correction 1: the
  bench track has no human in the loop to repair it.
