# Room partition: design and adversarial review

2026-10-19. Response to [frontier-model-prompt-3.md](frontier-model-prompt-3.md).
Original review scope: algorithm design, source review, synthetic falsification, and reference-score verification.

> **Implementation update:** this review was performed against the older benchmark branch named below. Current `main` has since replaced its generic closing primitive with per-pixel wall-end thresholds, guarded bounded-fill cuts, sheet/scale doorway widths, swing-arc handling, and vector doorway bridges. This patch carries forward the review's still-missing P0 invariant: a trace must close explicitly and its emitted polygon must be a finite simple ring, with a fixed validation budget. The earlier assisted verification remains historical evidence for the reviewed commit; the current engine has not been retuned or rerun against benchmark ground truth as part of this fix.

> **Implementation (2026-10-24):** the partition pass is in [`src/engine/partition.ts`](../../src/engine/partition.ts), wired into Dynamic Fill (`dynamicFill` keeps the click contract and returns the child holding the seed; `dynamicFillRooms` returns every child; [`src/engine/auto-rooms.ts`](../../src/engine/auto-rooms.ts) does seed selection with atomic parent replacement). Deviations, each forced by the current code: portals are discovered **cue-first** — from each swing arc the fill already finds, a local scan for the wall band and both jambs — because `closingThresholds` rightly rejects a jamb whose door leaf touches it as a wall end; its two-wall-end gaps remain the evidence for `unresolved`. Main's swing chords already turn most door cues into virtual walls upstream, so inside Dynamic Fill the pass fires only where a chord fails (a chord stopped short, a punctured wall); its main value is as a strict, evidence-checked split for regions that still span a doorway. Distance-transform necks are not computed. Two cue-extractor defects found by the proxies are fixed in `swingArcs` (a thin wall punctured by the arc grow step, double-door arcs joined into one piece). The section 3 matrix runs in CI ([`scripts/check-partition.mjs`](../../scripts/check-partition.mjs)); kill criteria, the frozen synthetic holdout and the single external verification are in [the run log](../../evals/runs/2026-10-24-room-partition/RESULT.md).

**Decision: repair closing and polygon validity first; then implement wall-supported doorway strips followed by connected-component relabelling. Use distance-transform necks to locate or rank candidates, never as sufficient evidence to split.** Preserve the original ink and fill mask: a traced exterior polygon alone is insufficient input.

Evidence labels: **[verified]** means inspected in the current source or reproduced by the accompanying probes; **[prompt]** means supplied in the task; **[assumed]** marks an unverified engine/input property. Algorithm choices and acceptance targets below are proposals, not measured performance claims.

## 1. Correct the failure model before implementing a partitioner

The engine reviewed is commit `409e16882821ab72a60ef8d45f30d62ffb684ae0`, with `dynamicfill.ts` SHA-256 `9541f40b3c271570b215f5b3d220d3f254f1ce127405dfaf7b0e48d27f8bc0a9`. This matches the B6d freeze. Evidence is in [the review run directory](../../evals/runs/2026-10-19-room-partition-review/RESULT.md).

### Blocking findings at review time

1. **Horizontal closing is incorrectly indexed [verified].** In `closeLine`, horizontal scans use `start + k * step`, where `start` is the row number and `step=1`. The row base must be `start * w`. The defect affects run filtering and both passes of dilation and erosion. A 160×120 synthetic mask with two 40-pixel horizontal runs and a 20-pixel gap produces no horizontal closure; transposing the same mask produces the expected 100-pixel vertical run. Fix the line base in every scan, not just the gate. Add transpose and translation invariance tests. Current synthetic checks primarily exercise a gap in a vertical wall, so their passing does not establish orientation correctness.

2. **Invalid polygons materially change the instance count [verified].** The frozen auto predictions contain 28 rings, of which **12 are invalid**. The official scorer's `buffer(0)` repair yields **43 polygon components**, then its union pass yields **39 instances**. This explains `9 TP + 30 FP = 39`, despite 28 submitted rings. It does not identify which repaired component is a false positive, and does not prove that every false positive is an overmerged room. No benchmark GT was loaded for this geometry audit.

