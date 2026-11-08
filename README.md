# SEO Tag Analyzer

An interactive tool that fetches any web page's HTML and checks its SEO / meta tags against best practices — with Google search and social-media share previews.

Built as the SEO Analyzer project from *Vibe Coding 101* (DeepLearning.AI), part of the AI Engineer roadmap.

## Run it

1. Double-click **`start.bat`** (or run `python server.py` in a terminal in this folder).
2. Your browser opens at **http://localhost:8000**.
3. Type a site (e.g. `stinson.com`) and click **Analyze**.

No installs needed: it uses only Python's standard library. Press `Ctrl+C` in the console window to stop.
Tip: you can link straight to a report, e.g. `http://localhost:8000/?url=example.com`.

## What it checks

| Area | Checks |
|---|---|
| Essentials | Title (length + pixel width), meta description, canonical, robots / X-Robots-Tag, viewport, `lang`, charset, favicon |
| Content | One H1, heading hierarchy, image alt text, crawlable text (flags JavaScript-only pages) |
| Open Graph | og:title, og:description, og:image (loads it, checks size & 1.91:1 ratio), og:url, og:type, og:site_name, og:image:alt |
| Twitter / X | twitter:card validity, title/description/image (with OG fallbacks), twitter:site |
| Technical | HTTP status, HTTPS, redirects, JSON-LD structured data, robots.txt, sitemap, duplicate tags, hreflang, meta keywords |

Each check is pass / warning / fail / note, weighted into a 0–100 score.

## Tabs

- **Report**: every check, grouped and filterable, with the actual tag value and a best-practice tip.
- **Google preview**: desktop and mobile results, truncated at Google's pixel widths, plus width meters.
- **Social previews**: Facebook, X, LinkedIn and Slack cards, labelled with which tag supplied each field (and when a fallback was used).
- **All tags**: every meta/link tag on the page, searchable, plus pretty-printed JSON-LD.

## How it works

```
server.py          Python server: serves public/ and GET /api/fetch?url=…
                   (fetches the page server-side to get around browser CORS limits,
                   and also reads robots.txt)
public/index.html  Page layout
public/styles.css  Styling
public/app.js      Parsing (DOMParser), the checks, scoring, and all previews
```

Tune the rules (title/description lengths, image sizes, etc.) in the `RULES` object at the top of `public/app.js`.

## Limits

- It analyzes the **raw HTML**, as social scrapers see it. Tags injected by JavaScript won't appear, and the "Crawlable text" check flags that.
- Some sites block automated requests and return 403s or bot-challenge pages.
- Google can rewrite titles and snippets per query, so the previews show what your tags *request*.
