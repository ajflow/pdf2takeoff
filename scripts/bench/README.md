# Room-area benchmark (ResPlan)

Scores Magic Fill (`src/engine/dynamicfill.ts`) on real floor-plan geometry:
200 ResPlan plans rendered to clean vector PDFs, one click per room, ground
truth from the dataset's room polygons. Background, conventions and results:
[docs/research/benchmarks/room-area-datasets.md](../../docs/research/benchmarks/room-area-datasets.md).

Two steps: a Python generator (shapely for the geometry, cairosvg for the
PDFs) and a Node scorer that runs the fill through the same headless path as
the CLI and MCP server.

## Setup

1. Clone the dataset (CC BY 4.0; about 190 MB, the plans are a zip inside
   the repo). Keep it outside this repository; nothing from it is checked in.

   ```bash
   git clone --depth 1 https://github.com/m-agour/resplan /path/to/resplan
   ```

2. Python 3.10+ with shapely 2 and cairosvg. A venv keeps them off the
   system interpreter:

   ```bash
   python3 -m venv ~/.venvs/pdf2takeoff-bench
   ~/.venvs/pdf2takeoff-bench/bin/pip install shapely cairosvg
   ```

3. Node dependencies as for the app (`npm install`).

## Generate the PDFs

```bash
~/.venvs/pdf2takeoff-bench/bin/python -I scripts/bench/resplan_to_pdf.py \
    --resplan /path/to/resplan --out /tmp/resplan-bench
```

Defaults: 200 plans sampled from the test split (`--limit`, `--seed`,
or `--ids 1,8,59`), drawing ratio 1:100 (`--ratio 50` or `200` to test the
gap-closing ladder at other scales), variants A, B and C (`--variants AB`),
A3 landscape page when the plan fits (`--page fit` for a tight page). Takes
about 10 seconds for 200 plans.

`-I` matters: the dataset pickle is third-party data. The script loads it
through a restricted unpickler that admits only `shapely.io.from_wkb` and
the numpy scalar helpers the file needs and raises on any other global.

Per plan it writes `<id>_A.pdf` (walls and window outlines, door openings
left as bare gaps), `<id>_B.pdf` (plus the door leaf drawn closed in the
opening), `<id>_C.pdf` (plus an open-door symbol: perpendicular leaf and
swing arc), optionally `<id>_D.pdf` (`--raster`: B rasterised at 150 dpi as
an image PDF, scored like the others when named in `--variants ABCD`; the
scorer leaves D out by default because it is the slow one), and
`<id>_tasks.json` with, per room, click
points, the room type, `doors`, flags `expectLeak` (balcony, garden,
parking, pool: outside the building) and `open` (a doorless opening wider
than 1.3 m to another room: open kitchens, stairs in halls), and the
ground-truth area in m2 under three conventions: `gt_m2` (polygon as is),
`gt_face_m2` (polygon minus walls, the inside-face area a floor finish
takeoff wants), `gt_centre_m2` (buffered by half the wall depth, clipped to
the envelope). `--labels` adds room names as text so the text-layer label
hint runs too. `--rotate 15,30 --rotate-share 0.1` turns every tenth plan
about its envelope centre, cycling through the angles (the diagonal-wall
subset); the task file records `rotationDeg` and the scorer adds a row per
angle. The checked-in run uses a separate 20-plan folder: `--ids` with every
tenth id of the 200-plan sample and `--rotate 15,30`.

## Score

```bash
npm run bench:rooms -- --dir /tmp/resplan-bench --jobs 4 --json /tmp/resplan-bench/results.json
```

Options: `--variants ABC`, `--hints all|scale|labels|none` (what the fill is
told, default `all` = scale plus text-layer labels plus vector door bridges,
the CLI's calibrated path), `--limit N`, `--ids 1,8`, `--jobs N` (plans
split across worker processes), `--quiet`. About 5 minutes for 200 plans and
three variants with four jobs.

Per variant and room type it prints: rooms, median relative error against
the inside-face area, 90th percentile of its absolute value, median error
against the polygon as is and against the centreline area, median IoU
against the polygon as is and against the inside-face polygon, leak rate
(fill larger than 1.5x the room), unbounded rate (the fill returned an
error), and recovered rate (IoU at least 0.5 and no leak). "all enclosed
rooms" is the headline; open-plan and expect-leak rooms get their own rows.
The JSON holds the same summary plus every room's record (fill area,
errors, IoU, `gapPx`, `bridged`, timing).
