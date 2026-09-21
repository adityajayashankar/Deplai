"""Synthetic-only proof controls. Does not authorize imported application execution."""
import ipaddress
import math
import re
import time

CHECKS = (
    'gvisor', 'http', 'tls', 'path_routing', 'cookie_roundtrip', 'csrf',
    'websocket', 'sse', 'hot_reload', 'body_size', 'worktree_visibility',
    'host_blocked', 'metadata_blocked', 'private_blocked', 'sibling_blocked',
    'cpu_limit', 'memory_limit', 'pid_limit', 'disk_limit', 'neighbor_healthy',
    'idle_gc', 'hard_gc', 'orphan_cleanup', 'egress_policy',
)


def image_digest(value):
    if not re.fullmatch(r'[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}', value):
        raise ValueError('An immutable, operator-approved image digest is required')
    return value


def quota(cpu=0.5, memory_mb=256, disk_mb=32, pids=128, idle_seconds=180, hard_seconds=600):
    values = dict(cpu=cpu, memory_mb=memory_mb, disk_mb=disk_mb, pids=pids,
                  idle_seconds=idle_seconds, hard_seconds=hard_seconds)
    maxima = dict(cpu=2, memory_mb=1024, disk_mb=128, pids=128, idle_seconds=900, hard_seconds=1800)
    for key, value in values.items():
        if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value) or not 0 < value <= maxima[key]:
            raise ValueError('Invalid synthetic quota')
        if key != 'cpu' and not isinstance(value, int):
            raise ValueError('Integer quota required')
    if idle_seconds > hard_seconds or memory_mb < 64 or disk_mb < 8 or pids < 8:
        raise ValueError('Invalid synthetic quota relationship')
    return values


def hardened_args(name, run_id, image, limits, network='none'):
    if not re.fullmatch(r'[a-f0-9]{32}', run_id) or not re.fullmatch(r'proof-[a-f0-9]{32}-[a-z0-9-]+', name):
        raise ValueError('Invalid scoped proof identity')
    image_digest(image)
    quota(**limits)
    return ['run', '-d', '--name', name, '--label', f'deplai.proof={run_id}',
            '--runtime=runsc', '--network', network, '--read-only', '--user=65532:65532',
            '--cap-drop=ALL', '--security-opt=no-new-privileges=true', '--init',
            '--cpus', str(limits['cpu']), '--memory', f"{limits['memory_mb']}m",
            '--memory-swap', f"{limits['memory_mb']}m", '--pids-limit', str(limits['pids']),
            '--ulimit', 'nofile=256:256', '--ulimit', f"nproc={limits['pids']}:{limits['pids']}", '--log-driver=none',
            '--tmpfs', f"/tmp:rw,nosuid,nodev,noexec,size={limits['disk_mb'] // 2}m,uid=65532,gid=65532",
            '--tmpfs', f"/runtime:rw,nosuid,nodev,noexec,size={limits['disk_mb'] // 2 - 1}m,uid=65532,gid=65532"]


def lifecycle(record, now=None):
    """Absolute host timestamps survive controller restart. Activity never extends hard TTL."""
    now = time.time() if now is None else now
    if record['state'] in ('STOPPED', 'DESTROYED'):
        return record['state']
    if now < record['created_at'] or record['last_activity_at'] > now:
        return 'STOPPED'  # Clock rollback cannot extend a lease.
    if now - record['created_at'] >= record['hard_seconds'] or now - record['last_activity_at'] >= record['idle_seconds']:
        return 'STOPPED'
    return 'RUNNING'


def public_target(host, resolved_addresses, approved_hosts):
    """Broker policy: exact hosts, HTTPS/443 only in caller, ALL resolved addresses public.

    Caller must connect to one validated address while retaining TLS hostname checks.
    Never resolve again or follow redirects after this check.
    """
    if host not in approved_hosts or not re.fullmatch(r'[a-z0-9]+(?:[.-][a-z0-9]+)*', host):
        raise ValueError('Egress host is not approved')
    if not resolved_addresses:
        raise ValueError('No egress address')
    for value in resolved_addresses:
        address = ipaddress.ip_address(value)
        if not address.is_global or address.is_multicast or address.is_unspecified or getattr(address, 'ipv4_mapped', None):
            raise ValueError('Nonpublic egress address')
    return resolved_addresses[0]


def proof_passed(results):
    return set(results) == set(CHECKS) and all(results[key] == 'PASS' for key in CHECKS)
