"""Run inside Agentic with its effective environment; never print driver errors."""
import os
import sys
from urllib.parse import urlsplit

from pymongo import MongoClient
from pymongo.errors import ConfigurationError, OperationFailure, ServerSelectionTimeoutError


def check_storage():
    uri = os.getenv("MONGODB_URI", "").strip()
    if not uri:
        return 1, "MISSING_URI: Set MONGODB_URI in deploy/.env and recreate agentic-layer."
    client = None
    stage = "connect"
    try:
        client = MongoClient(uri, serverSelectionTimeoutMS=5000,
                             connectTimeoutMS=5000, socketTimeoutMS=5000)
        db = client[os.getenv("REMEDIATION_MONGODB_DATABASE", "deplai_security")]
        db.command("ping")
        stage = "indexes"
        # The same idempotent initialization required by SecurityRunStore.db().
        # No scan records, reports or leases are modified.
        db.security_runs.create_index([("project_id", 1), ("created_at", -1)])
        db.security_events.create_index([("run_id", 1), ("sequence", 1)], unique=True)
        return 0, "OK: MongoDB connection and required scan indexes are available."
    except OperationFailure as exc:
        if exc.code == 18:
            return 1, "AUTHENTICATION: Check database credentials, URI escaping and authSource."
        if exc.code == 13:
            return 1, "AUTHORIZATION: Grant the scan service read/write and index permissions on its configured database."
        if exc.code in (85, 86, 11000):
            return 1, "INDEX_CONFLICT: Existing scan indexes or duplicate events need operator review; no data was deleted."
        return 1, "DATABASE_OPERATION: MongoDB rejected scan storage initialization at stage " + stage + "."
    except ServerSelectionTimeoutError:
        return 1, "UNREACHABLE: Check the production host's MongoDB network access, DNS, TLS trust and cluster availability."
    except ConfigurationError:
        return 1, "CONFIGURATION: Check MongoDB URI syntax, SRV DNS resolution and TLS certificate file settings."
    except Exception:
        # Driver exceptions can contain the URI, credentials and private hosts.
        return 1, "STORAGE_ERROR: Scan storage check failed at stage " + stage + "; inspect private sanitized diagnostics."
    finally:
        if client is not None:
            client.close()


if __name__ == "__main__":
    try:
        host = urlsplit(os.getenv("MONGODB_URI", "")).hostname or ""
        provider = "MongoDB Atlas" if host.endswith(".mongodb.net") else "non-Atlas or custom endpoint" if host else "not configured"
    except ValueError:
        provider = "invalid URI"
    print("Configured storage: " + provider)
    code, message = check_storage()
    print(message)
    sys.exit(code)
