# pdf2takeoff

**PDF in, quantities out: free and open source.**

pdf2takeoff turns construction PDF drawings into measured quantities. Calibrate the scale from any printed dimension, measure lengths, areas and counts, export the markups list to CSV for Excel, and save the markups back into the PDF as standard annotations that open in Bluebeam Revu and Adobe Acrobat.

Everything runs in your browser. **Drawings are never uploaded**; rendering and measurement happen on your machine, so it's safe for confidential tender documents and keeps working offline once the page is loaded.

- Price: free, no account, no file limits, no paid tier
- Licence: Apache-2.0 — to our knowledge the **only permissively licensed takeoff engine** in a field of AGPL competitors, so you can embed and bundle it
- Privacy: 100% client-side, zero telemetry

## Benchmarks & evals — the numbers, the method, the failures

We publish what the engine scores, how every number was produced, and what
it is still bad at — including a benchmark we built and gave away (CC BY 4.0,
usable by anyone, including to beat us):

- **ScaledDrawingBench v0.1** (ours, deterministic, seeded): **99.8%** on
  born-digital sheets, **37.3%** on degraded scans (up from 23.0% — the
  improvement log is part of the disclosure), **0 hallucinations** on 92
  unanswerable-by-design questions
- **AECV-Bench** (external, public): 0.295 five-field exact match with a
  deterministic engine and **no vision model**; bedroom/toilet counts at
  0.708/0.500 from a label dictionary + OCR alone
- **AEC-Geometric-Bench** (external, released scorer): **wall pixel F1 0.519
  — about 1.8× the best frontier VLM** on the identical sheets (0.18–0.29),
  area precision 0.943, object F1 0.031 at the frontier-VLM range; a
  click-free deterministic engine, no GPU, ~23 s per sheet
- ~**100 ms** CV scan, **1.6 s** cached in-browser ONNX scan, 76 MB model —
  in-browser, nothing uploaded
- A correctness gate on every push: ten behavioural checks + the takeoff
  bench + MCP smoke + PDF round-trip in CI

Everything regenerates from this repo with one command per table — see
[evals/README.md](evals/README.md).

