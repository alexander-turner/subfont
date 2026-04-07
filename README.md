# subfont

[![Build Status](https://github.com/Munter/subfont/actions/workflows/ci.yml/badge.svg)](https://github.com/Munter/subfont/actions/workflows/ci.yml)

A command line tool and Node.js library that optimizes web font loading by automatically subsetting fonts to include only the characters actually used on your pages.

Subfont reduces time to first meaningful paint by shrinking font payloads and shortening the critical path to font files.

## What it does

- Analyzes your pages to detect exactly which characters are used from each font
- Creates minimal subsets containing only those characters
- Reduces variable font variation space based on actual usage (`--instance`)
- Generates subsets in `woff2` and `woff` formats (configurable)
- Adds `<link rel="preload">` hints for subset fonts
- Renames subsetted fonts and prepends them in `font-family` declarations, preserving missing-glyph fallback to the original font
- Moves original `@font-face` CSS off the critical path via async loading with `<noscript>` fallback
- Warns about characters used on your pages that don't exist in the applied font
- Supports OpenType features (`font-feature-settings`, `font-variant-*`) by preserving GSUB alternate glyphs in subsets

![A site before and after running subfont](https://raw.githubusercontent.com/Munter/subfont/master/images/before-after.png)

## Supported font sources

- Google Fonts
- Self-hosted / local fonts

## Installation

```
npm install -g subfont
```

Requires Node.js >= 18.

## Quick start

Run on your build output before deploying:

```bash
subfont path/to/dist/index.html -i
```

This modifies the HTML files in place (`-i`). For a preview without writing changes:

```bash
subfont path/to/dist/index.html --dry-run
```

## Usage

### On build artifacts (recommended)

Run subfont on the files you are ready to deploy. If these are build artifacts from another build system, use `-i` (in-place) to modify them directly:

```bash
subfont path/to/artifacts/index.html -i
```

### Output to a separate directory

Copy processed files to a new directory using `-o`:

```bash
subfont path/to/index.html -o path/to/output
```

This uses [Assetgraph](https://github.com/assetgraph/assetgraph) to trace your site's dependency graph and write it to the output directory. Check for warnings that might indicate issues with your markup.

### Multi-page sites

Crawl all linked pages with `--recursive`:

```bash
subfont path/to/index.html -i --recursive
```

### Remote URLs

You can point subfont at a live URL (requires `--output`):

```bash
subfont https://example.com -o path/to/output
```

This is mainly useful for quick demos. Results may vary since the tool is designed for static file analysis.

### Dynamic content tracing

By default, subfont performs static analysis of your HTML and CSS. If your pages inject content via JavaScript, use `--dynamic` to also trace font usage in a headless browser:

```bash
subfont path/to/index.html -i --dynamic
```

This launches a headless Chrome instance and detects fonts applied to dynamically rendered text.

### Variable font instancing

If your variable fonts use only a portion of their variation space (e.g., only weights 400 and 700 out of 100-900), use `--instance` to reduce the axis ranges in the subset:

```bash
subfont path/to/index.html -i --instance
```

This can significantly reduce file sizes for variable fonts with broad axis ranges.

## Including additional characters

If automatic tracing misses characters you need (e.g., content loaded at runtime), you can ensure they're included in subsets.

### Per-font via CSS

Add a `-subfont-text` property to specific `@font-face` declarations:

```css
@font-face {
  font-family: Roboto;
  font-style: italic;
  font-weight: 700;
  src: url(roboto.woff) format('woff');
  -subfont-text: '0123456789';
}
```

### Globally via CLI

Include characters in every subset with `--text`:

```bash
subfont index.html -i --text '0123456789!@#$%'
```

## Command line options

```
$ subfont --help
Create optimal font subsets from your actual font usage.
subfont [options] <htmlFile(s) | url(s)>

Options:
  --help                             Show help                                           [boolean]
  --version                          Show version number                                 [boolean]
  --root                             Path to your web root (will be deduced from your input files
                                     if not specified)                                    [string]
  --canonical-root                   URI root where the site will be deployed. Must be either an
                                     absolute, a protocol-relative, or a root-relative url[string]
  --output, -o                       Directory where results should be written to         [string]
  --browsers                         Override your project's browserslist configuration to specify
                                     which browsers to support. Controls font formats.    [string]
  --formats                          Font formats to subset into. Defaults based on --browsers.
                                                    [array] [choices: "woff2", "woff", "truetype"]
  --text                             Additional characters to include in every subset     [string]
  --fallbacks                        Load original fonts as fallback for dynamic content.
                                     Disable with --no-fallbacks            [boolean] [default: true]
  --dynamic                          Trace font usage in a headless browser with JS enabled
                                                                            [boolean] [default: false]
  --in-place, -i                     Modify HTML files in-place. Only use on build artifacts
                                                                            [boolean] [default: false]
  --inline-css                       Inline the subset @font-face CSS into HTML
                                                                            [boolean] [default: false]
  --font-display                     Inject a font-display value into subset @font-face rules
             [string] [choices: "auto", "block", "swap", "fallback", "optional"] [default: "swap"]
  --recursive, -r                    Crawl all HTML pages linked with relative and root-relative
                                     links within your domain              [boolean] [default: false]
  --relative-urls                    Emit relative URLs instead of root-relative
                                                                            [boolean] [default: false]
  --instance                         Reduce variable font variation space based on actual usage
                                                                            [boolean] [default: false]
  --source-maps                      Preserve CSS source maps (off by default for speed)
                                                                            [boolean] [default: false]
  --silent, -s                       Suppress all stdout output             [boolean] [default: false]
  --debug, -d                        Verbose font glyph detection output    [boolean] [default: false]
  --dry-run                          Preview changes without writing to disk
                                                                            [boolean] [default: false]
```

## Programmatic API

```js
const subfont = require('subfont');

const assetGraph = await subfont(
  {
    inputFiles: ['path/to/index.html'],
    inPlace: true,
    formats: ['woff2'],
    fontDisplay: 'swap',
    instance: false,
    dynamic: false,
  },
  console
);
```

The function returns the [Assetgraph](https://github.com/assetgraph/assetgraph) instance after processing.

## How it works

1. **Load & populate**: Parses input HTML and follows CSS relations (stylesheets, `@import`, `@font-face src`) to build an asset graph
2. **Trace font usage**: For each page, runs [font-tracer](https://github.com/nicolo-ribaudo/font-tracer) to determine which font-family/weight/style combinations are used and which text characters they render. Uses a worker pool for parallel tracing on multi-page sites.
3. **Generate subsets**: Uses [HarfBuzz](https://github.com/nicolo-ribaudo/harfbuzzjs) (via WASM) to create minimal font subsets. Supports glyph-level subsetting including OpenType feature alternates (ligatures, stylistic sets, etc.)
4. **Optimize variable fonts** (with `--instance`): Analyzes which axis values are actually used and constrains or pins axes to reduce file size
5. **Inject into HTML/CSS**: Adds subset `@font-face` declarations with `unicode-range`, prepends subset font names in `font-family` properties, adds preload hints, and async-loads the original font CSS as a fallback

## Performance on large sites

Subfont includes several optimizations for sites with many pages:

- **Fast-path caching**: Pages sharing identical CSS configurations reuse a single font-tracer run; only the HTML text content is re-extracted
- **Worker pool**: Font tracing runs in parallel across worker threads (up to 8 workers)
- **Global deduplication**: Font subsets are computed once per unique font URL, then shared across all pages
- **Pre-indexed relations**: Asset graph lookups use pre-built indices to avoid repeated O(n) scans

Run with `--debug` to see detailed timing breakdowns.

## Related tools

- [Fontsquirrel Webfont Generator](https://www.fontsquirrel.com/tools/webfont-generator)
- [Font Style Matcher](https://meowni.ca/font-style-matcher/)
- [Google Fonts](https://fonts.google.com/) (natively supports `text=` parameter for subsetting)

## License

MIT -- Original work by [Peter Muller (Munter)](https://github.com/Munter/subfont)
