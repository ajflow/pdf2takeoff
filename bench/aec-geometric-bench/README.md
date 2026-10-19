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
