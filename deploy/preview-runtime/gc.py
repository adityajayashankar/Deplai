"""Host-side lease reaper. Only exact preview labels owned by private records."""
import argparse
import json
import os
from pathlib import Path
import re
import time

from runtime import atomic, docker, lease_lock


def reap(root, now=None):
    now = time.time() if now is None else now
    root = Path(root).resolve(strict=True)
    if root.stat().st_mode & 0o077 or root.stat().st_uid != os.getuid():
        raise RuntimeError('Private owned runtime root required')
    for path in root.glob('*.preview.json'):
        if path.is_symlink() or not re.fullmatch(r'[a-f0-9]{32}\.preview\.json', path.name):
            continue
        with lease_lock(path):
            reap_record(path, now)


def reap_record(path, now):
        record = json.loads(path.read_text())
        if path.name != record['preview_id'] + '.preview.json':
            return
        pid = record.get('controller_pid', 0)
        try:
            alive = pid > 0 and Path(f'/proc/{pid}/stat').read_text().split(') ', 1)[1].split()[19] == record.get('controller_start_ticks')
        except FileNotFoundError:
            alive = False
        elapsed = now - record['created_at']
        quota = record['quota']
        expired = elapsed < 0 or elapsed >= quota['lifetime_seconds']
        if record['state'] == 'STARTING':
            expired |= elapsed >= quota['startup_seconds']
        elif record['state'] == 'PREVIEW_READY':
            expired |= now - record['last_activity_at'] >= quota['idle_seconds']
        if alive and not expired and record['state'] not in ['STOPPED', 'CANCELLED', 'DESTROYED', 'FAILED']:
            return
        record['state'] = 'STOPPED'; atomic(path, record)
        label = 'deplai.preview=' + record['preview_id']
        for container in docker('ps', '-aq', '--filter', 'label=' + label).splitlines():
            inspected = json.loads(docker('inspect', container))[0]
            if inspected['Config']['Labels'].get('deplai.preview') == record['preview_id']:
                docker('rm', '-f', inspected['Id'])
        for volume in docker('volume', 'ls', '-q', '--filter', 'label=' + label).splitlines():
            inspected = json.loads(docker('volume', 'inspect', volume))[0]
            if inspected.get('Labels', {}).get('deplai.preview') == record['preview_id']:
                docker('volume', 'rm', volume)
        record.update(state='DESTROYED', cleanup='COMPLETED'); atomic(path, record)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, required=True)
    reap(parser.parse_args().root)
