# `@turntrout/subfont`

[![Build Status](https://github.com/alexander-turner/subfont/actions/workflows/ci.yml/badge.svg)](https://github.com/alexander-turner/subfont/actions/workflows/ci.yml)

A faster fork of [subfont](https://github.com/Munter/subfont) that subsets web fonts to only the characters used on your pages. Adds parallel tracing, disk caching, woff2-only output, always-on variable font instancing, and is fully written in TypeScript (the upstream is JavaScript). On [`turntrout.com`](https://github.com/alexander-turner/TurnTrout.com) (382 pages, 20+ font variants), switching to this fork cut font subsetting from [111 minutes](https://github.com/alexander-turner/TurnTrout.com/actions/runs/23470135763) to [28 minutes](https://github.com/alexander-turner/TurnTrout.com/actions/runs/23518006824).

### Aggressive woff2 subsetting

`subfont` produces dramatically smaller font files by stripping data that browsers never use:

| Optimization                 | Technique                                                                               |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| Hinting removal              | Strips TrueType hinting instructions (browsers auto-hint)                               |
| Name table pruning           | Keeps only the 4 IDs browsers read (family, subfamily, full name, PostScript name)      |
| Name lang-ID filter          | Keeps only en-US name strings; drops Japanese, Russian, Korean, etc.                    |
| Table stripping              | Drops `DSIG`, `LTSH`, `VDMX`, `hdmx`, `gasp`, `PCLT`                                    |
| MATH-table drop (gated)      | Drops `MATH` when no math codepoints are used on the page                               |
| Color-table drop (gated)     | Drops `COLR`/`CPAL`/`SVG `/`CBDT`/`CBLC`/`sbix`/`EBDT`/`EBLC`/`EBSC` when no emoji used |
| Layout-script filter (gated) | Drops GSUB/GPOS lookups for OpenType scripts the page doesn't render                    |
| CSS-aware feature retention  | Drops GSUB/GPOS features the page's CSS doesn't reference                               |

Reproducible benchmark on `testdata/subsetFonts/OpenSans-400.ttf` (run with `node scripts/bench-readme.js`); "upstream" = the [`subset-font`](https://github.com/papandreou/subset-font) package the original [Munter/subfont](https://github.com/Munter/subfont) uses, woff2-compressed:

| Text sample       | Upstream subfont | `@turntrout/subfont` | Savings |
| ----------------- | ---------------- | -------------------- | ------- |
| Heading (short)   | 2,604 B          | 828 B                | **68%** |
| Paragraph         | 4,448 B          | 2,072 B              | **53%** |
| Full page charset | 9,388 B          | 5,500 B              | **41%** |

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

|               Flag | Default | Description                                                                           |
| -----------------: | :-----: | :------------------------------------------------------------------------------------ |
|   `-i, --in-place` |   off   | Modify files in-place                                                                 |
|     `-o, --output` |         | Output directory                                                                      |
|           `--root` |         | Path to web root (deduced from input files if not specified)                          |
| `--canonical-root` |         | URI root where the site will be deployed                                              |
|  `-r, --recursive` |   off   | Crawl linked pages                                                                    |
|        `--dynamic` |   off   | Trace with headless browser                                                           |
|        `--dry-run` |   off   | Preview without writing                                                               |
|      `--fallbacks` |   on    | Async-load the full original font as a fallback for dynamic content                   |
|   `--font-display` | `swap`  | `auto`/`block`/`swap`/`fallback`/`optional`                                           |
|           `--text` |         | Extra characters for every subset                                                     |
|    `--cache [dir]` |   off   | Cache subset results to disk between runs                                             |
|  `--concurrency N` |  auto   | Max worker threads (defaults to CPU count, capped by available memory at ~50 MB each) |
|   `--chrome-flags` |         | Custom Chrome flags for `--dynamic` (comma-separated)                                 |
|    `--source-maps` |   off   | Preserve CSS source maps (slower)                                                     |
|         `--strict` |   off   | Exit non-zero if any warnings are emitted                                             |
|     `-s, --silent` |   off   | Suppress all console output                                                           |
|      `-d, --debug` |   off   | Verbose timing and font glyph detection info                                          |
|  `--relative-urls` |   off   | Emit relative URLs instead of root-relative                                           |
|     `--inline-css` |   off   | Inline the subset @font-face CSS into HTML                                            |

Run `subfont --help` for the full list.

### Environment variables

| Variable                    | Description                                                                    |
| --------------------------- | ------------------------------------------------------------------------------ |
| `PUPPETEER_EXECUTABLE_PATH` | Path to a Chrome/Chromium binary; skips auto-download when `--dynamic` is used |

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

### Parameters

`subfont(options, console)` — the second argument is an optional logger (anything
with `log`, `warn`, and `error` methods — e.g. the global `console`). Pass
`null` together with `silent: true` to suppress all output.

The `options` object accepts the following keys:

| Option          | Type                | Default  | Description                                                                                                                                |
| --------------- | ------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `inputFiles`    | `string[]`          | `[]`     | HTML entry points (file paths or URLs). At least one is required unless `root` is given.                                                   |
| `root`          | `string`            | deduced  | Path or URL to the web root. Deduced from `inputFiles` if omitted.                                                                         |
| `canonicalRoot` | `string`            | —        | URI root where the site will be deployed (used to rewrite absolute URLs).                                                                  |
| `output`        | `string`            | —        | Output directory. Mutually exclusive with `inPlace`.                                                                                       |
| `inPlace`       | `boolean`           | `false`  | Modify input files in place.                                                                                                               |
| `dryRun`        | `boolean`           | `false`  | Trace and compute subsets but do not write any files.                                                                                      |
| `recursive`     | `boolean`           | `false`  | Crawl linked pages starting from `inputFiles`.                                                                                             |
| `dynamic`       | `boolean`           | `false`  | Trace JS-rendered content in headless Chrome (via puppeteer).                                                                              |
| `fallbacks`     | `boolean`           | `true`   | Async-load the full original font as a fallback for dynamic content.                                                                       |
| `fontDisplay`   | `string`            | `'swap'` | `font-display` CSS value: `auto`, `block`, `swap`, `fallback`, or `optional`.                                                              |
| `text`          | `string`            | —        | Extra characters to include in every subset.                                                                                               |
| `inlineCss`     | `boolean`           | `false`  | Inline the subset `@font-face` CSS into the HTML document.                                                                                 |
| `relativeUrls`  | `boolean`           | `false`  | Emit relative URLs instead of root-relative URLs.                                                                                          |
| `sourceMaps`    | `boolean`           | `false`  | Preserve CSS source maps (slower).                                                                                                         |
| `concurrency`   | `number`            | auto     | Max parallel tracing workers. Defaults to CPU count, capped by available memory (~50 MB per worker).                                       |
| `chromeFlags`   | `string[]`          | `[]`     | Extra Chrome flags forwarded to puppeteer when `dynamic` is set.                                                                           |
| `cache`         | `boolean \| string` | `false`  | Cache subset results between runs. Pass a path to customize the cache directory; `true` uses `.subfont-cache` inside the `root` directory. |
| `strict`        | `boolean`           | `false`  | Resolve with a non-zero exit (via the CLI) if any warnings are emitted.                                                                    |
| `silent`        | `boolean`           | `false`  | Suppress all log output to `console`.                                                                                                      |
| `debug`         | `boolean`           | `false`  | Emit verbose timing and glyph-detection info.                                                                                              |

## License

MIT -- Original work by [Peter Muller (Munter)](https://github.com/Munter/subfont)
