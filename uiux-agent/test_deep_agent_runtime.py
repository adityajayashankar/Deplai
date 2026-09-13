"""Focused boundary and lifecycle checks; no live model calls or repo execution."""
import asyncio
import json

import httpx
import pytest
from fastapi.testclient import TestClient
from service import deep_agent_app as runtime


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(runtime, "ROOT", tmp_path)
    monkeypatch.setenv("DEPLAI_SERVICE_KEY", "test-service-key")
    monkeypatch.setenv("OPENROUTER_API_KEY", "platform-test-key")
    monkeypatch.setenv("UIUX_CONNECTOR_URL", "http://connector:3000")
    runtime.ACTIVE.clear()
    with TestClient(runtime.app) as client:
        client.headers["X-API-Key"] = "test-service-key"
        yield client


def payload():
    return {"project_id": "project", "user_id": "owner", "source_sha": "a" * 40,
            "prompt": "Make the text blue", "files": [{"path": "src/app/page.tsx", "content": '<div className="red">Hello</div>'}]}


def record():
    return {"run_id": "b" * 32, "events": [], "usage": {"requests": 0, "budget_tokens": 0,
            "input_tokens": 0, "output_tokens": 0, "models": []}}


@pytest.mark.parametrize("path", ["../a.tsx", "/a.css", "C:/a.css", "a\\b.css", ".env", "a/./b.css", "a//b.css", "src/api/a.tsx", "src/hooks/useData.tsx", "package.json"])
def test_rejects_unsafe_and_business_paths(path):
    assert not runtime.presentation_path(path)


def test_free_catalog_prefers_openrouter_free_router(monkeypatch):
    monkeypatch.delenv("UIUX_OPENROUTER_MODEL", raising=False)
    valid = {"id": "vendor/code:free", "pricing": {"prompt": "0", "completion": "0"}, "supported_parameters": ["tools"]}
    router = {"id": "openrouter/free", "pricing": {"prompt": "0", "completion": "0"}, "context_length": 200000}
    assert runtime.free_candidates([valid, {**valid, "id": "vendor/paid"},
                                    {**valid, "pricing": {"prompt": "1", "completion": "0"}},
                                    {**valid, "supported_parameters": []}, router])[0] == "openrouter/free"
    with pytest.raises(RuntimeError, match="verified free"):
        runtime.free_candidates([valid])
    monkeypatch.setenv("UIUX_OPENROUTER_MODEL", "vendor/paid")
    with pytest.raises(RuntimeError, match="verified free"):
        runtime.free_candidates([valid])
    monkeypatch.setenv("UIUX_OPENROUTER_MODEL", "vendor/code:free")
    assert runtime.free_candidates([valid]) == [valid["id"]]


def test_scope_and_user_keys_rejected(client):
    data = payload()
    data["scope"] = ["src/other.tsx"]
    assert client.post("/uiux/runs", json=data).status_code == 422
    data = payload()
    data["api_key"] = "user-key"
    assert client.post("/uiux/runs", json=data).status_code == 422
    assert client.get("/uiux/health", headers={"X-API-Key": "wrong"}).status_code == 401


def test_shared_budget_counts_attempts():
    run = record()
    budget = runtime.Budget(run)
    for _ in range(runtime.MAX_CALLS):
        budget.reserve([], 1)
    with pytest.raises(RuntimeError, match="budget"):
        budget.reserve([], 1)
    assert run["usage"]["requests"] == runtime.MAX_CALLS


def test_context_window_is_separate_from_actual_aggregate_usage():
    run = record()
    budget = runtime.Budget(run)
    messages = [{"role": "user", "content": ".card { background: black; }\n" * 2000}]
    for _ in range(7):
        reserved = budget.reserve(messages, 3000)
        budget.reconcile(reserved, {"prompt_tokens": 1700, "completion_tokens": 200})
    assert run["usage"]["budget_tokens"] == 13300
    assert run["usage"]["requests"] == 7
    with pytest.raises(RuntimeError, match="200K model context"):
        budget.reserve([{"role": "user", "content": "x" * 610000}], 1000)


