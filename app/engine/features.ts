// Derived features computed from the parsed document + response headers.
import { findAll, walk, textOf, ownText, normSpace, fleschReadingEase, hostOf } from "./lib.ts";

const REQUIRED = {
  Article: ["headline", "image", "datePublished", "author"],
  NewsArticle: ["headline", "image", "datePublished", "author"],
  BlogPosting: ["headline", "image", "datePublished", "author"],
  Product: ["name", "image", "offers"],
  FAQPage: ["mainEntity"],
  Review: ["itemReviewed", "reviewRating", "author"],
  LocalBusiness: ["name", "address", "telephone"],
  Event: ["name", "startDate", "location"],
  VideoObject: ["name", "thumbnailUrl", "uploadDate"],
  BreadcrumbList: ["itemListElement"],
};
const RECOMMENDED = {
  Article: ["publisher", "dateModified", "mainEntityOfPage"],
  Organization: ["logo", "sameAs", "contactPoint"],
  Product: ["aggregateRating", "review", "brand", "sku"],
};
const DEPRECATED = ["CourseInfo", "WPSideBar", "WPSidebar", "WPFooter", "WPHeader", "WPAdBlock", "Blog", "Person"];

function flatTypes(node, out) {
  if (!node) return out;
  if (Array.isArray(node)) { node.forEach((n) => flatTypes(n, out)); return out; }
  if (typeof node !== "object") return out;
  if (node["@graph"]) flatTypes(node["@graph"], out);
  if (node["@type"]) {
    const t = node["@type"];
    (Array.isArray(t) ? t : [t]).forEach((x) => { if (typeof x === "string" && !out.includes(x)) out.push(x); });
  }
  for (const k of Object.keys(node)) {
    if (k === "@graph") continue;
    const v = node[k];
    if (v && typeof v === "object") flatTypes(v, out);
  }
  return out;
}

function nodesOfType(node, type, out) {
  if (!node) return out;
  if (Array.isArray(node)) { node.forEach((n) => nodesOfType(n, type, out)); return out; }
  if (typeof node !== "object") return out;
  if (node["@graph"]) nodesOfType(node["@graph"], type, out);
  const t = node["@type"];
  const list = Array.isArray(t) ? t : t ? [t] : [];
  if (list.includes(type)) out.push(node);
  return out;
}

