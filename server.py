"""
SEO Tag Analyzer - local server
--------------------------------
Serves the front end (public/) and exposes one API endpoint:

    GET /api/fetch?url=https://example.com

It fetches the page server-side (browsers block cross-site fetches via CORS),
then returns the raw HTML plus useful response metadata as JSON. All SEO
analysis happens in the browser (public/app.js).

Run:  python server.py        (then open http://localhost:8000)
Only uses the Python standard library - nothing to install.
"""

import json
import os
import re
import sys
import time
import webbrowser
import threading
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT", 8000))
PUBLIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "public")
MAX_BYTES = 5 * 1024 * 1024  # don't download more than 5 MB of HTML
TIMEOUT = 15  # seconds

# A normal desktop browser user agent - some sites return different (or no) HTML to bots.
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/130.0 Safari/537.36 SEOTagAnalyzer/1.0"
)


def normalize_url(raw: str) -> str:
    raw = (raw or "").strip()
    if not raw:
        raise ValueError("Please enter a URL.")
    if not re.match(r"^https?://", raw, re.I):
        raw = "https://" + raw
    parsed = urllib.parse.urlparse(raw)
    if not parsed.netloc or "." not in parsed.netloc and "localhost" not in parsed.netloc:
        raise ValueError(f"'{raw}' doesn't look like a valid web address.")
    return raw


def decode_body(body: bytes, content_type: str) -> str:
    """Pick the right text encoding: HTTP header, then <meta charset>, then utf-8."""
    charset = None
    m = re.search(r"charset=([\w-]+)", content_type or "", re.I)
    if m:
        charset = m.group(1)
    if not charset:
        m = re.search(rb"<meta[^>]+charset=[\"']?([\w-]+)", body[:4096], re.I)
        if m:
            charset = m.group(1).decode("ascii", "ignore")
    try:
        return body.decode(charset or "utf-8", errors="replace")
    except LookupError:
        return body.decode("utf-8", errors="replace")


def fetch_url(url: str, max_bytes: int = MAX_BYTES):
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
        },
    )
    start = time.time()
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        body = resp.read(max_bytes + 1)
        elapsed_ms = int((time.time() - start) * 1000)
        return {
            "status": resp.status,
            "finalUrl": resp.geturl(),
            "headers": {k.lower(): v for k, v in resp.headers.items()},
            "body": body[:max_bytes],
            "truncated": len(body) > max_bytes,
            "elapsedMs": elapsed_ms,
        }


def check_robots(final_url: str):
    """Quick look at robots.txt and whether it lists a sitemap."""
    p = urllib.parse.urlparse(final_url)
    robots_url = f"{p.scheme}://{p.netloc}/robots.txt"
    try:
        r = fetch_url(robots_url, max_bytes=200_000)
        text = decode_body(r["body"], r["headers"].get("content-type", ""))
        if r["status"] != 200 or "<html" in text[:500].lower():
            return {"url": robots_url, "found": False}
        sitemaps = re.findall(r"(?im)^\s*sitemap:\s*(\S+)", text)
        return {"url": robots_url, "found": True, "sitemaps": sitemaps, "text": text[:5000]}
    except Exception:
        return {"url": robots_url, "found": False}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=PUBLIC_DIR, **kwargs)

    def log_message(self, fmt, *args):  # quieter console
        if "/api/" in (args[0] if args else ""):
            sys.stderr.write("  %s\n" % (args[0],))

    def send_json(self, code: int, payload: dict):
        data = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != "/api/fetch":
            return super().do_GET()

        qs = urllib.parse.parse_qs(parsed.query)
        try:
            url = normalize_url(qs.get("url", [""])[0])
        except ValueError as e:
            return self.send_json(400, {"error": str(e)})

        try:
            r = fetch_url(url)
        except urllib.error.HTTPError as e:
            # Still analyze error pages (e.g. 404) - but report the status.
            body = e.read(MAX_BYTES) if hasattr(e, "read") else b""
            r = {
                "status": e.code,
                "finalUrl": e.geturl() or url,
                "headers": {k.lower(): v for k, v in (e.headers or {}).items()},
                "body": body,
                "truncated": False,
                "elapsedMs": 0,
            }
        except urllib.error.URLError as e:
            return self.send_json(502, {"error": f"Couldn't reach {url}: {e.reason}"})
        except Exception as e:  # timeouts, SSL errors, etc.
            return self.send_json(502, {"error": f"Couldn't fetch {url}: {e}"})

        ctype = r["headers"].get("content-type", "")
        html = decode_body(r["body"], ctype)
        include_robots = qs.get("robots", ["1"])[0] != "0"

        self.send_json(200, {
            "requestedUrl": url,
            "finalUrl": r["finalUrl"],
            "status": r["status"],
            "contentType": ctype,
            "xRobotsTag": r["headers"].get("x-robots-tag"),
            "elapsedMs": r["elapsedMs"],
            "bytes": len(r["body"]),
            "truncated": r["truncated"],
            "html": html,
            "robots": check_robots(r["finalUrl"]) if include_robots else None,
        })


def main():
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    url = f"http://localhost:{PORT}"
    print(f"\n  SEO Tag Analyzer running at {url}")
    print("  Press Ctrl+C to stop.\n")
    if "--no-browser" not in sys.argv:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  Stopped.")


if __name__ == "__main__":
    main()
