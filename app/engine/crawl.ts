// Crawler: BFS queue, robots.txt, concurrency, streaming progress.
import { extractPage, shingles, jaccard, hostOf } from "./lib.ts";
import { enrich } from "./features.ts";

const UA = "SeoLensBot/1.0 (+https://seolens.app/bot)";
const SKIP_EXT = /\.(jpg|jpeg|png|gif|webp|avif|svg|ico|pdf|zip|gz|tar|mp4|mp3|wav|woff2?|ttf|eot|css|js|json|xml|rss|txt)$/i;

export function rootDomain(host) {
  const parts = String(host || "").split(".");
  return parts.length > 2 ? parts.slice(-2).join(".") : parts.join(".");
}

export function normalize(u) {
  try {
    const x = new URL(u);
    x.hash = "";
    for (const k of Array.from(x.searchParams.keys())) if (/^utm_|^fbclid|^gclid|^ref$|^mc_/.test(k)) x.searchParams.delete(k);
    let s = x.toString();
    if (x.pathname !== "/" && s.endsWith("/") && !x.search) s = s.slice(0, -1);
    return s;
  } catch { return u; }
}

async function timedFetch(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs || 12000);
  const started = performance.now();
  try {
    const res = await fetch(url, {
      ...opts,
      redirect: "manual",
      signal: ctrl.signal,
      headers: { "user-agent": UA, "accept": "text/html,application/xhtml+xml", "accept-encoding": "gzip, br", ...(opts && opts.headers) },
    });
    const ttfbMs = Math.round(performance.now() - started);
    return { res, ttfbMs };
  } finally { clearTimeout(t); }
}

async function followChain(startUrl, maxHops, timeoutMs) {
  let url = startUrl, hops = 0, res = null, ttfbMs = 0, loop = false;
  const seen = new Set();
  for (let i = 0; i <= (maxHops || 6); i++) {
    if (seen.has(url)) { loop = true; break; }
    seen.add(url);
    const r = await timedFetch(url, { method: "GET" }, timeoutMs);
    res = r.res; ttfbMs = r.ttfbMs;
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      url = new URL(loc, url).toString();
      hops++;
      continue;
    }
    break;
  }
  return { res, finalUrl: url, hops, loop, ttfbMs };
}

function headersToObj(h) {
  const o = {};
  try { for (const [k, v] of h.entries()) o[k.toLowerCase()] = v; } catch {}
  return o;
}

function parseRobots(text) {
  const lines = String(text || "").split(/\r?\n/);
  const rules = { disallow: [], allow: [], sitemaps: [], agents: [] };
  let current = null;
  for (const raw of lines) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const [k, ...rest] = line.split(":");
    const key = k.trim().toLowerCase();
    const val = rest.join(":").trim();
    if (key === "user-agent") { current = val.toLowerCase(); rules.agents.push(current); }
    else if (key === "disallow" && (current === "*" || current === "seolensbot")) rules.disallow.push(val);
    else if (key === "allow" && (current === "*" || current === "seolensbot")) rules.allow.push(val);
    else if (key === "sitemap") rules.sitemaps.push(val);
  }
  return rules;
}

function blockedByRobots(rules, path) {
  let best = null, bestLen = -1;
  for (const d of rules.disallow) {
    if (!d) continue;
    if (path.startsWith(d) && d.length > bestLen) { best = false; bestLen = d.length; }
  }
  for (const a of rules.allow) {
    if (!a) continue;
    if (path.startsWith(a) && a.length >= bestLen) { best = true; bestLen = a.length; }
  }
  return best === false;
}

async function probe(url, timeoutMs) {
  try {
    const r = await timedFetch(url, { method: "GET" }, timeoutMs || 8000);
    try { if (r.res.body) await r.res.body.cancel(); } catch {}
    return { status: r.res.status, headers: headersToObj(r.res.headers), ttfbMs: r.ttfbMs };
  } catch { return { status: 0, headers: {}, ttfbMs: 0 }; }
}

