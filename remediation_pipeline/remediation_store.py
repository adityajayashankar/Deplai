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
        return max(1, min(365, int(os.getenv("REMEDIATION_MONGODB_RETENTION_DAYS", "30"))))
    except ValueError:
        return 30


def _redact(value: str) -> str:
    return _TOKEN_PATTERN.sub("[redacted]", value)


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
    """A memory fallback plus optional MongoDB-backed remediation event journal."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._runs: dict[str, dict[str, Any]] = {}
        self._events: dict[str, list[dict[str, Any]]] = {}
        self._client: Any | None = None
        self._mongo_attempted = False

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
        with self._lock:
            run = self._runs.get(resolved_run_id)
            if run:
                run.update(update)
        db = self._mongo_db()
        if db is not None:
            try:
                db.remediation_runs.update_one({"run_id": resolved_run_id}, {"$set": update})
            except Exception as exc:
                logger.warning("Could not persist remediation status: %s", type(exc).__name__)

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
                .sort("sequence", 1)
                .limit(max(1, min(limit, 200)))
            )
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