def test_missing_usage_retains_estimate_instead_of_bypassing_budget():
    run = record()
    budget = runtime.Budget(run)
    reserved = budget.reserve([{"role": "user", "content": "hello"}], 2000)
    budget.reconcile(reserved, {})
    assert run["usage"]["budget_tokens"] == reserved


def test_retry_delay_honors_reset_and_retry_after():
    assert runtime.retry_delay({"retry-after": "90"}, 0) >= 90
    assert runtime.retry_delay({"x-ratelimit-reset": str(runtime.time.time() + 120)}, 0) > 119


def test_edit_rejects_behavior_change():
    before = '<button onClick={save} className="red">Save</button>'
    runtime.guarded_edit("src/Button.tsx", before, before.replace("red", "blue"))
    with pytest.raises(ValueError, match="business"):
        runtime.guarded_edit("src/Button.tsx", before, before.replace("{save}", "{erase}"))


def test_cancel_and_owner_isolation(client, monkeypatch):
    async def waiting(run, request):
        await asyncio.sleep(60)
    monkeypatch.setattr(runtime, "execute_graph", waiting)
    response = client.post("/uiux/runs", json=payload())
    assert response.status_code == 202
    run_id = response.json()["run_id"]
    assert client.get(f"/uiux/runs/{run_id}?user_id=other&project_id=project").status_code == 404
    assert client.post("/uiux/runs", json=payload()).status_code == 409
    cancelled = client.delete(f"/uiux/runs/{run_id}?user_id=owner&project_id=project")
    assert cancelled.json()["status"] == "cancelled"
    assert cancelled.json()["changes"] == []


def test_request_id_replay_requires_identical_payload_and_owner(client, monkeypatch):
    async def waiting(run, request):
        await asyncio.sleep(60)
    monkeypatch.setattr(runtime, "execute_graph", waiting)
    data = {**payload(), "request_id": "12345678-1234-4234-8234-123456789abc"}
    first = client.post("/uiux/runs", json=data)
    replay = client.post("/uiux/runs", json=data)
    assert first.status_code == replay.status_code == 202
    assert first.json()["run_id"] == replay.json()["run_id"] == "12345678123442348234123456789abc"
    assert client.post("/uiux/runs", json={**data, "prompt": "Different edit"}).status_code == 409
    assert client.post("/uiux/runs", json={**data, "user_id": "other"}).status_code == 404


def test_service_auth_trims_environment_whitespace(client, monkeypatch):
    monkeypatch.setenv("DEPLAI_SERVICE_KEY", "  test-service-key \n")
    assert client.get("/uiux/health").status_code == 200
    assert client.get("/uiux/health", headers={"X-API-Key": "different"}).status_code == 401


def test_repository_callback_uses_fixed_url_and_service_key_only(client, monkeypatch):
    monkeypatch.setenv("UIUX_CONNECTOR_URL", "http://trusted-connector:3000")
    async def handler(request):
        assert str(request.url) == "http://trusted-connector:3000/api/uiux/source"
        assert request.headers["X-API-Key"] == "test-service-key"
        assert "Authorization" not in request.headers
        body = json.loads(request.content)
        assert body == {"run_id": "a" * 32, "user_id": "owner", "project_id": "project", "operation": "list", "query": "Card", "offset": 0}
        return httpx.Response(200, json={"files": [{"path": "src/Card.tsx", "size": 100, "editable": True}], "next_offset": None})
    async def perform():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as transport:
            return await runtime.repository_source(transport, {"run_id": "a" * 32, "user_id": "owner", "project_id": "project"}, "list", query="Card", offset=0)
    assert asyncio.run(perform())["files"][0]["path"] == "src/Card.tsx"
    data = {**payload(), "repository_access": True, "files": [], "scope": ["src/Card.tsx"]}
    assert runtime.RunInput(**data).repository_access
    with pytest.raises(ValueError):
        runtime.RunInput(**{**data, "connector_url": "https://attacker.example"})


