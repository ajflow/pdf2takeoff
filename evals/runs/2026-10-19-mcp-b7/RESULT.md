# MCP workflow conformance — first run (bench patch B7)

**Verdict: PASS — 18 contract checks, 18 tool calls, 307 ms total tool time
(slowest call: scan_symbol 85 ms; server boot ~1 s).** Ledger:
[ledger.json](ledger.json); hashes frozen in [FREEZE.sha256](FREEZE.sha256).
Counts (`mcp.tool_calls`, `mcp.roundtrip_markups`, `mcp.tools`) are
baseline-gated via `evals/compare.mjs`; timings are informational.

## What ran

The real local MCP server (`src/headless/mcp.ts`, pdf2takeoff 0.1.0) over
stdio JSON-RPC, driven through the full agent takeoff on the bundled
sample: open → render → **uncalibrated contract** → read_text scale →
set_scale → scan → measure (length/volume/angle) → set_status →
list_markups → export CSV → save annotated PDF → **fresh server process**
→ reopen → re-verify. The opentakeoff `run.mjs` shape (expected-failure
assertions, call/timing ledger, fresh-process re-import), reimplemented —
their harness is AGPL, ours is Apache-2.0.

## Contracts asserted (the interesting ones)

1. **Uncalibrated measure is null, not an error.** A `length` measurement
   before any `set_scale` records the markup and returns `value: null`;
   `angle` (90°) and `count` are scale-free and work. This is the *current*
   contract — the roadmap upgrade (graded scale verification) would turn
   the null into an explicit refusal, and this assertion is what flips
   with it.
2. **Calibration does not ride in the PDF** (bench finding). Reopening the
   saved annotated PDF in a fresh process restores every markup —
   geometry, labels, status flags — but scale-dependent values are `null`
   until the agent re-reads the printed scale and re-applies it
   (one `read_text` + `set_scale` round). After that round, the full
   markup set matches the pre-save set **canonically** (label/type/value/
   status). Follow-up product candidate: embed the calibration in
   annotation metadata so the round-trip is zero-call.
3. Everything else: exactly the 12 tools, PNG render with page metadata,
   printed scale auto-read, 8/8 scan hits, 11.995 m wall, 6.40 m³ slab,
   status flag survives save/reopen, CSV export contains the measured
   rows.

## Caveats

> Single run on one machine — not repeatability evidence. Contract
> assertions describe current behaviour; deliberate behaviour changes
> must update this bench and its baseline counts in the same commit.
