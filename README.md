# @alexander-turner/subfont

[![Build Status](https://github.com/alexander-turner/subfont/actions/workflows/ci.yml/badge.svg)](https://github.com/alexander-turner/subfont/actions/workflows/ci.yml)

Automatically subset web fonts to only the characters actually used on your pages. Reduces font payloads and time to first meaningful paint.

> Hard fork of [Munter/subfont](https://github.com/Munter/subfont). See [CHANGELOG.md](CHANGELOG.md) for what changed.

## Performance

On [TurnTrout.com](https://github.com/alexander-turner/TurnTrout.com) (382 pages, 20+ font variants), switching to this fork cut font subsetting from **111 minutes to 28 minutes**:

|                                                                                      | Version        | Duration |
| ------------------------------------------------------------------------------------ | -------------- | -------- |
| [Before](https://github.com/alexander-turner/TurnTrout.com/actions/runs/23470135763) | Munter/subfont | 111 min  |
| [After](https://github.com/alexander-turner/TurnTrout.com/actions/runs/23518006824)  | This fork      | 28 min   |

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

# Trace JS-rendered content in headless Chrome
subfont path/to/index.html -i --dynamic

# Cache subset results between runs
subfont path/to/index.html -i --cache
```

## Options

| Flag              | Default | Description                                                  |
| ----------------- | ------- | ------------------------------------------------------------ |
| `-i, --in-place`  | off     | Modify files in-place                                        |
| `-o, --output`    |         | Output directory                                             |
| `-r, --recursive` | off     | Crawl linked pages                                           |
| `--dynamic`       | off     | Trace with headless browser                                  |
| `--dry-run`       | off     | Preview without writing                                      |
| `--fallbacks`     | on      | Load the full original font for characters not in the subset |
| `--font-display`  | `swap`  | `auto`/`block`/`swap`/`fallback`/`optional`                  |
| `--text`          |         | Extra characters for every subset                            |
| `--cache [dir]`   | off     | Cache subset results to disk between runs                    |
| `--concurrency N` |         | Max worker threads for parallel font tracing                 |
| `--chrome-flags`  |         | Custom Chrome flags for `--dynamic`                          |
| `--source-maps`   | off     | Preserve CSS source maps (slower)                            |

Run `subfont --help` for the full list. You can also include extra characters per-font by adding `-subfont-text: '0123456789'` to any `@font-face` declaration.

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
