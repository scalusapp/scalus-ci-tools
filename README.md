# scalus-ci-tools

Automated quality gates for statically served web pages, run headless in CI.
Public so that CI jobs in private repos can fetch them without a credential.

Three checks, each exits non-zero so it can block a deploy:

| Script | What it catches |
|---|---|
| `build-gate.mjs` | Text inside the gutter, sideways scroll, a11y failures (contrast, tap target size, missing alt text, unnamed controls), and any request that 404s |
| `layout-check.mjs` | Text sitting flush against the viewport edge, which a plain overflow check misses entirely |
| `sra-review.mjs` | House standards measured on the rendered page: header geometry, head tags, console errors, image loading |

## Usage

```bash
npm install -g playwright axe-core
npx playwright install --with-deps chromium

node build-gate.mjs   http://localhost:4321/ --widths 390,768,1280
node layout-check.mjs http://localhost:4321/ --gutter 20
node sra-review.mjs   http://localhost:4321/
```

## Baselines

An existing site usually has pre-existing contrast or gutter decisions that are
brand choices, not regressions. If the gate hard failed on those, every site
would fail forever and the gate would get switched off, which is the real risk.

So a baseline is recorded once and reported every run, while anything the change
INTRODUCED is a hard fail.

```bash
node build-gate.mjs http://localhost:4321/ --baseline   # first run for a page
```

Two environment variables control where a baseline lives, so it can be committed
alongside the site it describes and survive a port change:

- `SCALUS_BASELINE_DIR` directory holding baseline JSON
- `SCALUS_BASELINE_KEY` stable per-site key, independent of the URL or port

Never widen an exclusion just to make a page pass. Record it in the baseline
instead, where the deviation stays visible.

## Self test

`self-test/index.html` is a deliberately clean page. Serve it and run the gates
against it: if that fails, the gates have regressed, not the site under test.
