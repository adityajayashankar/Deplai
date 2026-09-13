"""Durable, redacted remediation run state and optional LangGraph checkpoints.

MongoDB is optional for local development.  When configured, this module stores
run metadata and progress events so a browser WebSocket reconnect can recover
the real server-side status.  Full LangGraph checkpoints are intentionally an
explicit opt-in because they contain source snippets.  Direct BYOK secrets are
never checkpointed.
"""

from __future__ import annotations

import contextvars
import json
import logging
import os
import re
import threading
from copy import deepcopy
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4


logger = logging.getLogger(__name__)

_current_run_id: contextvars.ContextVar[str] = contextvars.ContextVar(
    "deplai_remediation_run_id", default=""
)
_TOKEN_PATTERN = re.compile(
    r"(?i)(?:"
    r"(?:sk|gsk|or-v1|AIza|xai)-?[a-z0-9_-]{8,}"
    r"|bearer\s+[a-z0-9._-]+"
    r"|(?:api[_-]?key|authorization|token|secret)\s*[=:]\s*[^\s,;]+"
    r")"
)
_MONGO_AUTH_PATTERN = re.compile(r"(?i)(mongodb(?:\+srv)?://[^:/\s]+:)[^@\s]+(@)")
_CREDENTIAL_ASSIGNMENT_PATTERN = re.compile(
    r"(?i)(\b(?:password|passwd|api[_-]?key|secret|token)\b\s*[:=]\s*[\"']?)[^\s,;\"']+"
)
_MAX_EVENT_CONTENT = 2_000


def bind_remediation_run(run_id: str | None) -> None:
    """Bind a run id to the current task without carrying provider secrets."""
    _current_run_id.set(str(run_id or "").strip())


def current_remediation_run_id() -> str:
    return _current_run_id.get().strip()


def _now() -> datetime:
    return datetime.now(UTC)


def _retention_days() -> int:
    try:
        return max(30, min(365, int(os.getenv("REMEDIATION_MONGODB_RETENTION_DAYS", "30"))))
    except ValueError:
        return 30


def _redact(value: str) -> str:
    redacted = _MONGO_AUTH_PATTERN.sub(r"\1[redacted]\2", value)
    redacted = _CREDENTIAL_ASSIGNMENT_PATTERN.sub(r"\1[redacted]", redacted)
    return _TOKEN_PATTERN.sub("[redacted]", redacted)


def _sanitize_artifact(value: Any, *, key: str = "", depth: int = 0) -> Any:
    if depth > 8:
        return "[depth limited]"
    if isinstance(value, dict):
        return {
            str(item_key)[:80]: _sanitize_artifact(item_value, key=str(item_key), depth=depth + 1)
            for item_key, item_value in list(value.items())[:80]
            if str(item_key).lower() not in {"api_key", "credential", "secret", "source_context", "contexts"}
        }
    if isinstance(value, list):
        return [_sanitize_artifact(item, key=key, depth=depth + 1) for item in value[:100]]
    if isinstance(value, str):
        limit = 20_000 if key.lower() in {"diff", "content"} else 4_000
        return _redact(value)[:limit]
    if value is None or isinstance(value, (bool, int, float)):
        return value
    return _redact(str(value))[:1_000]


def _safe_event_content(message_type: str, content: str) -> str:
    """Do not journal proposed diffs or arbitrary source code into run events."""
    if message_type == "changed_files":
        try:
            # Parse the original event: broad secret redaction can deliberately
            # make JSON invalid, but no diff content is retained below anyway.
            rows = json.loads(str(content or ""))
        except json.JSONDecodeError:
            return "Patch candidates were generated (details omitted from event journal)."
        if isinstance(rows, list):
            paths = [str(row.get("path") or "").strip() for row in rows if isinstance(row, dict)]
            paths = [path for path in paths if path][:20]
            suffix = ", ".join(paths)
            return f"Patch candidates: {len(paths)} file(s)" + (f" ({suffix})" if suffix else "")
        return "Patch candidates were generated (details omitted from event journal)."
    raw = _redact(str(content or "")).strip()
    return raw[:_MAX_EVENT_CONTENT]


