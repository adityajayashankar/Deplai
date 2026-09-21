"""Install-only, exact-registry CONNECT broker over a scoped Unix socket.

The app has no external IP network. DNS is resolved once here and all answers must
be public. Connection is pinned to a validated address. The client still verifies
registry TLS. This permits an approved endpoint, not arbitrary Internet access.
No application secrets are supplied during dependency installation.
"""
import ipaddress
import re
import selectors
import socket
import socketserver
import sys
import threading
import time

REGISTRIES = frozenset(['registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org'])


def resolve(authority, allowed, lookup=socket.getaddrinfo):
    if not re.fullmatch(r'[a-z0-9.-]+:443', authority):
        raise ValueError('REGISTRY_DENIED')
    host = authority[:-4]
    if host not in allowed or host not in REGISTRIES:
        raise ValueError('REGISTRY_DENIED')
    addresses = lookup(host, 443, type=socket.SOCK_STREAM)
    if not addresses:
        raise ValueError('REGISTRY_DNS_FAILED')
    for family, kind, protocol, _, address in addresses:
        ip = ipaddress.ip_address(address[0])
        if not ip.is_global or ip.is_multicast or ip.is_unspecified or getattr(ip, 'ipv4_mapped', None):
            raise ValueError('REGISTRY_DNS_DENIED')
    return addresses[0]


def transfer(left, right):
    deadline = time.monotonic() + 90
    remaining = 128 * 1024 * 1024
    with selectors.DefaultSelector() as selector:
        selector.register(left, selectors.EVENT_READ, right)
        selector.register(right, selectors.EVENT_READ, left)
        while remaining > 0 and time.monotonic() < deadline:
            for key, _ in selector.select(timeout=1):
                data = key.fileobj.recv(min(65536, remaining))
                if not data:
                    return
                remaining -= len(data)
                key.data.sendall(data)


class Broker(getattr(socketserver, 'ThreadingUnixStreamServer', socketserver.ThreadingTCPServer)):
    daemon_threads = True
    request_queue_size = 8
    slots = threading.BoundedSemaphore(8)

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()

    def handle_error(self, *_):
        pass  # Never echo proxy input or network errors.


class Handler(socketserver.StreamRequestHandler):
    timeout = 10

    def handle(self):
        connected = False
        try:
            line = self.rfile.readline(2049)
            if len(line) > 2048:
                raise ValueError('INVALID_REQUEST')
            method, authority, protocol = line.decode('ascii').strip().split(' ')
            if method != 'CONNECT' or protocol != 'HTTP/1.1':
                raise ValueError('INVALID_REQUEST')
            total = 0
            for _ in range(32):
                header = self.rfile.readline(2049)
                total += len(header)
                if total > 8192 or len(header) > 2048 or not header:
                    raise ValueError('INVALID_REQUEST')
                if header == b'\r\n':
                    break
                if header.lower().startswith((b'proxy-authorization:', b'authorization:')):
                    raise ValueError('CREDENTIALS_DENIED')
            else:
                raise ValueError('INVALID_REQUEST')
            family, kind, protocol, _, address = resolve(authority, self.server.allowed)
            with socket.socket(family, kind, protocol) as upstream:
                upstream.settimeout(10); upstream.connect(address)
                self.wfile.write(b'HTTP/1.1 200 Connection Established\r\n\r\n'); self.wfile.flush()
                connected = True
                transfer(self.connection, upstream)
        except (ValueError, UnicodeError, OSError):
            if not connected:
                try:
                    self.wfile.write(b'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
                except OSError:
                    pass


def main():
    allowed = frozenset(sys.argv[1:])
    if not allowed or not allowed <= REGISTRIES:
        raise SystemExit(2)
    with Broker('/channel/egress.sock', Handler) as server:
        server.allowed = allowed
        server.serve_forever()


if __name__ == '__main__':
    main()
