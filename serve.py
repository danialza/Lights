#!/usr/bin/env python3
"""Serve Lights locally: python3 serve.py [port]

Like `python3 -m http.server`, but always serves this folder, only on this computer
(127.0.0.1), and tells the browser not to cache, so updated files show up on reload.
"""
import functools
import http.server
import os
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    folder = os.path.dirname(os.path.abspath(__file__))
    handler = functools.partial(NoCacheHandler, directory=folder)
    http.server.ThreadingHTTPServer.allow_reuse_address = True
    with http.server.ThreadingHTTPServer(('127.0.0.1', port), handler) as server:
        print(f'Lights is running at http://localhost:{port}/  (Ctrl+C to stop)')
        server.serve_forever()
