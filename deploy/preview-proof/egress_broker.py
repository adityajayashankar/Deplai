"""Optional fixed HTTPS GET broker over a per-preview Unix socket.

No CONNECT, redirects, request credentials, arbitrary ports, inherited proxies,
or caller-selected allowlist. Public DNS answers are checked and IP-pinned with
normal TLS hostname verification. Default preview networking remains disabled.
"""
import http.client
import http.server
import socket
import socketserver
import ssl
import sys
import time
from urllib.parse import urlsplit
from boundary import public_target


def target(url, approved_hosts, resolver=socket.getaddrinfo):
    parsed = urlsplit(url)
    if (len(url) > 2048 or any(ord(c) < 33 or ord(c) > 126 for c in url)
            or parsed.scheme != 'https' or parsed.username or parsed.password
            or parsed.port not in (None, 443) or parsed.fragment):
        raise ValueError('Invalid egress URL')
    if parsed.hostname not in approved_hosts:
        raise ValueError('Unapproved egress host')
    addresses = sorted({item[4][0] for item in resolver(parsed.hostname, 443, type=socket.SOCK_STREAM)})
    address = public_target(parsed.hostname, addresses, approved_hosts)
    return parsed.hostname, address, (parsed.path or '/') + (('?' + parsed.query) if parsed.query else '')


class PinnedHTTPS(http.client.HTTPSConnection):
    def __init__(self, host, address):
        super().__init__(host, 443, timeout=5, context=ssl.create_default_context())
        self.address = address

    def connect(self):
        raw = socket.create_connection((self.address, 443), timeout=self.timeout)
        try:
            self.sock = self._context.wrap_socket(raw, server_hostname=self.host)
        except Exception:
            raw.close(); raise


def fetch(url, approved_hosts):
    host, address, path = target(url, approved_hosts)
    connection = PinnedHTTPS(host, address)
    try:
        connection.request('GET', path, headers={'Host': host, 'User-Agent': 'DeplAI-synthetic-proof'})
        response = connection.getresponse()
        if not 200 <= response.status < 300:
            raise ValueError('Egress status refused; redirects are disabled')
        # A single bounded read; do not relay arbitrary upstream headers/cookies.
        deadline = time.monotonic() + 5
        chunks = []; length = 0
        while True:
            if time.monotonic() >= deadline:
                raise ValueError('Egress deadline exceeded')
            chunk = response.read1(65536)
            if not chunk:
                break
            length += len(chunk)
            if length > 1024 * 1024:
                raise ValueError('Egress response exceeds limit')
            chunks.append(chunk)
        return b''.join(chunks)
    finally:
        connection.close()


class Broker(http.server.BaseHTTPRequestHandler):
    approved_hosts = frozenset()

    def setup(self):
        self.request.settimeout(6)
        super().setup()

    def log_message(self, *_):
        pass

    def do_GET(self):
        try:
            body = fetch(self.path, self.approved_hosts); status = 200
        except Exception:
            body = b'egress denied'; status = 403
        self.send_response(status); self.send_header('Content-Length', str(len(body)))
        self.end_headers(); self.wfile.write(body)


if __name__ == '__main__':
    # Hosts are operator-controlled command arguments, never browser/repository data.
    Broker.approved_hosts = frozenset(sys.argv[1:])
    with socketserver.UnixStreamServer('/channel/egress.sock', Broker) as server:
        server.serve_forever()
