"""Merge the dedicated preview runtime into Docker configuration on a Linux host."""
import json
import os
from pathlib import Path
import platform
import shutil


def main():
    if platform.system() != 'Linux' or os.geteuid() != 0:
        raise SystemExit('Linux root required')
    path = Path('/etc/docker/daemon.json')
    path.parent.mkdir(parents=True, exist_ok=True)
    config = json.loads(path.read_text()) if path.exists() else {}
    backup = path.with_suffix('.before-deplai-gvisor.json')
    if path.exists() and not backup.exists():
        shutil.copy2(path, backup)
    runtime = shutil.which('runsc')
    if not runtime:
        raise SystemExit('Install runsc first')
    config.setdefault('runtimes', {})['runsc'] = {
        'path': runtime,
        'runtimeArgs': ['--platform=systrap', '--host-uds=all', '--file-access-mounts=shared', '--gvisor-marker-file'],
    }
    path.write_text(json.dumps(config, indent=2) + '\n')


if __name__ == '__main__':
    main()
