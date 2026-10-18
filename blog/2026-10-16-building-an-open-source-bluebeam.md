# Building an open-source Bluebeam in the browser: the pdf2takeoff story

*October 2026 — by the pdf2takeoff team*

There is no real open-source Bluebeam for construction. That sentence was the
entire product strategy, and six weeks later it's still true — except that
now there's us. [pdf2takeoff](https://pdf2takeoff.com) is a free, Apache-2.0
PDF takeoff tool that runs entirely in your browser, with a Node CLI and an
MCP server built on the same engine, and this post is the honest engineering
story of how it got built: what shipped, where we got badly stuck, and the
approach that made the pace possible.

## What exists today

The short version, against Bluebeam's own tiers (AU$451–979 per user/year):

- **Every Basics-tier feature** — measurement, markups list, tool presets
  ("tool library"), custom statuses, filter/sort, notes, layers
- **Every Core-tier feature** — perimeter, volume, angle, per-page scales,
  multi-scale viewports, overlay compare
- **Most of Complete** — batch compare across revision folders, OCR scale
  auto-read, formula columns (waste factors, rates), Dynamic Fill, sets /
  slip-sheeting, quantity diffing between revisions
- **And the thing they charge the most for**: their new Max tier (AU$979) is
  built around an MCP integration for AI agents. We ship one free — eleven
  local tools an agent can use to open a drawing, look at it, measure, scan
  symbols, compare revisions and hand back an annotated PDF for a human to
  verify.

The scorecard we maintain against their feature list currently reads
**38 shipped (7 of which go beyond anything they offer), 5 planned, 11
deliberately not built.** That last number matters as much as the first:
knowing what not to build is how a free tool covers a $979 product.

## The approach

### One engine, every surface

The decision that paid for everything else came early: extract all takeoff
logic — measurement math, scan, compare, annotation IO, exports — into a
pure, environment-agnostic engine (`src/engine/`), with the browser UI and
the Node CLI/MCP as thin consumers behind small ports (a raster port, a
detector port). The rule is enforced, not aspirational: CI type-checks the
engine under a no-DOM library and a script fails the build on any DOM,
bundler or renderer import under `engine/`.

The payoff is that every feature lands everywhere at once. Perimeter,
volume and angle shipped in the web UI, the CLI and the MCP server in a
single pass. Custom columns flow from the sidebar editor into CSV, Excel,
the printable report and agent exports through one implementation.

### Specs before code, verification before claims