3. **The existing local ring check is also incomplete [verified].** `ringValid` rejects adjacent repeated vertices and proper crossings, but accepts a synthetic ring consisting of two squares meeting at a non-adjacent repeated vertex. Production `traceRegion` does not call that check anyway: its acceptance band is only `0.35 × filledPixels ≤ polygonArea ≤ 5 × filledPixels`. Trace termination on a guard or repeated state can fall through to this area check. Area agreement alone does not establish a valid room boundary.

4. **Successful early fills can already merge rooms [verified].** A synthetic pair of rooms connected through a 30-pixel opening returns a polygon spanning both rooms at `r=0`, because their combined area fits below the page-fraction cap. A merged region need not come from an opening wider than the largest rung. The partition stage must inspect successful bounded regions, including first-rung successes.

5. **Radius is half the eligible gap length [verified].** An aligned 200-pixel gap with sufficiently long flanks closes at `r=112`. Thus a reported 145–256-pixel band is not uniformly beyond a 112-radius ladder. The gate diagnostic reports a count of rasterised truth-edge samples, not necessarily a straight, collinear empty gap between two eligible ink runs. Re-measure actual portal geometry in inference; do not use those diagnostic numbers as tuning targets.

6. **False negatives are unmatched GT instances [verified from scorer].** A seed in excluded circulation space is not itself an FN. It may waste a seed or produce an FP. The prompt appears to transfer causes from the assisted run's nine failed seeds to the unassisted run's 13 unmatched instances; that attribution has not been established. Recovering small rooms may help, but the full FN budget is not yet explained.

7. **Current proposal deduplication can discard the right answer [verified from adapter].** Intersection-over-min is 1 when a correct child room is contained in an earlier merged parent. The adapter keeps the first polygon at overlap ≥0.6. Partitioning after that suppression cannot recover every lost candidate; accepting children must replace their parent atomically. Do not retain the parent alongside children, since the scorer can union them back together.

### Information limits

Two floor plans can share the same outer region polygon while one contains a gapped partition and the other contains no partition. A polygon-only function cannot distinguish them. Its input must include original ink or vector evidence.

Even identical visible geometry can represent one open-plan space with a cased opening or two named rooms. **No deterministic geometric rule can guarantee both perfect room splitting and zero open-plan splits on these indistinguishable inputs.** Adopt an explicit abstention result. For the first automatic implementation, require recognisable doorway evidence in addition to wall support; leave ambiguous cased openings unresolved. This bounds the achievable recall and must be reported, not hidden behind a confidence score.

## 2. Ranked partition design

| Rank | Design | Decision |
| --- | --- | --- |
| 1 | Original-wall evidence → doorway candidates → finite-width virtual wall strips → component relabelling | Implement after the blocking geometry fixes. This combines (d), the useful unbridged part of (b), and a bounded version of (c). |
| 2 | Distance-transform necks with wall/door validation | Optional candidate-ranking aid. Useful for passages; furniture, corridors and alcoves also create necks, so it cannot authorise a split. |
| 3 | Replay successful closing sites | Keep as provenance and a fast path. Already-effective bridges do not explain unbridged passages; record rejected candidates and their reasons too. |
| 4 | Re-fill every candidate subset / persistence-only watershed | Reject for the hackathon. Subset search becomes exponential; shape stability does not distinguish a stable alcove from a room. |

### Input and output contract

Proposed engine function, independent of DOM and benchmark data:

```ts
partitionRegion({
  originalInk,       // immutable, at the chosen threshold
  freeMask,          // actual filled pixels, not a rerasterised invalid polygon
  closureMask,      // synthetic pixels kept separate from original ink
  bounds,           // ROI and its offset in the page raster
  rasterFrame,      // exact transform, resolution, optional calibration
  wallEvidence,     // optional precomputed page-level segment index
  limits,           // fixed work/memory limits; exceeding them => unresolved
}): {
  status: 'unchanged' | 'partitioned' | 'unresolved';
  children: Region[];
  portals: PortalEvidence[];
  reasons: string[];
}
```

`dynamicFill` currently returns only `{points}` or `{error}` [verified]. Add an internal mask/evidence path while preserving that public click contract. The click tool selects the accepted child containing its original seed; an automatic extraction caller receives all children. No user seed, room label from GT, or human barrier enters the unassisted path.

### Step A — collect wall-supported portals

