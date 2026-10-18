# Patch plan 3: counting without asking the model to count

> **Status 2026-10-18:** issues documented, fixes specified, nothing in this
> plan shipped yet. Companion work shipped on the same branch
> (`claude/dynamic-fill-sheet-door-width`, commit 0a863b0): Dynamic Fill
> splits rooms joined by a door with no scale, labels or vector layer, the
> last open bench case from [patch-plan-2](patch-plan-2.md) P13. Sources:
> the MCP tool contracts in `src/headless/mcp.ts`, the research report
> [AI research for PDF takeoff](../../reports/AI%20research%20for%20PDF%20takeoff.md),
> the [literature review](ai-literature-review.md) sections 2 and 6, and
> `npm run bench`. Patch numbers continue from P20.

## 1. The problem

Large language and vision-language models are poor at counting objects in
an image, and construction takeoff is a counting job: downlights, power
points, smoke alarms, diffusers, doors, across dozens of dense sheets.

The evidence, already gathered in the research report and repeated here so
this document stands alone:

| Benchmark | What it measures | Best result | Source |
|---|---|---|---|
| AECV-Bench (2026) | counting doors and windows on 120 floor plans, ten current models | 0.40 to 0.55 accuracy; leaderboard top 54.3% exact match, 15.3% MAPE; text tasks on the same sheets reach 0.95 | [arXiv 2601.04819](https://arxiv.org/abs/2601.04819) |
| CountQA | general object counting | 42.9% | [arXiv 2508.06585](https://arxiv.org/abs/2508.06585) |
| HoloCount, high-density subset | counting in crowded images | 20% for a 27B model, against over 80% on sparse images | [arXiv 2607.06420](https://arxiv.org/html/2607.06420v1) |
| LED-BENCH | large-format engineering sheets | 52.65%, degrading as evidence spreads across the sheet | [arXiv 2610.19571](https://arxiv.org/abs/2610.19571) |
| MeasureBench (CVPR 2026) | reading instrument scales | about 30%; units recognised above 90%, numbers not | [CVPR 2026](https://openaccess.thecvf.com/content/CVPR2026/papers/Lin_Do_Vision-Language_Models_Measure_Up_Benchmarking_Visual_Measurement_Reading_with_CVPR_2026_paper.pdf) |

Two further findings shape the fix. First, the failure is not only
counting: models also misplace things. Dense-annotation perception is the
bottleneck on DrawingVQA, and GPT-4V was documented forgetting dimensions it
had just extracted (literature review, section 6). Asking a model for a
coordinate on an A1 sheet is the same weakness as asking it for a count.
Second, what the same models do well is reading text (0.95 on AECV-Bench),
naming what one small crop shows, and answering yes or no about it. The
VLM-as-judge result for industrial diagrams (Ghosh 2025) and the
parse-verify-retry pattern (Ayanzadeh and Oates 2026) both use the model
that way.

pdf2takeoff's architecture already takes the right side of this: "numbers
come from tools" is principle 3 of patch-plan-2, every count is
`hits.length` from a scan tier, and every MCP number carries provenance
(P15). The problem that remains is narrower and more specific, and it is
documented in the next section: **the agent path still asks the model to
read pixels at the points where the count is decided.**

## 2. Issues: where the agent is still asked to read pixels

An audit of the twelve MCP tools (`src/headless/mcp.ts`) and of what an
agent must do to count every symbol of one kind on a sheet.

### Issue A: `scan_symbol` needs a coordinate the model must find by eye

The tool description reads: "give one instance of a repeated symbol (its
centre in PDF points) ... **Look at render_page output first to pick a
symbol.**" To count downlights, the agent must recognise a 2 mm glyph among
thousands of similar marks on a rendered sheet and emit its centre in PDF
points. That is dense perception plus coordinate estimation, the two
documented failure modes, placed at the one step that decides what gets
counted. A click 3 pt off teaches the scan a wall junction or a text
glyph; the count that comes back is exact, provenanced, and about the wrong
thing. There is no error path for it: `scan_symbol` reports what it
matched, not whether the exemplar was a symbol.

Severity: high. This is the main leak.

### Issue B: `render_page` invites coordinate work

Description: "Render a sheet to a PNG so you can look at it ... pdfX = px /
scale, pdfY = heightPt - py / scale." The conversion formula is there so
the model can turn pixel positions into PDF points. Nothing says the image
is for orientation and human review only. `read_text`'s `region` parameter
reinforces it: "a title block you located on the rendered page".
`findScaleRatio` can already find the title-block scale from the text
layer without any region.

Severity: medium. It does not create a wrong number by itself, but it is
the documented route to Issue A and to Issue D.

### Issue C: no verification path other than looking again

`scan_symbol` returns hit coordinates and a count. The only way an agent
can check for false positives (a lookalike symbol, a junction the template
matched) is to render the page and count by eye, which is the thing it
cannot do. The research names the alternative: a judge pass over
individual crops.

Severity: medium. Counts are unverified in practice.

### Issue D: `measure` and `set_scale` take model-chosen coordinates

Length, area and calibration all take points in PDF space. The text layer
(`read_text`) positions dimension strings exactly, but the dimension line's
endpoints and wall faces are not text, so an agent measuring a wall
chooses endpoints from the render. The vector layer (P16) has every wall
end and line exactly and is not yet exposed for snapping.

Severity: medium for measurement, out of scope for this plan (noted as P26).

### Issue E: nothing reads the legend

`grep -ri legend src/` finds nothing. Legends are the one place on a sheet
where a symbol glyph sits next to its name in printed text. The text layer
gives the label and its position exactly; the glyph is beside it. That is
a scan exemplar with a label, found without any image reading, for every
symbol type the sheet uses. The literature review already lists
legend-informed recognition (section 1) as free supervision. Neither the
engine, the MCP server, nor any fixture (`generate-synthetic-dataset.mjs`,
`make-sample.mjs`, `takeoff-bench.mjs`) has a legend.

Severity: high as a missed opportunity. It is the fix for Issue A.

### Issue F: labels are whatever the agent typed

`scan_symbol`'s `label` is free text from the caller. With no legend, the
schedule's row names are the model's guesses from the render ("downlight"
for what the legend calls "DL-100 LED downlight 12W"). Estimators
reconcile schedules by legend code; a guessed name breaks that.

Severity: low alone, fixed by Issue E's fix.

### Issue G: the thesis is unmeasured

"Numbers come from tools" is a principle with no number behind it.
Patch-plan-2 P20 (public benchmark runs) is open. Without an agent run
against a counting benchmark, there is no evidence that the tool-grounded
path beats the model counting directly, and no regression signal if a
tool-description change makes agents count by eye again.

## 3. Design rules for the fix

1. **The model never emits a coordinate it got from an image.** Every
   point an agent passes to a tool comes from another tool's result (text
   layer, legend row, proposal, vector snap).
2. **The model never produces a quantity.** It may reject individual
   items; the number is always `len(hits)` minus rejections, computed by
   the tool.
3. **Use the model for what the benchmarks show it does well:** reading
   text, naming one crop, yes or no on one crop.
4. **Every fix lands with a check that fails today**, in `mcp-smoke.mjs`
   or `takeoff-bench.mjs`, on a fixture that has a legend.

## 4. Patches

### P21: `read_legend`, legend-driven exemplars (fixes A, E, F)

**Change.**
- `src/engine/legend.ts`: from `TextLayerWord[]`, find the legend block:
  a heading word among LEGEND, SYMBOLS, KEY, SCHEDULE, or a column of
  short text rows with regular vertical pitch and clear space to their
  left. For each row, the exemplar is the ink nearest the row's left edge
  within one text height: on born-digital sheets the vector group
  (`groupPaths` in `scan-vector.ts`) whose bbox sits there; on scans the
  connected component (`scan-cv.ts`) there. Return rows
  `{ label, code?, exemplar: Pt, glyphBbox, source: 'vector' | 'raster' }`.
- MCP `read_legend { id, page }`: returns the rows, with provenance
  (`method`, `bbox` of the legend block, word count read).
- MCP `count_legend { id, page | all_pages }`: runs `scan_symbol` from
  every legend row and returns a schedule `{ label, code, perPage, total,
  provider, provenance }`. One call, no coordinates from the caller.
- `scan_symbol` keeps working for ad hoc symbols, with a new optional
  `legend_row` input instead of `at`.

**Check.** New bench page and a detector-demo sheet with a legend of five
symbol types; `count_legend` returns every row's true count exactly, with
zero coordinates supplied by the test. `mcp-smoke.mjs` drives
`read_legend` then `count_legend` over stdio. Fixture generators grow a
`legend` option.

**Effort.** 1 to 2 days. **Depends on:** nothing; vector grouping and
`read_text` positions exist.

### P22: `propose_symbols`, candidates when there is no legend (fixes A)

**Change.**
- Born-digital: cluster `groupPaths` output by the P17 path signature;
  one proposal per cluster with `count`, one exemplar point, bbox, and a
  PNG crop (reuse the render path behind `render_page` with a region).
- Scans: connected components, shape descriptors already used by the CV
  scan's matcher, clustered the same way.
- MCP `propose_symbols { id, page, max?: 30 }` returns proposals sorted by
  count, each with a crop. The agent's job is to **name** the crops it
  wants counted; `scan_symbol` then takes `proposal_id`.

**Check.** On `detector-demo.pdf`, proposals cover all five classes and no
class is split across more than one proposal at the default tolerance; a
dimension tick and a text glyph never appear as proposals.

**Effort.** 1 day for vector, 1 more for raster. **Depends on:** P17
signatures (shipped).

### P23: `review_hits` and `reject_hits`, verification by crops (fixes C)

**Change.**
- MCP `review_hits { id, label | markup_ids, per_sheet?: 48 }` returns one
  or more contact-sheet PNGs: numbered crops of each hit at a fixed zoom,
  with the legend exemplar (when known) as crop 0 for comparison.
- MCP `reject_hits { id, markup_ids }` deletes those count markups and
  returns the corrected count with `provenance.reviewed = true` and
  `rejected = n`.
- Tool text tells the model its task: "list the crop numbers that are not
  the symbol in crop 0". Never "how many".

**Check.** `mcp-smoke.mjs` plants one lookalike among the sample's
downlights, scans, reviews, rejects it by id, and asserts the count drops
by one and provenance records the review.

**Effort.** Half a day to a day. **Depends on:** nothing.

### P24: tool contract, descriptions as guardrails (fixes B)

**Change.**
- `render_page`: "for orientation and for a human to review; never
  derive a coordinate, a count or a number from it; positions come from
  read_text, read_legend, propose_symbols and the vector tools". Drop the
  pixel-to-point formula from the description (keep it in the result as
  metadata for hosts that need it).
- `scan_symbol`: remove "Look at render_page output first"; point to
  `read_legend` and `propose_symbols`.
- `read_text`: the `region` example becomes "the legend block from
  read_legend" rather than a title block located on the render.
- Server instructions (MCP `instructions` field): the three design rules
  from section 3, in two sentences.
- Every numeric result gains `authoritative: true`.

**Check.** `mcp-smoke.mjs` asserts no tool description contains "look at"
or a pixel-to-point formula; `specs/headless-engine.md` tool table
updated.

**Effort.** Hours. **Depends on:** P21 to P23 so the descriptions have
somewhere to point.

### P25: measure the thesis (fixes G; replaces P20)

**Change.** Run two configurations on the AECV-Bench counting split
(doors and windows, 120 plans) and on a `count_legend` set built from
P21's fixtures:
1. VLM direct: the model is shown the sheet and asked for the count.
2. Agent with pdf2takeoff MCP under the P24 contract.

Report exact match and MAPE per configuration, plus how often the agent
in (2) emitted a coordinate not traceable to a tool result (the leak
metric). Publish in `docs/research/` and in the blog.

**Check.** The run script and results are committed; a CI job keeps the
leak metric at zero on the synthetic set (no model needed: the smoke
harness replays a recorded agent transcript and checks every coordinate
against tool outputs).

**Effort.** 2 to 3 days once an agent harness with model access exists.
**Depends on:** P21 to P24; the harness is the open dependency, as it was
for P20.

### P26 (follow-up, measurement): snap points to the vector layer (fixes D)

Noted here because it is the same disease. `snap_points { id, page,
points }` moves each point to the nearest wall end, line or intersection
in the vector layer within a tolerance and returns the exact coordinates;
`measure` and `set_scale` accept `snap: true`. Out of this plan's scope;
schedule after P25 reports where measurement errors come from.

## 5. Order and effort

| Order | Patch | Fixes | Effort | Depends on |
|---|---|---|---|---|
| 1 | P21 `read_legend`, `count_legend` | A, E, F | 1 to 2 days | none |
| 2 | P23 `review_hits`, `reject_hits` | C | half a day to 1 day | none |
| 3 | P22 `propose_symbols` | A (no legend) | 1 to 2 days | P17 (shipped) |
| 4 | P24 tool contract | B | hours | P21 to P23 |
| 5 | P25 benchmark runs | G | 2 to 3 days | P21 to P24, agent harness |
| later | P26 vector snapping | D | 1 to 2 days | P25 findings |

P21 and P23 are independent and can ship as separate PRs. P24 should not
land before P21, because removing "look at render_page" with nothing to
replace it leaves the agent with no sanctioned route to an exemplar.

## 6. Work done in this session

**Dynamic Fill without hints (shipped, commit 0a863b0).** Not a counting
fix, but the same principle applied to areas: the tool must produce the
right number without the model's help, because the model cannot supply it.
Before: on a scan with no calibration, no room labels and no vector
layer, a click in one of two rooms joined by a door returned both rooms
(17.61 m² for an 8.85 m² room, bench case `fill/interior-door-no-hints`).
The closing ladder only escalated on a leak or a hint, and a sealed outline
never leaks.

The fix reads the sheet's own doorways: gaps between two facing wall ends
(a jamb on both sides, which excludes an L-room's elbow and a wall end
facing a dimension tick), open floor on both sides at the centre (which
excludes dimension-line text breaks), a far wall within twelve widths on at
least one side. Their widths cluster at the door width. Each width is tried
as a closing rung, narrowest first, up to 1.5 times the narrowest plus the
best-supported cluster, and kept only when it bounds a fill that leaked or
cuts a room-sized part off the fill. A width that swallows the click or
still leaks is skipped, so nothing the sheet shows can break a fill that
was already bounded. A calibrated scale still wins.

Three drafts were needed, each caught by an existing check, which is the
reason those checks exist:
1. The first draft trusted any two clustered gaps and lost the alcove in
   `check-fill.mjs` case 8: the gaps between two separate test boxes'
   collinear walls looked like doorways. Fix: a doorway opens onto floor
   with a far wall.
2. The second draft rejected exterior doors facing blank paper, so the
   bench's page one had only one sample and the fix never fired. Fix: a
   far wall on at least one side, and a lone width is tried under the
   room-sized split guard instead of needing a partner.
3. The third draft let one-ended corner gaps vote and set the ladder start
   from the cluster; the L-room elbow in `check-revdiff.mjs` formed a
   298 px "door" cluster that swallowed the click and returned unbounded.
   Fix: only two-jamb gaps vote, and no width ever sets the ladder start.

Result: bench fill 21/22 (the open case is a diagonal door on a scan with
no vector layer, which axis-aligned closing cannot bridge), no regressions
in the bench, `check-fill`, `check-revdiff`, MCP smoke, round-trip or the
build. New guards: every page-one room re-run with no hints; a page with a
2.4 m open-plan opening that must stay open, a door into a 1.2 m corridor
closing from both sides, the middle of three rooms, and five dimension-line
text breaks at door width as decoys. On the bundled sample the uncalibrated
fill makes no doorway claim, because its only doorway is a one-jamb corner
opening; that is reported honestly rather than guessed.

## 7. Non-goals

- Fine-tuning or prompting a VLM to count better. The benchmarks above are
  the ceiling; the architecture routes around it.
- Density-map counters (FamNet, LOCA, CounTR) inside the agent loop. They
  belong in the scan tiers (P5b click-any-symbol), where their output is a
  tool result like any other.
- Asking the model for a count "as a sanity check". A wrong number from
  the model anchors the human reviewer; the review pass (P23) is per item,
  never a total.
