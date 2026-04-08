# @alexander-turner/subfont

[![Build Status](https://github.com/alexander-turner/subfont/actions/workflows/ci.yml/badge.svg)](https://github.com/alexander-turner/subfont/actions/workflows/ci.yml)

Automatically subset web fonts to only the characters used on your pages, then inject them optimally. Reduces font payloads and time to first meaningful paint.

> Hard fork of [Munter/subfont](https://github.com/Munter/subfont) with modern defaults: woff2-only, always-on variable font instancing, disk caching, and worker pool parallelism. See [CHANGELOG.md](CHANGELOG.md) for full details.

- Detects exactly which characters and variable font axes are actually used
- Creates minimal woff2 subsets via HarfBuzz
- Automatically reduces variable font axis ranges to actual usage
- Adds preload hints and async-loads original fonts as fallback
- Supports Google Fonts and self-hosted fonts

## Performance

On [TurnTrout.com](https://github.com/alexander-turner/TurnTrout.com) (382 pages, 20+ font variants), switching from upstream subfont to this fork cut the font subsetting step from **~107 minutes to ~30 minutes** -- a 3.5x speedup.

| Run                                                                                  | Version        | Duration |
| ------------------------------------------------------------------------------------ | -------------- | -------- |
| [Before](https://github.com/alexander-turner/TurnTrout.com/actions/runs/23470135763) | Munter/subfont | 111 min  |
| [After](https://github.com/alexander-turner/TurnTrout.com/actions/runs/23518006824)  | This fork      | 28 min   |

The gains come from parallel font tracing (worker pool), fast-path CSS caching (pages sharing identical stylesheets are traced once), and woff2-only output (half the subsetting work).

## Install

```
npm install -g @alexander-turner/subfont
```

Requires Node.js >= 18.

## Usage

```bash
# Optimize build artifacts in-place (recommended)
subfont path/to/dist/index.html -i

# Preview without writing
subfont path/to/dist/index.html --dry-run

# Output to a separate directory
subfont path/to/index.html -o path/to/output

# Crawl all linked pages
subfont path/to/index.html -i --recursive

# Also trace JS-rendered content in headless Chrome
subfont path/to/index.html -i --dynamic

# Cache subset results between runs
subfont path/to/index.html -i --cache
```

## Including additional characters

If tracing misses characters you need, add them per-font via CSS:

```css
@font-face {
  font-family: Roboto;
  font-weight: 700;
  src: url(roboto.woff) format('woff');
  -subfont-text: '0123456789';
}
```

Or globally via `--text '0123456789'`.

## Key options

| Flag              | Default | Description                                       |
| ----------------- | ------- | ------------------------------------------------- |
| `-i, --in-place`  | off     | Modify files in-place                             |
| `-o, --output`    |         | Output directory                                  |
| `-r, --recursive` | off     | Crawl linked pages                                |
| `--dynamic`       | off     | Trace with headless browser                       |
| `--dry-run`       | off     | Preview without writing                           |
| `--fallbacks`     | on      | Async-load full original font for dynamic content |
| `--font-display`  | `swap`  | `auto`/`block`/`swap`/`fallback`/`optional`       |
| `--text`          |         | Extra characters for every subset                 |
| `--cache [dir]`   | off     | Cache subset results to disk between runs         |
| `--concurrency N` |         | Max worker threads for parallel font tracing      |
| `--chrome-flags`  |         | Custom Chrome flags for `--dynamic`               |
| `--source-maps`   | off     | Preserve CSS source maps (slower)                 |

Run `subfont --help` for the full list.

## Programmatic API

```js
const subfont = require('@alexander-turner/subfont');

const assetGraph = await subfont(
  {
    inputFiles: ['path/to/index.html'],
    inPlace: true,
  },
  console
);
```

Returns the [Assetgraph](https://github.com/assetgraph/assetgraph) instance.

## License

MIT -- Original work by [Peter Muller (Munter)](https://github.com/Munter/subfont)
