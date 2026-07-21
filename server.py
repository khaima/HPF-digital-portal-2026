#!/usr/bin/env python3
"""
Human Practice Foundation — Digital Portal
Lightweight static server with single-page-app (SPA) route fallback.

Any request for an existing file (styles.css, app.js, ...) is served directly.
Any other path (e.g. /curriculum, /field-officer) falls back to index.html so
client-side routing and page refreshes work with real, clean URLs.

Usage:
    python server.py            # serves on http://localhost:5173
    python server.py 8080       # serves on http://localhost:8080
"""

import http.server
import os
import socketserver
import sys
from functools import partial

DEFAULT_PORT = 5173
ROOT = os.path.dirname(os.path.abspath(__file__))


class SPARequestHandler(http.server.SimpleHTTPRequestHandler):
    """Serve static assets; fall back to index.html for app routes."""

    def do_GET(self):  # noqa: N802 (stdlib naming)
        path = self.translate_path(self.path)
        # If the request doesn't map to a real file, serve the SPA shell.
        if not os.path.isfile(path):
            self.path = "/index.html"
        return super().do_GET()

    def end_headers(self):
        # Avoid stale assets during local development.
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("  %s - %s\n" % (self.address_string(), fmt % args))


def main():
    port = DEFAULT_PORT
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            print(f"Invalid port '{sys.argv[1]}', using {DEFAULT_PORT}.")

    handler = partial(SPARequestHandler, directory=ROOT)

    class Server(socketserver.ThreadingTCPServer):
        allow_reuse_address = True

    with Server(("0.0.0.0", port), handler) as httpd:
        url = f"http://localhost:{port}"
        print("\n  Human Practice Foundation — Digital Portal")
        print("  " + "-" * 42)
        print(f"  Serving at:  {url}")
        print(f"  Directory:   {ROOT}")
        print("  Press Ctrl+C to stop.\n")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n  Stopped. Goodbye!\n")


if __name__ == "__main__":
    main()
