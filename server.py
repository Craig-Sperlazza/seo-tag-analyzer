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
import socket
import ssl
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


HOST_RE = re.compile(r"^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$", re.I)
IP_RE = re.compile(r"^\d{1,3}(?:\.\d{1,3}){3}$")


def parse_input(raw: str):
    """Turn whatever the user typed into (scheme_or_None, host, path_and_query, notes).

    Forgiving on purpose: people paste with spaces/quotes, forget the scheme,
    type 'https//', add a trailing slash or full path, or give just a name.
    """
    notes = []
    raw = (raw or "").strip().strip("\"'<>()[]").strip()
    if not raw:
        raise ValueError("Please type a website, for example stinson.com")
    if re.search(r"\s", raw):
        raise ValueError(f"'{raw}' has a space in it. Website names can't contain spaces - check what you typed.")

    scheme = None
    m = re.match(r"^(https?)(?::/{0,2}|/{1,2})", raw, re.I)  # https://  https:/  https//  (not 'httpbin.org')
    if m:
        scheme = m.group(1).lower()
        raw = raw[m.end():]
    else:
        raw = raw.lstrip("/")  # '//example.com'

    raw = raw.split("#", 1)[0]  # fragments are never sent to a server
    cut = re.search(r"[/?]", raw)
    host_part, path = (raw[:cut.start()], raw[cut.start():]) if cut else (raw, "")
    host = host_part.rsplit("@", 1)[-1].lower().rstrip(".,;")  # drop user:pass@ and stray punctuation
    port = ""
    if ":" in host:
        host, _, port = host.partition(":")
        port = ":" + port if port.isdigit() else ""

    if not host:
        raise ValueError("Please type a website, for example stinson.com")
    if host != "localhost" and not IP_RE.match(host) and "." not in host:
        if HOST_RE.match(host):
            notes.append(f"No ending like .com was given, so we assumed {host}.com")
            host += ".com"
    try:
        host_ascii = host.encode("idna").decode("ascii")  # accented / non-latin names
    except UnicodeError:
        host_ascii = host
    if not (host_ascii == "localhost" or IP_RE.match(host_ascii) or HOST_RE.match(host_ascii)):
        raise ValueError(f"'{host_part}' doesn't look like a website address. Try something like stinson.com")
    path = urllib.parse.quote(path, safe="/?&=%:@+,;~!$*'()-._")
    return scheme, host_ascii + port, path, notes


def build_candidates(scheme, host, path):
    """Addresses to try, best first. Only guess when the user didn't say http/https."""
    if scheme:
        return [f"{scheme}://{host}{path}"]
    return [f"https://{host}{path}", f"http://{host}{path}"]


def classify_error(exc) -> str:
    r = getattr(exc, "reason", exc)
    text = str(r)
    if isinstance(r, socket.gaierror):
        return "dns"
    if isinstance(r, ssl.SSLError) or "CERTIFICATE_VERIFY_FAILED" in text or "SSL" in text:
        return "ssl"
    if isinstance(r, (socket.timeout, TimeoutError)) or "timed out" in text:
        return "timeout"
    if isinstance(r, ConnectionRefusedError):
        return "refused"
    if isinstance(r, ConnectionResetError):
        return "reset"
    return "other"


def friendly_error(kind: str, host: str, exc) -> str:
    return {
        "dns": f"We couldn't find a website called {host}. Check the spelling, or try the full address.",
        "ssl": f"A secure (HTTPS) connection to {host} couldn't be verified - the site's security certificate was rejected. "
               "That can be a problem with the site, or with this computer's certificate store.",
        "timeout": f"{host} took too long to respond. The site may be down or slow - try again in a moment.",
        "refused": f"{host} refused the connection. It may be down, or it may block automated checks.",
        "reset": f"The connection to {host} was cut off. It may block automated checks - try again.",
    }.get(kind, f"We couldn't load {host}: {getattr(exc, 'reason', exc)}")


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


def fetch_url(url: str, max_bytes: int = MAX_BYTES, timeout: int = TIMEOUT):
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
        },
    )
    start = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as resp:
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
            scheme, host, path, notes = parse_input(qs.get("url", [""])[0])
        except ValueError as e:
            return self.send_json(400, {"error": str(e)})

        # Try https first, then http; if the name doesn't resolve, also try www.
        queue = build_candidates(scheme, host, path)
        tried_www = host.startswith("www.") or bool(IP_RE.match(host)) or host.startswith("localhost")
        first_error = None
        r = None
        url = queue[0]
        i = 0
        while i < len(queue):
            url = queue[i]
            i += 1
            try:
                r = fetch_url(url, timeout=TIMEOUT if i == 1 else 8)
                break
            except urllib.error.HTTPError as e:
                # A real answer (e.g. 404, 403): still analyze it, but report the status.
                body = e.read(MAX_BYTES) if hasattr(e, "read") else b""
                r = {
                    "status": e.code,
                    "finalUrl": e.geturl() or url,
                    "headers": {k.lower(): v for k, v in (e.headers or {}).items()},
                    "body": body,
                    "truncated": False,
                    "elapsedMs": 0,
                }
                break
            except Exception as e:  # DNS, SSL, timeout, refused ...
                kind = classify_error(e)
                if first_error is None:
                    first_error = (kind, e)
                if kind == "dns" and not tried_www:
                    tried_www = True
                    queue += [u.replace("://", "://www.", 1) for u in build_candidates(scheme, host, path)]
                if kind == "timeout" and i >= 1 and len(queue) > i:
                    queue = queue[:i]  # a slow/dead host won't get better on another scheme
        if r is None:
            kind, exc = first_error
            return self.send_json(502, {"error": friendly_error(kind, host, exc), "errorKind": kind})

        if scheme is None and url.startswith("http://"):
            notes.append("A secure https:// connection didn't work, so we checked the plain http:// version instead.")
        elif scheme is None:
            notes.append("We added https:// for you.")
        if "://www." in url and not host.startswith("www."):
            notes.append("We added www. because the plain address wasn't found.")

        ctype = r["headers"].get("content-type", "")
        html = decode_body(r["body"], ctype)
        include_robots = qs.get("robots", ["1"])[0] != "0"

        self.send_json(200, {
            "requestedUrl": url,
            "notes": notes,
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
