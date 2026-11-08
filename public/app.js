/* =====================================================================
   SEO Tag Analyzer – front end
   1. Ask the local server (/api/fetch) for a page's HTML
   2. Parse it with DOMParser (scripts don't run, images don't load)
   3. Run best-practice checks, score them, and render report + previews
   ===================================================================== */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

const state = { page: null, checks: [], filter: "all" };

/* ---------- Best-practice thresholds (edit here to tune the rules) ---------- */
const RULES = {
  title: { min: 30, max: 60, maxPx: 600, font: "20px Arial" },
  description: { min: 50, max: 160, maxPx: 920, font: "14px Arial" },
  ogTitleMax: 90,
  ogDescMax: 200,
  ogImage: { minW: 600, minH: 315, idealW: 1200, idealH: 630 },
  thinContentWords: 80,
};

/* ---------- Text width measurement (for pixel-based truncation) ---------- */
const ctx = document.createElement("canvas").getContext("2d");
function textWidth(text, font) {
  ctx.font = font;
  return ctx.measureText(text).width;
}
function truncatePx(text, maxPx, font) {
  if (textWidth(text, font) <= maxPx) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (textWidth(text.slice(0, mid) + " ...", font) <= maxPx) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo).trimEnd() + " ...";
}

/* =====================================================================
   Fetch + parse
   ===================================================================== */
async function analyze(rawUrl) {
  rawUrl = rawUrl.trim();
  if (!rawUrl) return;
  const btn = $("#analyze-btn");
  btn.disabled = true;
  setStatus(`<div class="spinner"></div> Fetching <b>${esc(rawUrl)}</b> and checking its tags…`);

  try {
    let res;
    try {
      res = await fetch(`/api/fetch?url=${encodeURIComponent(rawUrl)}`);
    } catch {
      throw new Error("Can't reach the local server. Start it with start.bat (or `python server.py`) and open http://localhost:8000.");
    }
    const data = await res.json().catch(() => ({ error: "The server returned an unexpected response." }));
    if (!res.ok || data.error) throw new Error(data.error || `Request failed (${res.status})`);

    const doc = new DOMParser().parseFromString(data.html, "text/html");
    const page = extract(doc, data);
    await probeImages(page);
    state.page = page;
    state.checks = runChecks(page);
    state.filter = "all";

    hideStatus();
    render();
    const qs = new URLSearchParams({ url: rawUrl });
    history.replaceState(null, "", `?${qs}`);
  } catch (err) {
    setStatus(`⚠️ ${esc(err.message)}`, true);
  } finally {
    btn.disabled = false;
  }
}

function extract(doc, data) {
  const base = data.finalUrl;
  const abs = (u) => { try { return new URL(u, base).href; } catch { return u; } };
  const isAbsolute = (u) => /^https?:\/\//i.test(u || "");

  // All <meta> tags keyed by name / property / http-equiv (lower-cased)
  const meta = {};
  for (const m of $$("meta", doc)) {
    const key = (m.getAttribute("property") || m.getAttribute("name") || m.getAttribute("http-equiv") || "").toLowerCase().trim();
    if (!key) continue;
    (meta[key] ||= []).push(clean(m.getAttribute("content")));
  }
  const get = (k) => (meta[k] || [])[0] || "";

  const relHas = (el, token) => (el.getAttribute("rel") || "").toLowerCase().split(/\s+/).includes(token);
  const links = $$("link", doc);

  const titles = $$("title", doc).filter((t) => !t.closest("svg"));
  const canonicals = links.filter((l) => relHas(l, "canonical"));
  const icons = links.filter((l) => relHas(l, "icon") || relHas(l, "apple-touch-icon"));
  const hreflangs = links.filter((l) => relHas(l, "alternate") && l.hasAttribute("hreflang"));

  // Headings & images
  const headings = $$("h1,h2,h3,h4,h5,h6", doc).map((h) => ({ level: +h.tagName[1], text: clean(h.textContent) }));
  const images = $$("img", doc);

  // Visible text (roughly what a crawler sees without running JavaScript)
  const body = doc.body ? doc.body.cloneNode(true) : null;
  if (body) $$("script,style,noscript,template,svg", body).forEach((n) => n.remove());
  const words = body ? clean(body.textContent).split(" ").filter(Boolean).length : 0;

  // JSON-LD structured data
  const jsonld = $$('script[type="application/ld+json" i]', doc).map((s) => {
    const raw = s.textContent.trim();
    try {
      const parsed = JSON.parse(raw);
      const types = new Set();
      const walk = (n) => {
        if (Array.isArray(n)) return n.forEach(walk);
        if (n && typeof n === "object") {
          if (n["@type"]) [].concat(n["@type"]).forEach((t) => types.add(t));
          if (n["@graph"]) walk(n["@graph"]);
        }
      };
      walk(parsed);
      return { ok: true, raw, parsed, types: [...types] };
    } catch (e) {
      return { ok: false, raw, error: e.message, types: [] };
    }
  });

  const charsetEl = doc.querySelector("meta[charset]");
  const iconHref = icons[0]?.getAttribute("href");

  return {
    data, doc, meta, get, abs, isAbsolute,
    finalUrl: base,
    url: new URL(base),
    titles,
    title: clean(titles[0]?.textContent),
    description: get("description"),
    canonicals,
    canonical: canonicals[0]?.getAttribute("href") || "",
    robots: [get("robots"), get("googlebot")].filter(Boolean).join(", "),
    xRobots: data.xRobotsTag || "",
    viewport: get("viewport"),
    charset: charsetEl?.getAttribute("charset") || (get("content-type").match(/charset=([\w-]+)/i) || [])[1] || "",
    lang: doc.documentElement.getAttribute("lang") || "",
    favicon: iconHref ? abs(iconHref) : `${new URL(base).origin}/favicon.ico`,
    hasDeclaredFavicon: !!iconHref,
    hreflangs: hreflangs.map((l) => ({ lang: l.getAttribute("hreflang"), href: l.getAttribute("href") })),
    headings,
    h1s: headings.filter((h) => h.level === 1),
    images,
    words,
    scriptCount: $$("script[src]", doc).length,
    jsonld,
    imageInfo: {},
  };
}