For the initial implementation, support horizontal and vertical wall bands. On other orientations, return unresolved rather than rotating the raster approximately and silently changing measurements. Add a segment-frame implementation only after its own rotated synthetic suite passes.

1. Scan **original** ink into row/column runs. Group adjacent, overlapping runs into wall-band candidates; recognise paired parallel faces where the drawing uses outline walls. Retain holes, hatch and line discontinuities as evidence flags. Never let a virtual closure manufacture support for another closure.
2. Search facing endpoints within each orientation bucket. A candidate must lie along one continued wall band, with compatible wall faces and thickness on both sides. The proposed barrier connects the facing jambs along the missing wall, not a nearby pair of parallel corridor sidewalls.
3. Measure gap length `g`, available collinear support `Lleft/Lright`, local wall-band thickness `b`, normal alignment residual, and whether endpoints connect back into the enclosing wall network. A long isolated furniture edge is insufficient. Explicitly distinguish drawn stroke thickness from architectural wall-band thickness.
4. For automatic acceptance, also require an independently observed door cue. The first implementable cue is a leaf segment rooted at a jamb plus a geometrically consistent swing arc on either side of the wall: fitted arc centre at that jamb, radius compatible with the leaf/gap, endpoints consistent with the leaf, and fit residual within the raster uncertainty. Support both swing directions. Double doors use two compatible leaves/arcs. A circle or arc without the wall/jamb relationship is insufficient. Bound primitive fitting by a fixed candidate budget and deterministic enumeration; use no random RANSAC.
5. A sliding-door convention, a window band, or a cased opening without an unambiguous door cue is **unresolved** in v1. Text labels can help propose regions later, but two labels do not prove two rooms. Do not lower the acceptance gate just to hit a benchmark milestone.

Provisional geometric tolerances must come from synthetic geometry: derive positional error from sampling (approximately one pixel per endpoint, with larger measured uncertainty after degradation), then sweep thickness, phase, contrast and resolution. Any additional relative tolerance is a frozen configuration parameter selected on the synthetic development split. The design does not claim a universal percentage threshold that works across producers.

### Step B — optional distance-transform support

Compute a distance field inside the ROI only if candidate ranking needs it. A two-pass integer chamfer field is adequate for ranking; it is not an exact Euclidean measurement. For portal `e`, compare the throat clearance with the maximum clearance reachable on each side without crossing `e`. Record a neck-strength ratio and whether the candidate persists under ±1-pixel boundary perturbations.

Do not split at every distance maximum, impose a global width cutoff, or reject a small bathroom solely because it lacks a large inscribed disk. Door evidence authorises the hypothesis; distance geometry only prioritises it or records instability. Keeping this optional avoids putting a full watershed on the critical path.

### Step C — cut supported portals together, then relabel

Construct each portal as a **finite-width strip spanning the inferred wall band between its two faces**. Restore the missing wall volume locally; leave observed wall faces untouched. Preserve the gap geometry in provenance. A zero-width line is inadequate for export because children sharing a boundary are unioned by the scorer.

Accept all independently supported, compatible portal candidates in the connected ROI together. Then label the remaining free mask once. This handles two rooms connected by two doors: cutting either door alone does not disconnect them. Reject crossing/conflicting portal hypotheses as a group; do not search all subsets.

Remove redundant candidate strips whose two sides remain in the same component. Require a candidate endpoint to land in supported wall material and every accepted child to have a closed supported perimeter. A tiny fragment cannot simply disappear: restore the offending candidate group, relabel, and return unresolved if the result remains ambiguous. Cap validation at three labelling passes; no unbounded recursive retries.

