# CLAUDE.md — subfont

## Project Overview

subfont is a CLI tool and Node.js library that speeds up initial page paint by automatically subsetting local or Google fonts and loading them optimally. It uses puppeteer to trace font usage across pages and generates optimized font subsets.

## Development Commands

```bash
pnpm install          # Install dependencies
pnpm test             # Run mocha tests + lint
pnpm run lint         # ESLint + Prettier check
pnpm run coverage     # Run tests with nyc coverage
pnpm run check-coverage  # Verify coverage thresholds
```

## Code Style

- **Formatter**: Prettier with single quotes, trailing commas (es5)
- **Linter**: ESLint via neostandard + eslint-config-prettier
- **Rules**: `prefer-template`, `prefer-const` (destructuring: all)
- **Tests**: Mocha with `unexpected` assertion library (not chai/jest)
- No exclusive tests (`describe.only`, `it.only`) — enforced by eslint-plugin-mocha

## Project Structure

- `lib/` — Source code (entry: `lib/subfont.js`, CLI: `lib/cli.js`)
- `test/` — Mocha test files
- `testdata/` — HTML fixtures and font files for tests
- `cases/` — Additional test case data

## Key Architecture

- Built on **assetgraph** for HTML/CSS asset graph traversal
- Uses **puppeteer-core** for headless browser font tracing
- **font-tracer** traces which fonts are used on each page
- **subset-font** / **harfbuzzjs** for WOFF2 subsetting
- `lib/subsetFonts.js` — Main orchestration logic
- `lib/FontTracerPool.js` — Manages puppeteer browser pool for parallel tracing

## Testing Notes

- Tests have a 5-minute timeout (configured in `.mocharc.yml`)
- Tests use `httpception` for HTTP mocking and `unexpected` for assertions
- Some tests require puppeteer browser binaries (installed via `pnpm install`)
- Coverage thresholds are enforced via `nyc check-coverage`

## Conventions

- CommonJS modules (`require`/`module.exports`), not ESM
- Node.js >= 18 required
- Use `const` by default; `let` only when reassignment is needed
- Template literals preferred over string concatenation
