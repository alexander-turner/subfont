# `@turntrout/subfont`

[![Build Status](https://github.com/alexander-turner/subfont/actions/workflows/ci.yml/badge.svg)](https://github.com/alexander-turner/subfont/actions/workflows/ci.yml)

A faster fork of [subfont](https://github.com/Munter/subfont) that subsets web fonts to only the characters used on your pages. Adds parallel tracing, disk caching, woff2-only output, and always-on variable font instancing. On [`turntrout.com`](https://github.com/alexander-turner/TurnTrout.com) (382 pages, 20+ font variants), switching to this fork cut font subsetting from [111 minutes](https://github.com/alexander-turner/TurnTrout.com/actions/runs/23470135763) to [28 minutes](https://github.com/alexander-turner/TurnTrout.com/actions/runs/23518006824).

### Aggressive woff2 subsetting

subfont produces dramatically smaller font files by stripping data that browsers never use:

| Optimization                | Technique                                                                          |
| --------------------------- | ---------------------------------------------------------------------------------- |
| Hinting removal             | Strips TrueType hinting instructions (browsers auto-hint)                          |
| Name table pruning          | Keeps only the 4 IDs browsers read (family, subfamily, full name, PostScript name) |
| Table stripping             | Drops DSIG, LTSH, VDMX, hdmx, gasp, PCLT                                           |
| CSS-aware feature filtering | Only collects alternate glyphs for OpenType features actually used in your CSS     |

On the [`turntrout.com/design`](https://turntrout.com/design) page, a typical font subset (OpenSans, woff2) is **48-68% smaller** than a naive subset of the same glyphs:

| Text sample       | Naive subset | subfont | Savings |
| ----------------- | ------------ | ------- | ------- |
| Heading (short)   | 2,604 B      | 824 B   | **68%** |
| Paragraph         | 4,052 B      | 1,840 B | **55%** |
| Full page charset | 5,268 B      | 2,716 B | **48%** |

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

|               Flag | Default | Description                                                  |
| -----------------: | :-----: | :----------------------------------------------------------- |
|   `-i, --in-place` |   off   | Modify files in-place                                        |
|     `-o, --output` |         | Output directory                                             |
|           `--root` |         | Path to web root (deduced from input files if not specified) |
| `--canonical-root` |         | URI root where the site will be deployed                     |
|  `-r, --recursive` |   off   | Crawl linked pages                                           |
|        `--dynamic` |   off   | Trace with headless browser                                  |
|        `--dry-run` |   off   | Preview without writing                                      |
|      `--fallbacks` |   on    | Load the full original font for characters not in the subset |
|   `--font-display` | `swap`  | `auto`/`block`/`swap`/`fallback`/`optional`                  |
|           `--text` |         | Extra characters for every subset                            |
|    `--cache [dir]` |   off   | Cache subset results to disk between runs                    |
|  `--concurrency N` |         | Max worker threads (capped by available memory, ~50 MB each) |
|   `--chrome-flags` |         | Custom Chrome flags for `--dynamic`                          |
|    `--source-maps` |   off   | Preserve CSS source maps (slower)                            |
|         `--strict` |   off   | Exit non-zero if any warnings are emitted                    |
|     `-s, --silent` |   off   | Suppress all console output                                  |
|      `-d, --debug` |   off   | Verbose timing and font glyph detection info                 |
|  `--relative-urls` |   off   | Emit relative URLs instead of root-relative                  |
|     `--inline-css` |   off   | Inline the subset @font-face CSS into HTML                   |

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