def test_graph_dynamically_discovers_and_edits_unseeded_file(client, monkeypatch):
    def call(name, args):
        return {"tool_calls": [{"id": name, "function": {"name": name, "arguments": json.dumps(args)}}]}
    outputs = iter([
        {"content": "Discover a card component and adjust color"},
        call("list_files", {"query": "Card"}),
        call("read_file", {"path": "src/Card.tsx"}),
        call("edit_file", {"path": "src/Card.tsx", "old": 'className="red"', "new": 'className="blue"'}),
        call("finish", {"summary": "Updated card color"}),
        {"content": '{"approved":true,"conflicts":[],"warnings":[]}'},
    ])
    async def complete(client, budget, messages, tools=None, output_limit=3000):
        return next(outputs)
    async def source(client, run, operation, **arguments):
        if operation == "list":
            return {"files": [{"path": "src/Card.tsx", "editable": True}], "next_offset": None}
        return {"path": "src/Card.tsx", "content": '<div className="red">Card</div>', "editable": True}
    monkeypatch.setattr(runtime, "completion", complete)
    monkeypatch.setattr(runtime, "repository_source", source)
    request = runtime.RunInput(**{**payload(), "repository_access": True, "files": []})
    run = {**record(), "status": "queued", "warnings": [], "conflicts": [], "changes": []}
    runtime.persist(run)
    asyncio.run(runtime.run_job(run, request))
    assert run["status"] == "completed"
    assert run["changes"][0]["path"] == "src/Card.tsx"


@pytest.mark.parametrize('review', [
    {'approved': True, 'conflicts': [], 'warnings': []},
    {'approved': 'false', 'conflicts': [], 'warnings': []},
    {'approved': True, 'conflicts': 'hidden conflict', 'warnings': []},
])
def test_graph_with_mock_planner_editor_reviewer(client, monkeypatch, review):
    outputs = iter([
        {"content": "Inspect component and adjust color"},
        {"tool_calls": [{"id": "read", "function": {"name": "read_file", "arguments": json.dumps({"path": "src/app/page.tsx"})}}]},
        {"tool_calls": [{"id": "edit", "function": {"name": "edit_file", "arguments": json.dumps({"path": "src/app/page.tsx", "old": 'className="red"', "new": 'className="blue"'})}}]},
        {"tool_calls": [{"id": "done", "function": {"name": "finish", "arguments": json.dumps({"summary": "Updated text color"})}}]},
        {"content": json.dumps(review)},
    ])
    async def complete(client, budget, messages, tools=None, output_limit=3000):
        return next(outputs)
    monkeypatch.setattr(runtime, "completion", complete)
    request = runtime.RunInput(**payload())
    run = {**record(), "status": "queued", "warnings": [], "conflicts": [], "changes": []}
    runtime.persist(run)
    asyncio.run(runtime.run_job(run, request))
    if type(review['approved']) is not bool or not isinstance(review['conflicts'], list):
        assert run['status'] == 'failed'
        assert run['changes'] == []
        assert run['draft_changes']
        assert 'invalid contract' in run['error']
        return
    assert run["status"] == "completed"
    assert len(run["changes"]) == 1
    assert 'className="blue"' in run["changes"][0]["after"]
    assert run["events"][-1]["type"] == "completed"


