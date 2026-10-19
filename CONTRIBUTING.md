# Contributing to pdf2takeoff

Thanks for wanting to help. This page sets expectations up front so nobody
wastes their time — including yours.

## The most valuable contribution isn't code

We're building a takeoff tool for estimators, so the single most useful thing
you can contribute is **knowledge of the trade**: what does your takeoff
actually look like? Which symbols do you count by hand, on which trades, and
what does your boss want in the Excel export? Open an issue titled
`[trade] …` describing your workflow. That shapes the roadmap more than any PR.

## Ground rules

1. **Issue first, PR second.** For anything beyond a typo or obvious bug fix,
   open an issue and get a 👍 before writing code. Unrequested feature PRs
   will be closed politely.
2. **Small, scoped PRs.** One thing per PR. If it touches more than ~3 files or
   restructures anything, it needs an agreed issue and probably should be
   discussed in stages.
3. **CI must pass.** `npm ci && npm run build` green is the first review.
4. **No new dependencies without discussion.** The permissive-licence,
   zero-backend architecture is a feature (see STRATEGY.md). Propose the dep in
   an issue first.
5. **No drive-by refactors, formatting sweeps, framework migrations or
   "modernisation" PRs.** They will be closed.
6. **Describe how you verified it.** Which drawing (the bundled samples are
   fine), which browser, what you clicked, what you saw. UI changes need a
   screenshot.

## What we especially want

- Bug reports with real drawings described (vector vs scanned, page size,
  what broke)
- Trade-specific measurement needs (rebar? duct runs? cable lengths?)
- Accessibility fixes
- Small, boring, correct fixes

## Development quickstart

```bash
npm ci
npm run dev      # http://localhost:5173
npm run sample   # regenerate the demo drawings
npm run build    # typecheck + production build
```

The bundled sample (`Try the sample drawing`) has a printed 12.00 m dimension
for testing calibration, repeated symbols for testing Scan, and a revision B
for testing overlay compare.

## Licensing your contribution

By contributing, you agree that:

1. Your contributions are licensed under the project's Apache-2.0 licence,
   and you keep your copyright — the project stays Apache-2.0.
2. You also grant the project maintainer (A.J Awan) a broad, perpetual,
   royalty-free, non-exclusive licence to use and redistribute your
   contributions as part of the project under any licence chosen for future
   versions — including a change away from Apache-2.0. Nothing like that is
   planned; this clause just keeps the project's options open instead of
   locking them in 2026.
3. If your contribution was made as part of your employment or using an
   employer's resources, you confirm your employer is fine with this grant.
   If in doubt, contribute personally or attach your employer's written OK
   to the PR.

If any of that doesn't work for you, open an issue describing the change
instead — the maintainer can implement it.

## Conduct

Be civil and constructive. Estimators, developers, students and suppliers are
all welcome here; gatekeeping isn't.
