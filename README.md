# `@turntrout/subfont`

[![Build Status](https://github.com/alexander-turner/subfont/actions/workflows/ci.yml/badge.svg)](https://github.com/alexander-turner/subfont/actions/workflows/ci.yml)

A faster fork of [subfont](https://github.com/Munter/subfont) that subsets web fonts to only the characters used on your pages. Adds parallel tracing, disk caching, woff2-only output, and always-on variable font instancing. On [`turntrout.com`](https://github.com/alexander-turner/TurnTrout.com) (382 pages, 20+ font variants), switching to this fork cut font subsetting from [111 minutes](https://github.com/alexander-turner/TurnTrout.com/actions/runs/23470135763) to [28 minutes](https://github.com/alexander-turner/TurnTrout.com/actions/runs/23518006824). 

## Install

```
npm install -g @turntrout/subfont
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

|              Flag | Default | Description                                                  |
| ----------------: | :-----: | :----------------------------------------------------------- |
|  `-i, --in-place` |   off   | Modify files in-place                                        |
|    `-o, --output` |         | Output directory                                             |
| `-r, --recursive` |   off   | Crawl linked pages                                           |
|       `--dynamic` |   off   | Trace with headless browser                                  |
|       `--dry-run` |   off   | Preview without writing                                      |
|     `--fallbacks` |   on    | Load the full original font for characters not in the subset |
|  `--font-display` | `swap`  | `auto`/`block`/`swap`/`fallback`/`optional`                  |
|          `--text` |         | Extra characters for every subset                            |
|   `--cache [dir]` |   off   | Cache subset results to disk between runs                    |
| `--concurrency N` |         | Max worker threads for parallel font tracing                 |
|  `--chrome-flags` |         | Custom Chrome flags for `--dynamic`                          |
|   `--source-maps` |   off   | Preserve CSS source maps (slower)                            |

Run `subfont --help` for the full list.

To include extra characters in a specific font's subset, add `-subfont-text` to its `@font-face`:

```css
@font-face {
  font-family: Roboto;
  src: url(roboto.woff2) format('woff2');
  -subfont-text: '0123456789';
}
```

## Programmatic API

```js
const subfont = require('@turntrout/subfont');

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
