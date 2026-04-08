# subfont

[![Build Status](https://github.com/Munter/subfont/actions/workflows/ci.yml/badge.svg)](https://github.com/Munter/subfont/actions/workflows/ci.yml)

Automatically subset web fonts to only the characters used on your pages, then inject them optimally. Reduces font payloads and time to first meaningful paint.

- Detects exactly which characters and variable font axes are actually used
- Creates minimal woff2/woff subsets via HarfBuzz
- Adds preload hints and async-loads original fonts as fallback
- Supports Google Fonts and self-hosted fonts

![A site before and after running subfont](https://raw.githubusercontent.com/Munter/subfont/master/images/before-after.png)

## Install

```
npm install -g subfont
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
| `--source-maps`   | off     | Preserve CSS source maps (slower)                 |

Run `subfont --help` for the full list.

## Programmatic API

```js
const subfont = require('subfont');

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

MIT -- [Peter Muller (Munter)](https://github.com/Munter/subfont)