class RemediationRunStore:
    def packet_result(self, run_id: str, packet_id: str, result: dict | None = None) -> dict | None:
        """Keep completed packet outputs for continuation without repeating inference."""
        key = f"{run_id}:{packet_id}"
        db = self._mongo_db()
        if not hasattr(self, "_packets"):
            self._packets = {}
        if result is not None:
            self._packets[key] = deepcopy(result)
            if db is not None:
                db.remediation_packets.replace_one({"_id": key}, {"_id": key, "result": result,
                    "expire_at": _now() + timedelta(days=_retention_days())}, upsert=True)
            return result
        if key in self._packets:
            return deepcopy(self._packets[key])
        if db is not None:
            record = db.remediation_packets.find_one({"_id": key})
            return record.get("result") if record else None
        return None

    """A memory fallback plus optional MongoDB-backed remediation event journal."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._token_budgets: dict[str, int] = {}
        self._runs: dict[str, dict[str, Any]] = {}
        self._events: dict[str, list[dict[str, Any]]] = {}
        self._client: Any | None = None
        self._mongo_attempted = False

    @staticmethod
    def token_limit() -> int:
        try:
            return max(1_000, min(2_000_000, int(os.getenv("REMEDIATION_RUN_TOKEN_BUDGET", "2000000"))))
        except ValueError:
            return 2_000_000

    def reserve_tokens(self, run_id: str, amount: int) -> None:
        """Reserve an estimated worker request across every packet in this run.

        Mongo reservations are atomic; the existing single-process fallback uses
        the journal lock. Unknown/failed responses retain their reservation.
        This is a worker safety budget, separate from Connector quota/billing.
        """
        if not run_id or type(amount) is not int or amount <= 0:
            raise ValueError("A run ID and positive token reservation are required")
        limit = self.token_limit()
        db = self._mongo_db()
        if db is not None:
            from pymongo import ReturnDocument
            db.remediation_token_budgets.update_one({"_id": run_id}, {"$setOnInsert": {
                "used": 0, "expire_at": _now() + timedelta(days=_retention_days()),
            }}, upsert=True)
            reserved = db.remediation_token_budgets.find_one_and_update(
                {"_id": run_id, "used": {"$lte": limit - amount}},
                {"$inc": {"used": amount}}, return_document=ReturnDocument.AFTER)
            if reserved is None:
                raise RuntimeError("RUN_TOKEN_BUDGET: remediation reached its shared token allowance; accepted patches are retained")
            return
        with self._lock:
            used = self._token_budgets.get(run_id, 0)
            if used + amount > limit:
                raise RuntimeError("RUN_TOKEN_BUDGET: remediation reached its shared token allowance; accepted patches are retained")
            self._token_budgets[run_id] = used + amount

    def reconcile_tokens(self, run_id: str, reserved: int, actual: int | None) -> None:
        # Missing usage must not turn an expensive request into zero usage.
        if type(actual) is not int or actual <= 0:
            return
        difference = actual - reserved
        db = self._mongo_db()
        if db is not None:
            db.remediation_token_budgets.update_one({"_id": run_id}, {"$inc": {"used": difference}})
            return
        with self._lock:
            self._token_budgets[run_id] = max(0, self._token_budgets.get(run_id, 0) + difference)

    @property
    def enabled(self) -> bool:
        return bool(os.getenv("MONGODB_URI", "").strip())

    @property
    def database_name(self) -> str:
        return os.getenv("REMEDIATION_MONGODB_DATABASE", "deplai_security").strip() or "deplai_security"

    def _mongo_client(self) -> Any | None:
        if not self.enabled:
            return None
        with self._lock:
            if self._client is not None:
                return self._client
            if self._mongo_attempted:
                return None
            self._mongo_attempted = True
            try:
                from pymongo import MongoClient

                client = MongoClient(
                    os.environ["MONGODB_URI"],
                    appname="deplai-security-remediation",
                    serverSelectionTimeoutMS=3_000,
                    connectTimeoutMS=3_000,
                    socketTimeoutMS=5_000,
                    maxPoolSize=12,
                    retryWrites=True,
                )
                client.admin.command("ping")
                db = client[self.database_name]
                db.remediation_runs.create_index("run_id", unique=True)
                db.remediation_runs.create_index([("project_id", 1), ("created_at", -1)])
                db.remediation_runs.create_index("expire_at", expireAfterSeconds=0)
                db.remediation_events.create_index([("run_id", 1), ("sequence", 1)], unique=True)
                db.remediation_events.create_index([("project_id", 1), ("created_at", -1)])
                db.remediation_events.create_index("expire_at", expireAfterSeconds=0)
                db.remediation_packets.create_index("expire_at", expireAfterSeconds=0)
                db.remediation_token_budgets.create_index("expire_at", expireAfterSeconds=0)
                self._client = client
                logger.info("MongoDB remediation journal connected (database=%s)", self.database_name)
                return client
            except Exception as exc:  # optional dependency and remote network must not stop remediation
                logger.warning("MongoDB remediation journal unavailable; using in-memory recovery: %s", type(exc).__name__)
                return None

    def _mongo_db(self) -> Any | None:
        client = self._mongo_client()
        return client[self.database_name] if client is not None else None

    def begin_run(self, *, project_id: str, user_id: str, organization_id: str | None, scope: str) -> str:
        run_id = str(uuid4())
        created_at = _now()
        document = {
            "run_id": run_id,
            "project_id": str(project_id),
            "user_id": str(user_id),
            "organization_id": str(organization_id or "") or None,
            "scope": str(scope or "major"),
            "status": "queued",
            "checkpoint_backend": "memory",
            "agent_context": {
                "schema_version": "remediation.v2",
                "calls_limit": 14,
                "calls_used": 0,
                "master": None,
                "planner": None,
                "implementor": None,
                "reviewer": None,
            },
            "usage": {
                "requests": 0,
                "input_tokens": 0,
                "output_tokens": 0,
            },
            "created_at": created_at,
            "updated_at": created_at,
            "expire_at": created_at + timedelta(days=_retention_days()),
        }
        with self._lock:
            self._runs[run_id] = document
            self._events[run_id] = []
        db = self._mongo_db()
        if db is not None:
            try:
                db.remediation_runs.insert_one(document)
            except Exception as exc:
                logger.warning("Could not persist remediation run start: %s", type(exc).__name__)
        return run_id

    def record_usage(self, run_id: str | None, usage: dict[str, Any] | None) -> None:
        """Accumulate provider-reported tokens without storing prompts or output."""
        resolved_run_id = str(run_id or "").strip()
        if not resolved_run_id or not isinstance(usage, dict):
            return

        def positive(*values: Any) -> int:
            for value in values:
                try:
                    parsed = int(value)
                except (TypeError, ValueError):
                    continue
                if parsed > 0:
                    return parsed
            return 0

        input_tokens = positive(usage.get("input_tokens"), usage.get("prompt_tokens"), usage.get("inputTokens"))
        output_tokens = positive(usage.get("output_tokens"), usage.get("completion_tokens"), usage.get("outputTokens"))
        if not input_tokens and not output_tokens:
            input_tokens = positive(usage.get("total_tokens"), usage.get("totalTokens"))
        if not input_tokens and not output_tokens:
            return

        updated_at = _now()
        with self._lock:
            run = self._runs.get(resolved_run_id)
            if run:
                totals = run.setdefault("usage", {"requests": 0, "input_tokens": 0, "output_tokens": 0})
                totals["requests"] = int(totals.get("requests", 0) or 0) + 1
                totals["input_tokens"] = int(totals.get("input_tokens", 0) or 0) + input_tokens
                totals["output_tokens"] = int(totals.get("output_tokens", 0) or 0) + output_tokens
                run["updated_at"] = updated_at
        db = self._mongo_db()
        if db is not None:
            try:
                db.remediation_runs.update_one(
                    {"run_id": resolved_run_id},
                    {"$inc": {
                        "usage.requests": 1,
                        "usage.input_tokens": input_tokens,
                        "usage.output_tokens": output_tokens,
                    }, "$set": {"updated_at": updated_at}},
                )
            except Exception as exc:
                logger.warning("Could not persist remediation usage: %s", type(exc).__name__)

    def usage_for_run(self, run_id: str | None) -> dict[str, int]:
        resolved_run_id = str(run_id or "").strip()
        empty = {"requests": 0, "input_tokens": 0, "output_tokens": 0}
        if not resolved_run_id:
            return empty
        with self._lock:
            local = self._runs.get(resolved_run_id)
            if local:
                usage = local.get("usage") if isinstance(local.get("usage"), dict) else {}
                return {
                    "requests": int(usage.get("requests", 0) or 0),
                    "input_tokens": int(usage.get("input_tokens", 0) or 0),
                    "output_tokens": int(usage.get("output_tokens", 0) or 0),
                }
        db = self._mongo_db()
        if db is None:
            return empty
        try:
            run = db.remediation_runs.find_one({"run_id": resolved_run_id}, {"usage": 1}) or {}
            usage = run.get("usage") if isinstance(run.get("usage"), dict) else {}
            return {
                "requests": int(usage.get("requests", 0) or 0),
                "input_tokens": int(usage.get("input_tokens", 0) or 0),
                "output_tokens": int(usage.get("output_tokens", 0) or 0),
            }
        except Exception as exc:
            logger.warning("Could not read remediation usage: %s", type(exc).__name__)
            return empty

    def store_agent_artifact(
        self,
        run_id: str | None,
        stage: str,
        artifact: dict[str, Any],
        *,
        count_llm_call: bool = False,
    ) -> None:
        """Embed a compact, redacted agent result in its run document.

        This intentionally follows MongoDB's extended-reference pattern: the
        status endpoint can recover the current workflow without joining a
        second collection or storing the complete source context.
        """
        resolved_run_id = str(run_id or "").strip()
        normalized_stage = str(stage or "").strip().lower()
        if not resolved_run_id or normalized_stage not in {"master", "planner", "implementor", "reviewer"}:
            return
        safe = _sanitize_artifact(artifact)
        safe["stored_at"] = _now().isoformat()
        updated_at = _now()
        with self._lock:
            run = self._runs.get(resolved_run_id)
            if run:
                context = run.setdefault("agent_context", {})
                context[normalized_stage] = safe
                if count_llm_call:
                    context["calls_used"] = int(context.get("calls_used", 0) or 0) + 1
                run["updated_at"] = updated_at
        db = self._mongo_db()
        if db is not None:
            update: dict[str, Any] = {
                "$set": {
                    f"agent_context.{normalized_stage}": safe,
                    "updated_at": updated_at,
                }
            }
            if count_llm_call:
                update["$inc"] = {"agent_context.calls_used": 1}
            try:
                db.remediation_runs.update_one({"run_id": resolved_run_id}, update)
            except Exception as exc:
                logger.warning("Could not persist remediation agent artifact: %s", type(exc).__name__)

    def append_event(
        self,
        run_id: str | None,
        *,
        project_id: str,
        message_type: str,
        content: str,
        stage: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        resolved_run_id = str(run_id or "").strip()
        if not resolved_run_id:
            return
        created_at = _now()
        with self._lock:
            if not str(project_id).strip():
                project_id = str((self._runs.get(resolved_run_id) or {}).get("project_id") or "")
            events = self._events.setdefault(resolved_run_id, [])
            event = {
                "run_id": resolved_run_id,
                "project_id": str(project_id),
                "sequence": len(events) + 1,
                "type": str(message_type or "info")[:64],
                "content": _safe_event_content(str(message_type or "info"), content),
                "stage": str(stage or "")[:80] or None,
                "metadata": dict(metadata or {}),
                "created_at": created_at,
                "expire_at": created_at + timedelta(days=_retention_days()),
            }
            events.append(event)
            run = self._runs.get(resolved_run_id)
            if run:
                run["updated_at"] = created_at
        db = self._mongo_db()
        if db is not None:
            try:
                db.remediation_events.insert_one(event)
                db.remediation_runs.update_one(
                    {"run_id": resolved_run_id}, {"$set": {"updated_at": created_at}}
                )
            except Exception as exc:
                logger.warning("Could not persist remediation event: %s", type(exc).__name__)

    def mark_status(self, run_id: str | None, status: str, *, checkpoint_backend: str | None = None) -> None:
        resolved_run_id = str(run_id or "").strip()
        if not resolved_run_id:
            return
        updated_at = _now()
        update: dict[str, Any] = {"status": str(status), "updated_at": updated_at}
        if checkpoint_backend:
            update["checkpoint_backend"] = checkpoint_backend
        if status in {"completed", "failed", "cancelled"}:
            update["completed_at"] = updated_at
            update["expire_at"] = updated_at + timedelta(days=_retention_days())
        with self._lock:
            run = self._runs.get(resolved_run_id)
            if run:
                run.update(update)
        db = self._mongo_db()
        if db is not None:
            try:
                db.remediation_runs.update_one({"run_id": resolved_run_id}, {"$set": update})
                if "completed_at" in update:
                    expiry = update["expire_at"]
                    db.remediation_events.update_many({"run_id": resolved_run_id}, {"$max": {"expire_at": expiry}})
                    db.remediation_packets.update_many({"_id": {"$regex": "^" + re.escape(resolved_run_id) + ":"}}, {"$max": {"expire_at": expiry}})
                    db.remediation_token_budgets.update_many({"_id": resolved_run_id}, {"$max": {"expire_at": expiry}})
            except Exception as exc:
                logger.warning("Could not persist remediation status: %s", type(exc).__name__)

    def archive_for_run(self, run_id: str, *, project_id: str, user_id: str, organization_id: str) -> dict | None:
        scope = {"run_id": run_id, "project_id": project_id, "user_id": user_id, "organization_id": organization_id}
        db = self._mongo_db()
        if db is None:
            raise RuntimeError("Durable remediation storage is unavailable")
        run = db.remediation_runs.find_one(scope, {"_id": 0})
        if not run:
            return None
        events = list(db.remediation_events.find({"run_id": run_id}, {"_id": 0}).sort("sequence", 1))
        packets = list(db.remediation_packets.find({"_id": {"$regex": "^" + re.escape(run_id) + ":"}}))
        archive = self._public_run(run, events)
        archive["packets"] = [{"packet_id": item["_id"], "result": item.get("result", {})} for item in packets]
        archive["schema_version"] = "remediation.archive.v1"
        archive["retention_days_minimum"] = 30
        # Export the complete recorded evidence, but never credentials or prompts.
        def redact(value):
            if isinstance(value, dict):
                return {str(k): redact(v) for k, v in value.items() if str(k).lower() not in
                        {"api_key", "github_token", "credential", "secret", "contexts", "source_context", "raw_response", "prompt"}}
            if isinstance(value, list):
                return [redact(v) for v in value]
            if isinstance(value, str):
                return _redact(value)
            if isinstance(value, datetime):
                return value.isoformat()
            return value
        return redact(archive)

    def latest_for_project(self, project_id: str, *, limit: int = 100) -> dict[str, Any] | None:
        target = str(project_id)
        run: dict[str, Any] | None = None
        with self._lock:
            local = [item for item in self._runs.values() if item.get("project_id") == target]
            if local:
                run = deepcopy(max(local, key=lambda item: item.get("created_at", datetime.min.replace(tzinfo=UTC))))
                events = deepcopy(self._events.get(str(run["run_id"]), [])[-max(1, min(limit, 200)):])
                return self._public_run(run, events)
        db = self._mongo_db()
        if db is None:
            return None
        try:
            found = db.remediation_runs.find_one({"project_id": target}, sort=[("created_at", -1)])
            if not found:
                return None
            events = list(
                db.remediation_events.find({"run_id": found["run_id"]}, {"_id": 0})
                .sort("sequence", -1)
                .limit(max(1, min(limit, 200)))
            )
            events.reverse()
            found.pop("_id", None)
            return self._public_run(found, events)
        except Exception as exc:
            logger.warning("Could not read remediation recovery state: %s", type(exc).__name__)
            return None

    @staticmethod
    def _public_run(run: dict[str, Any], events: list[dict[str, Any]]) -> dict[str, Any]:
        public_run = dict(run)
        public_run.pop("_id", None)
        for key in ("created_at", "updated_at", "completed_at", "expire_at"):
            value = public_run.get(key)
            if isinstance(value, datetime):
                public_run[key] = value.isoformat()
        public_events: list[dict[str, Any]] = []
        for event in events:
            item = dict(event)
            item.pop("_id", None)
            item.pop("expire_at", None)
            value = item.get("created_at")
            if isinstance(value, datetime):
                item["created_at"] = value.isoformat()
            public_events.append(item)
        return {"run": public_run, "events": public_events}

    def checkpoint_saver(self, *, direct_api_key_present: bool) -> tuple[Any | None, str]:
        """Return a MongoDBSaver only after explicit source-context persistence opt-in."""
        if not self.enabled:
            return None, "memory"
        enabled = os.getenv("REMEDIATION_MONGODB_CHECKPOINTS", "false").strip().lower() in {"1", "true", "yes", "on"}
        persist_context = os.getenv("REMEDIATION_MONGODB_PERSIST_CONTEXT", "false").strip().lower() in {"1", "true", "yes", "on"}
        if not enabled or not persist_context:
            return None, "memory"
        if direct_api_key_present:
            logger.warning("MongoDB checkpoints disabled for a direct BYOK remediation request")
            return None, "memory_direct_key_protected"
        client = self._mongo_client()
        if client is None:
            return None, "memory_mongodb_unavailable"
        try:
            from langgraph.checkpoint.mongodb import MongoDBSaver

            return MongoDBSaver(
                client,
                db_name=self.database_name,
                checkpoint_collection_name="remediation_checkpoints",
                writes_collection_name="remediation_checkpoint_writes",
                ttl=_retention_days() * 86_400,
            ), "mongodb"
        except Exception as exc:
            logger.warning("MongoDB LangGraph checkpointer unavailable; using memory: %s", type(exc).__name__)
            return None, "memory_mongodb_unavailable"


remediation_runs = RemediationRunStore()


def record_llm_dispatch(
    *,
    stage: str,
    provider: str,
    model: str,
    access_mode: str,
    success: bool | None = None,
    error: str | None = None,
) -> None:
    """Journal dispatch observability without prompts, responses, or credentials."""
    run_id = current_remediation_run_id()
    if not run_id:
        return
    label = "LLM dispatch started" if success is None else ("LLM dispatch completed" if success else "LLM dispatch failed")
    suffix = f" ({_redact(str(error))[:500]})" if error else ""
    remediation_runs.append_event(
        run_id,
        project_id="",
        message_type="llm_dispatch",
        content=f"{label}: stage={stage}, provider={provider or 'auto'}, model={model or 'auto'}, mode={access_mode or 'auto'}{suffix}",
        stage=stage,
        metadata={
            "provider": provider or "auto",
            "model": model or "auto",
            "access_mode": access_mode or "auto",
            "success": success,
        },
    )
