# Room-area eval — first run (bench patches B1/B2)

**Verdict: PASS — 6/6 rooms, 0 failures.** Score: [score.json](score.json);
hashes frozen before these numbers were read or cited: [FREEZE.sha256](FREEZE.sha256).

## What ran

- **Sheet:** `evals/make-room-sheet.mjs` — deterministic 842×595 pt sheet,
  3×2 sealed rooms, outer walls 3 pt, dividers 2 pt, faint decoy grid
  (ignored by the fill, as intended). PDF SHA-256 pinned in the reference;
  the generator asserts byte-determinism every run.
- **Engine:** `dynamicFill` from `src/engine/dynamicfill.ts` — the exact
  code the browser app runs — seeded at each room's analytic centre.
  Page rendered at 3 px/pt via the Node raster adapter (`renderRasterNode`,
  pdf.js → skia), pdf2takeoff 0.1.0.
- **Scorer:** `evals/score-rooms.mjs`, zero dependencies, exact polygon
  intersection. Truth per room = wall faces (centerlines inset half the
  stroke). Tolerances (set with ~2× headroom over this run's observed
  error): area ≤ 1.0 %, IoU ≥ 0.985, boundary ≤ 1.0 pt.
- **Machine:** Apple Silicon (this repo's dev machine), Node 22.23.1.
  The same chain produced identical metrics under Node 23.10.0.

## Numbers

| room | area pt² | truth pt² | area % | IoU | boundary pt | fill ms |
|---|---|---|---|---|---|---|
| R1 | 71 189.0 | 71 456.3 | 0.374 | 0.99626 | 0.60 | 79 |
| R2 | 54 753.7 | 54 945.0 | 0.348 | 0.99652 | 0.60 | 59 |
| R3 | 55 123.0 | 55 361.3 | 0.430 | 0.99570 | 0.71 | 55 |
| R4 | 49 344.0 | 49 568.8 | 0.453 | 0.99547 | 0.47 | 39 |
| R5 | 37 952.0 | 38 115.0 | 0.428 | 0.99572 | 0.47 | 37 |
| R6 | 38 208.0 | 38 403.8 | 0.510 | 0.99490 | 0.60 | 39 |

Observed maxima vs tolerances: area 0.51 % / 1.0 %, IoU 0.9949 / 0.985,
boundary 0.71 pt / 1.0 pt. Boundary error is consistent with raster
quantization at 3 px/pt plus stroke-edge antialiasing (~1.4–2.1 px).
Fill polygons are 5 points each (rectangle + one split edge), 37–79 ms
per room on a 2526×1785 render.

## Caveats

> Single run on one machine — not repeatability evidence.
> The reference is analytic but the tolerances are ours; a pass means
> "within the tolerance we committed to", nothing broader.

Sealed rooms only — door-gap behaviour is covered behaviourally in
`scripts/check-fill.mjs`, not by this analytic eval (a gapped room's truth
is ambiguous until we freeze a convention for where the fill should span).
