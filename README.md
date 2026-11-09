# SeoLens — SEO Crawler & Site Auditor

A crawler that fetches a site the way a search engine would, parses the real HTML and response
headers, and evaluates **264 checks across 19 categories** — then lists every issue with the
measured value and the fix.

**Live UI:** https://allabout-aryan.github.io/seolens/
**Full specification:** SeoLens_SEO_Crawler_Spec.docx (39 pages, all 264 checks + the 50,000-page architecture)

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

## How it works

`index.html` is the front end: enter a URL, pick a page budget, and the crawl runs on a serverless
endpoint that fetches pages server-side (no CORS proxy, no browser rendering), streams each page
back as it lands, and returns a scored report.

- 226 checks run per page against the parsed document and response headers.
- 38 checks run once per crawl against the graph: robots.txt, sitemaps, orphans, click depth,
  duplicate clusters, canonical conflicts and exposed files.
- The hosted demo is capped at 100 pages per run because it executes inside one serverless
  request. The specification describes the distributed architecture required for 50,000 pages.

## Limits, stated plainly

Throughput on a single domain is bounded by politeness, not by worker count: a CDN-fronted site
tolerating 20 requests per second reaches 50,000 pages in about 42 minutes, while a slow CMS at
2 rps takes about 7 hours. The spec states both and requires the UI to show the ETA.