```text
partition(input):
    evidence = extractOriginalWallBands(input.originalInk, input.bounds)
    if evidence exceeds fixed work limits: return unresolved("complex evidence")
    candidates = enumerateFacingJambs(evidence)
    secure = []
    for c in stableSort(candidates, by orientation then coordinates):
        if !sameContinuedWallBand(c): continue
        if !supportedJambsAndWallNetwork(c): continue
        if !independentDoorGeometry(c): recordUnresolved(c); continue
        strip = wallBandAcrossGap(c)
        if !stripWithinSupportedEndpointUncertainty(strip): continue
        secure.push(strip)
    if secure is empty: return unchangedOrUnresolved(input)

    rejectConflictingGroups(secure)
    labels = connectedComponents(input.freeMask minus secure)
    removeStripsWhoseSidesHaveSameLabel(secure, labels)
    labels = connectedComponents(input.freeMask minus secure)  // if needed
    if unsupportedFragmentsOrTopology(labels):
        rollbackOffendingGroups()
        labels = connectedComponents(input.freeMask minus remainingSecure)
        if stillAmbiguous(labels): return unresolved("partition rejected")

    children = tracePixelCellEdges(labels)
    if !validSimpleBoundaries(children): return unresolved("invalid topology")
    if !pixelAccountingExact(labels, children, strips, classifiedHoles):
        return unresolved("unexplained area change")
    return replaceParentWithChildren(children, secure)
```

`unchanged` means no supported split, not a claim that the region is one semantic room. Expose unresolved candidates separately from automatically exported room instances.

### Step D — valid geometry and stable proposal selection

Trace oriented **pixel-cell edges** at half-integer coordinates, not a walk through boundary-pixel centres. An edge exists where a labelled cell meets another label or background. Walk each directed edge once with a fixed four-connected face rule. Reject nonclosed walks; identify exterior and hole loops. Ambiguous point contacts must be represented correctly or marked unresolved; do not turn them into rooms with `buffer(0)`.

First remove collinear vertices, which preserves the raster polygon exactly. Optional further simplification must preserve topology, portal endpoints and wall faces, and pass a rasterised symmetric-difference check. Validate non-adjacent touches, collinear overlaps, repeated vertices and proper crossings. For large contours use a spatial edge index; cap work rather than performing quadratic checks on millions of vertices. If simplification fails, retain the valid unsimplified boundary. If the unsimplified topology is unrepresentable, abstain.

Keep mask area, exterior area and hole area as distinct quantities. Furniture is not automatically a floor-area subtraction; structural voids may be. The current one-ring markup type cannot express net area with holes [verified]. For this pass, output a documented gross enclosure plus internal-loop evidence where appropriate; do not claim a correct net area for unresolved columns/shafts. Interior holes must never become extra room predictions merely to satisfy the output schema.

Within a fixed threshold/rung, use component identity to avoid processing the same region for every grid seed. Across rungs, geometry is not monotone: do not blindly inherit component IDs. When a validated partition replaces a parent, remove all parent proposals before deduplication. Prefer a single compatible partition of the page over a collection of overlapping hypotheses. Ambiguous competing partitions remain unresolved; do not union them or keep whichever seed happened to run first.

## 3. Edge-case matrix and synthetic specification

Add a new parameterised proxy generator beside `evals/make-room-sheet.mjs`; preserve the existing six-room baseline. Generate geometry in PDF points with analytic room faces and explicit semantic labels. Use both direct binary-mask tests and PDF renders through the production adapters. No benchmark crops, dimensions or layouts become fixtures.

Common proposed gates: exact expected instance count; all rings valid; each room IoU ≥0.98 on clean cases; boundary error ≤2 raster pixels before PDF conversion; no unexplained lost pixels beyond the declared portal strips and classified holes. Degraded cases use a separately frozen tolerance and allow abstention. Any returned wrong split fails, even when abstention would have passed. Transpose, translate, change page padding, reverse seed order, and render at 1.5/3/6 px per point.

