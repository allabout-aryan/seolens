// SeoLens core library: tolerant HTML parser + page feature extraction.
// Written in plain JS syntax so the same file runs on Deno, Node and the browser.

const VOID = new Set(["area","base","br","col","embed","hr","img","input","link","meta","param","source","track","wbr"]);
const RAW = new Set(["script","style","textarea","title"]);
const CLOSES_P = new Set(["p","div","section","article","ul","ol","table","h1","h2","h3","h4","h5","h6","header","footer","main","nav","aside","form","blockquote","pre"]);

export function makeEl(tag, attrs, parent) {
  return { tag, attrs: attrs || {}, children: [], parent: parent || null, raw: "" };
}

export function parseHTML(html) {
  const root = makeEl("#root", {}, null);
  const stack = [root];
  const src = String(html || "");
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<!doctype[^>]*>|<\/([a-zA-Z][\w:.-]*)\s*>|<([a-zA-Z][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/gi;
  let m, last = 0;
  const top = () => stack[stack.length - 1];

  const pushText = (t) => {
    if (!t) return;
    const p = top();
    p.raw += t;
  };

  while ((m = re.exec(src)) !== null) {
    if (m.index > last) pushText(src.slice(last, m.index));
    last = re.lastIndex;
    const closeTag = m[1];
    const openTag = m[2];

    if (closeTag) {
      const name = closeTag.toLowerCase();
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === name) { stack.length = i; break; }
      }
      continue;
    }
    if (!openTag) continue; // comment / doctype / cdata

    const name = openTag.toLowerCase();
    const attrs = parseAttrs(m[3] || "");
    // implicit close of <p> and friends
    if (CLOSES_P.has(name) && top().tag === "p") stack.pop();
    const el = makeEl(name, attrs, top());
    top().children.push(el);

    if (RAW.has(name)) {
      // capture raw content up to matching close tag
      const closeRe = new RegExp("</" + name + "\\s*>", "i");
      const rest = src.slice(last);
      const cm = closeRe.exec(rest);
      if (cm) {
        el.raw = rest.slice(0, cm.index);
        last = last + cm.index + cm[0].length;
        re.lastIndex = last;
      }
      continue;
    }
    if (VOID.has(name) || m[4] === "/") continue;
    stack.push(el);
  }
  if (last < src.length) pushText(src.slice(last));
  return root;
}

function parseAttrs(str) {
  const out = {};
  const re = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    const k = m[1].toLowerCase();
    if (!k) continue;
    const v = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : "";
    if (!(k in out)) out[k] = decodeEntities(v);
  }
  return out;
}

export function decodeEntities(s) {
  if (!s) return "";
  return String(s)
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (full, code) => {
      const c = String(code);
      if (c[0] === "#") {
        const n = c[1] === "x" || c[1] === "X" ? parseInt(c.slice(2), 16) : parseInt(c.slice(1), 10);
        return isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : full;
      }
      const map = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "-", mdash: "-", hellip: "...", rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', middot: ".", copy: "(c)", reg: "(R)", trade: "(TM)" };
      return map[c.toLowerCase()] !== undefined ? map[c.toLowerCase()] : full;
    });
}

export function walk(node, fn) {
  const kids = node.children || [];
  for (let i = 0; i < kids.length; i++) { fn(kids[i]); walk(kids[i], fn); }
}

export function findAll(root, tag) {
  const out = [];
  walk(root, (el) => { if (el.tag === tag) out.push(el); });
  return out;
}

export function findFirst(root, tag) {
  let found = null;
  walk(root, (el) => { if (!found && el.tag === tag) found = el; });
  return found;
}

export function textOf(node, opts) {
  const skip = (opts && opts.skip) || new Set(["script", "style", "noscript", "template", "svg"]);
  let out = "";
  const rec = (el) => {
    if (skip.has(el.tag)) return;
    const st = el.attrs && el.attrs.style ? String(el.attrs.style).toLowerCase() : "";
    if (opts && opts.skipHidden && (el.attrs.hidden !== undefined || /display\s*:\s*none|visibility\s*:\s*hidden/.test(st))) return;
    if (el.raw) out += " " + el.raw + " ";
    for (let i = 0; i < (el.children || []).length; i++) rec(el.children[i]);
  };
  for (let i = 0; i < (node.children || []).length; i++) rec(node.children[i]);
  if (node.raw && node.tag !== "#root") out += " " + node.raw;
  return out.replace(/\s+/g, " ").trim();
}

export function ownText(el) {
  let out = el.raw ? el.raw + " " : "";
  for (let i = 0; i < (el.children || []).length; i++) out += textOf(el.children[i]) + " ";
  return out.replace(/\s+/g, " ").trim();
}

export function normSpace(s) { return String(s || "").replace(/\s+/g, " ").trim(); }

