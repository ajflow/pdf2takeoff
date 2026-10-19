# Hosting & cost controls (Cloudflare free tier)

pdf2takeoff.com runs entirely on **free** Cloudflare Pages static hosting.
This document is the review of what can and cannot cost money, and the rules
that keep it that way. `scripts/check-deploy.mjs` enforces them in CI.

## The one fact that matters

**Cloudflare free plans never bill for overages — they cut you off.** Exceed
a free limit and requests get throttled (Workers/Functions: HTTP 429 after
100k/day), builds stop (Pages: 500/month), or the deploy is rejected (too
many/too large files). Charges only happen if a paid plan is explicitly
enabled in the Cloudflare dashboard. So our exposure is not "surprise bill" —
it is (a) the site breaking at a limit, and (b) drifting onto a metered
service and later flipping the billing switch. The controls below target
both.

## What runs where (and who pays for it)

| Piece | Hosted on | Cost to us |
| --- | --- | --- |
| Site (`dist/`: HTML, JS, CSS, sample PDFs, manifest) | Cloudflare Pages, static | free, unlimited requests & bandwidth |
| `onnxruntime-web` WASM (~4 MB, lazy) | jsDelivr CDN | none (their bandwidth) |
| OCR language packs (~4 MB, lazy, then cached) | tesseract.js CDN | none |
| Detector model binaries (`*.onnx`) | `model-v1` git branch, served via `raw.githubusercontent.com` (absolute URL in `symbols.json` manifest) | none (GitHub's bandwidth) — never ship them in `dist/` |
| Live sessions (same-machine) | Browser BroadcastChannel | none |

No Workers, Pages Functions, R2, D1, KV or Durable Objects are used anywhere.

## Free limits that apply to us

| Limit | Free value | What happens when hit |
| --- | --- | --- |
| Files per Pages site | 20,000 | deploy rejected |
| File size per asset | 25 MiB | deploy rejected |
| Pages builds | 500/month | new builds fail until next month |
| Static requests / bandwidth | unlimited | — |
| Workers/Functions requests (if ever added) | 100k/day | HTTP 429 until midnight UTC |

Current site: ~20 files, ~4 MiB total. We are nowhere near any limit; the
guard exists so that never changes by accident.

## Rules (enforced by `scripts/check-deploy.mjs`, wired into CI)

1. **The site stays 100% static.** No `functions/` directory, no
   `wrangler.toml|json|jsonc` in the repo. Adding server-side code is the
   only path to a metered service, so it must be a conscious decision: update
   this doc and the guard together in the same PR that adds it.
2. **No `.onnx` binaries in `dist/` or `public/models/`.** Models ship from
   the `model-v1` branch (`.gitignore` also blocks committing them; the
   manifest's `"model"` field takes an absolute URL).
3. **Deploy size sanity:** ≤ 20,000 files, ≤ 25 MiB per file. Today's build
   is ~4 MiB; if `dist/` ever grows past tens of MiB, that is bloat to
   investigate, not a limit to chase.

## Build budget (500/month)

Deploys via the Pages Git integration consume one build per push to `main`.
500/month is ample for this repo's pace. If it ever gets tight: GitHub
Actions already builds `dist/` on every push — deploy it with
`npx wrangler pages deploy dist --project-name=pdf2takeoff` from CI instead.
Direct uploads do **not** consume the Pages build allowance.

## If server-side ever lands (e.g. the cross-machine live relay)

Roadmap phase 4 mentions a cross-machine relay. If it is built on Cloudflare
it must, in this order:

1. Stay on the Workers **free** plan: ≤ 100k requests/day, and implement its
   own hard request cap that starts returning 429 well before the daily
   limit, with a `/limits` status endpoint so failure is diagnosable.
2. Be stateless or use free-tier storage within caps — no always-on
   Durable Objects (they require the paid plan).
3. **Never enable billing** without an explicit written decision in this
   doc. Until then, hitting the cap and refusing relay traffic for the day is
   the correct failure mode — the app's same-machine Live mode and all core
   tools keep working without the relay.
