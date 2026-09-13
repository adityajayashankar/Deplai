# UI/UX repository editor

The default `/dashboard/customization` workspace provides repository selection, a searchable file tree on the left, source and diff views, a prompt and optional file scope, progress, cancellation, recovery, patch download, and draft PR creation. The old AgentOS transport returns 410; it cannot submit work to the new service.

## Execution

1. Connector authenticates the user, checks project and organization permissions, and indexes a fixed GitHub commit or the user's uploaded ZIP project. There is no total repository byte or file-count cap and no archive download. Truncated GitHub recursive listings fall back to subtree traversal. File content is loaded on demand; recognizable secrets and unsafe paths remain filtered.
2. A task starts with a small presentation context. The worker can discover every indexed file through paginated `list_files`, then request additional files as needed through the fixed service-authenticated Connector callback. Connector records the trusted original before returning each file. Individual editing windows remain 128 KiB, and model-call/token/time budgets remain bounded; these are task limits, not repository eligibility limits. The worker never receives GitHub credentials or access to the original repository.
3. A bounded planner, tool-driven editor, and independent read-only reviewer share request, token, and time limits. Product inference uses Connector's authenticated `/api/ai/chat` gateway and its platform `openrouter/free` route (200K context), quota scheduling, and zero-price provider ceiling. Missing gateway configuration blocks a product run instead of switching to a worker provider key. No paid fallback or user key is accepted. CSS/SCSS-only edits treat process-only reviewer complaints as advisory after local guards; invalid review contracts and concrete conflicts remain blocked. This is a custom bounded graph, not an installation of the Deep Agents SDK.
4. Connector compares returned baselines with the saved source and applies its TypeScript AST presentation policy. Logic, hooks, handlers, routes, dynamic expressions, component contracts, and interactive order are protected. Ambiguous proposals are blocked from publication.
5. After the user reviews a completed diff, PR creation verifies the baseline again against Git blob hashes. It creates one commit on `deplai/uiux-<run_id>` with the original parent and unchanged base tree. Existing branches must match the expected tree; retries recover the existing PR. A changed base branch requires a new task. Uploaded ZIP projects download a patch instead.

## Configuration

Connector needs `UIUX_AGENT_BASE_URL` (defaults to `http://127.0.0.1:7777`), `DEPLAI_SERVICE_KEY`, and the platform `OPENROUTER_API_KEY`. The worker needs the matching service key and a reachable `UIUX_CONNECTOR_URL`; it does not require a provider key for product inference. Connector AI policies and customization plan access still apply; restricted model allowlists are currently rejected explicitly. Worker health reports local gateway configuration, not upstream availability.

Runs permit 80 worker requests, 64 editor steps per attempt, eight million aggregate estimated tokens, and one hour overall. These are safety ceilings, not promised model capacity. Gateway retries also consume its shared account quota. Missing or all-zero provider usage retains the worker's reservation. Independent review feedback can return saved drafts to the editor for up to two correction attempts within the same request and time limits.

Long tool histories compact only older source reads, preserving the path, offset, source hash, partial excerpts, tool IDs, edit confirmations, errors, and assistant messages. Compacted source is explicitly historical and must be read again before exact edits. Recent reads remain complete. Drafts survive failed validation without becoming approved changes. Reviewer approval requires a boolean and lists of conflict/warning strings; malformed responses cannot approve publication.

Root development and production Compose files wire the private worker and durable volumes. Standalone development can run `docker compose --env-file ../Connector/.env.local up -d --build` from `uiux-agent`, or install `requirements-runtime.txt` and run `python -m uvicorn service.deep_agent_app:app --host 127.0.0.1 --port 7777 --workers 1` with these variables in the process environment. Use one worker and one replica.

Workspace memory lives in browser IndexedDB, keyed by authenticated user and project: drafts, selected file, latest run, and run history. Completed history restores locally; active runs reconcile with the worker. The UI provides clear-memory and storage-quota error handling. Browser storage is device/origin-specific and can be cleared by the browser or user.

`UIUX_CONNECTOR_STATE_DIR` defaults to Connector's `tmp/uiux-state`; `UIUX_RUN_DIRECTORY` controls worker storage. These hold operational manifests, execution records, and trusted file baselines required for active work and PR verification, not the browser's workspace history. They still need private persistent storage and an operator retention policy. Worker restarts mark interrupted runs failed.

For a native local Connector with a Docker worker, start only the worker from the repository root with `docker compose --env-file Connector/.env.local -f compose.yaml up -d --build --no-deps uiux-agent`. This supplies the same service key and platform OpenRouter key as Connector. `UIUX_CONNECTOR_URL` must reach Connector from the worker (local Docker default `http://host.docker.internal:3000`, production `http://connector:3000`). A fully containerized local Connector can set `UIUX_CONNECTOR_URL=http://connector:3000`. Worker authentication failures are reported as service-configuration errors rather than a misleading user-login failure.

## Conflicts and limitations

- Free provider capacity, quality, and quotas change. Rate-limit cooldowns and retries are bounded; they cannot remove shared account quotas. Other platform agents sharing the key also consume quota.
- The automatic editing surface is existing React JSX/TSX and plain CSS. Vue, Svelte, server code, new components, dependency changes, and broad behavior refactors need a separate workflow. Existing CSS imports remain fixed.
- AST checks preserve code structure, not every observable behavior. CSS, wording, and layout can affect accessibility, usability, or business meaning; draft PR review remains necessary.
- Repository text is untrusted model input. Restricted tools and authoritative server validation contain edit permissions, but misleading source comments can still reduce output quality.
- Source is transmitted to OpenRouter providers. Secret detection is conservative and cannot identify every embedded credential; avoid committing credentials to source.
- Build commands and dependency scripts are not executed. Live preview is intentionally omitted; generated PRs state that application builds and visual checks have not run.
- In-process concurrency and quota limits require one replica. Multiple workers need a shared queue, distributed quota coordination, and shared storage before scaling.
- GitHub App installation access needs contents and pull-request write permission. Revoked access, branch drift, a conflicting proposal branch, or lost storage can block publication with an actionable error.

Focused verification: `npx tsx --test src/lib/uiux/*.test.ts` in Connector, and `python -m pytest test_deep_agent_runtime.py -q` in uiux-agent. Tests mock provider and GitHub writes.
