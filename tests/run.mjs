// Regression suite for the SeoLens check engine.
//
// The engine ships as TypeScript (it runs unchanged on Deno and in the edge
// function). Node cannot import .ts directly, so this runner materialises the
// engine into .engine-build/ with the import extensions rewritten and then
// imports it. No dependencies, no build step, works on any Node 18+.
//
//   node tests/run.mjs
//
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join, extname, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BUILD = join(ROOT, ".engine-build");
const ENGINE = ["lib", "checks1", "checks2", "checks3", "features", "crawl"];

// ---------------------------------------------------------------- build
rmSync(BUILD, { recursive: true, force: true });
mkdirSync(BUILD, { recursive: true });
for (const name of ENGINE) {
  const src = readFileSync(join(ROOT, "app", "engine", name + ".ts"), "utf8");
  writeFileSync(join(BUILD, name + ".mjs"), src.replace(/\.ts"/g, '.mjs"'));
}

const { extractPage } = await import(pathToFileURL(join(BUILD, "lib.mjs")).href);
const { enrich } = await import(pathToFileURL(join(BUILD, "features.mjs")).href);
const { crawl } = await import(pathToFileURL(join(BUILD, "crawl.mjs")).href);
const { GROUP1 } = await import(pathToFileURL(join(BUILD, "checks1.mjs")).href);
const { GROUP2 } = await import(pathToFileURL(join(BUILD, "checks2.mjs")).href);
const { GROUP3 } = await import(pathToFileURL(join(BUILD, "checks3.mjs")).href);

const ALL = [...GROUP1, ...GROUP2, ...GROUP3];
const BY_ID = new Map(ALL.map((c) => [c.id, c]));

// ---------------------------------------------------------------- static server
const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".txt": "text/plain", ".xml": "application/xml" };
const FIXTURES = join(ROOT, "tests", "fixtures");

const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  const file = join(FIXTURES, path === "/" ? "index.html" : path);
  try {
    let body = readFileSync(file);
    // fixtures carry the documented example host; rewrite it to the live test origin
    if (/\.(txt|xml|html)$/.test(file)) body = Buffer.from(body.toString("utf8").replaceAll("localhost:8765", "127.0.0.1:" + server.address().port));
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/html" });
    res.end("<html><body><h1>Not found</h1></body></html>");
  }
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = "http://127.0.0.1:" + server.address().port;

// ---------------------------------------------------------------- assertions
let pass = 0;
const failures = [];

function expect(label, actual, wanted) {
  if (actual === wanted) { pass++; return; }
  failures.push(`${label}: expected ${wanted}, got ${actual}`);
}

function pageChecks(page) {
  const out = {};
  for (const chk of ALL) {
    if (chk.scope !== "page") continue;
    let r;
    try { r = chk.run(page, null); } catch (e) { r = { status: "error", msg: String(e) }; }
    out[chk.id] = r.status;
  }
  return out;
}

// ---------------------------------------------------------------- page-level
const fixtures = {
  "index.html": {
    "HED-001": "fail",     // two H1 elements
    "MET-009": "fail",     // no meta description
    "MET-002": "warn",     // title far over 60 chars
    "CRL-015": "fail",     // no canonical
    "IMG-001": "fail",     // image without alt
    "IMG-005": "fail",     // image without dimensions
    "INT-001": "fail",     // no html lang
    "PRF-008": "fail",     // synchronous script in head
    "LNK-003": "fail",     // target=_blank without noopener
    "SOC-001": "fail",     // no og:title
    "SPM-001": "pass",     // hidden text is under the spam threshold
  },
  "about.html": {
    "HED-001": "pass",     // exactly one H1
    "MET-009": "pass",     // description present
    "MET-010": "pass",     // description within range
    "INT-001": "pass",     // lang declared
    "CRL-015": "pass",     // canonical present
    "SCH-001": "pass",     // JSON-LD present
    "SOC-003": "pass",     // og:image present
    "ACC-001": "pass",     // main landmark
  },
  "contact.html": {
    "CRL-013": "fail",     // noindex
    "CRL-015": "fail",     // no canonical
    "ACC-003": "warn",     // unlabelled input
    "SEC-014": "fail",     // form posts over http
  },
};

for (const [file, expectations] of Object.entries(fixtures)) {
  const html = readFileSync(join(FIXTURES, file), "utf8");
  const url = `${BASE}/${file}`;
  const page = enrich(extractPage(html, url, 200, { "content-type": "text/html" }, { ttfbMs: 5, totalMs: 10 }));
  const results = pageChecks(page);
  for (const [id, wanted] of Object.entries(expectations)) {
    expect(`${file} ${id}`, results[id], wanted);
  }
}

// ---------------------------------------------------------------- site-level
const { pages, site } = await crawl({ url: BASE + "/", maxPages: 12, concurrency: 4, budgetMs: 20000 });
server.close();

expect("crawl discovered pages", pages.length >= 4, true);
expect("robots.txt readable", site.robots.status, 200);
expect("sitemap parsed", site.sitemap.count, 2);
expect("404 status correct", site.notFoundStatus, 404);
expect("broken internal links found", site.brokenInternal.length > 0, true);
expect("about page discovered", site.hasAbout, true);
expect("contact page discovered", site.hasContact, true);

const seed = pages.find((p) => p.url.endsWith("/") || p.url.endsWith("index.html")) || pages[0];
const siteResults = {};
for (const chk of ALL.filter((c) => c.scope === "site")) {
  let r;
  try { r = chk.run(seed, site); } catch (e) { r = { status: "error" }; }
  siteResults[chk.id] = r.status;
}
expect("site CRL-004 robots exists", siteResults["CRL-004"], "pass");
expect("site CRL-008 sitemap reachable", siteResults["CRL-008"], "pass");
expect("site CRL-021 broken links flagged", siteResults["CRL-021"], "fail");
expect("site SRV-007 404 handled", siteResults["SRV-007"], "pass");
expect("site SEC-009 no exposed files", siteResults["SEC-009"], "pass");

// ---------------------------------------------------------------- registry integrity
const ids = ALL.map((c) => c.id);
expect("no duplicate check ids", new Set(ids).size, ids.length);
expect("registry has 264 checks", ALL.length, 264);
expect("every check has a rule", ALL.every((c) => c.rule && c.rule.length > 10), true);
expect("every check has a fix", ALL.every((c) => c.fix && c.fix.length > 5), true);
expect("every check has a valid scope", ALL.every((c) => c.scope === "page" || c.scope === "site"), true);
expect("every check has a valid severity", ALL.every((c) => ["critical", "high", "medium", "low", "info"].includes(c.sev)), true);
expect("ids follow the category prefix convention", ALL.every((c) => /^[A-Z]{3}-\d{3}$/.test(c.id)), true);

// ---------------------------------------------------------------- report
console.log(`\n${pass} assertions passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.log("  FAIL  " + f);
  console.log("");
  process.exit(1);
}
console.log("All checks behave as specified.\n");