Every phase started as a written spec with exit criteria (they live in
[`specs/`](https://github.com/ajflow/pdf2takeoff/tree/main/specs)). And
nothing is called done until it has been driven in a real browser by an
automation harness — placing measurements at known coordinates, reading
values back, reloading to prove persistence. The MCP server has a
24-check end-to-end protocol suite that runs in CI on every push, driving
the server over real stdio JSON-RPC: open → render → calibrate → scan →
measure → export → save. The CLI is smoke-tested the same way, including a
takeoff-spec runner that must find exactly 8 symbols on the sample sheet.

### Agent-driven development, honestly

Most of this codebase was written by an AI agent — and the reason that
worked is the two paragraphs above. An agent with a spec, enforced
architecture boundaries and a verification harness it must pass before
committing is a very different proposition from an agent with a text box.
The discipline wasn't trusting the agent; it was building the rails the
agent rides on. Where the harness caught agent mistakes (and it caught
several), that's the system working.

## Where we got stuck

The honest section. Four stories, each with a lesson.

### The segfault that was a polyfill

Getting pdf.js rendering into Node's `@napi-rs/canvas` produced native
crashes — SIGSEGV, no stack, nothing. We bisected for the better part of a
day: not the canvas library, not the import order, not the bundler. The
answer: **pdf.js's Node build installs its own JavaScript `Path2D` polyfill
on the global object at import time**, and skia's `ctx.fill(path)` only
accepts its own native `Path2D` class. Rendering through the polyfill
segfaults in native code. Our first fix guarded the global assignment with
"only if missing" — which politely deferred to pdf.js's incompatible
polyfill and kept crashing. The fix is an *unconditional* assignment of
skia's classes, and it's documented in the spec so nobody re-lives it.
Lesson: when two libraries both want to own a global, "polite" is wrong.

### The IndexedDB upgrade that silently killed persistence

Adding a new object store to IndexedDB, we created it in
`onupgradeneeded` — but unconditionally re-created the *existing* store
too. That throws inside the upgrade transaction, aborts the whole upgrade,
and every database operation afterwards silently no-ops. Sessions stopped
restoring and nothing errored. The browser verification harness caught it
(a reload came back empty), which is exactly why every feature gets driven
in a real browser before commit. Lesson: failed IndexedDB upgrades fail
quietly; guard every store creation, and test the upgrade path from real
old data.

### The collaboration bug that didn't exist

Live sessions (phase one: same-machine CRDT sync over BroadcastChannel)
had a maddening symptom: placements, deletions and calibrations synced
perfectly between tabs, but *edits* — renames, status flags — arrived at
the remote document (receive, apply and observe all fired, verified by
instrumentation) yet the UI read the old value. We restructured the data
model twice (nested per-field maps → whole-markup JSON leaves), changed
observer depth, built isolated reproductions that all *worked*… and then
discovered the truth: the bug was already fixed. Our failing test runs
were tabs still executing stale code from hot-module reloads — several
generations behind the fixes they were supposed to verify. On fresh tabs,
every operation synced both directions. Lesson: when a bug refuses to
reproduce in isolation, suspect the test harness before the code.

### Dynamic Fill leaked through doors (and we said so)

Click inside a room, flood-fill to the walls, read the area — it works in
~150 ms and creates a normal editable polygon. But floor-plan walls have
door openings, and a naive flood fill escapes through them (on our sample
it read 74 m² for a 32 m² office). We shipped it with that limitation
named, then closed it in layers, each with a bench case that failed first:
gaps are closed only between wall ends (so a bench near a wall is never
"closed" onto it); a calibrated scale closes doorways up to 1.0 m; room
labels in the text layer split rooms a door joins; the vector layer
bridges doors at any angle; and on a bare scan with none of those, the
sheet's own doorways, the gaps between facing wall ends, vote for a door
width that is tried only where it cuts off a room-sized part. The
accuracy bench now passes 23 of 24 room cases, the open one being a
diagonal door on a scan with no vector layer. Lesson: ship the mechanism,
name the limitation, then measure your way out of it.

## Numbers we can stand behind

- Tier-1 CV scan: **8/8 symbols, ~100–190 ms**, identical results in
  browser and Node (golden-raster check: mean channel delta 2.5/255
  between environments)
- Revision compare on an 86-sheet set: self-compare **86/86 unchanged,
  zero false positives**, ~93 ms per sheet
- Takeoff-as-code: same spec across two revisions reports
  `8 → 5, delta −3` — the exact change between the sheets
- Multi-scale viewports: the same 100 pt run reads **1.76 m inside a 1:50
  viewport, 3.53 m outside it** on a 1:100 page
- OCR calibration reads the printed dimension ("12.00") or the
  title-block scale ("SCALE 1:100") straight into the calibration dialog

## What's next

Three things, honestly scoped: a cross-machine relay for live sessions
(Cloudflare Durable Objects — the same CRDT layer, new transport), a
second generation of the in-browser symbol detector (v1 shipped with five
synthetic classes; real drawings and estimator corrections are next), and the phase our
strategy document has demanded all along — hardening against real tender
sets, with published "works on X" numbers instead of adjectives.

If you estimate for a living: the tool is free, your drawings never leave
your machine, and everything it writes is standard PDF annotations that
open in Revu and Acrobat. If you build: it's Apache-2.0, the architecture
is documented, and trade-specific contributions (HVAC, rebar, electrical)
are the most valuable PRs of all.

— [pdf2takeoff.com](https://pdf2takeoff.com) ·
[github.com/ajflow/pdf2takeoff](https://github.com/ajflow/pdf2takeoff)