/* Load social images in the browser to read their real pixel size */
function probeImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.referrerPolicy = "no-referrer";
    const t = setTimeout(() => resolve({ ok: false, timeout: true }), 6000);
    img.onload = () => { clearTimeout(t); resolve({ ok: true, w: img.naturalWidth, h: img.naturalHeight }); };
    img.onerror = () => { clearTimeout(t); resolve({ ok: false }); };
    img.src = url;
  });
}
async function probeImages(page) {
  const urls = [...new Set([page.get("og:image"), page.get("twitter:image"), page.get("twitter:image:src")].filter(Boolean).map(page.abs))];
  const results = await Promise.all(urls.map(probeImage));
  urls.forEach((u, i) => (page.imageInfo[u] = results[i]));
}

/* =====================================================================
   Checks
   status: pass | warn | fail | info   (info = no effect on score)
   ===================================================================== */
const CATEGORIES = [
  ["essentials", "Essentials"],
  ["content", "Content & structure"],
  ["og", "Open Graph — Facebook, LinkedIn, Slack"],
  ["twitter", "Twitter / X cards"],
  ["technical", "Indexing & technical"],
];

function runChecks(p) {
  const checks = [];
  const add = (cat, name, status, summary, opts = {}) =>
    checks.push({ cat, name, status, summary, weight: opts.weight ?? 3, ...opts });

  /* ---------------- Essentials ---------------- */
  // Title
  {
    const t = p.title, len = t.length, px = Math.round(textWidth(t, RULES.title.font));
    const lenbar = { value: len, min: RULES.title.min, max: RULES.title.max, scale: 90, unit: "chars" };
    if (!t) {
      add("essentials", "Title tag", "fail", "Missing — this is the headline Google shows", {
        weight: 10, value: null,
        tip: "Add a unique, descriptive <title> of about 50–60 characters with your main keyword near the start.",
      });
    } else {
      const issues = [];
      if (p.titles.length > 1) issues.push(`${p.titles.length} <title> tags found — keep only one`);
      if (len < RULES.title.min) issues.push(`Short (${len} chars) — you're leaving room for keywords on the table`);
      if (len > RULES.title.max || px > RULES.title.maxPx) issues.push(`Long (${len} chars, ~${px}px) — Google will likely cut it off around ${RULES.title.maxPx}px`);
      add("essentials", "Title tag", issues.length ? "warn" : "pass", issues[0] || `${len} characters · ~${px}px — good length`, {
        weight: 10, value: t, lenbar, messages: issues,
        tip: "Aim for 50–60 characters (under ~600px). Lead with the topic, end with your brand.",
      });
    }
  }
  // Meta description
  {
    const d = p.description, len = d.length, count = (p.meta.description || []).length;
    const lenbar = { value: len, min: RULES.description.min, max: RULES.description.max, scale: 220, unit: "chars" };
    if (!d) {
      add("essentials", "Meta description", "fail", "Missing — Google will pick random page text instead", {
        weight: 8, value: null,
        tip: 'Add <meta name="description" content="…"> with a 120–160 character summary that makes people want to click.',
      });
    } else {
      const issues = [];
      if (count > 1) issues.push(`${count} description tags found — keep only one`);
      if (len < RULES.description.min) issues.push(`Short (${len} chars) — use the space to sell the click`);
      if (len > RULES.description.max) issues.push(`Long (${len} chars) — likely truncated in results`);
      add("essentials", "Meta description", issues.length ? "warn" : "pass", issues[0] || `${len} characters — good length`, {
        weight: 8, value: d, lenbar, messages: issues,
        tip: "Aim for 120–160 characters. Summarize the page and include a reason to click.",
      });
    }
  }
  // Canonical
  {
    const c = p.canonical;
    if (!p.canonicals.length) {
      add("essentials", "Canonical URL", "warn", "Not set — duplicate URLs may split ranking signals", {
        weight: 6, value: null,
        tip: `Add <link rel="canonical" href="${p.finalUrl}"> so search engines know the preferred URL.`,
      });
    } else if (p.canonicals.length > 1) {
      add("essentials", "Canonical URL", "fail", `${p.canonicals.length} canonical tags — search engines may ignore all of them`, {
        weight: 6, value: p.canonicals.map((l) => l.getAttribute("href")).join("\n"),
        tip: "Keep exactly one canonical link per page.",
      });
    } else if (!c) {
      add("essentials", "Canonical URL", "fail", "Canonical tag has an empty href", { weight: 6, value: "" });
    } else {
      const absC = p.abs(c);
      const issues = [];
      let status = "pass";
      if (!p.isAbsolute(c)) { issues.push("Uses a relative URL — absolute URLs are safer"); status = "warn"; }
      try {
        if (new URL(absC).host !== p.url.host) { issues.push(`Points to a different domain (${new URL(absC).host})`); status = "warn"; }
        else if (stripSlash(absC) !== stripSlash(p.finalUrl)) issues.push("Points to a different URL on this site — fine if intentional (e.g. removing tracking parameters)");
      } catch {}
      add("essentials", "Canonical URL", status, issues[0] || "Set and self-referencing", {
        weight: 6, value: c, messages: issues,
        tip: "Use one absolute, self-referencing canonical on every indexable page.",
      });
    }
  }
  // Robots meta + X-Robots-Tag
  {
    const combined = [p.robots, p.xRobots].filter(Boolean).join(", ").toLowerCase();
    const shown = [p.robots && `meta robots: ${p.robots}`, p.xRobots && `X-Robots-Tag header: ${p.xRobots}`].filter(Boolean).join("\n");
    if (/\bnoindex\b|\bnone\b/.test(combined)) {
      add("essentials", "Robots directives", "fail", "noindex — this page is blocked from Google's index", {
        weight: 8, value: shown, tip: "If you want this page in search results, remove noindex. (Intentional for staging, thank-you or admin pages.)",
      });
    } else if (/\bnofollow\b/.test(combined)) {
      add("essentials", "Robots directives", "warn", "nofollow — links on this page pass no signals", { weight: 8, value: shown, tip: "Remove nofollow unless you deliberately don't want links crawled." });
    } else {
      add("essentials", "Robots directives", "pass", combined ? `Indexable (${combined})` : "Indexable — no restrictions (defaults to index, follow)", {
        weight: 8, value: shown || null,
      });
    }
  }
  // Viewport
  {
    const v = p.viewport.toLowerCase();
    if (!v) add("essentials", "Mobile viewport", "fail", "Missing — page won't scale properly on phones (hurts mobile-first indexing)", {
      weight: 5, value: null, tip: 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.',
    });
    else if (!v.includes("width=device-width")) add("essentials", "Mobile viewport", "warn", "Doesn't use width=device-width", { weight: 5, value: p.viewport });
    else if (/user-scalable\s*=\s*(no|0)|maximum-scale\s*=\s*1(\.0)?\b/.test(v)) add("essentials", "Mobile viewport", "warn", "Blocks pinch-zoom — an accessibility problem", {
      weight: 5, value: p.viewport, tip: "Remove user-scalable=no and maximum-scale=1.",
    });
    else add("essentials", "Mobile viewport", "pass", "Responsive viewport set", { weight: 5, value: p.viewport });
  }
  // Lang
  add("essentials", "Language attribute", p.lang ? "pass" : "warn", p.lang ? `<html lang="${p.lang}">` : "Missing <html lang> — helps search engines and screen readers", {
    weight: 3, value: p.lang || null, tip: p.lang ? null : 'Add a language to the html tag, e.g. <html lang="en">.',
  });
  // Charset
  add("essentials", "Character encoding", p.charset ? "pass" : "warn", p.charset ? `Declared as ${p.charset}` : "No charset declared — text may render as garbled characters", {
    weight: 2, value: p.charset || null, tip: p.charset ? null : 'Add <meta charset="utf-8"> as the first tag in <head>.',
  });
  // Favicon
  add("essentials", "Favicon", p.hasDeclaredFavicon ? "pass" : "warn", p.hasDeclaredFavicon ? "Declared — shown next to your result in Google" : "Not declared in <head> (browsers will guess /favicon.ico)", {
    weight: 2, value: p.hasDeclaredFavicon ? p.favicon : null, tip: p.hasDeclaredFavicon ? null : 'Add <link rel="icon" href="/favicon.ico"> (Google prefers at least 48×48px).',
  });

  /* ---------------- Content & structure ---------------- */
  {
    const n = p.h1s.length;
    if (n === 0) add("content", "H1 heading", "fail", "No <h1> — the page's main topic is unclear", { weight: 6, value: null, tip: "Add one H1 that describes the page (it can echo the title)." });
    else if (n > 1) add("content", "H1 heading", "warn", `${n} H1s found — one clear H1 is best practice`, { weight: 6, value: p.h1s.map((h) => h.text || "(empty)").join("\n") });
    else add("content", "H1 heading", p.h1s[0].text ? "pass" : "warn", p.h1s[0].text ? `"${p.h1s[0].text}"` : "H1 is empty", { weight: 6, value: p.h1s[0].text });
  }
  {
    const skips = [];
    p.headings.forEach((h, i) => {
      const prev = p.headings[i - 1];
      if (prev && h.level > prev.level + 1) skips.push(`H${prev.level} → H${h.level} before "${h.text.slice(0, 50)}"`);
    });
    const outline = p.headings.slice(0, 40).map((h) => `${"  ".repeat(h.level - 1)}H${h.level}  ${h.text.slice(0, 90)}`).join("\n");
    if (!p.headings.length) add("content", "Heading structure", "warn", "No headings found", { weight: 2, value: null });
    else add("content", "Heading structure", skips.length ? "warn" : "pass", skips.length ? `${skips.length} skipped level${skips.length > 1 ? "s" : ""} (e.g. ${skips[0]})` : `${p.headings.length} headings in a logical order`, {
      weight: 2, value: outline + (p.headings.length > 40 ? `\n… ${p.headings.length - 40} more` : ""),
      tip: skips.length ? "Don't skip levels (H2 → H4). Headings should read like a table of contents." : null,
    });
  }
  {
    const total = p.images.length;
    const missing = p.images.filter((i) => !i.hasAttribute("alt"));
    if (!total) add("content", "Image alt text", "info", "No <img> tags in the HTML", { weight: 0 });
    else {
      const pct = Math.round(((total - missing.length) / total) * 100);
      add("content", "Image alt text", missing.length ? (pct >= 80 ? "warn" : "fail") : "pass", missing.length ? `${missing.length} of ${total} images missing alt (${pct}% covered)` : total === 1 ? "The page's image has an alt attribute" : `All ${total} images have alt attributes`, {
        weight: 4,
        value: missing.length ? missing.slice(0, 12).map((i) => i.getAttribute("src") || i.getAttribute("data-src") || "(no src)").join("\n") + (missing.length > 12 ? `\n… ${missing.length - 12} more` : "") : null,
        tip: missing.length ? 'Describe meaningful images in alt text; use alt="" for decorative ones.' : null,
      });
    }
  }
  {
    const thin = p.words < RULES.thinContentWords;
    add("content", "Crawlable text", thin ? "warn" : "pass", thin ? `Only ~${p.words} words in the raw HTML${p.scriptCount > 5 ? " — content is probably rendered by JavaScript" : ""}` : `~${p.words.toLocaleString()} words visible without JavaScript`, {
      weight: 3,
      tip: thin ? "Social scrapers (Facebook, LinkedIn, Slack) never run JavaScript and Google renders it later. Server-render key content and all meta tags." : null,
    });
  }

  /* ---------------- Open Graph ---------------- */
  {
    const v = p.get("og:title");
    add("og", "og:title", v ? (v.length > RULES.ogTitleMax ? "warn" : "pass") : "warn", v ? (v.length > RULES.ogTitleMax ? `Long (${v.length} chars) — will be cut off in share cards` : `${v.length} characters`) : `Missing — platforms will fall back to the <title>`, {
      weight: 5, value: v || null, tip: v ? null : '<meta property="og:title" content="…"> — can be punchier than your SEO title.',
    });
  }
  {
    const v = p.get("og:description");
    add("og", "og:description", v ? (v.length > RULES.ogDescMax ? "warn" : "pass") : "warn", v ? (v.length > RULES.ogDescMax ? `Long (${v.length} chars)` : `${v.length} characters`) : "Missing — falls back to meta description (or nothing)", {
      weight: 4, value: v || null, tip: v ? null : '<meta property="og:description" content="…"> — 1–2 sentences.',
    });
  }
  {
    const v = p.get("og:image");
    if (!v) add("og", "og:image", "fail", "Missing — shared links will have no picture (far fewer clicks)", {
      weight: 6, value: null, tip: '<meta property="og:image" content="https://…/share.jpg"> — 1200×630px, under 5MB.',
    });
    else {
      const info = p.imageInfo[p.abs(v)] || {};
      const issues = [];
      let status = "pass";
      if (!p.isAbsolute(v)) { issues.push("Relative URL — most platforms require a full https:// URL"); status = "warn"; }
      else if (/^http:/i.test(v)) { issues.push("Uses http:// — use https://"); status = "warn"; }
      if (info.ok === false) { issues.push(info.timeout ? "Image took too long to load" : "Image failed to load (broken link, or the host blocks hotlinking)"); status = "fail"; }
      else if (info.ok) {
        const { w, h } = info;
        if (w < RULES.ogImage.minW || h < RULES.ogImage.minH) { issues.push(`Small (${w}×${h}) — shows as a thumbnail instead of a large card`); status = "warn"; }
        else if (Math.abs(w / h - 1.91) > 0.25) issues.push(`${w}×${h} — not 1.91:1, so it will be cropped`);
      }
      add("og", "og:image", status, issues[0] || (info.ok ? `${info.w}×${info.h}px — great` : "Set"), {
        weight: 6, value: v, messages: issues, image: p.abs(v),
        tip: `Recommended: ${RULES.ogImage.idealW}×${RULES.ogImage.idealH}px (1.91:1), absolute https URL.`,
      });
    }
  }
  {
    const v = p.get("og:url");
    const mismatch = v && p.canonical && stripSlash(p.abs(v)) !== stripSlash(p.abs(p.canonical));
    add("og", "og:url", !v ? "warn" : mismatch ? "warn" : "pass", !v ? "Missing — share counts may split across URL variants" : mismatch ? "Doesn't match the canonical URL" : "Set", {
      weight: 2, value: v || null, tip: "Should match your canonical URL.",
    });
  }
  add("og", "og:type", p.get("og:type") ? "pass" : "warn", p.get("og:type") ? p.get("og:type") : 'Missing — use "website" or "article"', { weight: 2, value: p.get("og:type") || null });
  add("og", "og:site_name", p.get("og:site_name") ? "pass" : "info", p.get("og:site_name") || "Not set (optional) — shown above the title on some platforms", { weight: p.get("og:site_name") ? 1 : 0, value: p.get("og:site_name") || null });
  if (p.get("og:image")) add("og", "og:image:alt", p.get("og:image:alt") ? "pass" : "info", p.get("og:image:alt") ? "Set — good for accessibility" : "Not set (optional) — describes the share image for screen readers", { weight: p.get("og:image:alt") ? 1 : 0, value: p.get("og:image:alt") || null });

  /* ---------------- Twitter / X ---------------- */
  {
    const v = p.get("twitter:card");
    const valid = ["summary", "summary_large_image", "app", "player"];
    if (!v) add("twitter", "twitter:card", "warn", "Missing — X shows a small card (or none)", {
      weight: 4, value: null, tip: '<meta name="twitter:card" content="summary_large_image"> for a big image preview.',
    });
    else if (!valid.includes(v)) add("twitter", "twitter:card", "fail", `"${v}" isn't a valid card type`, { weight: 4, value: v, tip: `Use one of: ${valid.join(", ")}.` });
    else add("twitter", "twitter:card", "pass", v === "summary_large_image" ? "Large image card" : `${v} card`, { weight: 4, value: v });
  }
  for (const [key, og, w] of [["twitter:title", "og:title", 2], ["twitter:description", "og:description", 2], ["twitter:image", "og:image", 3]]) {
    const v = p.get(key) || (key === "twitter:image" ? p.get("twitter:image:src") : "");
    if (v) add("twitter", key, "pass", "Set", { weight: w, value: v });
    else if (p.get(og)) add("twitter", key, "pass", `Not set — X falls back to ${og} (that's fine)`, { weight: w, value: null });
    else add("twitter", key, "warn", `Missing, and no ${og} to fall back on`, { weight: w, value: null });
  }
  add("twitter", "twitter:site", p.get("twitter:site") ? "pass" : "info", p.get("twitter:site") ? `Attributed to ${p.get("twitter:site")}` : "Not set (optional) — your brand's @handle", { weight: p.get("twitter:site") ? 1 : 0, value: p.get("twitter:site") || null });

  /* ---------------- Indexing & technical ---------------- */
  {
    const s = p.data.status;
    add("technical", "HTTP status", s >= 200 && s < 300 ? "pass" : "fail", `${s}${s >= 400 ? " — search engines won't index an error page" : ""}`, { weight: 8 });
  }
  add("technical", "HTTPS", p.url.protocol === "https:" ? "pass" : "fail", p.url.protocol === "https:" ? "Served securely" : "Not served over HTTPS — a ranking signal and browser warning", { weight: 5 });
  if (stripSlash(p.data.requestedUrl) !== stripSlash(p.finalUrl)) {
    add("technical", "Redirect", "info", `Redirected to ${p.finalUrl}`, { weight: 0, value: `${p.data.requestedUrl}\n→ ${p.finalUrl}`, tip: "Link to the final URL directly to avoid redirect hops." });
  }
  {
    const ld = p.jsonld;
    const bad = ld.filter((x) => !x.ok);
    const types = [...new Set(ld.flatMap((x) => x.types))];
    if (!ld.length) add("technical", "Structured data", "warn", "No JSON-LD found — you may miss rich results (stars, FAQs, breadcrumbs…)", {
      weight: 4, tip: "Add schema.org JSON-LD, e.g. Organization, WebSite, Article, Product or BreadcrumbList.",
    });
    else if (bad.length) add("technical", "Structured data", "fail", `${bad.length} JSON-LD block${bad.length > 1 ? "s" : ""} contain invalid JSON`, { weight: 4, value: bad.map((b) => b.error).join("\n") });
    else add("technical", "Structured data", "pass", `${ld.length} block${ld.length > 1 ? "s" : ""}: ${types.join(", ") || "untyped"}`, { weight: 4, value: types.join(", ") });
  }
  {
    const r = p.data.robots;
    if (r) {
      add("technical", "robots.txt", r.found ? "pass" : "warn", r.found ? "Found" : "Not found", { weight: 2, value: r.found ? r.text.slice(0, 1500) : null, link: r.url });
      if (r.found) add("technical", "XML sitemap", r.sitemaps?.length ? "pass" : "warn", r.sitemaps?.length ? `${r.sitemaps.length} listed in robots.txt` : "Not listed in robots.txt", {
        weight: 2, value: r.sitemaps?.join("\n") || null, tip: r.sitemaps?.length ? null : "Add a line like `Sitemap: https://example.com/sitemap.xml` to robots.txt.",
      });
    }
  }
  {
    const dupKeys = ["description", "robots", "viewport", "og:title", "og:description", "og:url", "og:type", "twitter:card", "twitter:title", "twitter:description"]
      .filter((k) => (p.meta[k] || []).length > 1);
    add("technical", "Duplicate tags", dupKeys.length ? "warn" : "pass", dupKeys.length ? `Duplicated: ${dupKeys.join(", ")}` : "No conflicting duplicates", {
      weight: 3, value: dupKeys.length ? dupKeys.map((k) => `${k}:\n  ${p.meta[k].join("\n  ")}`).join("\n") : null,
      tip: dupKeys.length ? "Platforms pick one unpredictably — keep a single tag for each (often a plugin/theme conflict)." : null,
    });
  }
  if (p.hreflangs.length) add("technical", "hreflang", "info", `${p.hreflangs.length} language alternates`, { weight: 0, value: p.hreflangs.map((h) => `${h.lang}  ${h.href}`).join("\n") });
  if (p.get("keywords")) add("technical", "Meta keywords", "info", "Present — ignored by Google (harmless, but reveals your keyword list to competitors)", { weight: 0, value: p.get("keywords") });

  return checks;
}

