"""Fixed synthetic processes only. Mounted read-only; no repository entrypoints."""
import base64
import errno
import hashlib
import http.server
import http.client
import json
import os
from pathlib import Path
import socket
import socketserver
import struct
import sys
import time


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def setup(self):
        self.request.settimeout(15)
        super().setup()
    def log_message(self, *_):
        pass

    def reply(self, status, body, headers=()):
        data = body.encode()
        self.send_response(status)
        for key, value in headers:
            self.send_header(key, value)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == '/':
            return self.reply(200, '<!doctype html><title>Preview boundary proof</title><main>Synthetic preview</main>', [('Content-Type', 'text/html; charset=utf-8')])
        if self.path == '/api/me':
            return self.reply(200 if 'proof_session=synthetic-only' in self.headers.get('Cookie', '').split('; ') else 401, 'synthetic-user')
        if self.path == '/api/file':
            return self.reply(200, Path('/workspace/visibility.txt').read_text())
        if self.path == '/api/health':
            return self.reply(200, 'healthy')
        if self.path == '/api/events':
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Cache-Control', 'no-cache')
            self.end_headers()
            for value in ['first', 'second']:
                self.wfile.write(f'data: {value}\n\n'.encode()); self.wfile.flush(); time.sleep(0.25)
            return
        if self.path in ('/ws', '/hmr') and self.headers.get('Upgrade', '').lower() == 'websocket':
            key = self.headers.get('Sec-WebSocket-Key', '')
            if len(key) > 64:
                return self.reply(400, 'invalid')
            self.send_response(101)
            self.send_header('Upgrade', 'websocket'); self.send_header('Connection', 'Upgrade')
            self.send_header('Sec-WebSocket-Accept', base64.b64encode(hashlib.sha1((key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode())
            self.end_headers()
            last = None
            for _ in range(60):
                value = Path('/workspace/visibility.txt').read_text() if self.path == '/hmr' else 'websocket-ok'
                if value != last:
                    payload = value.encode()[:120]
                    self.wfile.write(struct.pack('BB', 0x81, len(payload)) + payload); self.wfile.flush(); last = value
                time.sleep(0.2)
            return
        self.reply(404, 'not found')

    def do_POST(self):
        # Host-only Secure cookie on isolated preview origin; reject cross-origin mutations.
        expected = 'https://' + self.headers.get('Host', '')
        if self.headers.get('Origin') != expected or self.headers.get('X-Proof-CSRF') != 'synthetic-only':
            return self.reply(403, 'denied')
        length = int(self.headers.get('Content-Length', '0'))
        if length > 2 * 1024 * 1024:
            return self.reply(413, 'too large')
        self.rfile.read(length)
        if self.path == '/api/login':
            return self.reply(200, 'ok', [('Set-Cookie', 'proof_session=synthetic-only; Path=/api; Secure; HttpOnly; SameSite=Lax')])
        self.reply(200, str(length))


def main():
    mode = sys.argv[1]
    if mode == 'serve':
        path = '/channel/' + sys.argv[2] + '.sock'
        with Server(path, Handler) as server:
            server.serve_forever()
    elif mode == 'tcp-sentinel':
        with http.server.ThreadingHTTPServer(('0.0.0.0', 8080), Handler) as server:
            server.serve_forever()
    elif mode == 'network':
        result = {}
        for host in sys.argv[2:]:
            try:
                with socket.create_connection((host, 8080), timeout=1):
                    result[host] = 'REACHABLE'
            except OSError as error:
                result[host] = 'BLOCKED' if error.errno in (errno.ENETUNREACH, errno.EHOSTUNREACH, errno.EACCES, errno.EPERM) else 'UNPROVEN'
        print(json.dumps(result))
    elif mode == 'egress':
        statuses = []
        for url in ['https://registry.npmjs.org/-/ping', 'https://169.254.169.254/latest/meta-data/', 'https://example.invalid/']:
            connection = http.client.HTTPConnection('broker', timeout=10)
            channel = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); channel.settimeout(10)
            channel.connect('/channel/egress.sock'); connection.sock = channel
            connection.request('GET', url); response = connection.getresponse()
            statuses.append(response.status); response.read(); connection.close()
        print(json.dumps(statuses))
    elif mode == 'neighbor':
        connection = http.client.HTTPConnection('neighbor', timeout=3)
        channel = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); channel.settimeout(3)
        channel.connect('/channel/api.sock'); connection.sock = channel
        connection.request('GET', '/api/file'); response = connection.getresponse()
        print('HEALTHY' if response.status == 200 and response.read() == b'before' else 'FAILED')
        connection.close()
    elif mode == 'cpu':
        started = time.monotonic(); used = time.process_time()
        while time.monotonic() - started < 8:
            hashlib.sha256(b'x' * 4096).digest()
        print(json.dumps({'cpu_ratio': (time.process_time() - used) / (time.monotonic() - started)}), flush=True)
    elif mode == 'memory':
        held = []
        while True:
            held.append(bytearray(4 * 1024 * 1024))
    elif mode == 'pids':
        children = []
        try:
            for _ in range(256):
                child = os.fork()
                if child == 0:
                    time.sleep(20); os._exit(0)
                children.append(child)
            print('UNBOUNDED', flush=True)
        except OSError as error:
            print('LIMITED' if error.errno == errno.EAGAIN else 'UNPROVEN', flush=True)
        finally:
            for child in children:
                os.kill(child, 9); os.waitpid(child, 0)
    elif mode == 'disk':
        try:
            with open('/runtime/fill', 'wb') as target:
                for _ in range(256):
                    target.write(b'x' * (1024 * 1024)); target.flush()
            print('UNBOUNDED', flush=True)
        except OSError as error:
            print('LIMITED' if error.errno == errno.ENOSPC else 'UNPROVEN', flush=True)
    else:
        raise SystemExit('Unknown synthetic fixture')


if __name__ == '__main__':
    main()