def test_css_only_reviewer_rejection_is_advisory(client, monkeypatch):
    data = payload()
    data["files"] = [{"path": "styles.css", "content": ".card { background: rgba(255, 255, 255, 0.86); }"}]
    outputs = iter([
        {"content": "Change one card background to black"},
        {"tool_calls": [{"id": "read", "function": {"name": "read_file", "arguments": json.dumps({"path": "styles.css"})}}]},
        {"tool_calls": [{"id": "edit", "function": {"name": "edit_file", "arguments": json.dumps({"path": "styles.css", "old": "rgba(255, 255, 255, 0.86)", "new": "black"})}}]},
        {"tool_calls": [{"id": "done", "function": {"name": "finish", "arguments": json.dumps({"summary": "Made one card black"})}}]},
        {"content": '{"approved":false,"conflicts":["Repository not yet read"],"warnings":[]}'},
    ])
    async def complete(client, budget, messages, tools=None, output_limit=3000):
        return next(outputs)
    monkeypatch.setattr(runtime, "completion", complete)
    request = runtime.RunInput(**data)
    run = {**record(), "status": "queued", "warnings": [], "conflicts": [], "changes": []}
    runtime.persist(run)
    asyncio.run(runtime.run_job(run, request))
    assert run["status"] == "completed"
    assert run["conflicts"] == []
    assert "background: black" in run["changes"][0]["after"]


@pytest.mark.parametrize("approved", [True, False])
def test_step_exhaustion_reviews_existing_edits_without_bypassing_reviewer(client, monkeypatch, approved):
    monkeypatch.setattr(runtime, "MAX_STEPS", 12)
    outputs = iter([
        {"content": "Update styling"},
        {"tool_calls": [{"id": "read", "function": {"name": "read_file", "arguments": json.dumps({"path": "src/app/page.tsx"})}}]},
        {"tool_calls": [{"id": "edit", "function": {"name": "edit_file", "arguments": json.dumps({"path": "src/app/page.tsx", "old": 'className="red"', "new": 'className="blue"'})}}]},
        *[{"content": "Still thinking"} for _ in range(10)],
        {"content": json.dumps({"approved": approved, "conflicts": [] if approved else ["The requested scope was not preserved"], "warnings": []})},
    ])
    async def complete(client, budget, messages, tools=None, output_limit=3000):
        return next(outputs)
    monkeypatch.setattr(runtime, "completion", complete)
    run = {**record(), "status": "queued", "warnings": [], "conflicts": [], "changes": []}
    runtime.persist(run)
    asyncio.run(runtime.run_job(run, runtime.RunInput(**payload())))
    assert any(item["type"] == "handoff" for item in run["events"])
    assert run["status"] == ("completed" if approved else "failed")
    assert bool(run["changes"]) is approved


def test_failure_is_terminal_and_sanitized(client, monkeypatch):
    async def fail(run, request):
        raise ValueError("secret source and key")
    monkeypatch.setattr(runtime, "execute_graph", fail)
    run = {**record(), "status": "queued", "changes": [{"path": "bad"}]}
    asyncio.run(runtime.run_job(run, runtime.RunInput(**payload())))
    assert run["status"] == "failed"
    assert run["changes"] == []
    assert "secret" not in run["error"]


def test_failed_review_preserves_unapproved_draft(client, monkeypatch):
    draft = {"path": "app.css", "before": "a{color:red}", "after": "a{color:blue}"}
    async def fail(run, request):
        run["draft_changes"] = [draft]
        raise RuntimeError("Model capacity unavailable")
    monkeypatch.setattr(runtime, "execute_graph", fail)
    run = {**record(), "status": "queued", "changes": []}
    asyncio.run(runtime.run_job(run, runtime.RunInput(**payload())))
    assert run["status"] == "failed"
    assert run["changes"] == []
    assert run["draft_changes"] == [draft]
    assert run["validation_status"] == "pending"