> Phase plan: the [Roadmap](#roadmap) below. Feature-by-feature position against Bluebeam Revu, and what we deliberately won't build: [docs/feature-comparison.md](docs/feature-comparison.md). Hosting cost model: [docs/hosting-cost-controls.md](docs/hosting-cost-controls.md). Licensing rationale: [Why open source?](#why-open-source).

## What it does today

- **Viewer**: open any PDF drawing; zoom, pan, multi-page (PDF.js)
- **Scale calibration**: click both ends of a known dimension and type its real length, or pick a preset (1:50 … 1:500, 1/8″ = 1′-0″, 1/4″ = 1′-0″, 1″ = 10′/20′/30′). Each page keeps its own scale. Metric and imperial. Multi-scale viewports (W): outline a region drawn at a different scale (a 1:20 detail on a 1:100 sheet) and measurements inside it resolve to that scale automatically.
- **OCR auto-read**: click both ends of a printed dimension and hit *Auto-read from sheet* — the value ("12.00") or the title-block scale ("1:100") is read straight off the drawing. First use fetches the OCR language pack (~4 MB, then cached); drawings still never leave your machine.
- **Takeoff tools**: Length (segmented runs), Area, Perimeter, Volume (area × depth), Angle (scale-free) and Count, with live measurements on the drawing and per-label group totals
- **Scan (auto-count)**: press `S` and click one instance of a repeated symbol: a local computer-vision pass (rasterize → binarize → connected components → shape matching) finds and counts every match on the page in ~100 ms, no model download and nothing uploaded. Hits land as **flagged proposals** (⚑) — confirm (✓) or delete them, and the totals show a live **kept-rate** per label (kept/proposed: every deletion is a judged false positive), so the tool's accuracy on *your* symbols is always visible. A trained **v1 detector ships with the site** (five classes: downlight, GPO, switch, smoke alarm, diffuser — manifest in [`public/models/symbols.json`](public/models/symbols.json)): on cluttered sheets the same click upgrades automatically to an in-browser ONNX detector (`onnxruntime-web`, WASM) that labels hits by class, with automatic fallback to the CV pass if the model can't load. The ~76 MB model is fetched once from GitHub and cached; drawings still never leave your machine. Self-hosting or retraining: drop your own `symbols.onnx` + `symbols.json` into `public/models/` — the pipeline is in [`training/`](training/README.md).
- **Markups list**: rename labels, jump to page, delete; flag / confirm statuses that round-trip through the PDF; filter by status, search by label, sort; one-click Clear; export CSV, a real Excel workbook (.xlsx), or copy straight into a spreadsheet
- **Printable report**: one click builds a print-ready quantity report: every marked sheet re-rendered with its markup overlay, per-sheet quantity tables, and group totals; print or save as PDF from the browser
- **Editing**: drag whole markups or individual vertices with live value updates; Ctrl+Z restores the pre-drag geometry; calibrate once and apply the scale to every page in the set
- **Dynamic Fill**: click inside a room to read its area off the walls (flood fill + boundary trace). Doorways between wall ends close automatically: from the calibrated scale, from room labels in the text layer, from the vector layer (any angle), or, on an uncalibrated scan with none of those, from the door width the sheet itself shows. Wide open-plan openings stay open; a diagonal door on a scan with no vector layer can still leak
- **Custom columns**: formula columns over quantities (waste factors, rates) in totals and every export; `value * 1.1` style, no code
- **Notes**: pin a note anywhere (T); round-trips through the PDF
- **Layers**: place per trade and hide layers while measuring the next; layer names ride inside the PDF
- **Tool library**: save a tool + label once (e.g. Length "Skirting", Count "Downlight DL-100"), then click the chip to measure pre-labelled — every placement and scan hit carries the label; presets persist locally across sessions
- **Multi-sheet sets**: page filmstrip with lazily rendered thumbnails and per-page calibration badges; the bundled sample carries two sheets at different scales (1:100 and 1:50) to show per-page scales
- **Live sessions**: hit **Live** and every tab/window with the same drawing shares the takeoff in real time — placements, edits (rename/status/drag), deletions, calibrations and presence (Yjs CRDT over BroadcastChannel; cross-machine relay is the next phase)
- **Sessions persist**: markups and calibrations autosave to IndexedDB keyed by the file's hash, so a refresh or re-open restores your takeoff (PDF annotations still take precedence when present); the PDF itself is never stored or uploaded
- **Save into the PDF**: markups are written as standard Line / PolyLine / Polygon / FreeText annotations (pdf-lib) with the measurement in the comment, and they round-trip: reopen the file and your takeoff comes back
- **Revision overlay compare**: pick two revisions of a sheet; red exists only in A (removed), blue only in B (added), dark ink is unchanged. Auto fit-to-page, 1 pt nudge alignment, and a *Changes only* mode that fades everything unchanged to grey. Try it with `sample-floor-plan.pdf` vs `sample-floor-plan-rev-b.pdf`.

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173
```

Then hit **▶ Watch the demo**: the tool drives itself through a full takeoff on
the sample drawing (calibrate → measure → area → scan-count) and shows the
output summary with working export buttons. Or skip straight to "Try the sample
drawing" and do it yourself.

```bash
npm run build      # type-check + production build in dist/
npm run sample     # regenerate public/examples/sample-floor-plan.pdf
npm run bench      # takeoff accuracy bench on synthetic sheets (rooms, counts, scales)
```

`npm run bench:rooms -- --dir <folder>` scores Dynamic Fill room areas against the ResPlan floor-plan dataset (setup in [scripts/bench/README.md](scripts/bench/README.md)). `npm run bench:ledger` runs the fast benches and appends their headline numbers, with the commit, to [bench/results/ledger.jsonl](bench/results/README.md) (`--compare` prints the delta against the previous run).

Deploy `dist/` to any static host. Cloudflare Pages is the reference target (`public/_headers` is included).

## Headless CLI (agents & scripts)

The same engine runs headless on Node (≥ 22.6) — no browser, no bundler, and
no network calls except two: the first `ocr` run on a scan downloads a ~3 MB
language pack (cached; see `PDF2TAKEOFF_TESSDATA` below), and `ai-count`
sends the page you choose to the AI provider you choose:

```bash
npm run cli -- info drawing.pdf                      # pages, sizes, annotation counts
npm run cli -- compare r2.pdf r3.pdf --png diff.png  # per-sheet change fractions + regions
npm run cli -- compare r2/ r3/ --png-dir ov/         # folders: batch the whole set, pair by filename
npm run cli -- scan drawing.pdf --page 1 --at 88,271 # click-point auto-count, JSON hits
npm run cli -- scan plan.png --page 1 --at 318,447   # PNG/JPG input (every command): one page of W/3 x H/3 points
npm run cli -- export drawing.pdf --scale 1:100      # annotations → quantities CSV
npm run cli -- annotate drawing.pdf --spec takeoff.yaml -o marked.pdf
npm run cli -- run takeoff.yaml --prev run-a.json   # regenerate + diff quantities
npm run cli -- set tender/ -o current-issue.pdf     # slip-sheet: newest per sheet, sorted
npm run cli -- ocr scan.pdf --page 1 [--region x,y,w,h]  # scanned sheet: OCR words, scale note, room labels by class
```

### AI count (bring your own model)

One command asks a vision model to inventory a sheet:

```bash
export OPENROUTER_API_KEY=...   # or set it in your shell profile
npm run cli -- ai-count drawing.pdf --model google/gemini-3.5-flash
```

An [OpenRouter](https://openrouter.ai) key gets you any vision model with one
account; OpenAI, Google Gemini and Z.ai keys work directly (`--provider
openai|gemini|zai`). Prefer nothing to leave the machine? `--provider ollama`
or `lmstudio` talks to a local server, and any other OpenAI-compatible
endpoint works through `--base-url`. Keys come from environment variables
only (`OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`,
`ZAI_API_KEY`, or `PDF2TAKEOFF_AI_KEY` for any provider) — never command
lines or files.

What comes back is the model's proposals as flagged count markups (the same
review flow as scan proposals) plus quantities counted under a preset
(`--preset aecv` or `schedule`): switching the preset recounts instantly,
with no new model call. `--items` lists every proposal as JSON; `-o
marked.pdf` writes them into the PDF, types included, so a human can confirm
or delete each one and a later run replaces only the unconfirmed ones. Accuracy depends entirely on the model you point it at — review the
flags before trusting a number.

`run` is takeoff-as-code: the spec names the scale, one click-point per
symbol type (a `class:` field is reserved for when the ONNX detector runs
headless; today the CLI scans with the CV tier), and the exports. Re-run it on
every revision with `--prev` to see exactly which quantities changed — the
CI-friendly revision loop.

Every `<file.pdf>` above also takes a PNG or JPG directly (the MCP
`open_document` included), as well as image-only (scanned) PDFs: an image is
one page of width/3 by height/3 points, so a click at pixel (px, py) is
`--at px/3,(H - py)/3` and the scan sees the native pixels. `compare --json`
is designed for pipelines (`jq '.changedSheets'`); `scan`
returns the same hits the web Scan tool finds. This is the substrate for the
agent API (MCP) — see [specs/headless-engine.md](specs/headless-engine.md).

Environment variables: `PDF2TAKEOFF_MODEL_DIR` (or `scan --model <dir>`)
selects a trained ONNX detector directory — without it the scan stays on the
CV tier; `PDF2TAKEOFF_TESSDATA` points the OCR language pack at an
offline/frozen copy instead of downloading it; `PDF2TAKEOFF_OCR_DUMP`
writes the binarised OCR crops to a folder for debugging.

## Agent API (MCP)

`pdf2takeoff mcp` starts a local MCP server on stdio with fifteen tools —
`open_document`, `render_page` (the agent's eyes: a PNG of any sheet),
`read_text` (the sanctioned way to read printed scales/dimensions/labels —
exact, positioned, never off the rendered image), `set_scale`, `measure`,
`fill_area`, `scan_symbol`, `propose_items`, `count_items`,
`compare_revisions`, `list_markups`, `set_status`, `delete_markup`,
`export`, `save_annotated` — so an AI agent can run a whole takeoff and hand
the marked-up PDF to a human for review. Local process, local files, nothing
uploaded.

Proposed doors, Windows and spaces land as flagged count markups a human can
confirm or delete, and `count_items` derives every quantity from those items
under a counting preset (`aecv`, `schedule`) — switching the counting
convention recounts instantly, with no new detection pass.

Register it with any MCP client (ZCode, Claude Desktop, Cursor):

```json
{
  "mcpServers": {
    "pdf2takeoff": {
      "command": "node",
      "args": ["/path/to/pdf2takeoff/bin/pdf2takeoff.js", "mcp"]
    }
  }
}
```

## ScaledDrawingBench

No public benchmark tests measuring a length or an area from a scaled drawing,
so the repo ships one. [bench/scaled-drawing-bench](bench/scaled-drawing-bench/README.md)
is a deterministic, CC BY 4.0 set of 200 synthetic floor-plan sheets (half
born-digital, half degraded 150 dpi scans; five scale notations; A3, A1 and
ARCH D; some rotated; some with a revision B) and about 2,000 estimator-style
questions with exact answers: scale, wall lengths, room areas and perimeters,
symbol counts, printed dimensions and revision changes. `npm run bench:scaled -- generate`
builds it from a seed, `score` grades a predictions file (within 2 and 5
percent, MAPE, exact counts, change-set F1, hallucination rate) and
`reference` runs pdf2takeoff's own deterministic solver, whose table is in the
benchmark README: near perfect on the vector half, with the raster half
showing where the engine's scan and OCR paths still fall short.

[`evals/`](evals/README.md) is a public, reproducible benchmark suite: room-area fill scored against analytic ground truth, detector precision/recall with every miss attributed to the gate that dropped it, an MCP workflow conformance bench, a perf bench, and a committed baseline that fails CI on any regression — plus a manual anchor on the external AEC-Geometric-Bench. Numbers are published with their run logs under [`evals/runs/`](evals/runs/).

## Architecture

- **`src/engine/`** — the takeoff engine: measurement geometry, scan CV + ONNX decode, compare blend, PDF annotation IO, quantity export. Pure TypeScript with zero DOM/bundler imports (enforced in CI via a no-DOM typecheck + import guard) so the same code runs in the browser and headless in Node.
- **`src/app/`** — the browser UI: PDF.js viewer, tools, markups table, report, persistence. Wires the engine's ports (`RasterPage`, `DetectorSession`) to browser adapters.
- **`src/headless/`** — the Node side: the CLI (`cli.ts`, launched by `bin/pdf2takeoff.js`), the MCP server (`mcp.ts`), the takeoff-as-code spec loader, and the PDF.js/raster adapters that wire the engine's ports to Node. Design: [specs/headless-engine.md](specs/headless-engine.md).

## Keyboard

| Key | Action |
| --- | --- |
| `V` / `C` / `W` / `L` / `A` / `N` / `P` / `O` / `G` / `T` / `D` / `S` | pan · calibrate · viewport · length · area · count · perimeter · volume · angle · note · fill · scan |
| `F` | fit width |
| `+` / `−` | zoom |
| `←` / `→` | previous / next page |
| Double-click or `Enter` | finish a measurement |
| `Backspace` | remove last vertex while drawing |
| `Delete` | remove selected markup |
| `Ctrl/Cmd+Z` | undo last measurement |
| `Esc` | cancel / deselect |

## Roadmap

1. ~~Viewer + scale calibration~~ ✅
2. ~~Length / area / count + markups list + CSV export~~ ✅
3. ~~Revision overlay compare (colour-blend the difference between two revisions)~~ ✅
4. ~~Headless engine: Node CLI, MCP agent API, takeoff-as-code~~ ✅ ([specs/headless-engine.md](specs/headless-engine.md))
5. ~~ML symbol detection in the browser (ONNX Runtime Web, WASM)~~ ✅ v1 shipped (five classes); v2 retrain next — FloorPlanCAD transfer stage and the tile contract for large sheets ([training/](training/README.md), [specs/detector-tiling.md](specs/detector-tiling.md))
6. Live multi-user sessions — phase 1 shipped (same-machine, experimental — see above); next: cross-machine relay
7. Plugin API: AI takeoff helpers, quote generation and trade-specific tools as add-ons anyone can write

## Why open source?

There is no real open-source Bluebeam for construction yet. An open core lets builders and developers add trade-specific tools (HVAC, rebar, electrical) and AI takeoff helpers without asking permission. Permissive dependencies only (PDF.js is Apache-2.0, pdf-lib is MIT); we deliberately avoid AGPL components.

## Contributing

Issues and PRs welcome; read [CONTRIBUTING.md](CONTRIBUTING.md) first (short version:
issue before PR, small scoped changes, CI green, and the contributor licence
terms under *Licensing your contribution*). Trade-specific feature ideas
(what does your takeoff actually look like?) are the most valuable input of all.

## Licence

[Apache-2.0](LICENSE) © pdf2takeoff contributors
