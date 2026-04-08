# Changelog

## 9.0.0 -- Hard fork from [Munter/subfont](https://github.com/Munter/subfont)

Hard fork of subfont v8.0.0 with modern defaults and new features. Published as `@alexander-turner/subfont`.

### Breaking changes

- **woff2-only output.** Removed `--browsers` and `--formats` flags. Every browser has supported woff2 since 2016 -- no reason to generate woff/truetype anymore.
- **Always-on variable font instancing.** Removed `--instance` flag. If your variable font supports weights 100-900 but you only use 400 and 700, the subset automatically shrinks to just that range.
- **Removed legacy flags:** `--skip-source-map-processing`, `--dryrun`/`--dry`/`--canonicalroot`/`--sourceMaps` aliases, and validation for long-removed v5 flags.

### New features

- **`--cache [dir]`** -- Cache subset results to disk between builds. Dramatically speeds up repeat runs when fonts and text haven't changed.
- **`--chrome-flags`** -- Pass custom flags to the headless Chrome used with `--dynamic` (e.g., `--chrome-flags=--no-sandbox,--disable-gpu`).
- **`--concurrency N`** -- Control how many worker threads trace fonts in parallel. Defaults to CPU count (max 8).
- **`--root` validation** -- Fails early with a clear message instead of a confusing error deep in the pipeline.
- **Timing summary** -- Every run prints a structured timing breakdown, useful for CI optimization.
- **Better `--dry-run`** -- Shows a detailed preview of files, sizes, and CSS changes.
- **Parallel font tracing** -- Worker pool traces fonts across pages concurrently. Pages sharing identical CSS reuse a single trace, re-extracting only the text.

### Bug fixes

- Fixed crash on invalid/corrupt font files when variable font instancing runs.
- Fixed incorrect axis range computation for variable fonts.

### Differences from upstream

| Feature                    | Munter/subfont              | This fork              |
| -------------------------- | --------------------------- | ---------------------- |
| Font formats               | woff2 + woff + ttf (auto)   | woff2 only             |
| Variable font instancing   | Opt-in (`--instance`)       | Always on              |
| Disk cache                 | No                          | `--cache`              |
| Chrome flags               | No                          | `--chrome-flags`       |
| Concurrency control        | No                          | `--concurrency`        |
| Parallel font tracing      | No                          | Worker pool (up to 8)  |
| Fast-path CSS caching      | No                          | Automatic              |
| `--root` validation        | Late confusing error        | Early clear error      |
| Timing summary             | Debug-only                  | Always printed         |
| `--dry-run` detail         | Minimal                     | Full file/size preview |
| Legacy flags/aliases       | Supported                   | Removed                |