| Case / proxy ID | Expected behaviour | Discriminating cue and assertion |
| --- | --- | --- |
| Two rooms, one swing door / `two-door-h/v` | Split into two | Continued wall faces, facing jambs and consistent leaf/arc; two valid children, correct wall-face strip and conserved area. |
| Two rooms, two separate doors / `two-door-cycle` | Split into two | Both door sites supported independently; simultaneous cuts succeed even though either cut alone leaves connectivity. |
| Three rooms in a loop / `three-room-cycle` | Three | All independently supported portals cut; deterministic result regardless of candidate order. |
| Wide double door / `double-door-width-sweep` | Two when resolved | Two hinge/leaf/arc relationships in one wall band; sweep gap sizes across rung boundaries and require scale-consistent topology. |
| Diagonal doorway / `rotated-door-30-45` | Unresolved in v1 | Axis-only support is insufficient; never emit a staircase-based speculative split. Later segment-frame version must produce two. |
| L-shaped room / `l-room-elbow` | One | A bend is not facing endpoints of one interrupted wall; a neck or multiple distance peaks must not trigger a split. |
| Shallow/deep alcove / `alcove-neck` | One | No independent doorway cue. Sweep alcove depth and width so shape persistence cannot become a hidden classifier. |
| Cased opening with ambiguous semantics / `cased-identical-pair` | Unresolved in both interpretations | Use byte-identical raster inputs with one-room versus two-room semantic annotations; require identical abstention. This falsifies any claimed perfect geometry-only rule. |
| Straight, bent, widening corridor / `corridor-width-step` | One | Parallel corridor sides do not form one interrupted wall across the path; no transverse portal strip. |
| Open-plan kitchen/living with opposing wall stubs / `open-plan-stubs` | One or unresolved, never auto-split | Jamb-like ends and a narrow throat alone are insufficient; retain one candidate enclosure without inventing a room boundary. |
| Island / `island-neck` | One | Two walkways around a closed interior object; no wall-anchored doorway cue, no children around distance maxima. |
| Interior columns / `column-grid` | One enclosure | Multiple holes and pinches do not imply rooms; preserve loop evidence, assert no room multiplication. Net-area policy tested separately. |
| Long cabinetry and furniture clumps / `cabinet-false-wall` | One | Furniture may satisfy run length; require wall-network and door support. Include long strokes plus an adversarial arc-shaped chair. |
| Small bathroom with fixtures / `fixture-dense-bath` | One recoverable enclosure or unresolved | Door-supported structural envelope; clutter removed only from topology model, never from source. No hard 21×21 seed-window requirement. |
| Pantry next to larger room / `short-flank-pantry` | Two if doorway evidence resolves; otherwise unresolved | Short wall support must not be deleted by a larger `minRun`; test a portal whose support lies between successive rungs. |
| Hatch/text/dashed shelving / `hatch-glyph-shelf` | One | Repeated strokes do not license virtual barriers; vary run lengths across each gate and place hatching against walls. |
| Window band on exterior wall / `window-exterior` | No room split; exterior excluded | Window lines are not internal door portals. If exterior cannot be excluded, return unresolved rather than a bounded outside pocket. |
| Two rooms joined by a gap with no symbol / `uncued-door` | Unresolved | Structural hypothesis recorded but no semantic proof; count this abstention in coverage, never silently claim success. |
| Door to circulation excluded from requested scope / `room-circulation` | Separate geometry; scope handled explicitly | Partitioning and target classification are different stages. A geometric corridor is not an FN; exporting an out-of-scope region can be an FP. |
| Thin slits, notches, point contacts / `trace-comb-pinch` | Valid topology or unresolved | No non-adjacent repeated vertices, trace truncation or scorer repair; compare cell-edge reconstruction with input mask. |
| Merged parent plus correct child proposals / `parent-child-order` | Same accepted partition in every order | Replace parent atomically; child must survive despite intersection-over-min=1. No overlapping parent remains. |
| One room occupying >40% of page / `large-room-padding` | Same room geometry after page padding changes | Existing fraction cap is not a topological boundedness proof. New partition validation uses supported boundaries; isolate any change to the upstream cap as its own patch. |

Reserve generator seeds/families before development. Use the hand-authored cases for debugging, then a frozen 200-sheet synthetic holdout with positives and hard negatives. Vary door conventions, wall representation, stroke weight, furniture density, scale and degradation independently. Keep a separate unsupported-convention slice; excluding it from headline recall would hide the conservative policy's cost.

## 4. Cost model and integration

Let `N` be ROI pixels, `P` traced boundary edges, `E` wall endpoints and `K` candidate portals. With indexed endpoint buckets and fixed work caps:

- Ink/run extraction and grouping: O(N), cached by page/threshold.
- Portal enumeration: O(E log E + K), plus bounded fitting samples per candidate. Dense unmatched endpoint cases hit an explicit budget and abstain.
- Optional distance field: O(N).
- At most three component labellings: O(N).
- Cell-edge tracing: O(N + P); validation with spatial indexing is output-sensitive. A pathological candidate/edge count must not expand into unbounded O(E²) or O(P²) work.