// ---------------------------------------------------------------- URLs
export function resolveUrl(href, base) {
  try { return new URL(href, base).toString(); } catch { return null; }
}
export function stripHash(u) {
  try { const x = new URL(u); x.hash = ""; return x.toString(); } catch { return u; }
}
export function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; }
}
export function sameSite(a, b) { return hostOf(a) === hostOf(b) && !!hostOf(a); }

// ---------------------------------------------------------------- extraction
export function extractPage(html, finalUrl, status, headers, timing) {
  const root = parseHTML(html);
  const head = findFirst(root, "head") || root;
  const body = findFirst(root, "body") || root;

  const meta = findAll(root, "meta");
  const titles = findAll(root, "title").map((t) => normSpace(decodeEntities(t.raw || ""))).filter(Boolean);
  const title = titles[0] || "";

  let metaDesc = "";
  let metaDescCount = 0;
  const canonicals = [];
  const metaRobots = [];
  let viewport = null;
  const og = {};
  const tw = {};
  let ogCount = 0, twCount = 0;
  let charset = null;
  let metaKeywords = "";

  for (const m of meta) {
    const name = (m.attrs.name || "").toLowerCase();
    const prop = (m.attrs.property || "").toLowerCase();
    const content = m.attrs.content || "";
    if (name === "description") { metaDescCount++; if (!metaDesc) metaDesc = normSpace(content); }
    if (name === "robots" || name === "googlebot" || name === "bingbot") metaRobots.push({ name, content: String(content).toLowerCase() });
    if (name === "viewport") viewport = content;
    if (name === "keywords") metaKeywords = normSpace(content);
    if (name === "charset" || prop === "charset") charset = m.attrs.charset || content;
    if (m.attrs.charset) charset = m.attrs.charset;
    if (prop.startsWith("og:")) { ogCount++; if (og[prop] === undefined) og[prop] = content; }
    if (name.startsWith("twitter:")) { twCount++; if (tw[name] === undefined) tw[name] = content; }
  }

  const refresh = meta.find((m) => (m.attrs["http-equiv"] || "").toLowerCase() === "refresh");

  for (const l of findAll(root, "link")) {
    const rel = (l.attrs.rel || "").toLowerCase();
    if (rel.split(/\s+/).includes("canonical")) canonicals.push(resolveUrl(l.attrs.href || "", finalUrl) || l.attrs.href || "");
  }

  const headings = [];
  walk(root, (el) => {
    if (/^h[1-6]$/.test(el.tag)) headings.push({ level: +el.tag[1], text: ownText(el), hidden: isHidden(el) });
  });
  const h1s = headings.filter((h) => h.level === 1);

  const imgs = findAll(root, "img").map((i) => ({
    src: i.attrs.src || i.attrs["data-src"] || "",
    alt: i.attrs.alt === undefined ? null : i.attrs.alt,
    width: i.attrs.width || "", height: i.attrs.height || "",
    loading: (i.attrs.loading || "").toLowerCase(),
    srcset: i.attrs.srcset || "", role: i.attrs.role || "",
    ariaHidden: i.attrs["aria-hidden"] || "",
  }));

  const links = [];
  for (const a of findAll(root, "a")) {
    const hrefRaw = a.attrs.href;
    const href = hrefRaw === undefined ? null : resolveUrl(hrefRaw, finalUrl);
    const rel = (a.attrs.rel || "").toLowerCase().split(/\s+/).filter(Boolean);
    const text = ownText(a);
    links.push({
      href, raw: hrefRaw === undefined ? null : hrefRaw, rel,
      text, title: a.attrs.title || "", target: a.attrs.target || "",
      internal: href ? sameSite(href, finalUrl) : false,
      hidden: isHidden(a), download: a.attrs.download !== undefined,
    });
  }

  const scripts = findAll(root, "script").map((s) => ({
    src: s.attrs.src || "", async: s.attrs.async !== undefined, defer: s.attrs.defer !== undefined,
    type: (s.attrs.type || "").toLowerCase(), inline: normSpace(s.raw || "").slice(0, 4000),
    inHead: inHeadOf(s, head),
  }));
  const stylesheets = findAll(root, "link").filter((l) => (l.attrs.rel || "").toLowerCase().split(/\s+/).includes("stylesheet")).map((l) => ({ href: l.attrs.href || "", media: l.attrs.media || "" }));
  const inlineStyles = findAll(root, "style").map((s) => normSpace(s.raw || ""));

  // JSON-LD
  const jsonld = [];
  const ldErrors = [];
  for (const s of findAll(root, "script")) {
    const type = (s.attrs.type || "").toLowerCase();
    if (type.includes("ld+json")) {
      const raw = (s.raw || "").trim();
      try { jsonld.push(JSON.parse(raw)); }
      catch (e) { ldErrors.push(String(e && e.message ? e.message : e).slice(0, 200)); }
    }
  }

  const hreflang = [];
  for (const l of findAll(root, "link")) {
    const rel = (l.attrs.rel || "").toLowerCase();
    if (rel === "alternate" && l.attrs.hreflang) hreflang.push({ lang: String(l.attrs.hreflang).toLowerCase(), href: resolveUrl(l.attrs.href || "", finalUrl) || l.attrs.href || "" });
  }
  const feeds = findAll(root, "link").filter((l) => /alternate/.test((l.attrs.rel || "").toLowerCase()) && /rss|atom|json/.test((l.attrs.type || "").toLowerCase())).map((l) => l.attrs.href || "");

  const htmlEl = findFirst(root, "html");
  const htmlLang = htmlEl ? (htmlEl.attrs.lang || "") : "";

  const bodyText = textOf(body);
  const words = bodyText ? bodyText.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)) : [];
  let domNodes = 0, domDepth = 0;
  const recDom = (n, d) => { domNodes++; if (d > domDepth) domDepth = d; for (const c of n.children || []) recDom(c, d + 1); };
  recDom(root, 0);

  const xRobots = String((headers && (headers["x-robots-tag"] || "")) || "").toLowerCase();
  const robotsBlob = metaRobots.map((r) => r.content).join(",") + "," + xRobots;

  const iframes = findAll(root, "iframe").map((f) => ({ src: f.attrs.src || "", title: f.attrs.title || "" }));
  const forms = findAll(root, "form").map((f) => ({ action: f.attrs.action || "", inputs: findAll(f, "input").length }));
  const inputs = findAll(root, "input").map((i) => ({ type: (i.attrs.type || "text").toLowerCase(), id: i.attrs.id || "", name: i.attrs.name || "", ariaLabel: i.attrs["aria-label"] || "", placeholder: i.attrs.placeholder || "", hasLabel: false }));
  const labels = findAll(root, "label").map((l) => l.attrs.for || "");
  for (const i of inputs) if (i.id && labels.includes(i.id)) i.hasLabel = true;

  const buttons = findAll(root, "button").map((b) => ({ text: ownText(b), ariaLabel: b.attrs["aria-label"] || "" }));
  const tables = findAll(root, "table").map((t) => ({ th: findAll(t, "th").length, rows: findAll(t, "tr").length, scope: findAll(t, "th").some((x) => !!x.attrs.scope) }));

  return {
    root, htmlSnippet: String(html),
    url: finalUrl, status, headers: headers || {},
    htmlSize: html.length,
    title, titles, titleCount: titles.length,
    metaDesc, metaDescCount, metaKeywords, refresh: !!refresh,
    canonicals, metaRobots, xRobots, robotsBlob,
    noindex: /noindex|none/.test(robotsBlob), nofollow: /nofollow|none/.test(robotsBlob),
    og, tw, ogCount, twCount, charset, viewport,
    headings, h1s, imgs, links, scripts, stylesheets, inlineStyles,
    jsonld, ldErrors, hreflang, feeds, htmlLang,
    text: bodyText, words, wordCount: words.length, textLen: bodyText.length,
    htmlTextLen: normSpace(textOf(root)).length,
    domNodes, domDepth,
    iframes, forms, inputs, buttons, tables,
    ttfbMs: timing && timing.ttfbMs || 0, totalMs: timing && timing.totalMs || 0,
    inHead: { scripts: scripts.filter((s) => s.inHead).length },
    headFirstChild: head.children.length ? head.children[0].tag : "",
  };
}

