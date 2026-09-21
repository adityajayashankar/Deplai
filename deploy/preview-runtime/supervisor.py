"""Fixed preview pod supervisor. Imported processes share one tenant's sandbox.

No host access, sockets, inherited credentials or public network are granted by
this process. The host controller remains responsible for quotas and termination.
Application stdout/stderr are discarded until a redacted log transport is attached.
"""
import argparse
import http.client
import json
import os
from pathlib import Path
import signal
import socket
import socketserver
import subprocess
import sys
import threading
import time


def relay(left, right):
    import selectors
    total = 0
    with selectors.DefaultSelector() as selector:
        selector.register(left, selectors.EVENT_READ, right)
        selector.register(right, selectors.EVENT_READ, left)
        deadline = time.monotonic() + 300
        while time.monotonic() < deadline and total < 64 * 1024 * 1024:
            for key, _ in selector.select(timeout=1):
                data = key.fileobj.recv(65536)
                if not data:
                    return
                total += len(data)
                key.data.sendall(data)


class UnixServer(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True
    request_queue_size = 32


def expose(port, path):
    class Handler(socketserver.BaseRequestHandler):
        def handle(self):
            try:
                self.request.settimeout(10)
                with socket.create_connection(('127.0.0.1', port), timeout=10) as upstream:
                    relay(self.request, upstream)
            except OSError:
                pass
    server = UnixServer(path, Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def install_relay():
    class Handler(socketserver.BaseRequestHandler):
        def handle(self):
            try:
                self.request.settimeout(10)
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as upstream:
                    upstream.settimeout(10); upstream.connect('/channel/egress.sock')
                    relay(self.request, upstream)
            except OSError:
                pass
    class Server(socketserver.ThreadingTCPServer):
        daemon_threads = True
        allow_reuse_address = True
    with Server(('127.0.0.1', 18080), Handler) as server:
        server.serve_forever()


def environment(extra):
    # Deliberately do not merge os.environ: host/control-plane keys never flow in.
    base = dict(PATH='/usr/local/bin:/usr/bin:/bin', HOME='/runtime/home',
                TMPDIR='/tmp', PYTHONDONTWRITEBYTECODE='1', PYTHONUNBUFFERED='1',
                npm_config_cache='/runtime/npm-cache', npm_config_audit='false',
                npm_config_fund='false', npm_config_update_notifier='false')
    base.update(extra)
    return base


def health(port, path):
    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=2)
    try:
        connection.request('GET', path)
        response = connection.getresponse()
        return 200 <= response.status < 300
    except OSError:
        return False
    finally:
        connection.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['idle', 'serve', 'run', 'health', 'install-relay'])
    parser.add_argument('--port', type=int)
    parser.add_argument('--socket')
    parser.add_argument('--health-path', default='/')
    parser.add_argument('--directory', default='/workspace')
    arguments = sys.argv[1:]
    separator = arguments.index('--') if '--' in arguments else len(arguments)
    command = arguments[separator + 1:]
    args = parser.parse_args(arguments[:separator])
    if args.mode == 'install-relay':
        return install_relay()
    if args.mode == 'health':
        raise SystemExit(0 if health(args.port, args.health_path) else 1)
    if args.mode == 'idle':
        Path('/runtime/home').mkdir(parents=True, exist_ok=True)
        while True:
            time.sleep(60)
    config = json.load(sys.stdin)
    if not command or (args.mode == 'serve' and (args.port is None or not 1 <= args.port <= 65535)):
        raise SystemExit(2)
    # Host constructs these arguments from the reviewed manifest, but containment
    # also holds inside the pod if a local caller invokes this utility directly.
    directory = Path(args.directory).resolve(strict=True)
    if not directory.is_relative_to('/workspace'):
        raise SystemExit(2)
    path = Path(args.socket) if args.socket else None
    if args.mode == 'serve' and (path is None or path.parent != Path('/channel') or not path.name.endswith('.sock')):
        raise SystemExit(2)
    process = subprocess.Popen(command, cwd=directory, env=environment(config),
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                               start_new_session=True)
    def stop(*_):
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    server = expose(args.port, str(path)) if args.mode == 'serve' else None
    try:
        raise SystemExit(process.wait())
    finally:
        if server:
            server.shutdown(); server.server_close(); path.unlink(missing_ok=True)


if __name__ == '__main__':
    main()
