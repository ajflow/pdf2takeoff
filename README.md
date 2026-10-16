# pdf2takeoff

**PDF in, quantities out: free and open source.**

pdf2takeoff turns construction PDF drawings into measured quantities. Calibrate the scale from any printed dimension, measure lengths, areas and counts, export the markups list to CSV for Excel, and save the markups back into the PDF as standard annotations that open in Bluebeam Revu and Adobe Acrobat.

Everything runs in your browser. **Drawings are never uploaded**; rendering and measurement happen on your machine, so it's safe for confidential tender documents and keeps working offline once the page is loaded.

- Price: free, no account, no file limits, no paid tier
- Licence: Apache-2.0
- Privacy: 100% client-side, zero telemetry

> Product strategy, phase plan, licensing rationale and cost model live in [STRATEGY.md](STRATEGY.md).

## What it does today

- **Viewer**: open any PDF drawing; zoom, pan, multi-page (PDF.js)
- **Scale calibration**: click both ends of a known dimension and type its real length, or pick a preset (1:50 … 1:500, 1/8″ = 1′-0″, 1/4″ = 1′-0″, 1″ = 10′/20′/30′). Each page keeps its own scale. Metric and imperial.
- **Takeoff tools**: Length (segmented runs), Area, Perimeter, Volume (area × depth), Angle (scale-free) and Count, with live measurements on the drawing and per-label group totals
- **Scan (auto-count)**: press `S` and click one instance of a repeated symbol: a local computer-vision pass (rasterize → binarize → connected components → shape matching) finds and counts every match on the page in ~100 ms, no model download and nothing uploaded. Drop a trained detector (`symbols.onnx` + `symbols.json`) into `public/models/` and the same click upgrades to an in-browser ONNX detector (via `onnxruntime-web`, WASM) that labels hits by class and handles cluttered sheets, with automatic fallback to the CV pass if the model is missing or fails. Train one with the pipeline in [`training/`](training/README.md).
- **Markups list**: rename labels, jump to page, delete; export CSV, a real Excel workbook (.xlsx), or copy straight into a spreadsheet
- **Printable report**: one click builds a print-ready quantity report: every marked sheet re-rendered with its markup overlay, per-sheet quantity tables, and group totals; print or save as PDF from the browser
- **Editing**: drag whole markups or individual vertices with live value updates; Ctrl+Z restores the pre-drag geometry; calibrate once and apply the scale to every page in the set
- **Tool library**: save a tool + label once (e.g. Length "Skirting", Count "Downlight DL-100"), then click the chip to measure pre-labelled — every placement and scan hit carries the label; presets persist locally across sessions
- **Multi-sheet sets**: page filmstrip with lazily rendered thumbnails and per-page calibration badges; the bundled sample carries two sheets at different scales (1:100 and 1:50) to show per-page scales
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
```

Deploy `dist/` to any static host. Cloudflare Pages is the reference target (`public/_headers` is included).

## Headless CLI (agents & scripts)

The same engine runs headless on Node (≥ 22.6) — no browser, no bundler, no
network calls:

```bash
npm run cli -- info drawing.pdf                      # pages, sizes, annotation counts
npm run cli -- compare r2.pdf r3.pdf --png diff.png  # per-sheet change fractions + regions
npm run cli -- scan drawing.pdf --page 1 --at 88,271 # click-point auto-count, JSON hits
npm run cli -- export drawing.pdf --scale 1:100      # annotations → quantities CSV
npm run cli -- annotate drawing.pdf --spec takeoff.yaml -o marked.pdf
```

`compare --json` is designed for pipelines (`jq '.changedSheets'`); `scan`
returns the same hits the web Scan tool finds. This is the substrate for the
agent API (MCP) — see [specs/headless-engine.md](specs/headless-engine.md).

## Agent API (MCP)

`pdf2takeoff mcp` starts a local MCP server on stdio with ten tools —
`open_document`, `render_page` (the agent's eyes: a PNG of any sheet),
`set_scale`, `measure`, `scan_symbol`, `compare_revisions`, `list_markups`,
`delete_markup`, `export`, `save_annotated` — so an AI agent can run a whole
takeoff and hand the marked-up PDF to a human for review. Local process,
local files, nothing uploaded.

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

## Architecture

- **`src/engine/`** — the takeoff engine: measurement geometry, scan CV + ONNX decode, compare blend, PDF annotation IO, quantity export. Pure TypeScript with zero DOM/bundler imports (enforced in CI via a no-DOM typecheck + import guard) so the same code runs in the browser and, upcoming, headless in Node (CLI + MCP — see [specs/headless-engine.md](specs/headless-engine.md)).
- **`src/app/`** — the browser UI: PDF.js viewer, tools, markups table, report, persistence. Wires the engine's ports (`RasterPage`, `DetectorSession`) to browser adapters.

## Keyboard

| Key | Action |
| --- | --- |
| `V` / `C` / `L` / `A` / `N` / `P` / `O` / `G` / `S` | pan · calibrate · length · area · count · perimeter · volume · angle · scan |
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
4. Live multi-user sessions (Yjs CRDT, the Studio Sessions equivalent)
5. Plugin API: AI takeoff, ML symbol detection (ONNX Runtime Web / WebGPU), quote generation as add-ons anyone can write

## Why open source?

There is no real open-source Bluebeam for construction yet. An open core lets builders and developers add trade-specific tools (HVAC, rebar, electrical) and AI takeoff helpers without asking permission. Permissive dependencies only (PDF.js is Apache-2.0, pdf-lib is MIT); we deliberately avoid AGPL components.

## Contributing

Issues and PRs welcome; read [CONTRIBUTING.md](CONTRIBUTING.md) first (short version:
issue before PR, small scoped changes, CI green). Trade-specific feature ideas
(what does your takeoff actually look like?) are the most valuable input of all.

## Licence

[Apache-2.0](LICENSE) © pdf2takeoff contributors
