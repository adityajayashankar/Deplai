# Phase 5.5: local gVisor boundary proof

All 24 mandatory synthetic checks passed on 2026-09-21 in local Ubuntu WSL2.
This is a local isolation result, not a production deployment or a full-stack
application acceptance result.

## Installed and verified

- Ubuntu 26.04, WSL2 Linux 6.6.87.2, cgroup v2.
- Docker 29.1.3 and gVisor runsc release-20260914.0, systrap platform.
- Playwright 1.63.0 with Chromium and an independent TLS handshake check.
- External systemd garbage-collection timer and an in-process host watchdog.

Run: `505e39a3158a4493bac837739ab6bcc8`.
Private report: `/var/lib/deplai-preview-proof/505e39a3158a4493bac837739ab6bcc8.proof.json`.
Harness SHA256: `a42ccb14b41554f964ad57d9d3a9212865d5ed2aa7a2938760175b123a319721`.

Python image: `python@sha256:2f17fc044b579bab302c2e8054d3a686e2cb9a83de48e70534b94cd8ebbe06a9`.
Gateway image: `nginx@sha256:ef8676b33d681f272ba429b27658bdd7e640963279714c96bddf1dc76307f7b6`.

## Observed checks

gVisor marker, HTTP, TLS, path routing, secure cookie round-trip, CSRF rejection,
WebSocket, SSE, synthetic hot reload, request-body limits, direct worktree edit
visibility, blocked host/metadata/private/sibling access, controlled registry egress,
CPU/memory/PID/disk limits, healthy neighbor, idle expiry, hard expiry and orphan cleanup.

CPU usage was measured from the host cgroup, not the virtual process clock:
0.485 CPU against `cpu.max = 50000 100000`. PID exhaustion incremented the host
PID-limit counter, terminated the sandbox with exit 2, and recorded no OOM kill.
The test does not mislabel an unrelated crash as PID enforcement. Normal fixtures
use 128 host PIDs; the PID abuse fixture uses 48 PIDs and 512 MiB to distinguish
process enforcement from memory exhaustion. Cleanup completed with no proof
containers remaining.

Focused policy tests: 5 passed. Connector Build tests: 68 passed, 1 live-MySQL
test skipped. Revision binding in this report is a synthetic fixture; it does not
replace live Connector/MySQL ownership and restart validation.

## Remaining boundaries

Real framework reload, dependency installation, application CRUD against Postgres,
runtime secret resolution, authenticated product provisioning and production
ingress remain Phase 6 work. The GET-only proof egress broker is not a package
manager proxy. Any additional runtime network path needs its own isolation tests.
The current production EC2 host was not modified. WSL systemd services run while
the local WSL instance is running; this is not an always-on production host.
