#!/usr/bin/env -S deno run --allow-net
// SeoLens CLI — run the audit engine against any site from the terminal.
//
//   deno run --allow-net app/cli.ts https://example.com
//   deno run --allow-net app/cli.ts example.com --max 200 --concurrency 8 --json report.json
//
// Flags:
//   --max <n>           page ceiling for the crawl (default 50)
//   --concurrency <n>   parallel requests per host (default 8)
//   --json <path>       also write the full report as JSON
//   --no-robots         ignore robots.txt (only for sites you own)
//   --quiet             print only the summary
//
// Written in plain JavaScript syntax so the same file runs on Deno and Node.
import { crawl } from "./engine/crawl.ts";
import { GROUP1 } from "./engine/checks1.ts";
import { GROUP2 } from "./engine/checks2.ts";
import { GROUP3 } from "./engine/checks3.ts";

const ALL = [...GROUP1, ...GROUP2, ...GROUP3];
const WEIGHT = { critical: 6, high: 3, medium: 1.5, low: 0.5, info: 0 };

function parseArgs(argv) {
  const args = { url: "", max: 50, concurrency: 8, json: "", robots: true, quiet: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--max") args.max = Number(argv[++i]);
    else if (a === "--concurrency") args.concurrency = Number(argv[++i]);
    else if (a === "--json") args.json = argv[++i];
    else if (a === "--no-robots") args.robots = false;
    else if (a === "--quiet") args.quiet = true;
    else rest.push(a);
  }
  args.url = rest[0] || "";
  if (args.url && !/^https?:\/\//i.test(args.url)) args.url = "https://" + args.url;
  return args;
}

// Weighted share of the checks that passed: each evaluated check adds its
// severity weight to the denominator, failures cost the full weight and
// warnings half. Not-applicable and informational checks are excluded.
function weigh(results) {
  let possible = 0, lost = 0;
  for (const r of results) {
    if (r.status === "na" || r.status === "info") continue;
    const w = WEIGHT[r.sev] === undefined ? 0.5 : WEIGHT[r.sev];
    possible += w;
    if (r.status === "fail") lost += w;
    else if (r.status === "warn") lost += w * 0.5;
  }
  return { possible, lost };
}

function score(results) {
  const w = weigh(results);
  if (!w.possible) return 100;
  return Math.max(0, Math.min(100, Math.round(100 * (1 - w.lost / w.possible))));
}

const args = parseArgs(Deno.args);
if (!args.url) {
  console.error("usage: deno run --allow-net app/cli.ts <url> [--max 50] [--concurrency 8] [--json out.json] [--no-robots] [--quiet]");
  Deno.exit(2);
}

const started = Date.now();

const { pages, site } = await crawl({
  url: args.url,
  maxPages: args.max,
  concurrency: args.concurrency,
  budgetMs: 30 * 60 * 1000,
  respectRobots: args.robots,
  onPage: (page, n) => {
    if (args.quiet) return;
    const issues = ALL.filter((c) => c.scope === "page").map((c) => {
      try { return { sev: c.sev, ...c.run(page, null) }; } catch { return { sev: c.sev, status: "na" }; }
    });
    const bad = issues.filter((i) => i.status === "fail" || i.status === "warn").length;
    console.log(`${String(n).padStart(4)}  ${String(page.status).padEnd(4)} ${String(score(issues)).padStart(3)}/100  ${String(bad).padStart(3)} issues  ${page.url}`);
  },
});

// aggregate page findings
const agg = new Map();
const perPage = [];
const totals = { possible: 0, lost: 0 };

for (const page of pages) {
  const results = [];
  for (const c of ALL) {
    if (c.scope === "site") continue;
    try { results.push({ id: c.id, sev: c.sev, cat: c.cat, title: c.title, ...c.run(page, null) }); } catch { /* skip */ }
  }
  const failing = results.filter((r) => r.status === "fail" || r.status === "warn");
  perPage.push({ url: page.url, status: page.status, words: page.wordCount || 0, score: score(results), issues: failing });
  const pw = weigh(results);
  totals.possible += pw.possible;
  totals.lost += pw.lost;
  for (const r of failing) {
    if (!agg.has(r.id)) agg.set(r.id, { id: r.id, sev: r.sev, cat: r.cat, title: r.title, status: r.status, msg: r.msg || "", count: 0, urls: [] });
    const a = agg.get(r.id);
    a.count++;
    if (a.urls.length < 10) a.urls.push(page.url);
    if (r.status === "fail") a.status = "fail";
  }
}

// site-level findings
const seed = pages.find((p) => p.status >= 200 && p.status < 300) || pages[0];
const siteResults = [];
for (const c of ALL) {
  if (c.scope !== "site") continue;
  let r;
  try { r = c.run(seed, site); } catch { r = { status: "na", msg: "" }; }
  siteResults.push({ id: c.id, sev: c.sev, cat: c.cat, title: c.title, status: r.status, msg: r.msg || "" });
  if (r.status !== "fail" && r.status !== "warn") continue;
  agg.set(c.id, { id: c.id, sev: c.sev, cat: c.cat, title: c.title, status: r.status, msg: r.msg || "", count: 1, urls: [args.url] });
}
const sw = weigh(siteResults);
totals.possible += sw.possible;
totals.lost += sw.lost;

const order = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const issues = [...agg.values()].sort((a, b) => (order[a.sev] - order[b.sev]) || (b.count - a.count));
const overall = totals.possible ? Math.max(0, Math.min(100, Math.round(100 * (1 - totals.lost / totals.possible)))) : 100;

const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
for (const i of issues) bySeverity[i.sev] = (bySeverity[i.sev] || 0) + 1;

console.log("");
console.log(`Target        ${args.url}`);
console.log(`Pages         ${pages.length} crawled, max depth ${site.depthMax}, ${site.orphans.length} orphans`);
console.log(`Checks        ${ALL.length} per page, ${issues.length} distinct findings`);
console.log(`Health score  ${overall}/100`);
console.log(`Severity      critical ${bySeverity.critical}  high ${bySeverity.high}  medium ${bySeverity.medium}  low ${bySeverity.low}`);
console.log(`Duration      ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log("");
for (const i of issues.slice(0, 60)) {
  console.log(`${i.sev.toUpperCase().padEnd(8)} ${i.id.padEnd(8)} ${String(i.count).padStart(4)}x  ${i.title}`);
  if (i.msg) console.log(`         ${i.msg}`);
}
if (issues.length > 60) console.log(`\n... ${issues.length - 60} more issues (use --json for the full report)`);

if (args.json) {
  const report = {
    target: args.url,
    generatedAt: new Date().toISOString(),
    engineVersion: "1.0.0",
    checksRun: ALL.length,
    score: overall,
    bySeverity,
    issues,
    pages: perPage,
    site: { robots: site.robots.status, sitemap: site.sitemap, orphans: site.orphans.length, depthMax: site.depthMax, brokenInternal: site.brokenInternal },
  };
  await Deno.writeTextFile(args.json, JSON.stringify(report, null, 2));
  console.log(`\nJSON report written to ${args.json}`);
}