const stripSlash = (u) => { try { const x = new URL(u); return (x.origin + x.pathname).replace(/\/$/, "") + x.search; } catch { return u; } };

function score(checks) {
  let got = 0, max = 0;
  for (const c of checks) {
    if (c.status === "info" || !c.weight) continue;
    max += c.weight;
    got += c.weight * (c.status === "pass" ? 1 : c.status === "warn" ? 0.5 : 0);
  }
  return max ? Math.round((got / max) * 100) : 0;
}

/* =====================================================================
   Rendering
   ===================================================================== */
function render() {
  $("#empty-state").classList.add("hidden");
  $("#results").classList.remove("hidden");
  renderSummary();
  renderReport();
  renderGoogle();
  renderSocial();
  renderTags();
  selectTab(startTab);
  startTab = "report";
}

function renderSummary() {
  const p = state.page, checks = state.checks;
  const s = score(checks);
  const color = s >= 80 ? "var(--pass)" : s >= 55 ? "var(--warn)" : "var(--fail)";
  const arc = $("#score-arc");
  arc.style.stroke = color;
  arc.style.strokeDashoffset = 326.7;
  requestAnimationFrame(() => requestAnimationFrame(() => (arc.style.strokeDashoffset = 326.7 * (1 - s / 100))));
  animateNumber($("#score-value"), s);

  const counts = { pass: 0, warn: 0, fail: 0, info: 0 };
  checks.forEach((c) => counts[c.status]++);
  for (const k in counts) $(`#count-${k}`).textContent = counts[k];

  $("#score-verdict").textContent =
    s >= 90 ? "Excellent — this page's tags are in great shape." :
    s >= 80 ? "Strong — a few refinements left." :
    s >= 55 ? "Needs work — fix the failed checks first for the biggest gains." :
    "Poor — key tags are missing. Start with the red items.";

  const a = $("#final-url");
  a.href = p.finalUrl;
  a.textContent = p.finalUrl;
  const fav = $("#site-favicon");
  fav.src = p.favicon;
  fav.onerror = () => (fav.style.visibility = "hidden");
  fav.onload = () => (fav.style.visibility = "visible");

  const d = p.data;
  $("#meta-strip").innerHTML = [
    `Status <b>${d.status}</b>`,
    d.elapsedMs ? `Response <b>${d.elapsedMs.toLocaleString()} ms</b>` : "",
    `HTML <b>${(d.bytes / 1024).toFixed(0)} KB</b>${d.truncated ? " (truncated)" : ""}`,
    `<b>${Object.values(p.meta).flat().length}</b> meta tags`,
    stripSlash(d.requestedUrl) !== stripSlash(p.finalUrl) ? "<b>Redirected</b>" : "",
  ].filter(Boolean).map((x) => `<span>${x}</span>`).join("");
}

