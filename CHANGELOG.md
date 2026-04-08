# Changelog

## 1.0.0 -- Hard fork from [Munter/subfont](https://github.com/Munter/subfont)

Published as `@alexander-turner/subfont`. Based on Munter/subfont v7.2.3.

### Performance

On [TurnTrout.com](https://github.com/alexander-turner/TurnTrout.com) (382 pages), font subsetting dropped from 111 minutes to 28 minutes:

|                                                                                      | Version        | Duration |
| ------------------------------------------------------------------------------------ | -------------- | -------- |
| [Before](https://github.com/alexander-turner/TurnTrout.com/actions/runs/23470135763) | Munter/subfont | 111 min  |
| [After](https://github.com/alexander-turner/TurnTrout.com/actions/runs/23518006824)  | This fork      | 28 min   |

### Breaking changes

- **woff2-only.** Removed `--browsers` and `--formats`. Every browser supports woff2.
- **Always-on variable font instancing.** Removed `--instance`. If you use weights 400 and 700 from a 100-900 variable font, the subset shrinks to just that range automatically.
- **Removed legacy flags:** `--skip-source-map-processing`, `--dryrun`/`--dry`/`--canonicalroot`/`--sourceMaps` aliases, and v5 flag validation.

### New features

- **`--cache [dir]`** -- Cache subset results to disk. Speeds up repeat builds.
- **`--chrome-flags`** -- Custom flags for headless Chrome with `--dynamic`.
- **`--concurrency N`** -- Control worker thread count for parallel font tracing.
- **Parallel font tracing** -- Worker pool (up to 8 threads). Pages sharing identical CSS are traced once.
- **`--root` validation** -- Fails early with a clear error.
- **Timing summary** -- Printed after every run.
- **Better `--dry-run`** -- Detailed preview of files, sizes, and CSS changes.

### Bug fixes

- Fixed crash on invalid/corrupt font files during instancing.
- Fixed incorrect axis range computation for variable fonts.