def test_review_feedback_repairs_saved_draft_against_original_baseline(client, monkeypatch):
    def call(name, **args):
        return {'tool_calls': [{'id': name, 'function': {'name': name, 'arguments': json.dumps(args)}}]}
    outputs = iter([
        {'content': 'Change color'}, call('read_file', path='src/app/page.tsx'),
        call('edit_file', path='src/app/page.tsx', old='red', new='blue'), call('finish', summary='Blue'),
        {'content': '{"approved":false,"conflicts":["Use green instead"],"warnings":[]}'},
        {'content': 'Correct color from saved draft'}, call('read_file', path='src/app/page.tsx'),
        call('edit_file', path='src/app/page.tsx', old='blue', new='green'), call('finish', summary='Green'),
        {'content': '{"approved":true,"conflicts":[],"warnings":[]}'},
    ])
    prompts = []
    async def complete(client, budget, messages, tools=None, output_limit=3000):
        prompts.append(json.dumps(messages))
        return next(outputs)
    monkeypatch.setattr(runtime, 'completion', complete)
    run = {**record(), 'status': 'queued', 'warnings': [], 'conflicts': [], 'changes': []}
    runtime.persist(run)
    asyncio.run(runtime.run_job(run, runtime.RunInput(**payload())))
    assert run['status'] == 'completed'
    assert run['changes'][0]['before'] == payload()['files'][0]['content']
    assert 'className="green"' in run['changes'][0]['after']
    assert 'Use green instead' in prompts[5]
    assert any(event['type'] == 'repairing' for event in run['events'])


def test_compaction_preserves_tool_pairing_and_recent_content():
    messages = [{"role": "system", "content": "scope"}, {"role": "user", "content": "task"}]
    for i in range(40):
        messages += [{"role": "assistant", "tool_calls": [{"id": str(i), "function": {
            "name": "read_file", "arguments": json.dumps({"path": f"src/file{i}.tsx", "offset": 12000})}}]},
                     {"role": "tool", "tool_call_id": str(i), "content": "x" * 12000}]
    runtime.compact_tool_history(messages)
    assert 'compacted' in messages[3]['content']
    assert messages[-1]['content'] == 'x' * 12000
    assert messages[2]['tool_calls'][0]['id'] == messages[3]['tool_call_id']
    summary = json.loads(messages[3]['content'])
    assert summary['path'] == 'src/file0.tsx'
    assert summary['offset'] == 12000
    assert summary['characters'] == 12000
    assert len(summary['sha256']) == 64


def test_compaction_keeps_edit_results_and_rejections():
    messages = [{'role': 'system', 'content': 'scope'}, {'role': 'user', 'content': 'task'}]
    for index, name in enumerate(['edit_file', 'read_file'] * 20):
        content = ('Edit confirmed: ' if name == 'edit_file' else 'Tool rejected: ') + 'x' * 12000
        messages.extend([{'role': 'assistant', 'tool_calls': [{'id': str(index), 'function': {
            'name': name, 'arguments': '{"path":"app.tsx"}'}}]},
            {'role': 'tool', 'tool_call_id': str(index), 'content': content}])
    before = json.dumps(messages)
    runtime.compact_tool_history(messages)
    assert json.dumps(messages) == before


@pytest.mark.parametrize('reported', [{}, {'prompt_tokens': 0, 'completion_tokens': 0},
                                     {'prompt_tokens': 10}])
def test_unknown_usage_retains_reserved_budget(reported):
    run = record()
    budget = runtime.Budget(run)
    reserved = budget.reserve([{'role': 'user', 'content': 'Inspect the source'}], 1000)
    budget.reconcile(reserved, reported)
    assert run['usage']['budget_tokens'] == reserved


def test_product_inference_uses_shared_gateway_and_preserves_tool_ids(client, monkeypatch):
    monkeypatch.setenv('UIUX_CONNECTOR_URL', 'http://connector:3000')
    run = {**record(), 'user_id': 'owner', 'organization_id': 'org'}
    messages = [{'role': 'assistant', 'content': '', 'tool_calls': [
        {'id': 'call-one', 'function': {'name': 'read_file', 'arguments': '{}'}}]},
        {'role': 'tool', 'tool_call_id': 'call-one', 'content': 'source'}]
    async def handler(request):
        assert str(request.url) == 'http://connector:3000/api/ai/chat'
        body = json.loads(request.content)
        assert body['metadata']['product'] == 'uiux'
        assert body['messages'][0]['toolCalls'][0]['id'] == 'call-one'
        assert body['messages'][1]['toolCallId'] == 'call-one'
        assert request.headers['x-deplai-organization-id'] == 'org'
        return httpx.Response(200, json={'output': '', 'toolCalls': [
            {'id': 'call-two', 'name': 'finish', 'arguments': '{}'}],
            'usage': {'inputTokens': 12, 'outputTokens': 3}})
    async def perform():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as transport:
            return await runtime.completion(transport, runtime.Budget(run), messages)
    result = asyncio.run(perform())
    assert result['tool_calls'][0]['id'] == 'call-two'
    assert run['usage']['input_tokens'] == 12


