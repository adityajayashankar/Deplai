"""Live local acceptance runner. Only fixed fixture code is generated here."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import uuid

from fixture import write_fixture, manifest
from runtime import Preview, atomic, docker, fixed, HERE


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--proof', type=Path, required=True)
    parser.add_argument('--pod-image', required=True)
    args = parser.parse_args()
    root = args.root.resolve(strict=True)
    if root.stat().st_mode & 0o077 or root.stat().st_uid != os.getuid():
        raise SystemExit('Private owned benchmark root required')
    worktree_id = 'fixture-' + uuid.uuid4().hex
    worktrees = root / 'worktrees'; worktrees.mkdir(exist_ok=True, mode=0o700)
    tree = worktrees / worktree_id; tree.mkdir()
    scope = dict(owner_user_id='fixture-user', organization_id='fixture-org', project_id='fixture-project', session_id=uuid.uuid4().hex)
    report = dict(scope='fixed-fixture-only', checks={}, started_at=time.time(), passed=False)
    preview = None
    try:
        write_fixture(tree)
        fixed(['git', '-c', 'init.templateDir=', 'init', str(tree)])
        fixed(['git', '-C', str(tree), 'add', '.'])
        fixed(['git', '-c', 'core.hooksPath=/dev/null', '-C', str(tree), '-c', 'user.name=Preview Benchmark', '-c', 'user.email=preview@example.invalid', 'commit', '-m', 'Fixed full-stack fixture'])
        revision = fixed(['git', '-C', str(tree), 'rev-parse', 'HEAD'])
        contract = manifest(revision, scope); contract['worktree_id'] = worktree_id
        atomic(worktrees / (worktree_id + '.owner.json'), dict(scope=scope, path=str(tree)))
        images = {name: json.loads(docker('image', 'inspect', value))[0]['Id'] for name, value in dict(pod=args.pod_image, gateway='nginx@sha256:ef8676b33d681f272ba429b27658bdd7e640963279714c96bddf1dc76307f7b6', broker='python@sha256:2f17fc044b579bab302c2e8054d3a686e2cb9a83de48e70534b94cd8ebbe06a9').items()}
        preview = Preview(root, contract, tree, images, lambda _: dict(frontend={}, backend={'DATABASE_URL': 'postgresql://preview@127.0.0.1:5432/preview'}), args.proof)
        preview.start(); report['checks']['startup'] = 'PASS'
        result = subprocess.run(['node', str(HERE / 'browser-benchmark.mjs'), preview.record['origin'], str(tree)], capture_output=True, text=True, timeout=90)
        report['checks'].update(json.loads(result.stdout or '{}'))
        if result.returncode:
            # Fixed fixture/browser diagnostics only; never used for imported code.
            atomic(root / (worktree_id + '.browser-diagnostic.json'), dict(diagnostic=result.stderr[-4096:]))
            raise RuntimeError('BROWSER_ACCEPTANCE_FAILED')
        fixed(['git', '-C', str(tree), 'add', '.'])
        fixed(['git', '-c', 'core.hooksPath=/dev/null', '-C', str(tree), '-c', 'user.name=Preview Benchmark', '-c', 'user.email=preview@example.invalid', 'commit', '-m', 'Observed framework reload changes'])
        revision = fixed(['git', '-C', str(tree), 'rev-parse', 'HEAD'])
        preview.manifest['revision'] = revision
        preview.verify_revision(); preview.record['revision'] = revision; preview.persist()
        report['checks']['revision'] = 'PASS'
        # Fixed network probes never print app environment or credentials.
        probe = "import socket,errno,json; result=[]\nfor ip in ['169.254.169.254','10.0.0.1','192.168.0.1','fd00:ec2::254']:\n try:\n  socket.create_connection((ip,80),timeout=1);result.append(False)\n except OSError as e: result.append(e.errno in (errno.ENETUNREACH,errno.EHOSTUNREACH,errno.EACCES,errno.EPERM))\nprint(json.dumps(result))"
        if json.loads(docker('exec', preview.pod, 'python', '-I', '-c', probe)) != [True] * 4:
            raise RuntimeError('NETWORK_BOUNDARY_FAILED')
        report['checks']['network'] = 'PASS'
        # Required-service death must immediately remove readiness on observation.
        docker('exec', preview.pod, 'pkill', '-f', 'node_modules/nodemon/bin/nodemon.js')
        time.sleep(1)
        if preview.observe_health() or preview.record['state'] == 'PREVIEW_READY':
            raise RuntimeError('DEGRADED_HEALTH_FAILED')
        report['checks']['degraded_health'] = 'PASS'
    except Exception as error:
        report['failure'] = getattr(error, 'code', type(error).__name__)
        report['failure_stage'] = getattr(error, 'stage', None)
    finally:
        if preview:
            report['preview_id'] = preview.id
            try:
                preview.close(); report['checks']['cleanup'] = 'PASS'
            except Exception:
                report['checks']['cleanup'] = 'FAILED'
        required = {'startup', 'cookie', 'crud', 'frontend_reload', 'backend_reload', 'cookie_isolation', 'revision', 'network', 'degraded_health', 'cleanup'}
        report['passed'] = set(report['checks']) == required and all(value == 'PASS' for value in report['checks'].values())
        report['completed_at'] = time.time()
        atomic(root / (worktree_id + '.benchmark.json'), report)
        if report['checks'].get('cleanup') == 'PASS' and tree.resolve().parent == worktrees.resolve() and not tree.is_symlink():
            shutil.rmtree(tree)
            (worktrees / (worktree_id + '.owner.json')).unlink(missing_ok=True)
    print(json.dumps(report))
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
