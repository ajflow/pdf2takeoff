# ResPlan-FP anchor

External anchor benchmark: ResPlan-FP from [fpvec-lab](https://github.com/Cyprinus12138/fpvec-lab)
(MIT code), 16,998 residential plans rendered as clean 256 px raster images with
wall-first vector ground truth; official test split of 1,000 plans, scored with
the benchmark's own scorer. Harness: `scripts/resplan-fp-bench.mjs`. Results and
the write-up: `results/` and `docs/research/benchmarks/resplan-fp.md`.

The clone, the downloaded data and the venv all live in `.cache/` (gitignored;
the data is never committed).

## Fetch and rerun

```bash
# 1. clone the benchmark and download the data (about 350 MB on disk)
mkdir -p bench/resplan-fp/.cache
git clone --depth 1 https://github.com/Cyprinus12138/fpvec-lab bench/resplan-fp/.cache/fpvec-lab
python3 -m venv bench/resplan-fp/.cache/venv
bench/resplan-fp/.cache/venv/bin/pip install numpy shapely scipy huggingface_hub
cd bench/resplan-fp/.cache && ./venv/bin/python -I fpvec-lab/scripts/download_data.py resplan-fp && cd -

# 2. run the engine over the official test split and score with the bench scorer
node --experimental-strip-types scripts/resplan-fp-bench.mjs \
  --out bench/resplan-fp/results
```

Flags: `--split test|val`, `--bench <fpvec-lab clone>`, `--out <dir>`,
`--bridge-gap <px>`, `--rooms spaces|faces`, `--limit <n>` (dev runs),
`--no-score`. The scorer runs from `bench/resplan-fp/.cache/venv/bin/python`
(`--python` overrides).

The `preds_<split>.jsonl` prediction files are not kept in `results/`: they
are regenerable in a few minutes with the harness command above, so only the
scorer's summary JSONs are committed.

## Attribution

- ResPlan-FP renders and labels derive from
  [ResPlan](https://github.com/m-agour/ResPlan) (data CC BY 4.0, code MIT) and
  are released with the benchmark under **CC BY 4.0**
  (Hugging Face `Tristan12138/resplan-fp`).
- fpvec-lab evaluation and scoring code is MIT
  (arXiv 2608.25608, "When Should a Network Emit Geometry, and When Should It
  Detect It?").

Neither the data nor the benchmark clone is committed: `.cache/` is
gitignored, and everything needed to reproduce the run is fetched by the two
steps above.