function inHeadOf(el, head) {
  let p = el;
  while (p) { if (p === head) return true; p = p.parent; }
  return false;
}

function isHidden(el) {
  let p = el;
  while (p) {
    const a = p.attrs || {};
    if (a.hidden !== undefined) return true;
    if ((a["aria-hidden"] || "").toLowerCase() === "true") return true;
    const st = String(a.style || "").toLowerCase().replace(/\s+/g, "");
    if (/display:none|visibility:hidden|opacity:0(;|$)|font-size:0(;|$)|text-indent:-9999/.test(st)) return true;
    p = p.parent;
  }
  return false;
}

// ---------------------------------------------------------------- similarity
export function shingles(text, k) {
  const n = k || 5;
  const w = String(text || "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  const set = new Set();
  for (let i = 0; i + n <= w.length; i++) set.add(w.slice(i, i + n).join(" "));
  return set;
}

export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  for (const x of small) if (big.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export function syllableCount(word) {
  const w = String(word || "").toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 0;
  if (w.length <= 3) return 1;
  const m = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "").match(/[aeiouy]{1,2}/g);
  return m ? m.length : 1;
}

export function fleschReadingEase(text) {
  const sents = String(text || "").split(/[.!?]+/).filter((s) => s.trim().length > 2).length || 1;
  const words = String(text || "").split(/\s+/).filter(Boolean);
  if (words.length < 20) return null;
  const syll = words.reduce((a, w) => a + syllableCount(w), 0);
  return Math.round(206.835 - 1.015 * (words.length / sents) - 84.6 * (syll / words.length));
}