def test_rate_retry_uses_openrouter_free_router(client, monkeypatch):
    # Exercise the isolated adapter helper, never the product inference path.
    monkeypatch.delenv('UIUX_CONNECTOR_URL', raising=False)
    run = record()
    runtime.persist(run)
    runtime.COOLDOWNS.clear()
    monkeypatch.setattr(runtime, "CATALOG", (0, []))
    monkeypatch.setattr(runtime, "LAST_CALL", 0)
    monkeypatch.delenv("UIUX_OPENROUTER_MODEL", raising=False)
    sent = []
    async def no_wait(seconds):
        runtime.COOLDOWNS.clear()
    monkeypatch.setattr(runtime.asyncio, "sleep", no_wait)
    async def handler(request):
        if request.url.path.endswith("/models"):
            return httpx.Response(200, json={"data": [
                {"id": "openrouter/free", "pricing": {"prompt": "0", "completion": "0"}, "context_length": 200000},
                {"id": "vendor/a:free", "pricing": {"prompt": "0", "completion": "0"}, "supported_parameters": ["tools"]},
            ]})
        assert request.headers["Authorization"] == "Bearer platform-test-key"
        data = json.loads(request.content)
        assert data["model"] == "openrouter/free"
        assert data["provider"]["max_price"] == {"prompt": 0, "completion": 0}
        sent.append(data["model"])
        if len(sent) == 1:
            return httpx.Response(429, headers={"Retry-After": "2"})
        return httpx.Response(200, json={"choices": [{"message": {"content": "done"}}], "usage": {"cost": 0}})
    async def perform():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as transport:
            return await runtime.completion(transport, runtime.Budget(run), [{"role": "user", "content": "edit"}])
    assert asyncio.run(perform())["content"] == "done"
    assert sent[0] == "openrouter/free"
    assert len(sent) == 2
    assert run["usage"]["requests"] == 2


def test_product_requires_gateway_but_no_worker_provider_key(client, monkeypatch):
    monkeypatch.delenv('OPENROUTER_API_KEY', raising=False)
    assert client.get('/uiux/health').json()['configured'] is True
    monkeypatch.delenv('UIUX_CONNECTOR_URL', raising=False)
    assert client.get('/uiux/health').json()['configured'] is False
    assert client.post('/uiux/runs', json=payload()).status_code == 503


def test_request_id_replay_checks_inputs_and_owner(client, monkeypatch):
    async def hold(run, request):
        await asyncio.sleep(3600)
    monkeypatch.setattr(runtime, "run_job", hold)
    data = {**payload(), "request_id": "a" * 32}
    assert client.post("/uiux/runs", json=data).json()["run_id"] == "a" * 32
    assert client.post("/uiux/runs", json=data).status_code == 202
    assert client.post("/uiux/runs", json={**data, "prompt": "Different edit"}).status_code == 409
    assert client.post("/uiux/runs", json={**data, "user_id": "other"}).status_code == 404


def test_concurrent_owners_keep_distinct_run_identifiers(client, monkeypatch):
    async def hold(run, request):
        await asyncio.sleep(3600)
    monkeypatch.setattr(runtime, "run_job", hold)
    first = {**payload(), "request_id": "a" * 32}
    second = {**payload(), "request_id": "b" * 32, "user_id": "second"}
    assert client.post("/uiux/runs", json=first).json()["run_id"] == "a" * 32
    assert client.post("/uiux/runs", json=second).json()["run_id"] == "b" * 32
    assert runtime.owned("a" * 32, "owner", "project")["user_id"] == "owner"
    assert runtime.owned("b" * 32, "second", "project")["user_id"] == "second"