function animateNumber(el, to) {
  const start = performance.now(), dur = 800;
  const step = (t) => {
    const k = Math.min(1, (t - start) / dur);
    el.textContent = Math.round(to * (1 - Math.pow(1 - k, 3)));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

const ICON = { pass: "✓", warn: "!", fail: "✕", info: "i" };

function renderReport() {
  const html = CATEGORIES.map(([key, label]) => {
    const items = state.checks.filter((c) => c.cat === key);
    if (!items.length) return "";
    const catScore = score(items);
    return `
      <div class="category" data-cat="${key}">
        <div class="category-head">
          <h2>${esc(label)}</h2>
          <span class="mini">${catScore}%<span class="mini-bar"><i style="width:${catScore}%;background:${catScore >= 80 ? "var(--pass)" : catScore >= 55 ? "var(--warn)" : "var(--fail)"}"></i></span></span>
        </div>
        <div class="checks">${items.map(checkHtml).join("")}</div>
      </div>`;
  }).join("");
  $("#report").innerHTML = html;
  applyFilter();
}

function checkHtml(c) {
  const body = [];
  if (c.value !== undefined) {
    body.push(c.value === null || c.value === "" ? `<div class="value empty">Not found in the page</div>` : `<div class="value">${esc(c.value)}</div>`);
  }
  if (c.lenbar) body.push(lenbarHtml(c.lenbar));
  if (c.image) {
    const info = state.page.imageInfo[c.image];
    if (info?.ok) body.push(`<img src="${esc(c.image)}" referrerpolicy="no-referrer" alt="" style="max-width:280px;border-radius:8px;border:1px solid var(--line);margin-bottom:10px;display:block">`);
  }
  (c.messages || []).slice(c.status === "pass" ? 0 : 1).forEach((m) => body.push(`<p>• ${esc(m)}</p>`));
  if (c.link) body.push(`<p><a href="${esc(c.link)}" target="_blank" rel="noopener">${esc(c.link)}</a></p>`);
  if (c.tip) body.push(`<p class="tip"><b>Best practice:</b> ${esc(c.tip)}</p>`);
  const hasBody = body.length > 0;
  return `
    <div class="check ${c.status === "fail" && hasBody ? "open" : ""}" data-status="${c.status}">
      <button class="check-head" ${hasBody ? "" : "disabled style='cursor:default'"}>
        <span class="icon ${c.status}">${ICON[c.status]}</span>
        <span class="check-name">${esc(c.name)}</span>
        <span class="check-summary">${esc(c.summary)}</span>
        <span class="chev">${hasBody ? "▶" : ""}</span>
      </button>
      ${hasBody ? `<div class="check-body">${body.join("")}</div>` : ""}
    </div>`;
}

function lenbarHtml({ value, min, max, scale, unit }) {
  const pct = (n) => Math.min(100, (n / scale) * 100);
  return `
    <div class="lenbar">
      <span>0</span>
      <div class="track">
        <div class="zone" style="left:${pct(min)}%;width:${pct(max) - pct(min)}%" title="Ideal: ${min}–${max} ${unit}"></div>
        <div class="marker" style="left:${pct(value)}%"></div>
      </div>
      <span><b>${value}</b> ${unit} · ideal ${min}–${max}</span>
    </div>`;
}

function applyFilter() {
  const f = state.filter;
  $$("#report .check").forEach((el) => el.classList.toggle("hidden", f !== "all" && el.dataset.status !== f));
  $$("#report .category").forEach((cat) => cat.classList.toggle("hidden", !$$(".check:not(.hidden)", cat).length));
  $$(".filter[data-filter]").forEach((b) => b.classList.toggle("active", b.dataset.filter === f));
}

/* ---------- Google SERP preview ---------- */
function renderGoogle() {
  const p = state.page;
  const title = p.title || p.get("og:title") || p.url.hostname;
  const desc = p.description || "";
  const siteName = p.get("og:site_name") || p.url.hostname.replace(/^www\./, "");
  const parts = p.url.pathname.split("/").filter(Boolean).map(decodeURIComponentSafe);
  const crumb = `${p.url.origin}${parts.length ? " › " + parts.join(" › ") : ""}`;
  const descShown = desc || "No meta description — Google will generate a snippet from text on the page, which may not represent it well.";

  const block = (t, d, italic) => `
    <div class="serp-site">
      <div class="serp-fav"><img src="${esc(p.favicon)}" alt="" onerror="this.style.display='none'"></div>
      <div style="min-width:0">
        <div class="serp-sitename">${esc(siteName)}</div>
        <div class="serp-crumb">${esc(crumb)}</div>
      </div>
    </div>
    <h3 class="serp-title">${esc(t)}</h3>
    <div class="serp-desc" ${italic ? 'style="font-style:italic;color:#9aa0a6"' : ""}>${esc(d)}</div>`;

  $("#serp-desktop").innerHTML = block(
    truncatePx(title, RULES.title.maxPx, RULES.title.font),
    desc ? truncatePx(desc, RULES.description.maxPx, RULES.description.font) : descShown,
    !desc
  );
  $("#serp-mobile").innerHTML = block(title, descShown, !desc);

  const meter = (label, text, font, limit, rule) => {
    const px = Math.round(textWidth(text, font));
    const ok = text && px <= limit && text.length >= rule.min;
    const color = !text ? "var(--fail)" : ok ? "var(--pass)" : "var(--warn)";
    const scale = limit * 1.35;
    return `
      <div class="meter">
        <h4>${label}</h4>
        <div class="nums">${text ? `${text.length} characters · ~${px}px of ${limit}px` : "Missing"}</div>
        <div class="track">
          <div class="fill" style="width:${Math.min(100, (px / scale) * 100)}%;background:${color}"></div>
          <div class="limit" style="left:${(limit / scale) * 100}%" title="Truncation point"></div>
        </div>
      </div>`;
  };
  $("#serp-meters").innerHTML =
    meter("Title width", p.title, RULES.title.font, RULES.title.maxPx, RULES.title) +
    meter("Description width", p.description, RULES.description.font, RULES.description.maxPx, RULES.description);
}
const decodeURIComponentSafe = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

/* ---------- Social previews ---------- */
function renderSocial() {
  const p = state.page;
  const domain = p.url.hostname.replace(/^www\./, "");

  // pick(...) returns the first tag that has a value, and where it came from
  const pick = (...keys) => {
    for (const k of keys) {
      const v = k === "<title>" ? p.title : k === "description" ? p.description : p.get(k);
      if (v) return { v, src: k, fallback: k !== keys[0] };
    }
    return { v: "", src: null, wanted: keys[0] };
  };
  const srcHtml = (fields) => `<div class="sources">${fields.map(([label, r]) =>
    r.src ? `<span class="${r.fallback ? "fallback" : ""}">${label}: <code>${esc(r.src)}</code>${r.fallback ? " (fallback)" : ""}</span>`
          : `<span class="missing">${label}: <code>missing</code></span>`).join("")}</div>`;
  const imgHtml = (r, cls = "social-img") => r.v
    ? `<img class="${cls}" src="${esc(p.abs(r.v))}" referrerpolicy="no-referrer" alt="" onerror="this.outerHTML='<div class=&quot;img-missing&quot;>Image failed to load</div>'">`
    : `<div class="img-missing">No image tag<br><small>add og:image</small></div>`;
  const dims = (r) => {
    const i = r.v && p.imageInfo[p.abs(r.v)];
    if (!i || !i.ok) return "";
    const good = i.w >= 1200 && Math.abs(i.w / i.h - 1.91) < 0.1;
    return `<div class="img-dims">Image: ${i.w}×${i.h}px ${good ? "✓ ideal" : "· recommended 1200×630"}</div>`;
  };

  // Facebook
  const fb = { t: pick("og:title", "<title>"), d: pick("og:description", "description"), i: pick("og:image") };
  // X / Twitter
  const card = p.get("twitter:card") || "summary";
  const tw = { t: pick("twitter:title", "og:title", "<title>"), d: pick("twitter:description", "og:description", "description"), i: pick("twitter:image", "twitter:image:src", "og:image") };
  const large = card === "summary_large_image";
  // LinkedIn
  const li = { t: pick("og:title", "<title>"), i: pick("og:image") };
  // Slack
  const sl = { s: pick("og:site_name"), t: pick("og:title", "twitter:title", "<title>"), d: pick("og:description", "twitter:description", "description"), i: pick("og:image", "twitter:image") };

  const cards = [
    {
      name: "Facebook",
      html: `<div class="fb">${imgHtml(fb.i)}<div class="fb-foot">
        <div class="fb-domain">${esc(domain)}</div>
        <div class="fb-title clamp2">${esc(fb.t.v || domain)}</div>
        <div class="fb-desc clamp1">${esc(fb.d.v)}</div></div></div>${dims(fb.i)}`,
      src: [["Title", fb.t], ["Description", fb.d], ["Image", fb.i]],
    },
    {
      name: `X (Twitter) · <span style="text-transform:none">${esc(card)}</span>`,
      html: large
        ? `<div class="x-large"><div class="x-imgwrap">${imgHtml(tw.i)}<div class="x-overlay clamp1">${esc(tw.t.v || domain)}</div></div>
           <div class="x-from">From ${esc(domain)}</div></div>${dims(tw.i)}`
        : `<div class="x-small"><div class="thumb">${imgHtml(tw.i)}</div><div class="body">
           <div class="domain">${esc(domain)}</div><div class="title clamp1">${esc(tw.t.v || domain)}</div>
           <div class="desc clamp2">${esc(tw.d.v)}</div></div></div>
           ${!p.get("twitter:card") ? `<div class="img-dims">No twitter:card tag, so X uses the small "summary" layout.</div>` : ""}`,
      src: [["Card", p.get("twitter:card") ? { src: "twitter:card" } : { src: null }], ["Title", tw.t], ["Description", tw.d], ["Image", tw.i]],
    },
    {
      name: "LinkedIn",
      html: `<div class="li">${imgHtml(li.i)}<div class="li-foot">
        <div class="li-title clamp2">${esc(li.t.v || domain)}</div>
        <div class="li-domain">${esc(domain)}</div></div></div>${dims(li.i)}`,
      src: [["Title", li.t], ["Image", li.i]],
    },
    {
      name: "Slack",
      html: `<div class="slack"><div class="slack-bar"></div><div style="min-width:0">
        <div class="slack-site"><img src="${esc(p.favicon)}" alt="" onerror="this.style.display='none'">${esc(sl.s.v || domain)}</div>
        <div class="slack-title">${esc(sl.t.v || domain)}</div>
        <div class="slack-desc clamp2">${esc(sl.d.v)}</div>
        ${sl.i.v ? imgHtml(sl.i) : ""}</div></div>`,
      src: [["Site", sl.s], ["Title", sl.t], ["Description", sl.d], ["Image", sl.i]],
    },
  ];

  $("#social-grid").innerHTML = cards.map((c) => `
    <div>
      <h3 class="preview-label">${c.name}</h3>
      <div class="preview-card">${c.html}${srcHtml(c.src)}</div>
    </div>`).join("");
}

/* ---------- All tags table ---------- */
function renderTags() {
  const p = state.page;
  const rows = $$("title, meta, link, base", p.doc)
    .filter((el) => !el.closest("svg"))
    .map((el) => {
      const tag = el.tagName.toLowerCase();
      let key = "", val = "";
      if (tag === "title") { val = clean(el.textContent); }
      else if (tag === "meta") {
        if (el.hasAttribute("charset")) { key = "charset"; val = el.getAttribute("charset"); }
        else { key = el.getAttribute("property") || el.getAttribute("name") || el.getAttribute("http-equiv") || el.getAttribute("itemprop") || ""; val = el.getAttribute("content") || ""; }
      } else if (tag === "link") {
        key = el.getAttribute("rel") || "";
        val = [el.getAttribute("href"), el.getAttribute("hreflang") && `hreflang=${el.getAttribute("hreflang")}`, el.getAttribute("sizes") && `sizes=${el.getAttribute("sizes")}`, el.getAttribute("type")].filter(Boolean).join("  ·  ");
      } else { val = el.getAttribute("href") || ""; }
      return { tag, key, val };
    })
    .filter((r) => !(r.tag === "link" && /^(stylesheet|preload|modulepreload|preconnect|dns-prefetch|prefetch)$/i.test(r.key)));

  const ld = p.jsonld.map((b, i) => `
    <div class="jsonld">
      <h3>JSON-LD block ${i + 1}${b.types.length ? ` — ${esc(b.types.join(", "))}` : ""}${b.ok ? "" : ` <span style="color:var(--fail)">(invalid: ${esc(b.error)})</span>`}</h3>
      <pre>${esc(b.ok ? JSON.stringify(b.parsed, null, 2) : b.raw)}</pre>
    </div>`).join("");

  $("#all-tags").innerHTML = `
    <table class="tag-table">
      <thead><tr><th>Tag</th><th>Name / property / rel</th><th>Value</th></tr></thead>
      <tbody>${rows.map((r) => `<tr data-text="${esc((r.tag + " " + r.key + " " + r.val).toLowerCase())}"><td>&lt;${r.tag}&gt;</td><td>${esc(r.key)}</td><td>${esc(r.val) || '<span style="color:var(--ink-3)">(empty)</span>'}</td></tr>`).join("")}</tbody>
    </table>
    <p class="footnote">Stylesheet, preload and preconnect links are hidden. ${rows.length} SEO-relevant tags shown.</p>
    ${ld}`;
  $("#tag-search").value = "";
}

/* =====================================================================
   UI wiring
   ===================================================================== */
function setStatus(html, isError = false) {
  const el = $("#status");
  el.innerHTML = html;
  el.classList.toggle("error", isError);
  el.classList.remove("hidden");
}
function hideStatus() { $("#status").classList.add("hidden"); }

let startTab = "report";
function selectTab(name) {
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  $$(".tab-panel").forEach((p) => p.classList.toggle("hidden", p.id !== `panel-${name}`));
}

$("#search-form").addEventListener("submit", (e) => { e.preventDefault(); analyze($("#url-input").value); });
$$(".chip").forEach((c) => c.addEventListener("click", () => { $("#url-input").value = c.dataset.url; analyze(c.dataset.url); }));
$$(".tab").forEach((t) => t.addEventListener("click", () => selectTab(t.dataset.tab)));
$$(".filter[data-filter]").forEach((b) => b.addEventListener("click", () => { state.filter = b.dataset.filter; applyFilter(); }));
$$(".count").forEach((b) => b.addEventListener("click", () => { state.filter = b.dataset.filter; selectTab("report"); applyFilter(); }));

$("#report").addEventListener("click", (e) => {
  const head = e.target.closest(".check-head");
  if (head && !head.disabled) head.parentElement.classList.toggle("open");
});
$("#tag-search").addEventListener("input", (e) => {
  const q = e.target.value.toLowerCase().trim();
  $$("#all-tags tbody tr").forEach((tr) => tr.classList.toggle("hidden", q && !tr.dataset.text.includes(q)));
});

// Support links like http://localhost:8000/?url=example.com
const params = new URLSearchParams(location.search);
const initial = params.get("url");
if (["report", "google", "social", "tags"].includes(params.get("tab"))) startTab = params.get("tab");
if (initial) { $("#url-input").value = initial; analyze(initial); }
else $("#url-input").focus();
