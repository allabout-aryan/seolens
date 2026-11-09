# SeoLens — SEO Crawler & Site Auditor

A crawler that fetches a site the way a search engine would, parses the real HTML and response
headers, and evaluates **264 checks across 19 categories** — then lists every issue with the
measured value and the fix.

**Live UI:** https://allabout-aryan.github.io/seolens/
**Specification:** `SeoLens_SEO_Crawler_Spec.docx` — 39 pages, all 264 checks, and the 50,000-page architecture.

## What it checks

| Category | Checks | Category | Checks |
|---|---|---|---|
| Crawl & Indexability | 30 | Mobile & UX | 10 |
| Titles & Meta | 20 | Accessibility | 10 |
| Headings | 12 | Analytics | 6 |
| Content | 20 | AI & LLM Readiness | 12 |
| Images & Media | 16 | URL Structure | 12 |
| Links | 18 | Server Response | 8 |
| Structured Data | 20 | E-E-A-T & Trust | 10 |
| Social & Sharing | 10 | Spam & Policy | 8 |
| International | 8 | Performance | 20 |
| Security & Headers | 14 | **Total** | **264** |

226 checks run per page against the parsed document and response headers. 38 run once per crawl
against the graph: robots.txt, sitemaps, orphans, click depth, duplicate clusters, canonical
conflicts and exposed files.

## Layout

```
index.html            the hosted UI (GitHub Pages) — calls the crawl API
app/engine/           the engine, TypeScript, runs unchanged on Deno and Node
  lib.ts              tolerant HTML parser + feature extraction
  features.ts         derived signals (dates, schema, analytics, DOM stats)
  checks1..3.ts       the 264-check registry
  crawl.ts            frontier, robots, politeness, concurrency
  index.ts            edge-function server: UI + streaming JSON API
  ui.ts               the UI as a module, generated from index.html
app/cli.ts            terminal runner
tests/                regression suite and fixtures
```

## Run it locally

The CLI needs [Deno](https://deno.land):

```bash
deno run --allow-net app/cli.ts https://example.com --max 50
deno run --allow-net app/cli.ts example.com --max 200 --json report.json
```

It prints a live line per page and a severity-sorted issue list. `--json` writes the full report.

## Tests

```bash
node tests/run.mjs
```

The suite spins up a static server over `tests/fixtures`, crawls it with the real crawler, and
asserts specific verdicts per check (a fixture with two H1s must fail `HED-001`; a clean page must
pass it), plus registry integrity: no duplicate ids, every check has a rule and a fix, ids follow
the `XXX-000` convention. 42 assertions, no dependencies, Node 18+.

## Scoring

The score is the weighted share of applicable checks that pass: each evaluated check adds its
severity weight to the denominator, a failure costs the full weight and a warning half.
Not-applicable and informational checks are excluded from both sides, so a page with no images is
never scored on image checks. Weights: critical 6, high 3, medium 1.5, low 0.5.

## Limits, stated plainly

The hosted UI is capped at 100 pages per run because it executes inside one serverless request.
A 50,000-page crawl needs the distributed frontier described in the specification.

Throughput on a single domain is bounded by politeness, not by worker count: a CDN-fronted site
tolerating 20 requests per second reaches 50,000 pages in about 42 minutes, while a slow CMS at
2 rps takes about 7 hours. The crawler honours robots.txt by default, caps concurrency per host,
and backs off on 429/503.
