# Synthetic gVisor boundary proof

This harness implements the Phase 5.5 proof matrix using fixed synthetic services.
It does not launch imported application code or unlock production Build previews.
The runner fails if any mandatory check is missing, unproven or unsuccessful.

## Host setup

Use a dedicated Ubuntu/Debian Linux test host with systemd, cgroup v2 and Docker
access. WSL2 can be used to exercise the gVisor runtime locally; a local result
does not establish EC2 host equivalence or public production TLS/DNS readiness.

From the repository on that host, run:

```bash
sudo bash deploy/preview-proof/setup-gvisor-host.sh
cd deploy/preview-proof
npm ci
npx playwright install --with-deps chromium
```

The installer uses the signed official gVisor apt repository and configures a
`runsc` Docker runtime. It preserves other daemon settings and backs up an existing
daemon configuration before changing it. It does not set gVisor as Docker's global
default. The harness always requests it explicitly. Source:
[gVisor installation](https://gvisor.dev/docs/user_guide/install/).

The dedicated runtime enables `host-uds=all` for the narrowly mounted per-preview
Unix socket channel and `file-access-mounts=shared` so host worktree edits remain visible.
Do not mount Docker sockets, host service sockets or arbitrary host paths into
this runtime. These flags need the live cross-container socket/file tests; their
presence alone is not proof. See [gVisor filesystem](https://gvisor.dev/docs/user_guide/filesystem/)
and [runtime configuration](https://github.com/google/gvisor/blob/master/runsc/config/config.go).

## Run

Pull reviewed Python 3.12+ and nginx images on the host, resolve their RepoDigests,
and supply those immutable digests to the runner. It will not implicitly pull a tag.
Use a private root owned by the account running the test. For example, the installer
creates `/var/lib/deplai-preview-proof` for root; run the harness as root when using
that directory, or provision a separate 0700 directory for the test account.

```bash
python3 deploy/preview-proof/run_proof.py \
  --root /var/lib/deplai-preview-proof \
  --python-image "$PROOF_PYTHON_IMAGE" \
  --proxy-image "$PROOF_PROXY_IMAGE"
```

Only the gateway binds host ports, on loopback with dynamically assigned ports.
The browser uses an ephemeral test certificate; the runner independently verifies
its TLS handshake/hostname. It is not a production certificate test.

Before leaving any proof resources running, configure a one-minute external timer
under the same account to run:

```bash
python3 /absolute/repository/deploy/preview-proof/run_proof.py \
  --root /var/lib/deplai-preview-proof --gc
```

The runner also has an external-to-sandbox watchdog. The timer recovers an interrupted
controller after its process lock is released. Cleanup rechecks exact ownership
labels before removal, persists STOPPED before destroy, and removes scoped orphan
containers/channels/worktrees. It never removes unrelated Docker resources.

## What is tested

- Canonical Git repository, independent main/task worktrees and direct task mount.
- Actual browser HTTP/TLS, path routing, Secure/HttpOnly/SameSite cookie round-trip,
  origin/CSRF rejection, 1 MiB bodies, rejection above 2 MiB, WS, SSE and synthetic HMR.
- Task edits appear through the gateway and HMR socket without source copying;
  the main worktree remains unchanged. Final task content is committed and recorded.
- Candidate application network is `none`: host, metadata, private subnet and live
  sibling-sentinel probes must be blocked. Raw application ports are never published.
- Optional per-preview Unix-socket HTTPS GET broker checks an operator allowlist,
  all DNS addresses, IP-pinned TLS and size/time bounds; redirects, credentials,
  CONNECT, unapproved hosts and private targets are refused. The proof permits only
  the npm registry ping. It is not yet a package-manager-compatible proxy.
- CPU, memory, PIDs and tmpfs disk exhaustion fixtures run only inside gVisor.
  An independent neighbor worktree/channel must remain healthy.
- Idle/hard TTL, STOPPED/destroy lifecycle and orphan cleanup.

Read-only source/root and bounded tmpfs separate source identity from runtime noise.
The synthetic disk quota covers `/tmp`, `/runtime` and the socket volume; imported
dependency caches, uploads and host checkout disk quotas require the full preview
provider's own mount allocation. Docker controls:
[resource constraints](https://docs.docker.com/engine/containers/resource_constraints/).

## Evidence and limits

The private root receives a structured proof report, registry and ordered event
journal with run ID, harness fingerprint, image digests, timestamps, stage durations,
failure stage, resource outcomes and GC events. On failure, bounded diagnostics from
the fixed synthetic fixtures and nginx startup are saved privately; imported source,
request bodies and credentials are never logged. `passed` is computed from every mandatory observed check, never supplied
by a model. Reports are internal operator artifacts, not browser-issued capabilities.

The BuildSession binding in the synthetic report is a fixture. The actual Connector
binding method is separately unit-tested; live MySQL integration remains a separate
gate. Synthetic HMR proves the transport/file boundary, not Next/Vite reload behavior.
Live application CRUD, actual framework reload, production ingress authorization
and complete sandbox provisioning are Phase 6 requirements.

Local policy tests (no containers or abusive processes run):

```bash
python3 -m unittest discover -s deploy/preview-proof -p 'test_*.py' -v
```
