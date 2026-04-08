# Changelog

## 9.0.0 — Hard fork from [Munter/subfont](https://github.com/Munter/subfont)

This is a hard fork of subfont v8.0.0 with opinionated modern defaults, removed legacy baggage, and new features. It is published as `@alexander-turner/subfont`.

### Breaking changes

- **woff2-only output.** Removed `--browsers` and `--formats` flags. Subsets are always generated in woff2 only — every browser has supported it since 2016. The `browserslist` dependency is removed.
- **Always-on variable font instancing.** Removed `--instance` flag. Variable font axis ranges are always reduced to actual usage. There is no opt-out.
- **Removed backwards-compat flags and aliases:**
  - `--skip-source-map-processing` (use `--source-maps` / `--no-source-maps`)
  - `--dryrun`, `--dry` aliases (use `--dry-run`)
  - `--canonicalroot` alias (use `--canonical-root`)
  - `--sourceMaps` alias (use `--source-maps`)
  - Legacy `.check()` validation for `--harfbuzz`, `--subset-per-page`, `--inline-fonts` (subfont v5 flags)

### New features

- **`--cache [dir]`** — Disk caching of subset font results between runs. Dramatically speeds up repeat builds when fonts and text haven't changed. Defaults to `.subfont-cache` when passed without a value.
- **`--chrome-flags`** — Custom flags for the headless Chrome instance used with `--dynamic` (e.g., `--chrome-flags=--no-sandbox,--disable-gpu`).
- **`--concurrency N`** — Control the number of worker threads for parallel font tracing. Defaults to CPU count (max 8).
- **`--root` validation** — Early error with a clear message when `--root` points to a nonexistent directory, instead of a confusing assetgraph error later.
- **Timing summary** — Always prints a structured timing breakdown at the end of each run, visible in CI logs.
- **Dry-run preview** — `--dry-run` now shows a detailed preview of files, sizes, and CSS changes that would be made.
- **Fast-path optimization** — Pages sharing identical CSS configurations reuse a single font-tracer run. Only the HTML text content is re-extracted.
- **Worker pool** — Font tracing runs in parallel across worker threads (up to 8).

### Bug fixes

- **Invalid font crash fix.** `getVariationAxisBounds` now handles invalid/corrupt fonts with a try/catch instead of crashing. Exposed by always-on instancing.
- **Axis range narrowing bug.** Fixed incorrect min/max computation for variable font axis bounds.

### Code cleanup

- Deleted `warnAboutUnusedVariationAxes` function (~90 lines) — dead code since instancing is always on.
- Deleted `outOfBoundsAxesByFontUrl` tracking — only consumer was the removed warning function.
- Deleted `hasOutOfBoundsAnimationTimingFunction` computation and propagation — orphaned dead code that was parsing cubic-bezier timing functions on every font entry for no reason.
- Removed unused `parseAnimationShorthand` import from `collectTextsByPage.js`.
- Removed `browserslist` dependency.
- ~800 lines removed net.

### Differences from upstream (Munter/subfont v8.0.0)

| Feature | Munter/subfont | This fork |
| --- | --- | --- |
| Font formats | Auto-detected via browserslist (woff2 + woff + truetype) | woff2 only |
| Variable font instancing | Opt-in via `--instance` | Always on |
| `--browsers` flag | Supported | Removed |
| `--formats` flag | Supported | Removed |
| `--skip-source-map-processing` | Supported (hidden) | Removed |
| Legacy v5 flag validation | Active | Removed |
| CLI aliases (`--dryrun`, etc.) | Supported | Removed |
| Disk cache (`--cache`) | Not available | New |
| Chrome flags (`--chrome-flags`) | Not available | New |
| Concurrency control (`--concurrency`) | Not available | New |
| `--root` validation | Late error from assetgraph | Early clear error |
| Timing summary | Debug-only | Always printed |
| Dry-run preview | Minimal | Detailed file/size breakdown |
| Worker pool for font tracing | Not available | New (up to 8 workers) |
| Fast-path CSS caching | Not available | New |