export function enrich(c) {
  const root = c.root;
  const body = findAll(root, "body")[0] || root;

  // links
  const withHref = c.links.filter((l) => l.href);
  c.internalLinkCount = withHref.filter((l) => l.internal).length;
  c.externalLinkCount = withHref.filter((l) => !l.internal).length;

  // heading wrapped in links
  let headingLinks = 0;
  for (const h of findAll(root, "h1").concat(findAll(root, "h2"), findAll(root, "h3"))) {
    let p = h.parent;
    while (p) { if (p.tag === "a") { headingLinks++; break; } p = p.parent; }
  }
  c.headingLinks = headingLinks;

  // hidden text volume
  const visibleLen = textOf(body, { skipHidden: true }).length;
  c.hiddenTextLen = Math.max(0, c.textLen - visibleLen);

  // paragraphs
  const paras = findAll(root, "p").map((p) => ownText(p)).filter(Boolean);
  c.longParas = paras.filter((t) => t.length > 400).length;
  c.firstParaWords = paras.length ? paras[0].split(/\s+/).length : 0;

  c.flesch = fleschReadingEase(c.text);
  c.listCount = findAll(root, "ul").length + findAll(root, "ol").length;

  // dates
  const dates = { published: "", modified: "" };
  for (const n of c.jsonld) {
    for (const k of ["datePublished", "dateModified", "uploadDate"]) {
      const found = [];
      (function dig(o) {
        if (!o || typeof o !== "object") return;
        if (Array.isArray(o)) return o.forEach(dig);
        if (o[k]) found.push(o[k]);
        for (const kk of Object.keys(o)) if (kk !== k) dig(o[kk]);
      })(n);
      if (found.length) {
        if (k === "datePublished" && !dates.published) dates.published = String(found[0]);
        if (k !== "datePublished" && !dates.modified) dates.modified = String(found[0]);
      }
    }
  }
  for (const m of findAll(root, "meta")) {
    const p = (m.attrs.property || m.attrs.name || "").toLowerCase();
    const v = m.attrs.content || "";
    if (/article:published_time|datepublished/.test(p) && !dates.published) dates.published = v;
    if (/article:modified_time|datemodified/.test(p) && !dates.modified) dates.modified = v;
  }
  if (!dates.modified) {
    const t = findAll(root, "time").map((x) => x.attrs.datetime || "").filter(Boolean);
    if (t.length && !dates.published) dates.published = t[0];
  }
  c.dates = dates;

  // authorship
  const relAuthor = c.links.some((l) => l.rel.includes("author"));
  const authorLink = c.links.some((l) => l.href && /\/(author|authors|team|about)\//.test(l.href));
  const metaAuthor = findAll(root, "meta").some((m) => (m.attrs.name || "").toLowerCase() === "author");
  const bylineRe = /\b(by|written by|author)\b[:\s]/i.test(textOf(body).slice(0, 4000));
  c.hasAuthor = relAuthor || metaAuthor || c.jsonldTypes === undefined && false || bylineRe || authorLink;
  c.authorLinks = relAuthor || authorLink ? 1 : 0;

  // structured data summary
  const types = [];
  for (const n of c.jsonld) flatTypes(n, types);
  c.jsonldTypes = types;

  const missing = [];
  const recommended = [];
  for (const t of types) {
    const req = REQUIRED[t];
    if (req) {
      const nodes = [];
      for (const n of c.jsonld) nodesOfType(n, t, nodes);
      const node = nodes[0] || {};
      for (const r of req) if (node[r] === undefined || node[r] === null || node[r] === "") missing.push(t + "." + r);
    }
    const rec = RECOMMENDED[t];
    if (rec) {
      const nodes = [];
      for (const n of c.jsonld) nodesOfType(n, t, nodes);
      const node = nodes[0] || {};
      for (const r of rec) if (node[r] === undefined) recommended.push(t + "." + r);
    }
  }
  c.schemaMissing = missing;
  c.schemaRecommended = recommended;
  c.deprecatedSchema = types.filter((t) => DEPRECATED.includes(t));
  c.hasSchemaId = JSON.stringify(c.jsonld).includes('"@id"');

  const canon = (c.canonicals[0] || "").replace(/\/$/, "");
  let urlMismatch = false;
  for (const n of c.jsonld) {
    const s = JSON.stringify(n);
    const m = /"url"\s*:\s*"([^"]+)"/.exec(s);
    if (m && canon && m[1].replace(/\/$/, "") !== canon) urlMismatch = true;
  }
  c.schemaUrlMismatch = urlMismatch;

  // FAQ visible-content match
  let hiddenMismatch = false;
  const faq = [];
  for (const n of c.jsonld) {
    for (const q of nodesOfType(n, "Question", [])) if (q.name) faq.push(String(q.name));
  }
  if (faq.length) {
    const lower = c.text.toLowerCase();
    hiddenMismatch = faq.filter((q) => !lower.includes(q.toLowerCase().slice(0, 25))).length > 0;
  }
  c.schemaHiddenMismatch = hiddenMismatch;
  c.microdataCount = findAll(root, "div").concat(findAll(root, "span")).filter((e) => e.attrs.itemprop).length;
  c.unlabelledSvg = findAll(root, "svg").filter((s) => !findAll(s, "title").length && !s.attrs["aria-label"]).length;

  // og duplicates
  c.ogDupes = Math.max(0, c.ogCount - Object.keys(c.og).length);

  // media
  c.videoCount = findAll(root, "video").length + c.links.filter((l) => l.href && /youtube\.com|vimeo\.com/.test(l.href)).length;
  c.legacyEmbeds = findAll(root, "object").length + findAll(root, "embed").length + findAll(root, "applet").length;
  c.iframes = findAll(root, "iframe").map((f) => ({ src: f.attrs.src || "", title: f.attrs.title || "", sized: !!(f.attrs.width && f.attrs.height) }));

  // response meta
  c.contentEncoding = c.headers["content-encoding"] || "";
  c.contentType = c.headers["content-type"] || "";
  c.protocol = c.headers["x-http-protocol"] || c.headers[":protocol"] || "";
  c.cacheControl = c.headers["cache-control"] || "";

  // render blocking
  let blockingCss = 0;
  for (const s of c.stylesheets) {
    const media = (s.media || "").toLowerCase();
    if (!media || media === "all") blockingCss++;
  }
  c.blockingCss = blockingCss;
  c.blockingJs = c.scripts.filter((s) => s.src && s.inHead && !s.async && !s.defer && s.type !== "module").length;
  c.inlineScriptBytes = c.scripts.filter((s) => !s.src).reduce((a, s) => a + (s.inline || "").length, 0);
  c.inlineStyleBytes = c.inlineStyles.reduce((a, s) => a + s.length, 0);
  c.inlineCss = c.inlineStyles.join(" ");

  const hosts = new Set();
  for (const s of c.scripts) if (s.src) { const h = hostOf(s.src); if (h && h !== hostOf(c.url)) hosts.add(h); }
  for (const s of c.stylesheets) if (s.href) { const h = hostOf(s.href); if (h && h !== hostOf(c.url)) hosts.add(h); }
  c.thirdPartyHosts = Array.from(hosts);
  c.fontHosts = Array.from(hosts).filter((h) => /font|typekit|googleapis/.test(h));

  let preconnect = 0, preload = 0;
  for (const l of findAll(root, "link")) {
    const rel = (l.attrs.rel || "").toLowerCase();
    if (/preconnect|dns-prefetch/.test(rel)) preconnect++;
    if (/preload|prefetch/.test(rel)) preload++;
  }
  c.preconnectCount = preconnect;
  c.preloadCount = preload;

  // mixed content
  let mixed = 0;
  walk(root, (el) => {
    if (["img", "script", "iframe", "source", "video", "audio", "embed"].includes(el.tag)) {
      const s = el.attrs.src || el.attrs["data-src"] || "";
      if (/^http:\/\//i.test(s)) mixed++;
    }
    if (el.tag === "link" && /^http:\/\//i.test(el.attrs.href || "")) mixed++;
  });
  c.mixedContentCount = mixed;

  // responsive heuristics
  let fixedWidth = 0;
  walk(root, (el) => {
    const st = String(el.attrs.style || "");
    const m = /width\s*:\s*(\d{3,5})px/i.exec(st);
    if (m && +m[1] > 1000 && !/max-width/i.test(st)) fixedWidth++;
  });
  c.fixedWidthCount = fixedWidth;
  c.interstitialHint = /class="[^"]*(modal|interstitial|popup|overlay)[^"]*"/i.test(c.htmlSnippet || "") || findAll(root, "dialog").length > 0;

  // a11y
  c.hasMain = findAll(root, "main").length > 0 || walkHasRole(root, "main");
  c.hasNav = findAll(root, "nav").length > 0 || walkHasRole(root, "navigation");
  let tab = 0;
  walk(root, (el) => { if (el.attrs.tabindex && +el.attrs.tabindex > 0) tab++; });
  c.positiveTabindex = tab;
  c.semanticScore = ["article", "section", "main", "nav", "header", "footer", "aside"].reduce((a, t) => a + (findAll(root, t).length ? 1 : 0), 0);

  // analytics
  const blob = (c.htmlSnippet || "") + " " + c.scripts.map((s) => s.src + " " + s.inline).join(" ");
  const found = [];
  if (/googletagmanager\.com\/gtm\.js|GTM-[A-Z0-9]{4,}/.test(blob)) found.push("GTM");
  if (/gtag\/js|G-[A-Z0-9]{8,}/.test(blob)) found.push("GA4");
  if (/plausible\.io/.test(blob)) found.push("Plausible");
  if (/matomo|piwik/.test(blob)) found.push("Matomo");
  if (/umami/.test(blob)) found.push("Umami");
  if (/clarity\.ms/.test(blob)) found.push("Clarity");
  if (/hotjar/.test(blob)) found.push("Hotjar");
  if (/fbevents\.js/.test(blob)) found.push("Meta Pixel");
  c.analytics = found;
  c.tagManager = /googletagmanager\.com\/gtm\.js|GTM-[A-Z0-9]{4,}/.test(blob);
  c.ga4 = /G-[A-Z0-9]{8,}/.test(blob);
  c.duplicateAnalytics = (blob.match(/gtag\/js/g) || []).length > 1 || (blob.match(/googletagmanager\.com\/gtm\.js/g) || []).length > 1;
  c.blockingAnalytics = c.scripts.filter((s) => /googletagmanager|google-analytics|gtag/.test(s.src) && !s.async && !s.defer).length;
  c.hasConsent = /consent|cookiebot|onetrust|osano|termly|cookieyes|iubenda/i.test(blob);

  // content quality signals
  c.questionHeadings = c.headings.filter((h) => /\?\s*$/.test(h.text)).length;
  const ws = c.words;
  if (ws.length > 80) {
    const counts = new Map();
    for (let i = 0; i + 5 <= ws.length; i++) {
      const k = ws.slice(i, i + 5).join(" ");
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    let max = 0;
    for (const v of counts.values()) if (v > max) max = v;
    c.repetitionScore = max / Math.max(1, ws.length / 5);
  } else c.repetitionScore = 0;

  // ads, breadcrumbs, forms
  const html = c.htmlSnippet || "";
  c.adSlots = (html.match(/adsbygoogle|class="[^"]*\bad[-_]?(slot|unit|container)\b/gi) || []).length;
  c.hasBreadcrumb = /aria-label="[^"]*breadcrumb|itemtype="[^"]*BreadcrumbList|class="[^"]*breadcrumb/i.test(html);
  c.hasCommentForm = findAll(root, "form").some((f) => findAll(f, "textarea").length > 0);
  c.sponsoredHint = /sponsored|advertorial|paid partnership|affiliate/i.test(c.text.slice(0, 5000));
  c.sneakyRedirect = (() => {
    for (const m of findAll(root, "meta")) {
      if ((m.attrs["http-equiv"] || "").toLowerCase() === "refresh") {
        const u = /url=(.+)$/i.exec(m.attrs.content || "");
        if (u && hostOf(u[1]) && hostOf(u[1]) !== hostOf(c.url)) return true;
      }
    }
    return false;
  })();

  delete c.root;
  delete c.htmlSnippet;
  return c;
}

function walkHasRole(root, role) {
  let hit = false;
  walk(root, (el) => { if ((el.attrs.role || "").toLowerCase() === role) hit = true; });
  return hit;
}
