"""Optional, revision-bound OpenWiki context. Generation is off until evaluated."""
import base64
import hashlib
import hmac
import io
import json
import os
import tarfile
import time
from pathlib import Path
from uuid import uuid4

VERSION = "0.5.0"


def cache_key(tenant: str, project: str, contexts: dict[str, str]) -> str:
    hashes = {path: hashlib.sha256(text.encode()).hexdigest() for path, text in contexts.items()}
    return hashlib.sha256(json.dumps([tenant, project, VERSION, hashes], sort_keys=True).encode()).hexdigest()


def wiki_context(*, project_id: str, tenant: str, user_id: str, run_id: str,
                 model: str, contexts: dict[str, str], repository_id: str = "", revision: str = "") -> tuple[str, str]:
    key = cache_key(tenant, (repository_id or project_id) + ":" + revision, contexts)
    cache = Path(os.getenv("SECURITY_WIKI_CACHE_DIR", "/workspace/runtime/security-wiki")) / f"{key}.json"
    if cache.is_file():
        data = json.loads(cache.read_text(encoding="utf-8"))
        if data.get("key") == key:
            return data["context"], "Using source-verified cached OpenWiki context."
    if os.getenv("SECURITY_OPENWIKI_GENERATE", "false").lower() != "true":
        return "", "OpenWiki cache unavailable; using direct source context (automatic generation disabled pending evaluation)."
    from utils import CODEBASE_VOLUME, get_docker_client
    from scanner_runtime import wait_container
    client = get_docker_client()
    volume = client.volumes.create(name="security-wiki-" + uuid4().hex)
    worker = None
    try:
        client.containers.run("alpine", command=["sh", "-ec",
            'cp -a "/source/$PID/." /repo/; rm -rf /repo/.git; find /repo -name ".env*" -type f -delete'],
            environment={"PID": project_id},
            volumes={CODEBASE_VOLUME: {"bind": "/source", "mode": "ro"}, volume.name: {"bind": "/repo", "mode": "rw"}}, remove=True)
        payload = base64.urlsafe_b64encode(json.dumps({"user": user_id, "org": tenant, "run": run_id,
            "model": model or "best_coding", "exp": int(time.time()) + 600}).encode()).decode().rstrip("=")
        signature = hmac.new(os.environ["DEPLAI_SERVICE_KEY"].encode(), payload.encode(), hashlib.sha256).hexdigest()
        gateway = (os.getenv("DEPLAI_AI_GATEWAY_URL") or os.getenv("CONNECTOR_URL", "")).rstrip("/")
        worker = client.containers.run("deplai-openwiki:0.5.0", detach=True,
            environment={"OPENAI_COMPATIBLE_API_KEY": payload + "." + signature,
                         "OPENAI_COMPATIBLE_BASE_URL": gateway + "/api/security/wiki/v1",
                         "OPENWIKI_MODEL_ID": model or "best_coding", "OPENWIKI_PROVIDER_RETRY_ATTEMPTS": "1"},
            volumes={volume.name: {"bind": "/repo", "mode": "rw"}},
            mem_limit="1g", pids_limit=128, cap_drop=["ALL"], security_opt=["no-new-privileges:true"],
            network=os.getenv("SECURITY_WORKER_NETWORK", "bridge"))
        ok, detail, _ = wait_container(worker, timeout_seconds=300, engine="OpenWiki")
        if not ok:
            return "", f"OpenWiki did not finish ({detail}); using direct source context."
        chunks, _ = worker.get_archive("/repo/openwiki")
        pages = []
        size = 0
        with tarfile.open(fileobj=io.BytesIO(b"".join(chunks))) as archive:
            for entry in archive:
                if entry.isfile() and entry.name.endswith(".md") and entry.size <= 20_000:
                    stream = archive.extractfile(entry)
                    text = stream.read().decode("utf-8", errors="replace") if stream else ""
                    # Retrieve pages that cite the current packet's source paths.
                    if any(path in text for path in contexts) and size + len(text) <= 6000:
                        pages.append(text)
                        size += len(text)
        context = "\n\n".join(pages)
        if not context:
            return "", "OpenWiki produced no relevant source references; using direct source context."
        cache.parent.mkdir(parents=True, exist_ok=True)
        temporary = cache.with_suffix("." + uuid4().hex + ".tmp")
        temporary.write_text(json.dumps({"key": key, "context": context}), encoding="utf-8")
        temporary.replace(cache)
        return context, "OpenWiki context generated; repository source remains authoritative."
    except Exception as exc:
        return "", f"OpenWiki unavailable ({type(exc).__name__}); using direct source context."
    finally:
        if worker is not None:
            try:
                worker.remove(force=True)
            except Exception:
                pass
        try:
            volume.remove(force=True)
        except Exception:
            pass
