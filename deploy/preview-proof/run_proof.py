"""Linux-only synthetic gVisor proof. Never reads or starts imported applications.

Run as a dedicated test-host account with Docker access. Image digests must already
be pulled and operator-approved. stdout is a redacted proof summary, not child logs.
"""
import argparse
try:
    import fcntl
except ImportError:
    fcntl = None  # Read-only unit tests run on Windows; live entrypoint rejects it.
import http.client
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import ssl
import subprocess
import tempfile
import threading
import time
import uuid

from boundary import CHECKS, hardened_args, image_digest, lifecycle, proof_passed, quota

HERE = Path(__file__).resolve().parent


class ProofOperationError(RuntimeError):
    def __init__(self, message, stderr):
        super().__init__(message)
        self.stderr = stderr


def run(args, cwd=None, timeout=30):
    result = subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=timeout, check=False)
    if result.returncode:
        raise ProofOperationError(f'Trusted proof operation failed: {Path(args[0]).name}/{args[1] if len(args) > 1 else "command"}, exit {result.returncode}', result.stderr[-4096:])
    return result.stdout.strip()


def docker(*args, timeout=30):
    return run(['docker', *args], timeout=timeout)


def atomic_json(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    os.chmod(temporary, 0o600)
    temporary.replace(path)


class Controller:
    """External TTL watchdog plus restart-safe, label-scoped orphan cleanup.

    Registry writes precede launch. A separate --gc invocation recovers a dead
    controller; the test-host timer in README is required while tests run.
    """
    def __init__(self, root, run_id):
        self.root = root
        self.run_id = run_id
        self.registry = root / f'{run_id}.registry.json'
        self.lock = threading.RLock()
        self.records = json.loads(self.registry.read_text()) if self.registry.exists() else {}
        if not self.registry.exists():
            atomic_json(self.registry, self.records)
        self.events = []

    def event(self, stage, outcome, started=None):
        event = dict(timestamp=time.time(), run_id=self.run_id, stage=stage, outcome=outcome)
        if started is not None:
            event['duration_ms'] = round((time.monotonic() - started) * 1000)
        self.events.append(event)
        with (self.root / f'{self.run_id}.events.jsonl').open('a') as target:
            target.write(json.dumps(event) + '\n')

    def register(self, name, limits):
        with self.lock:
            now = time.time()
            self.records[name] = dict(state='RUNNING', created_at=now, last_activity_at=now,
                                      idle_seconds=limits['idle_seconds'], hard_seconds=limits['hard_seconds'])
            atomic_json(self.registry, self.records)

    def activity(self, name):
        with self.lock:
            record = self.records[name]
            if lifecycle(record) != 'RUNNING':
                raise RuntimeError('Preview lease expired')
            record['last_activity_at'] = time.time()
            atomic_json(self.registry, self.records)

    def owned(self):
        ids = docker('ps', '-aq', '--filter', f'label=deplai.proof={self.run_id}').splitlines()
        return [json.loads(docker('inspect', value))[0] for value in ids]

    def destroy(self, container):
        with self.lock:
            self._destroy(container)

    def _destroy(self, container):
        # Inspect labels again immediately before a destructive operation; never
        # derive names from repository/user text or remove unrelated containers.
        current = json.loads(docker('inspect', container['Id']))[0]
        if current['Config']['Labels'].get('deplai.proof') != self.run_id:
            raise RuntimeError('Container ownership mismatch')
        name = current['Name'].lstrip('/')
        if name in self.records:
            self.records[name]['state'] = 'STOPPED'
            atomic_json(self.registry, self.records)
        docker('rm', '-f', current['Id'])
        if name in self.records:
            self.records[name]['state'] = 'DESTROYED'
            atomic_json(self.registry, self.records)
        self.event('gc', 'DESTROYED')

    def gc(self, all_owned=False):
        with self.lock:
            for container in self.owned():
                record = self.records.get(container['Name'].lstrip('/'))
                if all_owned or record is None or lifecycle(record) != 'RUNNING':
                    self.destroy(container)

    def cleanup_channels(self):
        if self.owned():
            return
        for kind in ('network', 'volume'):
            names = docker(kind, 'ls', '--format', '{{.Name}}', '--filter', f'label=deplai.proof={self.run_id}').splitlines()
            for name in names:
                current = json.loads(docker(kind, 'inspect', name))[0]
                if current.get('Labels', {}).get('deplai.proof') != self.run_id:
                    raise RuntimeError('Channel ownership mismatch')
                docker(kind, 'rm', name)

    def cleanup_worktrees(self):
        if self.owned():
            return
        for directory in self.root.glob(f'proof-{self.run_id}-*'):
            if directory.is_symlink() or directory.resolve().parent != self.root.resolve():
                raise RuntimeError('Unsafe proof cleanup path')
            if directory.is_dir():
                shutil.rmtree(directory)
                self.event('worktree_gc', 'DESTROYED')


def nginx_config():
    return '''pid /tmp/nginx.pid;
events { worker_connections 128; }
http {
 access_log off; error_log /dev/stderr crit;
 client_body_temp_path /tmp/body;
 proxy_temp_path /tmp/proxy;
 fastcgi_temp_path /tmp/fastcgi;
 uwsgi_temp_path /tmp/uwsgi;
 scgi_temp_path /tmp/scgi;
 map $http_upgrade $connection_upgrade { default upgrade; '' close; }
 upstream api { server unix:/channel/api.sock; }
 upstream frontend { server unix:/channel/frontend.sock; }
 server {
  listen 8080;
  location / { return 200 "synthetic-http"; }
 }
 server {
  listen 8443 ssl;
  server_name localhost;
  ssl_certificate /proof/tls.crt;
  ssl_certificate_key /proof/tls.key;
  client_max_body_size 2m;
  proxy_http_version 1.1;
  proxy_set_header Host $http_host;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection $connection_upgrade;
  proxy_buffering off;
  proxy_read_timeout 20s;
  location /api/ { proxy_pass http://api; }
  location /ws { proxy_pass http://api; }
  location /hmr { proxy_pass http://frontend; }
  location / { proxy_pass http://frontend; }
 }
}'''


def proof(args, root):
    results = {key: 'NOT_RUN' for key in CHECKS}
    run_id = uuid.uuid4().hex
    control = Controller(root, run_id)
    report_path = root / f'{run_id}.proof.json'
    harness = hashlib.sha256()
    for source in sorted([*HERE.glob('*.py'), HERE / 'browser-proof.mjs', HERE / 'package-lock.json']):
        harness.update(source.name.encode()); harness.update(source.read_bytes())
    report = dict(schema_version=1, run_id=run_id, provider='gvisor', scope='synthetic-only', checks=results, passed=False,
                  started_at=time.time(), harness_sha256=harness.hexdigest(), images=dict(python=args.python_image, proxy=args.proxy_image))
    work = Path(tempfile.mkdtemp(prefix=f'proof-{run_id}-', dir=root))
    limits = quota()
    volume = f'proof-{run_id}-channel'; network = f'proof-{run_id}-gateway'
    stopped = threading.Event()
    watchdog = None
    cleanup_failed = False
    try:
        stage = 'preflight'
        if platform.system() != 'Linux':
            raise RuntimeError('Dedicated Linux gVisor host required')
        info = json.loads(docker('info', '--format', '{{json .}}'))
        report['docker_version'] = info.get('ServerVersion')
        if 'runsc' not in info.get('Runtimes', {}) or str(info.get('CgroupVersion')) != '2':
            raise RuntimeError('gVisor and cgroup v2 required')
        for image in [args.python_image, args.proxy_image]:
            image_digest(image); docker('image', 'inspect', image)  # Never implicitly pull unreviewed images.
        for binary in ['git', 'openssl', 'node']:
            if not shutil.which(binary):
                raise RuntimeError('Proof host tool missing')
        run(['node', '-e', "import('playwright').then(()=>{}).catch(()=>process.exit(1))"], cwd=HERE)
        stage = 'worktrees'
        canonical = work / 'canonical'; main = work / 'main'; task = work / 'task'
        canonical.mkdir()
        run(['git', '-c', 'init.templateDir=', 'init', str(canonical)])
        (canonical / 'visibility.txt').write_text('before')
        run(['git', '-C', str(canonical), 'add', 'visibility.txt'])
        run(['git', '-C', str(canonical), '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Boundary Proof', '-c', 'user.email=proof@example.invalid', 'commit', '-m', 'Synthetic fixture'])
        for path in [main, task]:
            run(['git', '-C', str(canonical), '-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--detach', str(path), 'HEAD'])
        revision = run(['git', '-C', str(task), 'rev-parse', 'HEAD'])
        report['session_binding_fixture'] = dict(active_worktree_id='task', active_preview_revision=revision, source_revision=revision)
        # Only this exact task worktree is mounted. No copying/rebuilding after edits.
        fixture_dir = work / 'fixtures'; fixture_dir.mkdir()
        gateway_dir = work / 'gateway'; gateway_dir.mkdir()
        shutil.copyfile(HERE / 'synthetic.py', fixture_dir / 'synthetic.py')
        for name in ('boundary.py', 'egress_broker.py'):
            shutil.copyfile(HERE / name, fixture_dir / name)
        (gateway_dir / 'nginx.conf').write_text(nginx_config())
        run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
             '-addext', 'subjectAltName=DNS:localhost', '-keyout', str(gateway_dir / 'tls.key'), '-out', str(gateway_dir / 'tls.crt')])
        os.chmod(gateway_dir / 'tls.key', 0o644)  # Ephemeral test key only; mounted into gateway, never app.
        os.chmod(work, 0o755)  # Containers can traverse mounted proof directory; parent remains 0700.
        docker('volume', 'create', '--label', f'deplai.proof={run_id}', '--driver', 'local', '--opt', 'type=tmpfs', '--opt', 'device=tmpfs', '--opt', 'o=size=1m,uid=65532,gid=65532,mode=0700', volume)
        neighbor_volume = f'proof-{run_id}-neighbor'
        docker('volume', 'create', '--label', f'deplai.proof={run_id}', '--driver', 'local', '--opt', 'type=tmpfs', '--opt', 'device=tmpfs', '--opt', 'o=size=1m,uid=65532,gid=65532,mode=0700', neighbor_volume)
        # Gateway is trusted ingress and needs Docker host-port publication. App
        # containers never join this network; they have only their Unix channel.
        docker('network', 'create', '--label', f'deplai.proof={run_id}', network)
        sibling_network = f'proof-{run_id}-sibling'
        docker('network', 'create', '--internal', '--label', f'deplai.proof={run_id}', sibling_network)

        def launch(suffix, mode, chosen=limits, net='none', extra=(), image=None, channel=None, workspace=None):
            if stopped.is_set():
                raise RuntimeError('Proof watchdog failed')
            name = f'proof-{run_id}-{suffix}'; started = time.monotonic()
            control.register(name, chosen)
            command = hardened_args(name, run_id, image or args.python_image, chosen, net)
            if image:
                command.remove('--log-driver=none')
            command += ['--mount', f'type=bind,source={gateway_dir if image else fixture_dir},target=/proof,readonly',
                        '--mount', f'type=bind,source={workspace or task},target=/workspace,readonly',
                        '--mount', f'type=volume,source={channel or volume},target=/channel', *extra,
                        image or args.python_image, *mode]
            docker(*command)
            details = json.loads(docker('inspect', name))[0]
            if details['HostConfig']['Runtime'] != 'runsc' or details['HostConfig']['Privileged'] or not details['HostConfig']['ReadonlyRootfs']:
                raise RuntimeError('Sandbox configuration mismatch')
            control.event('sandbox_create', 'COMPLETED', started)
            return name

        def watch():
            while not stopped.wait(1):
                try:
                    control.gc()
                except Exception as error:
                    control.event('watchdog', 'FAILED')
                    report['watchdog_failed'] = True
                    report['watchdog_reason'] = str(error) if isinstance(error, RuntimeError) else type(error).__name__
                    stopped.set()

        watchdog = threading.Thread(target=watch, daemon=True); watchdog.start()
        stage = 'sandbox'
        api = launch('api', ['python', '-B', '/proof/synthetic.py', 'serve', 'api'])
        frontend = launch('frontend', ['python', '-B', '/proof/synthetic.py', 'serve', 'frontend'])
        neighbor = launch('neighbor', ['python', '-B', '/proof/synthetic.py', 'serve', 'api'], channel=neighbor_volume, workspace=main)
        docker('exec', api, 'python', '-c', "from pathlib import Path; assert Path('/proc/gvisor/kernel_is_gvisor').exists()")
        results['gvisor'] = 'PASS'
        stage = 'proxy'
        started = time.monotonic()
        proxy = launch('proxy', ['nginx', '-c', '/proof/nginx.conf', '-g', 'daemon off;'], net=network,
                       extra=['--log-driver=local', '--log-opt=max-size=256k', '--log-opt=max-file=2', '-p', '127.0.0.1::8443', '-p', '127.0.0.1::8080'], image=args.proxy_image)
        proxy_details = json.loads(docker('inspect', proxy))[0]
        report['proxy_process'] = {key: proxy_details['State'].get(key) for key in ['Status', 'ExitCode', 'OOMKilled']}
        report['proxy_ports'] = proxy_details['NetworkSettings'].get('Ports')
        report['proxy_bindings'] = proxy_details['HostConfig'].get('PortBindings')
        https_port = int(proxy_details['NetworkSettings']['Ports']['8443/tcp'][0]['HostPort'])
        http_port = int(proxy_details['NetworkSettings']['Ports']['8080/tcp'][0]['HostPort'])
        ctx = ssl.create_default_context(cafile=str(gateway_dir / 'tls.crt'))
        for _ in range(30):
            try:
                connection = http.client.HTTPSConnection('localhost', https_port, context=ctx, timeout=2)
                connection.request('GET', '/api/health'); response = connection.getresponse()
                if response.status == 200 and response.read() == b'healthy':
                    break
            except OSError:
                pass
            finally:
                connection.close()
            time.sleep(0.25)
        else:
            raise RuntimeError('Proxy health timeout')
        control.event('proxy_configure', 'COMPLETED', started)
        results['tls'] = 'PASS'
        connection = http.client.HTTPConnection('localhost', http_port, timeout=3)
        connection.request('GET', '/'); response = connection.getresponse()
        if response.status == 200 and response.read() == b'synthetic-http':
            results['http'] = 'PASS'
        connection.close()
        stage = 'browser'
        browser = subprocess.run(['node', str(HERE / 'browser-proof.mjs'), f'https://localhost:{https_port}', str(task / 'visibility.txt')], cwd=HERE, timeout=90, capture_output=True, text=True)
        observed = json.loads(browser.stdout or '{}')
        for key in ('path_routing', 'cookie_roundtrip', 'csrf', 'websocket', 'sse', 'hot_reload', 'body_size', 'worktree_visibility'):
            if observed.get(key) == 'PASS':
                results[key] = 'PASS'
        if browser.returncode:
            raise ProofOperationError('Browser proof incomplete', browser.stderr[-4096:])
        if any(observed.get(key) != 'PASS' for key in ('path_routing', 'cookie_roundtrip', 'csrf', 'websocket', 'sse', 'hot_reload', 'body_size', 'worktree_visibility')):
            raise RuntimeError('Browser proof missing mandatory observation')
        if (main / 'visibility.txt').read_text() != 'before':
            raise RuntimeError('Worktree isolation failed')
        run(['git', '-C', str(task), 'add', 'visibility.txt'])
        run(['git', '-C', str(task), '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Boundary Proof', '-c', 'user.email=proof@example.invalid', 'commit', '-m', 'Observed synthetic task modification'])
        report['session_binding_fixture']['active_preview_revision'] = run(['git', '-C', str(task), 'rev-parse', 'HEAD'])
        control.activity(api); control.activity(frontend); control.activity(proxy)
        stage = 'network'
        details = json.loads(docker('network', 'inspect', network))[0]
        host_ip = details['IPAM']['Config'][0]['Gateway']
        sentinel = launch('sibling-sentinel', ['python', '-B', '/proof/synthetic.py', 'tcp-sentinel'], net=sibling_network, channel=neighbor_volume, workspace=main)
        sibling_ip = json.loads(docker('inspect', sentinel))[0]['NetworkSettings']['Networks'][sibling_network]['IPAddress']
        # Positive control: the sibling target really serves TCP, so a failed
        # candidate connection is not misreported from a nonexistent target.
        positive = ''
        for _ in range(10):
            try:
                positive = docker('exec', sentinel, 'python', '-c', "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8080/api/health', timeout=3).status)")
                break
            except RuntimeError:
                time.sleep(0.2)
        if positive != '200':
            raise RuntimeError('Sibling probe positive control failed')
        targets = [host_ip, sibling_ip, '169.254.169.254', '10.0.0.1', '192.168.0.1', 'fd00:ec2::254']
        network_result = json.loads(docker('exec', api, 'python', '-B', '/proof/synthetic.py', 'network', *targets))
        if json.loads(docker('inspect', api))[0]['HostConfig']['NetworkMode'] != 'none':
            raise RuntimeError('Unexpected sandbox network')
        for key, hosts in {'host_blocked': [host_ip], 'sibling_blocked': [sibling_ip], 'metadata_blocked': ['169.254.169.254', 'fd00:ec2::254'], 'private_blocked': ['10.0.0.1', '192.168.0.1']}.items():
            if all(network_result.get(host) == 'BLOCKED' for host in hosts):
                results[key] = 'PASS'
        control.destroy(json.loads(docker('inspect', sentinel))[0])
        stage = 'egress'
        broker = launch('egress', ['python', '-B', '/proof/egress_broker.py', 'registry.npmjs.org'], net='bridge')
        for _ in range(20):
            ready = docker('exec', api, 'python', '-c', "from pathlib import Path; print(Path('/channel/egress.sock').exists())")
            if ready == 'True':
                break
            time.sleep(0.1)
        if json.loads(docker('exec', api, 'python', '-B', '/proof/synthetic.py', 'egress')) == [200, 403, 403]:
            results['egress_policy'] = 'PASS'
        control.destroy(json.loads(docker('inspect', broker))[0])
        stage = 'quotas'
        for mode in ('cpu', 'memory', 'pids', 'disk'):
            # Logging is disabled for service containers. Fixed fixture output is
            # captured via docker exec; memory death is observed through inspect.
            stress = launch(mode, ['python', '-B', '/proof/synthetic.py', 'memory'] if mode == 'memory' else ['python', '-c', 'import time; time.sleep(60)'], chosen=quota(pids=48, memory_mb=512) if mode == 'pids' else limits)
            if mode == 'pids':
                pid = json.loads(docker('inspect', stress))[0]['State']['Pid']
                relative = next(line.split(':', 2)[2] for line in Path(f'/proc/{pid}/cgroup').read_text().splitlines() if line.startswith('0::'))
                cgroup = (Path('/sys/fs/cgroup') / relative.lstrip('/')).resolve(strict=True)
                if not cgroup.is_relative_to('/sys/fs/cgroup'):
                    raise RuntimeError('Invalid cgroup containment')
                counters = {'pids_limit_hits': 0, 'peak_host_pids': 0, 'oom_kills': 0}
                monitoring_done = threading.Event()
                def sample_pids():
                    while not monitoring_done.is_set():
                        try:
                            hits = dict(line.split() for line in (cgroup / 'pids.events').read_text().splitlines())
                            memory = dict(line.split() for line in (cgroup / 'memory.events').read_text().splitlines())
                            counters['pids_limit_hits'] = max(counters['pids_limit_hits'], int(hits['max']))
                            counters['peak_host_pids'] = max(counters['peak_host_pids'], int((cgroup / 'pids.current').read_text()))
                            counters['oom_kills'] = max(counters['oom_kills'], int(memory['oom_kill']))
                        except FileNotFoundError:
                            break
                        monitoring_done.wait(0.01)
                sampler = threading.Thread(target=sample_pids, daemon=True); sampler.start()
                try:
                    output = docker('exec', stress, 'python', '-B', '/proof/synthetic.py', mode, timeout=30)
                except ProofOperationError:
                    output = 'SANDBOX_EXITED'
                finally:
                    monitoring_done.set(); sampler.join(timeout=2)
                state = json.loads(docker('inspect', stress))[0]['State']
                report['pid_observation'] = {**counters, 'fixture_result': output, 'oom_killed': state.get('OOMKilled'), 'exit_code': state.get('ExitCode')}
                results['pid_limit'] = 'PASS' if (output == 'LIMITED' or counters['pids_limit_hits'] > 0) and not counters['oom_kills'] and not state.get('OOMKilled') else 'FAILED'
            elif mode == 'memory':
                for _ in range(100):
                    state = json.loads(docker('inspect', stress))[0]['State']
                    if state.get('OOMKilled'):
                        results['memory_limit'] = 'PASS'; break
                    time.sleep(0.1)
            else:
                if mode == 'cpu':
                    pid = json.loads(docker('inspect', stress))[0]['State']['Pid']
                    relative = next(line.split(':', 2)[2] for line in Path(f'/proc/{pid}/cgroup').read_text().splitlines() if line.startswith('0::'))
                    cgroup = (Path('/sys/fs/cgroup') / relative.lstrip('/')).resolve(strict=True)
                    if not cgroup.is_relative_to('/sys/fs/cgroup'):
                        raise RuntimeError('Invalid cgroup containment')
                    def cpu_usage():
                        return int(dict(line.split() for line in (cgroup / 'cpu.stat').read_text().splitlines())['usage_usec'])
                    usage_before = cpu_usage(); wall_before = time.monotonic()
                output = docker('exec', stress, 'python', '-B', '/proof/synthetic.py', mode, timeout=30)
                if mode == 'cpu':
                    ratio = (cpu_usage() - usage_before) / 1_000_000 / (time.monotonic() - wall_before)
                    report['cpu_observation'] = dict(host_usage_ratio=ratio, cpu_max=(cgroup / 'cpu.max').read_text().strip())
                    if 0 < ratio <= limits['cpu'] * 1.4:
                        results['cpu_limit'] = 'PASS'
                elif output == 'LIMITED':
                    results['pid_limit' if mode == 'pids' else 'disk_limit'] = 'PASS'
            control.event('resource_limit', results.get(mode + '_limit', results.get('pid_limit')))
            control.destroy(json.loads(docker('inspect', stress))[0])
            if docker('exec', neighbor, 'python', '-B', '/proof/synthetic.py', 'neighbor') != 'HEALTHY':
                raise RuntimeError('Neighbor preview was affected by resource abuse')
            control.activity(neighbor)
        connection = http.client.HTTPSConnection('localhost', https_port, context=ctx, timeout=3)
        connection.request('GET', '/api/health'); response = connection.getresponse()
        if response.status == 200 and docker('exec', neighbor, 'python', '-B', '/proof/synthetic.py', 'neighbor') == 'HEALTHY':
            results['neighbor_healthy'] = 'PASS'
        response.read(); connection.close()
        stage = 'gc'
        for key, lifetime in [('idle_gc', quota(idle_seconds=5, hard_seconds=30)), ('hard_gc', quota(idle_seconds=12, hard_seconds=12))]:
            name = launch(key.replace('_', '-'), ['python', '-c', 'import time; time.sleep(30)'], chosen=lifetime)
            if key == 'hard_gc':
                for _ in range(4):
                    time.sleep(0.5); control.activity(name)
                deadline = control.records[name]['created_at'] + lifetime['hard_seconds']
                time.sleep(max(0, deadline - time.time()) + 2)
            else:
                time.sleep(lifetime['idle_seconds'] + 1)
            control.gc()
            if control.records[name]['state'] == 'DESTROYED':
                results[key] = 'PASS'
        orphan = launch('orphan', ['python', '-c', 'import time; time.sleep(30)'])
        with control.lock:
            del control.records[orphan]; atomic_json(control.registry, control.records)
        control.gc()
        if not any(c['Name'].lstrip('/') == orphan for c in control.owned()):
            results['orphan_cleanup'] = 'PASS'
    except Exception as error:
        report['failure_stage'] = locals().get('stage', 'setup')
        report['failure_class'] = type(error).__name__
        # Messages raised here describe only fixed harness operations, never
        # repository content or child stdout/stderr.
        if isinstance(error, RuntimeError):
            report['failure_reason'] = str(error)
        if isinstance(error, ProofOperationError):
            atomic_json(root / f'{run_id}.operation.json', {'synthetic_operation_diagnostic': error.stderr})
        if locals().get('proxy'):
            # Only this fixed nginx fixture has bounded private startup logs.
            # No imported app or user request body is included; access_log is off.
            diagnostic = subprocess.run(['docker', 'logs', '--tail', '20', proxy], capture_output=True, text=True, timeout=5)
            atomic_json(root / f'{run_id}.proxy-startup.json', {'diagnostic': (diagnostic.stdout + diagnostic.stderr)[-4096:]})
        control.event(report['failure_stage'], 'FAILED')
    finally:
        stopped.set()
        if watchdog:
            watchdog.join(timeout=35)
        try:
            control.gc(all_owned=True)
            control.cleanup_channels()
        except Exception:
            cleanup_failed = True
        report['cleanup'] = 'FAILED' if cleanup_failed else 'COMPLETED'
        report['passed'] = proof_passed(results) and not cleanup_failed and not report.get('watchdog_failed', False)
        report['completed_at'] = time.time()
        atomic_json(report_path, report)
        # Delete only a resolved directory created by this invocation under the
        # configured proof root, after successful resource cleanup.
        if not cleanup_failed and work.resolve().parent == root.resolve() and work.name.startswith(f'proof-{run_id}-'):
            shutil.rmtree(work)
    print(json.dumps(dict(report=str(report_path), passed=report['passed'], checks=results)))
    return 0 if report['passed'] else 1


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--python-image', type=image_digest)
    parser.add_argument('--proxy-image', type=image_digest)
    parser.add_argument('--gc', action='store_true')
    args = parser.parse_args()
    if platform.system() != 'Linux':
        parser.error('Live proof requires a dedicated Linux gVisor host')
    root = args.root.resolve(strict=True)
    if any(c in str(root) for c in ',\r\n') or args.root.is_symlink() or not root.is_dir() or root.stat().st_mode & 0o077 or root.stat().st_uid != os.getuid():
        parser.error('Proof root must be an owned private directory (mode 0700), not a symlink')
    with (root / '.controller.lock').open('a') as lock:
        # Test-host timer skips an actively supervised proof. On process death the
        # OS releases this lock and the next timer recovers expired/orphan resources.
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 0 if args.gc else 1
        if args.gc:
            for registry in root.glob('*.registry.json'):
                run_id = registry.name.split('.')[0]
                if len(run_id) == 32 and all(c in '0123456789abcdef' for c in run_id):
                    control = Controller(root, run_id)
                    control.gc(); control.cleanup_channels(); control.cleanup_worktrees()
            return 0
        if not args.python_image or not args.proxy_image:
            parser.error('Both approved image digests are required')
        return proof(args, root)


if __name__ == '__main__':
    raise SystemExit(main())
