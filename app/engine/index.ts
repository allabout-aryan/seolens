// SeoLens — edge function: serves the UI and runs the crawl API.
import { GROUP1 } from "./checks1.ts";
import { GROUP2 } from "./checks2.ts";
import { GROUP3 } from "./checks3.ts";
import { crawl } from "./crawl.ts";
import { HTML } from "./ui.ts";

const ALL = [...GROUP1, ...GROUP2, ...GROUP3];
const WEIGHT = { critical: 6, high: 3, medium: 1.5, low: 0.5, info: 0 };
const REG = new Map(ALL.map((c) => [c.id, c]));

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
};

function scoreFrom(issueList) {
  let s = 100;
  for (const i of issueList) {
    const w = WEIGHT[i.sev] === undefined ? 0.5 : WEIGHT[i.sev];
    if (i.status === "fail") s -= w;
    else if (i.status === "warn") s -= w * 0.5;
  }
  return Math.max(0, Math.round(s));
}

function runChecks(page, site) {
  const out = [];
  for (const chk of ALL) {
    if (chk.scope === "site" && !site) continue;
    let r;
    try { r = chk.run(page, site); } catch (e) { r = { status: "na", msg: "check error: " + String(e).slice(0, 80) }; }
    if (!r) continue;
    out.push({ id: chk.id, cat: chk.cat, sev: chk.sev, scope: chk.scope, title: chk.title, status: r.status, msg: r.msg || "", detail: r.detail || "" });
  }
  return out;
}

function summarize(pages) {
  const agg = new Map();
  for (const p of pages) {
    for (const i of p.issues) {
      if (i.status !== "fail" && i.status !== "warn") continue;
      const k = i.id;
      if (!agg.has(k)) agg.set(k, { id: i.id, cat: i.cat, sev: i.sev, scope: i.scope, title: i.title, status: i.status, msg: i.msg, count: 0, urls: [] });
      const a = agg.get(k);
      a.count++;
      if (a.urls.length < 12) a.urls.push(p.url);
      if (i.status === "fail") a.status = "fail";
    }
  }
  const enriched = Array.from(agg.values()).map((i) => {
    const reg = REG.get(i.id);
    return { ...i, rule: reg ? reg.rule : "", fix: reg ? reg.fix : "", why: reg ? reg.why : "" };
  });
  const issues = enriched.sort((a, b) => {
    const order = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
    if (order[a.sev] !== order[b.sev]) return order[a.sev] - order[b.sev];
    return b.count - a.count;
  });
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
  const byCategory = {};
  for (const i of issues) {
    bySeverity[i.sev] = (bySeverity[i.sev] || 0) + 1;
    byCategory[i.cat] = (byCategory[i.cat] || 0) + 1;
  }
  return { issues, bySeverity, byCategory, score: scoreFrom(issues) };
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  const api = url.searchParams.get("api");

  if (api === "meta") {
    return new Response(JSON.stringify({
      total: ALL.length,
      categories: Array.from(new Set(ALL.map((c) => c.cat))),
      checks: ALL.map((c) => ({ id: c.id, cat: c.cat, sev: c.sev, scope: c.scope, title: c.title, rule: c.rule, why: c.why, fix: c.fix })),
    }), { headers: { "content-type": "application/json", ...CORS } });
  }

  if (api === "crawl") {
    let target = url.searchParams.get("url") || "";
    let maxPages = +(url.searchParams.get("max") || 25);
    let respectRobots = url.searchParams.get("robots") !== "0";
    const wantJson = url.searchParams.get("json") === "1";
    if (req.method === "POST") {
      try {
        const body = await req.json();
        target = body.url || target;
        maxPages = body.max || maxPages;
        respectRobots = body.robots !== false;
      } catch {}
    }
    if (!/^https?:\/\//i.test(target)) target = "https://" + target;
    try { new URL(target); } catch { return new Response(JSON.stringify({ error: "Invalid URL" }), { status: 400, headers: { "content-type": "application/json", ...CORS } }); }

    const enc = new TextEncoder();
    const started = Date.now();
    let payload = null;

    const run = async (send) => {
      send({ type: "start", target, maxPages, checks: ALL.length, at: new Date().toISOString() });
      const { pages, site } = await crawl({
        url: target, maxPages, concurrency: 8, budgetMs: 95000, respectRobots,
        onPage: (page, n) => {
          const issues = runChecks(page, null);
          const pageScore = scoreFrom(issues.filter((i) => i.status === "fail" || i.status === "warn"));
          send({
            type: "page", n, url: page.url, status: page.status, title: page.title || "",
            words: page.wordCount || 0, score: pageScore, ms: Date.now() - started,
            found: issues.filter((i) => i.status === "fail" || i.status === "warn").length,
          });
          page.issues = issues;
        },
      });

      const seed = pages.find((p) => p.status >= 200 && p.status < 300) || pages[0] || { url: target, status: 0 };
      const siteIssues = [];
      for (const chk of ALL.filter((c) => c.scope === "site")) {
        let r;
        try { r = chk.run(seed, site); } catch (e) { r = { status: "na", msg: "check error" }; }
        siteIssues.push({ id: chk.id, cat: chk.cat, sev: chk.sev, scope: "site", title: chk.title, status: r.status, msg: r.msg || "" });
      }
      if (siteIssues.length && seed && seed.issues) seed.issues.push(...siteIssues);

      const summary = summarize(pages);
      const clean = pages.map((p) => ({
        url: p.url, status: p.status, title: p.title || "", words: p.wordCount || 0,
        score: scoreFrom((p.issues || []).filter((i) => i.status === "fail" || i.status === "warn")),
        issues: (p.issues || []).filter((i) => i.status === "fail" || i.status === "warn").map((i) => ({ id: i.id, sev: i.sev, title: i.title, msg: i.msg, status: i.status })),
      }));

      payload = {
        type: "done",
        target,
        durationMs: Date.now() - started,
        pagesCrawled: pages.length,
        checksRun: ALL.length,
        summary,
        pages: clean,
        site: {
          robots: { status: site.robots.status, sitemaps: site.robots.sitemaps, disallowAll: site.robots.disallowAll },
          sitemap: site.sitemap,
          orphans: site.orphans.length,
          depthMax: site.depthMax,
          brokenInternal: site.brokenInternal.length,
          notFoundStatus: site.notFoundStatus,
        },
      };
      send(payload);
      return payload;
    };

    if (wantJson) {
      try {
        const out = await run(() => {});
        return new Response(JSON.stringify(out), { headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS } });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e).slice(0, 300) }), { status: 500, headers: { "content-type": "application/json", ...CORS } });
      }
    }

    const stream = new ReadableStream({
      async start(controller) {
        const send = (o) => { try { controller.enqueue(enc.encode(JSON.stringify(o) + "\n")); } catch {} };
        try { await run(send); } catch (e) { send({ type: "error", message: String(e).slice(0, 300) }); }
        try { controller.close(); } catch {}
      },
    });
    return new Response(stream, {
      headers: { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-accel-buffering": "no", ...CORS },
    });
  }

  return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...CORS } });
});
