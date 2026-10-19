# MCP workflow conformance — follow-up: calibration round-trips (B7b)

**Verdict: PASS — 17 contract checks, 15 tool calls (was 18), 307 ms.**
Ledger: [ledger.json](ledger.json); hashes frozen in
[FREEZE.sha256](FREEZE.sha256). The baseline metric `mcp.tool_calls`
deliberately ratcheted 18 → 15 in the same change: the two recovery calls
are gone because they are no longer needed.

## What changed vs [b7](../2026-10-19-mcp-b7/RESULT.md)

The b7 finding — "calibration does not ride in the PDF; reopened values
are null until one read-text + set-scale round" — is fixed in the engine:

- `buildAnnotatedPdf` now writes the page calibration into every markup
  comment as `[mpp:<exact double>]` (`String(n)` — the shortest
  representation that parses back bit-identically; a first attempt with
  9-digit precision flipped a 4th-decimal rounding boundary and the bench
  caught it).
- `read.ts` gained `parseCalibration()`; `ops.readMarkups` returns restored
  calibrations; MCP `open_document` seeds them into the session (and now
  reports `restoredCalibrations`); the browser app's `importMarkups` fills
  any page the local session hasn't calibrated itself.
- Regression guards: `scripts/roundtrip-check.mjs` asserts the calibration
  round-trips, recomputes the original value exactly, and that the token
  never leaks into labels; the B7 bench flipped its phase-C contract from
  "values null before re-calibration" to "values live at open, markup set
  canonically equal".

The uncalibrated-measure contract (value null, not an error) is unchanged —
that one still belongs to the graded-scale-verification roadmap item.

## Caveats

> Single run, one machine. Old PDFs saved before this change carry no
> [mpp:…] token and restore exactly as before (markups, no calibration) —
> backward compatible by construction.
