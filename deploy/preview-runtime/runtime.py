"""Internal Linux preview controller. No unauthenticated HTTP execution endpoint.

Connector must authorize and register an exact scoped worktree before calling this
controller. All repository commands execute in the one-tenant gVisor pod. Docker,
Git and gateway configuration on the host are fixed operator operations only.
"""
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import socket
import ssl
import subprocess
import time
import uuid
from contextlib import contextmanager

from contracts import PreviewError, validate

HERE = Path(__file__).resolve().parent


def fixed(argv, *, timeout=30, data=None):
    result = subprocess.run(argv, input=data, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise PreviewError('WORKER_FAILED')
    return result.stdout.strip()


def docker(*args, **kwargs):
    return fixed(['docker', *args], **kwargs)


def atomic(path, value):
    temporary = path.with_suffix('.' + uuid.uuid4().hex + '.tmp')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.chmod(0o600); temporary.replace(path)


@contextmanager
def lease_lock(path):
    import fcntl
    with path.with_suffix('.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def image_id(value):
    if not isinstance(value, str) or not re.fullmatch(r'sha256:[a-f0-9]{64}', value):
        raise PreviewError('CONTRACT_INVALID')
    if json.loads(docker('image', 'inspect', value))[0]['Id'] != value:
        raise PreviewError('CONTRACT_INVALID')
    return value


class Preview:
    """One trusted controller owns a live preview; close() is mandatory on exit.

Persistent metadata records identity, timings and observed outcomes. A separate
lease sweeper must reclaim this preview if the controlling process terminates.
The controller never treats application-supplied metadata as readiness evidence.
"""
    def __init__(self, root, manifest, worktree, images, resolve_environment, proof_path):
        proof_file = Path(proof_path)
        if proof_file.is_symlink() or proof_file.stat().st_uid != os.getuid() or proof_file.stat().st_mode & 0o077:
            raise PreviewError('SANDBOX_CREATE_FAILED')
        proof = json.loads(proof_file.read_text())
        # Host-local operator evidence, never a browser-supplied healthy flag.
        required = {'gvisor', 'http', 'tls', 'path_routing', 'cookie_roundtrip', 'csrf', 'websocket', 'sse', 'hot_reload', 'body_size', 'worktree_visibility', 'host_blocked', 'metadata_blocked', 'private_blocked', 'sibling_blocked', 'cpu_limit', 'memory_limit', 'pid_limit', 'disk_limit', 'neighbor_healthy', 'idle_gc', 'hard_gc', 'orphan_cleanup', 'egress_policy'}
        if proof.get('provider') != 'gvisor' or proof.get('passed') is not True or proof.get('cleanup') != 'COMPLETED' or set(proof.get('checks', {})) != required or any(value != 'PASS' for value in proof['checks'].values()):
            raise PreviewError('SANDBOX_CREATE_FAILED')
        self.manifest = validate(json.loads(json.dumps(manifest)))
        self.root = Path(root).resolve(strict=True)
        if self.root.stat().st_mode & 0o077 or self.root.stat().st_uid != os.getuid():
            raise PreviewError('CONTRACT_INVALID')
        self.worktree = Path(worktree).resolve(strict=True)
        if not self.worktree.is_relative_to(self.root / 'worktrees') or Path(worktree).is_symlink():
            raise PreviewError('WORKSPACE_MOUNT_FAILED')
        self.images = {key: image_id(images[key]) for key in ['pod', 'gateway', 'broker']}
        self.resolve_environment = resolve_environment
        self.id = uuid.uuid4().hex
        self.prefix = 'preview-' + self.id
        self.pod = self.prefix + '-pod'
        self.channel = self.prefix + '-channel'
        self.record = dict(preview_id=self.id, scope=self.manifest['scope'], state='STARTING',
                           revision=self.manifest['revision'], worktree_id=self.manifest['worktree_id'],
                           runtime_manifest_sha256=self.manifest['runtime_manifest_sha256'],
                           preview_manifest_sha256=self.manifest['preview_manifest_sha256'],
                           created_at=time.time(), last_activity_at=time.time(), quota=self.manifest['quota'],
                           stages=[], processes={}, images=self.images, controller_pid=os.getpid(),
                           controller_start_ticks=Path(f'/proc/{os.getpid()}/stat').read_text().split(') ', 1)[1].split()[19])
        self.processes = {}
        self.path = self.root / (self.id + '.preview.json')
        self.control = self.root / (self.id + '.control')
        self.control.mkdir(mode=0o755)
        self.persist()

    def persist(self):
        with lease_lock(self.path):
            if self.path.exists():
                current = json.loads(self.path.read_text())
                if current['state'] in ['CANCELLED', 'STOPPED', 'DESTROYED'] and self.record['state'] != 'DESTROYED':
                    self.record['state'] = current['state']
            atomic(self.path, self.record)

    def alive(self):
        if self.path.exists():
            current = json.loads(self.path.read_text())
            if current['state'] in ['CANCELLED', 'STOPPED', 'DESTROYED']:
                self.record['state'] = current['state']
        if self.record['state'] in ['CANCELLED', 'STOPPED', 'DESTROYED', 'FAILED']:
            raise PreviewError('CANCELLED')
        if time.time() - self.record['created_at'] >= self.manifest['quota']['lifetime_seconds']:
            raise PreviewError('PREVIEW_TIMEOUT')

    def stage(self, name, code, operation):
        self.alive()
        start = time.monotonic()
        entry = dict(name=name, started_at=time.time(), outcome='RUNNING')
        self.record['stages'].append(entry); self.persist()
        try:
            value = operation()
            self.alive()
            entry['outcome'] = 'COMPLETED'
            return value
        except Exception:
            entry['outcome'] = 'FAILED'
            self.record.update(state='FAILED', failure_code=code, failure_stage=name)
            raise PreviewError(code, name) from None
        finally:
            entry['duration_ms'] = round((time.monotonic() - start) * 1000)
            self.persist()

    def verify_revision(self):
        registration = json.loads((self.root / 'worktrees' / (self.manifest['worktree_id'] + '.owner.json')).read_text())
        if registration != dict(scope=self.manifest['scope'], path=str(self.worktree)):
            raise PreviewError('WORKSPACE_MOUNT_FAILED')
        actual = fixed(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', str(self.worktree), 'rev-parse', 'HEAD'])
        if actual != self.manifest['revision']:
            raise PreviewError('REVISION_MISMATCH')
        for service in self.manifest['services']:
            directory = (self.worktree / service['directory']).resolve(strict=True)
            if not directory.is_relative_to(self.worktree):
                raise PreviewError('WORKSPACE_MOUNT_FAILED')

    def owned(self, name):
        value = json.loads(docker('inspect', name))[0]
        if value['Config']['Labels'].get('deplai.preview') != self.id:
            raise PreviewError('CONTRACT_INVALID')
        return value

    def launch(self, suffix, image, command, *, extra=(), network='none', memory=None):
        q = self.manifest['quota']
        name = self.prefix + '-' + suffix
        args = ['run', '-d', '--name', name, '--label', 'deplai.preview=' + self.id,
                '--runtime=runsc', '--network', network, '--read-only', '--user=65532:65532',
                '--cap-drop=ALL', '--security-opt=no-new-privileges=true', '--init',
                '--cpus', str(q['cpu'] - 0.25 if suffix == 'pod' else 0.25),
                '--memory', str(memory or q['memory_mb'] - 256) + 'm', '--memory-swap', str(memory or q['memory_mb'] - 256) + 'm',
                '--pids-limit', str(q['pids']), '--log-driver=none',
                '--mount', 'type=volume,source=' + self.channel + ',target=/channel',
                *extra, image, *command]
        with lease_lock(self.path):
            self.alive()
            docker(*args, timeout=60)
            state = self.owned(name)
        if not state['State']['Running'] or state['HostConfig']['Runtime'] != 'runsc':
            raise PreviewError('SANDBOX_CREATE_FAILED')
        return name

    def pod_create(self):
        q = self.manifest['quota']; n = len(self.manifest['services'])
        docker('volume', 'create', '--label', 'deplai.preview=' + self.id, '--driver', 'local', '--opt', 'type=tmpfs', '--opt', 'device=tmpfs', '--opt', 'o=size=1m,uid=65532,gid=65532,mode=0700', self.channel)
        available = q['disk_mb'] - 17  # One MiB channel and sixteen MiB gateway temp.
        runtime_mb = available * 3 // 10
        tmp_mb = max(1, available // 10)
        service_mb = (available - runtime_mb - tmp_mb) // (2 * n)
        extra = ['--mount', 'type=bind,source=' + str(self.worktree) + ',target=/workspace,readonly']
        for directory, size in [('/runtime', runtime_mb), ('/tmp', tmp_mb)]:
            extra.extend(['--tmpfs', f'{directory}:rw,nosuid,nodev,size={size}m,uid=65532,gid=65532'])
        for service in self.manifest['services']:
            directory = (self.worktree / service['directory']).resolve(strict=True)
            for child in ['node_modules', '.next']:
                destination = directory / child
                if destination.is_symlink() or (destination.exists() and any(destination.iterdir())):
                    raise PreviewError('WORKSPACE_MOUNT_FAILED')
                destination.mkdir(exist_ok=True)
                target = '/workspace/' + str(destination.relative_to(self.worktree)).replace('\\', '/')
                extra.extend(['--tmpfs', f'{target}:rw,nosuid,nodev,size={service_mb}m,uid=65532,gid=65532'])
        self.launch('pod', self.images['pod'], ['idle'], extra=extra)

    def execute(self, command, *, directory='.', env=None, key=None, port=None):
        self.alive()
        mode = 'serve' if port is not None else 'run'
        argv = ['docker', 'exec', '-i', self.pod, 'python', '-I', '/opt/deplai/supervisor.py', mode,
                '--directory', '/workspace' + ('' if directory == '.' else '/' + directory)]
        if port is not None:
            argv += ['--port', str(port), '--socket', '/channel/' + key + '.sock']
        argv += ['--', *command]
        child = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, text=True)
        child.stdin.write(json.dumps(env or {})); child.stdin.close()
        if key:
            self.processes[key] = child
            self.record['processes'][key] = dict(state='STARTING', revision=self.manifest['revision'], restart_count=0, exit_code=None)
            self.persist()
        else:
            try:
                if child.wait(timeout=self.manifest['quota']['startup_seconds']) != 0:
                    raise PreviewError('WORKER_FAILED')
            except subprocess.TimeoutExpired:
                # Killing docker exec alone does not kill an in-container command.
                # Stop the whole scoped pod before returning a timeout.
                self.destroy_container(self.pod)
                child.kill(); child.wait(timeout=5)
                raise PreviewError('PREVIEW_TIMEOUT') from None

    def database(self):
        self.execute(['/usr/lib/postgresql/17/bin/initdb', '-D', '/runtime/postgres', '-U', 'preview', '--auth=trust', '--no-locale'])
        self.execute(['/usr/lib/postgresql/17/bin/postgres', '-D', '/runtime/postgres', '-h', '127.0.0.1', '-k', '/tmp', '-c', 'shared_buffers=32MB', '-c', 'max_connections=20'], key='postgres')
        for _ in range(40):
            try:
                self.execute(['/usr/lib/postgresql/17/bin/pg_isready', '-h', '127.0.0.1', '-U', 'preview'])
                self.execute(['/usr/lib/postgresql/17/bin/createdb', '-h', '127.0.0.1', '-U', 'preview', 'preview'])
                self.record['processes']['postgres']['state'] = 'RUNNING'; self.persist()
                return
            except PreviewError:
                time.sleep(0.25)
        raise PreviewError('DATABASE_START_FAILED')

    def dependencies(self):
        # No user secrets are resolved until this broker has been destroyed.
        broker = self.launch('install-broker', self.images['broker'], ['python', '-I', '/broker/install_proxy.py', 'registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org'],
                             extra=['--mount', 'type=bind,source=' + str(HERE) + ',target=/broker,readonly'], network='bridge', memory=256)
        relay = subprocess.Popen(['docker', 'exec', self.pod, 'python', '-I', '/opt/deplai/supervisor.py', 'install-relay'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            self.execute(['python', '-m', 'venv', '/runtime/venv'])
            env = dict(PATH='/runtime/venv/bin:/usr/local/bin:/usr/bin:/bin',
                       HTTPS_PROXY='http://127.0.0.1:18080', HTTP_PROXY='http://127.0.0.1:18080',
                       npm_config_https_proxy='http://127.0.0.1:18080', npm_config_proxy='http://127.0.0.1:18080',
                       PIP_DISABLE_PIP_VERSION_CHECK='1')
            for service in self.manifest['services']:
                self.execute(service['install'], directory=service['directory'], env=env)
        finally:
            self.destroy_container(broker)
            # Broker removal revokes every existing and future external tunnel.
            # The now-inert local relay is part of the pod's quota and lifetime.
            self.processes['install-relay'] = relay

    def service_health(self, service):
        child = self.processes[service['id']]
        for _ in range(60):
            self.alive()
            if child.poll() is not None:
                raise PreviewError('WORKER_FAILED')
            result = subprocess.run(['docker', 'exec', self.pod, 'python', '-I', '/opt/deplai/supervisor.py', 'health', '--port', str(service['port']), '--health-path', service['health_path']], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
            if result.returncode == 0:
                self.record['processes'][service['id']]['state'] = 'RUNNING'; self.persist()
                return
            time.sleep(0.25)
        raise PreviewError('PREVIEW_TIMEOUT')

    def start(self):
        self.stage('revision', 'REVISION_MISMATCH', self.verify_revision)
        self.stage('sandbox', 'SANDBOX_CREATE_FAILED', self.pod_create)
        if self.manifest['resources']:
            self.stage('postgres', 'DATABASE_START_FAILED', self.database)
        self.stage('install', 'DEPENDENCY_INSTALL_FAILED', self.dependencies)
        environments = self.stage('secrets', 'SECRET_RESOLUTION_FAILED', lambda: self.resolve_environment(self.manifest))
        if set(environments) != {s['id'] for s in self.manifest['services']}:
            raise PreviewError('SECRET_RESOLUTION_FAILED')
        for service in sorted(self.manifest['services'], key=lambda item: item['role'] == 'frontend'):
            env = environments[service['id']]
            if set(env) != set(service['environment_keys']) or any(not isinstance(v, str) or '\x00' in v or len(v) > 8192 for v in env.values()):
                raise PreviewError('SECRET_RESOLUTION_FAILED')
            env = {**env, 'PATH': '/runtime/venv/bin:/usr/local/bin:/usr/bin:/bin'}
            if service['migration']:
                self.stage('migration:' + service['id'], 'MIGRATION_FAILED', lambda s=service, e=env: self.execute(s['migration'], directory=s['directory'], env=e))
            role = service['role'].upper()
            self.stage('start:' + service['id'], role + '_START_FAILED', lambda s=service, e=env: self.execute(s['start'], directory=s['directory'], env=e, key=s['id'], port=s['port']))
            self.stage('health:' + service['id'], role + '_HEALTH_FAILED', lambda s=service: self.service_health(s))
        self.stage('revision', 'REVISION_MISMATCH', self.verify_revision)
        self.stage('gateway', 'PROXY_CONFIGURATION_FAILED', self.gateway)
        self.stage('gateway_health', 'PROXY_CONFIGURATION_FAILED', self.gateway_health)
        self.record['state'] = 'PREVIEW_READY'; self.persist()
        return self.record

    def gateway(self):
        hostname = 'p-' + self.id + '.localhost'
        fixed(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
               '-keyout', str(self.control / 'tls.key'), '-out', str(self.control / 'tls.crt'),
               '-subj', '/CN=' + hostname, '-addext', 'subjectAltName=DNS:' + hostname])
        (self.control / 'tls.key').chmod(0o444)
        frontend = next(s['id'] for s in self.manifest['services'] if s['role'] == 'frontend')
        backend = next((s['id'] for s in self.manifest['services'] if s['role'] == 'backend'), frontend)
        config = '''pid /tmp/nginx.pid;
events { worker_connections 128; }
http {
 access_log off; error_log /dev/null crit;
 client_body_temp_path /tmp/body; proxy_temp_path /tmp/proxy;
 fastcgi_temp_path /tmp/fastcgi; uwsgi_temp_path /tmp/uwsgi; scgi_temp_path /tmp/scgi;
 map $http_upgrade $connection_upgrade { default upgrade; '' close; }
 server {
  listen 8443 ssl;
  ssl_certificate /gateway/tls.crt; ssl_certificate_key /gateway/tls.key;
  client_max_body_size 2m; proxy_http_version 1.1; proxy_buffering off;
  proxy_set_header Host $http_host; proxy_set_header X-Forwarded-Proto https;
  proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection $connection_upgrade;
  proxy_read_timeout 60s;
'''
        config += '  server_name ' + hostname + ';\n'
        config += '  location /api/ { proxy_pass http://unix:/channel/' + backend + '.sock:; }\n'
        config += '  location / { proxy_pass http://unix:/channel/' + frontend + '.sock:; }\n'
        config += ' }\n}\n'
        (self.control / 'nginx.conf').write_text(config)
        gateway = self.launch('gateway', self.images['gateway'], ['nginx', '-c', '/gateway/nginx.conf', '-g', 'daemon off;'], network='bridge', memory=256,
                              extra=['-p', '127.0.0.1::8443', '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=16m,uid=65532,gid=65532',
                                     '--mount', 'type=bind,source=' + str(self.control) + ',target=/gateway,readonly'])
        port = self.owned(gateway)['NetworkSettings']['Ports']['8443/tcp'][0]['HostPort']
        self.record['origin'] = f'https://{hostname}:{port}'
        self.persist()

    def gateway_health(self):
        from urllib.parse import urlsplit
        origin = urlsplit(self.record['origin'])
        context = ssl.create_default_context(cafile=str(self.control / 'tls.crt'))
        for service in self.manifest['services']:
            healthy = False
            for _ in range(15):
                connection = http.client.HTTPConnection('127.0.0.1', origin.port, timeout=3)
                try:
                    connection.sock = context.wrap_socket(socket.create_connection(('127.0.0.1', origin.port), timeout=3), server_hostname=origin.hostname)
                    connection.request('GET', service['health_path'], headers={'Host': origin.netloc})
                    response = connection.getresponse()
                    if 200 <= response.status < 300:
                        healthy = True
                        break
                except OSError:
                    pass
                finally:
                    connection.close()
                time.sleep(0.25)
            if not healthy:
                raise PreviewError('PROXY_CONFIGURATION_FAILED')

    def observe_health(self):
        """The polling owner must call this; a previously healthy process can die."""
        self.alive()
        for key, process in self.processes.items():
            if key == 'install-relay':
                continue
            code = process.poll()
            if code is not None:
                self.record['processes'][key].update(state='CRASHED', exit_code=code)
                self.record.update(state='FAILED', failure_code='WORKER_FAILED', failure_stage=key)
                self.persist()
                return False
        try:
            for service in self.manifest['services']:
                self.service_health(service)
            self.gateway_health()
        except Exception:
            self.record.update(state='FAILED', failure_code='WORKER_FAILED', failure_stage='health')
            self.persist()
            return False
        return self.record['state'] == 'PREVIEW_READY'

    def destroy_container(self, name):
        with lease_lock(self.path):
            remaining = docker('ps', '-aq', '--filter', 'label=deplai.preview=' + self.id).splitlines()
            for value in remaining:
                container = self.owned(value)
                if name in (container['Id'], container['Name'].lstrip('/')) or container['Id'].startswith(name):
                    docker('rm', '-f', container['Id'])
                    return

    def close(self):
        self.record['state'] = 'STOPPED'; self.persist()
        failed = False
        for value in docker('ps', '-aq', '--filter', 'label=deplai.preview=' + self.id).splitlines():
            try:
                self.destroy_container(value)
            except Exception:
                failed = True
        for child in self.processes.values():
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill(); child.wait(timeout=5)
        volumes = docker('volume', 'ls', '-q', '--filter', 'label=deplai.preview=' + self.id).splitlines()
        for name in volumes:
            inspected = json.loads(docker('volume', 'inspect', name))[0]
            if inspected.get('Labels', {}).get('deplai.preview') != self.id:
                failed = True
            else:
                docker('volume', 'rm', name)
        self.record['cleanup'] = 'FAILED' if failed else 'COMPLETED'
        self.record['state'] = 'FAILED' if failed else 'DESTROYED'; self.persist()
        if failed:
            raise PreviewError('CLEANUP_FAILED')