Budget about **16–24 bytes per ROI pixel**, plus roughly 8–16 bytes per boundary edge and segment-index storage. A one-megapixel ROI is approximately 16–24 MB of typed arrays before edge storage and the already-resident page raster. Reuse scratch arrays and process ROIs serially. Never cache all 18 full-page masks simultaneously. A browser implementation needs a hard allocation limit and an unresolved result when it cannot stay within it.

**Proposed planning envelope, not a measurement:** 25–100 ms for a warm 0.25–1 MP region with modest geometry and typed-array loops; dense fitting or validation may exceed it. Require measured p95 ≤100 ms for 1 MP on the declared reference machine before claiming parity with the reported ~58 ms fill. Measure a slower browser/device separately; Node timing is not browser timing. If this fails, remove the optional distance pass, tighten work budgets, or reduce automatic scope rather than guessing a speedup.

Place the pass after a bounded mask is found and before final trace/export, not inside every failed threshold/radius attempt. Cache candidates per page/threshold and processed component within each rung. If no secure portals exist, skip relabelling and return early.

The existing 442-seed auto run took **3296 seconds [verified in run log]**, about 7.46 seconds per seed on average. The 58 ms successful-room microbenchmark does not describe that workload. Independently of partitioning, reuse threshold masks/closures and label components once per mask, then query seeds; preserve seed semantics while avoiding hundreds of identical floods. This is a separate performance patch, not an assumed property of the current engine.

## 5. Fixture-dense rooms and safe widening

### Fixture-dense FN strategy

Start with seed coverage before destructive ink removal. In automatic mode, label every free component at a fixed boundary mask and choose its distance maximum as a representative seed; a one-pixel free location is sufficient to attempt a fill. A large inscribed rectangle/disk is a quality diagnostic, not a requirement for a real room. Deterministically break distance ties by raster index.

For a structurally supported enclosure whose free space is fragmented by fixtures, construct a second **structural boundary mask** from verified walls and accepted door strips. Flood this mask, then validate the enclosure against the original ink. Retain all original pixels for audit. Suppress isolated interior object boundaries only in this auxiliary mask; wall-attached fixtures, narrow shafts and short partition walls remain ambiguous unless their roles are resolved by independent evidence.

This must be local and enclosed: removing fixtures globally can erase exterior boundaries or merge a pantry into its neighbour. Existing run-length gating only controls synthetic bridge participation; `dynamicFill` ORs the original ink back into the final boundary [verified], so it is not a fixture-removal mechanism. Increasing or decreasing the gate does not by itself solve clutter.

If no wall-supported enclosure survives, return unresolved. Do not manufacture a room from its largest rectangle or its printed area. In the synthetic bath case require the gross room envelope to survive fixture placements without becoming several fixture-sized predictions; separately test the declared column/void policy.

### Derivation of the widening limit

For an axis-aligned, same-row/column candidate with an empty gap of `g` pixels and uninterrupted original flanks `L1,L2`, corrected gated closing is eligible when:

```text
g ≤ 2r
min(L1, L2) ≥ max(24, r)

therefore, for integer r:
ceil(g / 2) ≤ r ≤ min(L1, L2), with min(L1,L2) ≥ 24.
```

This is a **necessary geometric eligibility interval for that simple run pair**, not a semantic safety proof for an entire sheet. Misalignment, orientation, page borders and fragmented strokes can prevent the intended closure.

- A true 145-pixel gap needs `r≥73` and support ≥73; `r=80` can already close it.
- A true 224-pixel gap can close at `r=112` with support ≥112.
- A true 256-pixel gap needs `r≥128` with support ≥128. A 144 rung adds no necessary width coverage for that ideal case.
- With a 200-pixel gap and 140-pixel flanks, `r=112` and `128` close it but `144` does not. **This nonmonotonicity was reproduced.** Larger `r` also raises the gate, removing the flanks from consideration.

For each unwanted run pair `j`, the dangerous radius interval is likewise:

```text
Ij = [ceil(gj/2), min(Lj1,Lj2)]  if the interval is nonempty and both runs ≥24.
```

