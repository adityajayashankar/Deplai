"""Security job ledger. MongoDB is mandatory when production mode is enabled."""
import os
from datetime import datetime, timedelta, timezone
from uuid import uuid4


class SecurityRunStore:
    def __init__(self):
        self._db = None

    def db(self):
        if self._db is not None:
            return self._db
        uri = os.getenv("MONGODB_URI", "").strip()
        required = (os.getenv("SECURITY_DURABLE_REQUIRED", "").lower() == "true"
            or os.getenv("APP_ENV", "").lower() == "production")
        if not uri:
            if required:
                raise RuntimeError("Security execution requires MONGODB_URI")
            return None
        from pymongo import MongoClient
        from pymongo.errors import OperationFailure, PyMongoError
        client = None
        try:
            kwargs = {
                "serverSelectionTimeoutMS": 15000,
                "connectTimeoutMS": 10000,
                "socketTimeoutMS": 15000,
                "retryWrites": True,
                "appname": "deplai-security-scans",
            }
            if uri.startswith("mongodb+srv://") or "tls=true" in uri.lower() or "ssl=true" in uri.lower():
                try:
                    import certifi
                    kwargs["tlsCAFile"] = certifi.where()
                except Exception:
                    pass
            client = MongoClient(uri, **kwargs)
            db = client[os.getenv("REMEDIATION_MONGODB_DATABASE", "deplai_security")]
            db.command("ping")
            try:
                db.security_runs.create_index([("project_id", 1), ("created_at", -1)])
                db.security_events.create_index([("run_id", 1), ("sequence", 1)], unique=True)
            except OperationFailure as exc:
                # Identical indexes are idempotent. Conflicting leftover
                # definitions must not block scan startup after a successful ping.
                if getattr(exc, "code", None) not in (85, 86):
                    raise
        except PyMongoError:
            if client is not None:
                client.close()
            # The API maps RuntimeError to a recoverable 503. Do not expose
            # connection strings, Atlas hosts, or driver diagnostics to users.
            raise RuntimeError(
                "Scan storage is unavailable. Restore the configured MongoDB "
                "connection (network access, TLS, and credentials), then retry the scan."
            ) from None
        self._db = db
        return db

    def create(self, project_id, user_id, run_id):
        db = self.db()
        if db is None:
            return
        now = datetime.now(timezone.utc)
        # One lease per project prevents simultaneous mutation of its legacy checkout.
        from pymongo.errors import DuplicateKeyError
        try:
            lease = db.security_leases.find_one_and_update(
                {"_id": project_id, "$or": [{"expires_at": {"$lt": now}}, {"run_id": run_id}]},
                {"$set": {"run_id": run_id, "expires_at": now + timedelta(seconds=90)}}, upsert=True)
        except DuplicateKeyError as exc:
            raise RuntimeError("A security scan for this project is already active") from exc
        # An expired lease cannot be represented as a successful old run.
        if lease and lease.get("run_id") != run_id:
            db.security_runs.update_one({"_id": lease["run_id"], "status": "running"},
                {"$set": {"status": "interrupted", "error": "Worker lease expired; restart scan from its source revision."}})
        db.security_runs.insert_one({"_id": run_id, "project_id": project_id,
            "user_id": str(user_id), "status": "running", "created_at": now})

    def heartbeat(self, project_id, run_id):
        db = self.db()
        if db is not None:
            result = db.security_leases.update_one({"_id": project_id, "run_id": run_id},
                {"$set": {"expires_at": datetime.now(timezone.utc) + timedelta(seconds=90)}})
            if not result.matched_count:
                raise RuntimeError("Security worker lost its lease")

    def event(self, run_id, payload):
        db = self.db()
        if db is not None:
            db.security_events.insert_one({"_id": uuid4().hex, "run_id": run_id,
                "sequence": payload["sequence"], "payload": payload})

    def finish(self, project_id, run_id, status):
        db = self.db()
        if db is not None:
            db.security_runs.update_one({"_id": run_id}, {"$set": {"status": status,
                "finished_at": datetime.now(timezone.utc)}})
            db.security_leases.delete_one({"_id": project_id, "run_id": run_id})

    def latest(self, project_id):
        db = self.db()
        if db is None:
            return None
        run = db.security_runs.find_one({"project_id": project_id}, sort=[("created_at", -1)])
        if run and run["status"] == "running":
            lease = db.security_leases.find_one({"_id": project_id, "run_id": run["_id"],
                "expires_at": {"$gt": datetime.now(timezone.utc)}})
            if not lease:
                run["status"] = "interrupted"
        return run

    def events(self, run_id):
        db = self.db()
        if db is None:
            return []
        return [row["payload"] for row in db.security_events.find({"run_id": run_id}).sort("sequence", 1)]