export async function crawl(opts) {
  const seed = opts.url;
  const origin = new URL(seed).origin;
  const siteHost = rootDomain(hostOf(seed));
  const maxPages = Math.max(1, Math.min(opts.maxPages || 25, 200));
  const concurrency = Math.max(1, Math.min(opts.concurrency || 8, 16));
  const deadline = Date.now() + (opts.budgetMs || 110000);
  const onPage = opts.onPage || (() => {});
  const respectRobots = opts.respectRobots !== false;

  // ---- site level fetches (parallel)
  const [robotsRes, httpRes, wwwRes, sitemapProbe, nf, secTxt, llms, gitProbe, envProbe] = await Promise.all([
    probe(origin + "/robots.txt", 8000),
    probe(seed.replace(/^https:/, "http:"), 8000),
    probe(seed.replace("://", "://www."), 6000).catch(() => ({ status: 0, headers: {} })),
    probe(origin + "/sitemap.xml", 8000),
    probe(origin + "/seolens-not-found-" + Math.random().toString(36).slice(2, 8), 8000),
    probe(origin + "/.well-known/security.txt", 6000),
    probe(origin + "/llms.txt", 6000),
    probe(origin + "/.git/config", 6000),
    probe(origin + "/.env", 6000),
  ]);

  let robotsText = "";
  let robotsStatus = robotsRes.status;
  try {
    const r = await fetch(origin + "/robots.txt", { headers: { "user-agent": UA } });
    if (r.ok) robotsText = await r.text();
  } catch {}
  const rules = parseRobots(robotsText);
  const disallowAll = rules.disallow.some((d) => d === "/");
  const blockedAssets = rules.disallow.filter((d) => /\.(css|js)$|\/assets\/|\/static\/|\/_next\/|\/build\//.test(d));

  // sitemap body
  let sitemapText = "";
  const sitemapUrl = rules.sitemaps[0] || origin + "/sitemap.xml";
  try {
    const r = await fetch(sitemapUrl, { headers: { "user-agent": UA } });
    if (r.ok) sitemapText = await r.text();
  } catch {}
  const locs = Array.from(sitemapText.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)).map((m) => m[1]);
  const lastmods = (sitemapText.match(/<lastmod>/gi) || []).length;
  const sitemap = {
    status: sitemapText ? 200 : sitemapProbe.status,
    valid: /<urlset|<sitemapindex/i.test(sitemapText),
    count: locs.length,
    lastmodRatio: locs.length ? Math.min(1, lastmods / locs.length) : 0,
    index: /<sitemapindex/i.test(sitemapText),
  };
  const sitemapSet = new Set(locs.map((l) => normalize(l)));

  // ---- crawl
  const queue = [{ url: normalize(seed), depth: 0 }];
  const seen = new Set([normalize(seed)]);
  const pages = [];
  const byUrl = {};
  const inbound = new Map();
  const brokenInternal = [];
  const nofollowInternal = [];
  const soft404 = [];
  const trapUrls = [];
  const titles = new Map();
  const descs = new Map();
  let internalLinkTotal = 0;
  let paramDupes = 0;
  const paramSeen = new Map();

  async function processOne(item) {
    let page = null;
    try {
      const chain = await followChain(item.url, 6, 12000);
      const res = chain.res;
      if (!res) return null;
      const status = res.status;
      const ctype = (res.headers.get("content-type") || "").toLowerCase();
      let html = "";
      if (status >= 200 && status < 300 && /html|xml/.test(ctype)) html = await res.text();
      const headers = headersToObj(res.headers);
      const timing = { ttfbMs: chain.ttfbMs, totalMs: 0 };
      if (!html) {
        page = { url: chain.finalUrl, status, depth: item.depth, title: "", wordCount: 0, noindex: false, canonical: "", hops: chain.hops, error: status >= 400 ? "HTTP " + status : "" };
      } else {
        const c = extractPage(html, chain.finalUrl, status, headers, timing);
        c.redirectChain = chain.hops;
        c.loop = chain.loop;
        enrich(c);
        page = c;
      }
      return page;
    } catch (e) {
      return { url: item.url, status: 0, depth: item.depth, title: "", wordCount: 0, noindex: false, canonical: "", error: String(e).slice(0, 120) };
    }
  }

  function harvest(page, item) {
    if (!page) return;
    page.depth = item.depth;
    pages.push(page);
    byUrl[normalize(page.url)] = { status: page.status, noindex: !!page.noindex };
    if (page.status >= 400) {
      if (item.depth > 0) brokenInternal.push(page.url);
      return;
    }
    if (page.title) titles.set(page.title.toLowerCase(), (titles.get(page.title.toLowerCase()) || 0) + 1);
    if (page.metaDesc) descs.set(page.metaDesc.toLowerCase(), (descs.get(page.metaDesc.toLowerCase()) || 0) + 1);
    if (page.status === 200 && page.wordCount < 200 && /not found|404|doesn.t exist|no longer available/i.test(page.title + " " + page.text.slice(0, 300))) soft404.push(page.url);
    if (page.wordCount < 150 && /calendar|date=|page=\d{3,}|\/tag\//.test(page.url)) trapUrls.push(page.url);
    const base = page.url.split("?")[0];
    paramSeen.set(base, (paramSeen.get(base) || 0) + 1);
    for (const l of page.links || []) {
      if (!l.href) continue;
      const n = normalize(l.href);
      if (l.internal) {
        internalLinkTotal++;
        if (l.rel.includes("nofollow")) nofollowInternal.push(n);
        inbound.set(n, (inbound.get(n) || 0) + 1);
        if (l.rel.includes("next") || l.rel.includes("prev")) page.hasPaginationMarkup = true;
        if (seen.size < maxPages * 6 && !seen.has(n) && Date.now() < deadline) {
          if (SKIP_EXT.test(new URL(n).pathname)) continue;
          if (rootDomain(hostOf(n)) !== siteHost) continue;
          if (respectRobots && disallowAll) continue;
          if (respectRobots && blockedByRobots(rules, new URL(n).pathname)) continue;
          seen.add(n);
          queue.push({ url: n, depth: item.depth + 1 });
        }
      }
    }
  }

  let active = 0;
  const running = [];
  async function worker() {
    while (queue.length || active > 0) {
      if (Date.now() > deadline) break;
      if (pages.length >= maxPages) break;
      const item = queue.shift();
      if (!item) {
        if (active === 0) break;
        await new Promise((r) => setTimeout(r, 40));
        continue;
      }
      active++;
      try {
        const page = await processOne(item);
        harvest(page, item);
        if (page) onPage(page, pages.length);
      } finally { active--; }
    }
  }

  const workers = [];
  for (let i = 0; i < concurrency; i++) workers.push(worker());
  await Promise.all(workers);

  // ---- asset probes on the seed page
  const seedPage = pages.find((p) => p.status === 200 && p.stylesheets) || null;
  let assetProbe = [];
  if (seedPage) {
    const targets = (seedPage.stylesheets || []).map((s) => s.href).concat((seedPage.scripts || []).filter((s) => s.src).map((s) => s.src)).slice(0, 4);
    const results = await Promise.all(targets.map(async (u) => {
      const abs = new URL(u, seedPage.url).toString();
      const r = await probe(abs, 8000);
      return { url: abs, status: r.status, cacheControl: r.headers["cache-control"] || "", encoding: r.headers["content-encoding"] || "" };
    }));
    assetProbe = results;
    if (seedPage) seedPage.assetProbe = assetProbe;
  }

  // ---- aggregate
  const dupTitles = {};
  for (const [t, n] of titles) if (n > 1) dupTitles[t] = n;
  const dupDescs = {};
  for (const [t, n] of descs) if (n > 1) dupDescs[t] = n;

  const orphans = pages.filter((p) => p.status === 200 && (inbound.get(normalize(p.url)) || 0) === 0 && normalize(p.url) !== normalize(seed)).map((p) => p.url);

  const depthMax = pages.reduce((a, p) => Math.max(a, p.depth || 0), 0);

  // duplicate content
  const dupePairs = [];
  const boilerplatePages = [];
  const contentPages = pages.filter((p) => p.status === 200 && p.wordCount > 40).slice(0, 80);
  const sh = contentPages.map((p) => shingles(p.text, 5));
  for (let i = 0; i < contentPages.length; i++) {
    for (let j = i + 1; j < contentPages.length; j++) {
      const sim = jaccard(sh[i], sh[j]);
      if (sim > 0.8) dupePairs.push({ a: contentPages[i].url, b: contentPages[j].url, sim: Math.round(sim * 100) });
      if (sim > 0.6 && contentPages[i].wordCount < 150) boilerplatePages.push(contentPages[i].url);
    }
  }

  const langs = new Set(pages.filter((p) => p.htmlLang).map((p) => p.htmlLang));
  const allHrefs = pages.flatMap((p) => (p.links || []).filter((l) => l.href).map((l) => l.href));
  const linkBlob = allHrefs.join(" ").toLowerCase();

  let dirListing = false;
  const exposed = [];
  if (gitProbe.status === 200) exposed.push("/.git/config");
  if (envProbe.status === 200) exposed.push("/.env");

  const site = {
    origin, siteHost,
    httpCheck: { status: httpRes.status, location: httpRes.headers["location"] || "" },
    wwwCheck: { status: wwwRes.status, location: wwwRes.headers["location"] || "" },
    robots: { status: robotsStatus, text: robotsText, sitemaps: rules.sitemaps, disallowAll, blockedAssets },
    sitemap, sitemapSet,
    byUrl, orphans, depthMax, brokenInternal: Array.from(new Set(brokenInternal)).slice(0, 50),
    soft404, trapUrls,
    paginated: pages.filter((p) => p.hasPaginationMarkup).length,
    hasPaginationMarkup: pages.some((p) => p.hasPaginationMarkup),
    paramDupes: Array.from(paramSeen.values()).filter((n) => n > 1).length,
    internalLinkTotal,
    dupTitles, dupDescs,
    dupePairs: dupePairs.slice(0, 10),
    boilerplatePages: Array.from(new Set(boilerplatePages)).slice(0, 20),
    nofollowInternal: Array.from(new Set(nofollowInternal)).slice(0, 30),
    exposed, dirListing,
    securityTxt: secTxt.status === 200,
    llmsTxt: llms.status === 200,
    feedFound: /\/feed|\/rss/.test(linkBlob),
    notFoundStatus: nf.status,
    hasAbout: /\/about|about-us/.test(linkBlob),
    hasContact: /\/contact|contact-us/.test(linkBlob),
    hasPrivacy: /privacy/.test(linkBlob),
    hasTerms: /terms|legal/.test(linkBlob),
    multiLang: langs.size > 1,
    aiBots: ["gptbot", "claudebot", "perplexitybot", "google-extended", "ccbot", "anthropic-ai", "bytespider"].filter((b) => new RegExp("user-agent:\\s*" + b, "i").test(robotsText)),
    doorwayClusters: 0,
  };

  return { pages, site, assetProbe };
}