A radius is geometrically safe relative to a *known complete set* of unwanted pairs only if it is outside the union of those intervals. A conservative ceiling before the first dangerous interval is `min_j ceil(gj/2) - 1`, but the current ink gate cannot identify all unwanted pairs. Cabinetry can have arbitrarily long runs; legitimate architecture can have short runs. **There is no universal safe 128/144 ceiling derivable from `minRun=max(24,r)`.** Raising it may both add unwanted bridges between long strokes and remove desired bridges at short walls.

Recommended policy: do not widen the global ladder as the partition fix. For an independently supported portal, insert only its measured strip. If reusing closing locally, choose the smallest eligible `r=ceil(g/2)` and require it to fall within the support interval; otherwise abstain or use the explicitly supported strip without pretending the run gate verified it. Convert all lengths to the actual inference raster before this calculation. Do not substitute manifest pixels or PDF points for fill pixels.

## 6. Kill criteria, delivery sequence and generalisation risks

### Cheapest falsification, before investing in a benchmark run

1. **Primitive gate, hours:** transpose and translate the two-run mask; include gaps exactly `2r` and `2r+1`, short-flank loss, and room fixtures with horizontal versus vertical doors. Failure blocks partition work. The current horizontal implementation already fails this gate.
2. **Information gate, hours:** the byte-identical cased-opening pair must force abstention. If the proposed confidence heuristic claims different semantic answers, the input contract is leaking labels or the design is unsound.
3. **Geometry gate, hours:** shared-edge children, finite-strip children, a self-touching two-lobe ring, and the comb/notch case. Require valid polygons and exact intended instance count after the official scorer's preprocessing on **synthetic geometry only**. No scorer repair may be necessary. The current local ring validator fails one of these probes.
4. **Value gate, one day after the primitives:** on 20 clean door-supported positive layouts, automatically recover at least 18 correct partitions; on at least 40 named non-split variants, zero incorrect splits. Abstention counts as a miss on positive layouts. Failure means stop expanding this rule system and revisit the cue extractor, not relax the no-split requirement.
5. **Holdout gate:** on the frozen synthetic holdout, target ≥99% precision of emitted split decisions and ≥80% recall on declared supported door conventions; report every unsupported convention separately. Any canonical hard-negative split blocks release. These finite tests do not prove zero real-world false splits.
6. **Runtime gate:** measure stage timings, peak allocations and work-budget abstentions against the cost model. Runtime limits must produce the same geometry decisions on every run: fixed work counts, not wall-clock deadlines that change output by device speed.

Implementation order for a few-day effort:

| Step | Deliverable | Exit condition |
| --- | --- | --- |
| P0, first | Correct horizontal indexing; explicit trace-success state; valid cell-edge boundaries and robust validity tests | All primitive/geometry probes pass; existing analytic room regressions remain within their gates. |
| P1 | Mask/evidence contract and component cache; parent-replacement logic | Same masks give deterministic candidates; seed order does not alter the accepted partition. |
| P2 | Axis-aligned wall/jamb + swing-door cue extractor; local strips and bounded relabelling | Value gate passes, including multi-door cycles and all non-split cases. |
| P3 | Fixture-dense local structural-mask fallback and held-out validation | No erosion of short-wall rooms, no undocumented hole/area policy, measured runtime acceptable. |
| P4, last | Freeze engine, configuration, predictions and hashes; one external verification run | Publish all metrics and caveats; no post-score threshold adjustment on that sheet. |

P0 is itself a meaningful algorithm change. Its benchmark effect is unknown; do not assert it will recover a particular number of rooms. Save synthetic results by stage, then run the external verification once for the final frozen candidate. The benchmark has already informed qualitative diagnosis, so describe this honestly as **synthetic-tuned verification on a previously diagnosed sheet**, not a pristine blind test. Future untouched sheets provide stronger generalisation evidence.

### Ranked generalisation risks

