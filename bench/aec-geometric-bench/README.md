# AEC-Geometric-Bench run (external anchor)

pdf2takeoff's predictions and score on the fifteen released sheets of
[KamaiEnterprises/aec-geometric-bench](https://github.com/KamaiEnterprises/aec-geometric-bench)
(their code and released data are MIT). The bench repo itself is not
vendored here; clone it and run:

    git clone --depth 1 https://github.com/KamaiEnterprises/aec-geometric-bench.git /tmp/aec-gb
    node --experimental-strip-types scripts/aec-geometric-bench.mjs --bench /tmp/aec-gb

That re-renders each sheet into the bench's 300 dpi scoring frame, runs the
click-free raster opening detector, writes `results/sheet_NN.json` and pipes
them through the bench's own `scoring/score.py`. Numbers and reading:
[docs/research/benchmarks/aec-geometric-bench.md](../../docs/research/benchmarks/aec-geometric-bench.md).

The harness pins the detector configuration of the first pass (wall pixel
F1 0.519): base closing ladder `[0,1,2,3]`, closing guards disabled. The
engine defaults since grew an extended closing ladder with guards that trade
wall recall on these large commercial sheets for count sanity on hatched
residential scans (AECV-Bench); pinning keeps this anchor's wall time series
comparable run over run. The other submitted fields (windows, areas) track
the current engine: this run scored wall pixel F1 0.519 (P 0.784 / R 0.388,
identical to the first pass), area pixel F1 0.324 (was 0.381; the spaces
relative-size floor drops small areas), area instance F1 0.089 (was 0.087),
window object F1 0.041 (was 0.089; the exterior-facing window gate removes
windows whose outside walk crosses wall ink on these dense sheets).
