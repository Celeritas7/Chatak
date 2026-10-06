#!/usr/bin/env python3
"""Static server for local Chatak development.

The stdlib's http.server sends Last-Modified and nothing else, so browsers
happily serve index.html from cache for a long time — which during development
means you edit a file, reload, and see the previous build. Every response here
carries no-store, so a plain reload always fetches the current file.

  python scripts/serve-nocache.py [port]
"""

import os
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        # One terse line per request; the default logs the whole request line.
        sys.stderr.write("  %s %s\n" % (args[1] if len(args) > 1 else "", args[0].split(" ")[1] if " " in args[0] else args[0]))


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5080
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    os.chdir(root)
    handler = partial(NoCacheHandler, directory=root)
    with ThreadingHTTPServer(("127.0.0.1", port), handler) as httpd:
        print("  Serving %s" % root)
        print("  http://localhost:%d/   (no-store: reloads always get the current file)" % port)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n  Stopped.")


if __name__ == "__main__":
    main()