1. **Semantic ambiguity and drawing conventions.** Cased openings, doorless spaces and room-scope choices cannot always be inferred from pixels. Abstention is essential; this is the largest recall limitation.
2. **Wall versus furniture representation.** Single strokes, double lines, hatch, long cabinetry and attached fixtures can defeat wall classification. Original-ink provenance and hard-negative proxy families are required.
3. **Resolution, orientation and line weight.** Pixel gates and 1.5-pixel simplification are not scale invariant. Use exact frame transforms, resolution-aware uncertainty, and explicit unsupported-angle handling.
4. **Topology and export.** Touching children, self-crossing simplification and hole policies can change scores without changing the intended room model. Validate before and after coordinate conversion/rounding; preserve finite strips from geometry, never an arbitrary scorer-sized moat.
5. **Dense pages and repeated work.** A3 microbenchmarks understate A0 and many-seed cost. Use ROI limits, caches and fixed-work abstention; publish browser timings separately.
6. **Threshold sensitivity, antialiasing and degradation.** A tiny intensity change may disconnect a wall or join furniture. Independent stability checks can downgrade to unresolved; never silently pick whichever threshold creates the desired room count.

## 7. Verified scoring and reference comparisons

Official scorer inspected at benchmark commit `b855483786285ee31120c2e5e03f985810bf7b08`, SHA-256 `e338b71e3de5f781067fb9f3532aa421557ffa480f804f39a29dec9796aac767`.

- Invalid prediction polygons are repaired with `buffer(0)` before matching. Touching/overlapping polygons are unioned; resulting multipolygons are decomposed into components.
- `merge_touching` groups candidates using a proximity buffer of `0.0015 × min(pageWidth,pageHeight)`, but unions their **original** geometries. Thus a genuine positive gap remains a gap even when smaller than that grouping tolerance. Synthetic probes confirm shared-edge children become one instance while a one-pixel strip leaves two. Do not carve a tolerance-sized moat to manipulate scoring.
- Area matching is greedy, highest analytic IoU first, one-to-one, with **strict `IoU > 0.50`**, not `≥0.50`. Unmatched predicted components are FPs; unmatched GT components are FNs. `F1 = 2TP / (Npred + Ngt)`.
- Pixel scoring unions coverage and fills exterior rings; it does not deduct interior holes. A high pixel score cannot certify room topology or net floor-area accuracy.

These are source-verified rules, not inferred from the README shorthand. See the [pinned official scorer](https://github.com/KamaiEnterprises/aec-geometric-bench/blob/b855483786285ee31120c2e5e03f985810bf7b08/scoring/score.py).

| System / sheet_02 | TP / FP / FN | Instance F1 | Pixel F1 | Verification |
| --- | --- | --- | --- | --- |
| pdf2takeoff frozen unassisted B6d | 9 / 30 / 13 | 0.295082 | 0.882411 | Existing frozen report; not rerun or tuned in this review. |
| OpenTakeoff published first-pass predictions | 14 / 6 / 8 | **0.666667** | **0.887290** | Recomputed with the same local official scorer. |
| Kamai example predictions | 17 / 2 / 5 | **0.829268** | **0.985150** | Recomputed with that scorer; published per-sheet JSON lists instance 0.8293 and pixel 0.9855. |

OpenTakeoff's [published protocol](https://github.com/Kentucky-ai/opentakeoff/blob/f18595c4c39451fab8f47d06a61bc9b7c515f1db/evals/aec-geometric-bench/README.md) uses Claude reading room labels and choosing one-click seeds through MCP. It is an **LLM-orchestrated/tool-assisted run**, not the same input/compute protocol as a deterministic grid sweep. Its numeric result is reproducible on the same sheet and scorer today; the historical README does not pin its scorer revision, so exact historical-version identity is not established.

The owner's [per-sheet results](https://github.com/KamaiEnterprises/aec-geometric-bench/blob/b855483786285ee31120c2e5e03f985810bf7b08/dataset/per_sheet_scores.json) confirm the approximate 0.83 claim. The full-corpus area-instance reference is **0.924**, and the released-subset published figure is **0.941** (analytic reproduction approximately 0.940); **0.93 is not the exact area-instance target**. [Official benchmark results](https://github.com/KamaiEnterprises/aec-geometric-bench/tree/b855483786285ee31120c2e5e03f985810bf7b08)

For 22 GT instances, reducing all current FPs while retaining only 9 TPs would reach `18/31 = 0.581`. To beat 2/3 requires at least 12 TPs with zero FPs; at 22 predictions it requires at least 15 TPs. Polygon validity and suppression can matter substantially, but additional correct room matches are still necessary. No improvement is claimed until the final frozen run.
