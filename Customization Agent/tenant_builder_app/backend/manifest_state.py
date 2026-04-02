import json
import re
from copy import deepcopy
from pathlib import Path
from threading import Lock
from typing import Any


def deep_merge(target: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    for key, value in patch.items():
        if isinstance(value, dict) and isinstance(target.get(key), dict):
            deep_merge(target[key], value)
        else:
            target[key] = value
    return target


class ManifestState:
    def __init__(self, base_dir: Path) -> None:
        self.base_dir = base_dir
        self._sessions: dict[str, dict[str, Any]] = {}
        self._lock = Lock()

    def _default_manifest(self, tenant_id: str = "draft-tenant") -> dict[str, Any]:
        tenant_slug = self._slugify(tenant_id)
        tenant_name = tenant_slug.replace("-", " ").title() or "Draft Tenant"
        return {
            "schema_version": "1.0",
            "tenant_id": tenant_slug,
            "tenant_name": tenant_name,
            "base_profile": "cultureplace-default",
            "categories": {
                "branding": {
                    "company_name": tenant_name,
                    "title": tenant_name,
                    "description": "",
                    "logo_light": "",
                    "logo_dark": "",
                    "favicon": "",
                    "contact_email": "",
                    "contact_phone": "",
                },
                "theme": {
                    "primary": "",
                    "secondary": "",
                    "accent": "",
                    "font_heading": "",
                    "font_body": "",
                    "border_radius": "md",
                },
                "domains": {
                    "site_url": "",
                    "admin_url": "",
                    "api_base_url": "",
                    "video_base_url": "",
                },
                "portals": {
                    "frontend": True,
                    "admin_frontend": True,
                    "expert": False,
                    "corporates": False,
                },
                "features": {
                    "communities": True,
                    "sessions": True,
                    "forms": False,
                    "rewards": False,
                    "blog": False,
                },
                "integrations": {
                    "payments": {"provider": "", "env_ref": ""},
                    "email": {"provider": "", "env_ref": ""},
                    "video": {"provider": "", "env_ref": ""},
                    "meeting_fallback": {"provider": "", "env_ref": ""},
                    "google_forms": {"enabled": False, "env_ref": ""},
                },
            },
            "flow_rules": [],
            "extensions": [],
            "metadata": {
                "generated_by": "prototype-chat-agent",
                "confidence": "low",
                "requires_review": True,
            },
        }

    def _tenant_dir(self, tenant_id: str) -> Path:
        return self.base_dir / "tenants" / tenant_id

    def _manifest_path(self, tenant_id: str) -> Path:
        return self._tenant_dir(tenant_id) / "manifest.json"

    def _draft_path(self, tenant_id: str) -> Path:
        return self._tenant_dir(tenant_id) / "draft.manifest.json"

    def _load_json(self, path: Path) -> dict[str, Any] | None:
        if not path.exists():
            return None
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return None

    def _write_json(self, path: Path, payload: dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    def _build_session(self, tenant_id: str) -> dict[str, Any]:
        manifest_path = self._manifest_path(tenant_id)
        draft_path = self._draft_path(tenant_id)

        confirmed_manifest = self._load_json(manifest_path)
        draft_manifest = self._load_json(draft_path)

        if draft_manifest is not None:
            active_manifest = draft_manifest
        elif confirmed_manifest is not None:
            active_manifest = confirmed_manifest
        else:
            active_manifest = self._default_manifest(tenant_id=tenant_id)

        active_manifest["tenant_id"] = tenant_id
        if confirmed_manifest is not None:
            confirmed_manifest["tenant_id"] = tenant_id

        has_unconfirmed_changes = bool(
            confirmed_manifest is None or active_manifest != confirmed_manifest
        )

        session = {
            "manifest": active_manifest,
            "confirmed_tenant_id": tenant_id if confirmed_manifest is not None and not has_unconfirmed_changes else "",
            "has_unconfirmed_changes": has_unconfirmed_changes,
        }
        self._write_json(draft_path, active_manifest)
        return session

    def _get_or_create_session(self, tenant_id: str) -> dict[str, Any]:
        if tenant_id not in self._sessions:
            self._sessions[tenant_id] = self._build_session(tenant_id)
        return self._sessions[tenant_id]

    def ensure_tenant(self, tenant_id: str) -> str:
        normalized = self._slugify(tenant_id)
        with self._lock:
            self._get_or_create_session(normalized)
        return normalized

    def get_manifest(self, tenant_id: str) -> dict[str, Any]:
        normalized = self._slugify(tenant_id)
        with self._lock:
            session = self._get_or_create_session(normalized)
            return deepcopy(session["manifest"])

    def reset(self, tenant_id: str) -> None:
        normalized = self._slugify(tenant_id)
        with self._lock:
            manifest_path = self._manifest_path(normalized)
            confirmed_manifest = self._load_json(manifest_path)
            if confirmed_manifest is None:
                new_manifest = self._default_manifest(tenant_id=normalized)
                confirmed_tenant_id = ""
            else:
                confirmed_manifest["tenant_id"] = normalized
                new_manifest = confirmed_manifest
                confirmed_tenant_id = normalized

            self._sessions[normalized] = {
                "manifest": new_manifest,
                "confirmed_tenant_id": confirmed_tenant_id,
                "has_unconfirmed_changes": False,
            }
            self._write_json(self._draft_path(normalized), new_manifest)

    def apply_patch(self, tenant_id: str, manifest_patch: dict[str, Any]) -> dict[str, Any]:
        normalized = self._slugify(tenant_id)
        with self._lock:
            session = self._get_or_create_session(normalized)
            before = deepcopy(session["manifest"])
            deep_merge(session["manifest"], manifest_patch)
            session["manifest"]["tenant_id"] = normalized
            if session["manifest"] != before:
                session["has_unconfirmed_changes"] = True
                session["confirmed_tenant_id"] = ""
            self._write_json(self._draft_path(normalized), session["manifest"])
            return deepcopy(session["manifest"])

    def get_confirmation_state(self, tenant_id: str) -> dict[str, Any]:
        normalized = self._slugify(tenant_id)
        with self._lock:
            session = self._get_or_create_session(normalized)
            confirmed_tenant_id = session["confirmed_tenant_id"]
            has_unconfirmed_changes = session["has_unconfirmed_changes"]
            return {
                "confirmed_tenant_id": confirmed_tenant_id,
                "has_unconfirmed_changes": has_unconfirmed_changes,
                "is_confirmed": bool(confirmed_tenant_id) and not has_unconfirmed_changes,
            }

    def build_summary(self, tenant_id: str) -> dict[str, Any]:
        manifest = self.get_manifest(tenant_id)
        categories = manifest["categories"]
        return {
            "tenant_id": manifest["tenant_id"],
            "tenant_name": manifest["tenant_name"],
            "company_name": categories["branding"].get("company_name", ""),
            "portals": categories["portals"],
            "integrations": {
                key: value.get("provider") if isinstance(value, dict) else value
                for key, value in categories["integrations"].items()
            },
        }

    def confirm_manifest(self, tenant_id: str) -> Path:
        normalized = self._slugify(tenant_id)
        with self._lock:
            session = self._get_or_create_session(normalized)
            session["manifest"]["tenant_id"] = normalized
            output_path = self._manifest_path(normalized)
            self._write_json(output_path, session["manifest"])
            self._write_json(self._draft_path(normalized), session["manifest"])
            session["confirmed_tenant_id"] = normalized
            session["has_unconfirmed_changes"] = False
            return output_path

    def _slugify(self, value: str) -> str:
        slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
        return slug or "draft-tenant"