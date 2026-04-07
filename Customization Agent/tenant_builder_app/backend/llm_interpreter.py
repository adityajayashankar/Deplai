import json
import os
from pathlib import Path
import re
import time
from typing import Any
from urllib import error, request

from dotenv import load_dotenv


BACKEND_DIR = Path(__file__).resolve().parent
load_dotenv(BACKEND_DIR / ".env")


class LLMInterpreter:
    MODEL = os.getenv("LLM_MODEL_ID", os.getenv("HF_MODEL_ID", "Qwen/Qwen2.5-Coder-32B-Instruct"))
    API_URL = os.getenv("LLM_API_URL", os.getenv("HF_API_URL", "https://router.huggingface.co/v1/chat/completions"))
    NO_CHANGE_PATTERNS = (
        r"\bno change\b",
        r"\bno changes\b",
        r"\bno more changes\b",
        r"\bdone\b",
        r"\bthat's all\b",
        r"\bleave it as is\b",
        r"\bleave it\b",
        r"\bkeep it the same\b",
        r"\bkeep it as is\b",
        r"\bnothing to change\b",
        r"\blooks good\b",
        r"\bfinished\b",
        r"\bstop editing\b",
        r"\bdo not change\b",
        r"\bdon't change\b",
    )
    REQUIRED_FIELD_QUESTIONS = {
        "categories.branding.company_name": "What company name should this tenant use?",
        "categories.domains.site_url": "What domain should this tenant use?",
        "categories.theme.primary": "What primary theme color should be used?",
        "categories.portals.expert": "Should the expert portal be enabled?",
        "categories.integrations.payments.provider": "Which payment provider should be used for this tenant?",
    }

    def __init__(self) -> None:
        prompt_path = BACKEND_DIR / "prompts" / "manifest_extraction_prompt.txt"
        self.prompt_template = prompt_path.read_text(encoding="utf-8")
        self.provider = os.getenv("LLM_PROVIDER", "").strip().lower() or self._infer_provider(self.API_URL)
        self.enforce_required_field_questions = os.getenv(
            "ENFORCE_REQUIRED_FIELD_QUESTIONS", "false"
        ).strip().lower() in {"1", "true", "yes", "on"}
        self.max_retries = max(0, int(os.getenv("LLM_MAX_RETRIES", "2") or "2"))
        self.retry_base_delay_seconds = max(
            0.1,
            float(os.getenv("LLM_RETRY_BASE_DELAY_SECONDS", "1.5") or "1.5"),
        )

    def _infer_provider(self, api_url: str) -> str:
        lowered = (api_url or "").lower()
        if "anthropic" in lowered:
            return "anthropic"
        if "huggingface" in lowered:
            return "huggingface"
        if "127.0.0.1" in lowered or "localhost" in lowered:
            return "local"
        return "generic"

    def _is_transient_http_error(self, code: int, details: str) -> bool:
        if code in {429, 500, 502, 503, 504}:
            return True
        lowered = details.lower()
        return "server_overload" in lowered or "overload" in lowered or "try again later" in lowered

    def _requested_ui_scopes_from_message(self, message: str) -> list[str]:
        normalized = message.lower()
        all_frontend_requested = bool(
            re.search(r"\b(all|every|each)\s+(frontend\s+apps?|ui\s+apps?|ui\s+roots?)\b|\bacross\s+all\s+frontend\b", normalized)
        )
        admin_requested = bool(
            re.search(r"\badmin(?:[-_\s]*frontend)?\b|\badmin[-_\s]*portal\b", normalized)
        )
        expert_requested = bool(
            re.search(r"\bexpert(?:[-_\s]*frontend)?\b|\bexpert[-_\s]*portal\b", normalized)
        )
        corporates_requested = bool(
            re.search(r"\bcorporates?\b|\bcorporate(?:[-_\s]*frontend)?\b|\bcorporate[-_\s]*portal\b", normalized)
        )
        frontend_requested = bool(
            re.search(r"\bfrontend\b|\bfront[-_\s]*end\b|\bui\b|\bpage(s)?\b", normalized)
        )

        if all_frontend_requested:
            return ["frontend", "admin_frontend", "expert", "corporates"]

        explicit_scopes: list[str] = []
        if frontend_requested:
            explicit_scopes.append("frontend")
        if admin_requested:
            explicit_scopes.append("admin_frontend")
        if expert_requested:
            explicit_scopes.append("expert")
        if corporates_requested:
            explicit_scopes.append("corporates")

        if explicit_scopes:
            return explicit_scopes

        return ["frontend"]

    def _retry_delay_seconds(self, attempt: int, exc: error.HTTPError) -> float:
        retry_after_raw = exc.headers.get("Retry-After") if exc.headers else None
        if retry_after_raw:
            try:
                return max(0.1, float(retry_after_raw))
            except ValueError:
                pass
        return self.retry_base_delay_seconds * (2 ** (attempt - 1))

    def interpret(self, message: str, current_manifest: dict[str, Any]) -> dict[str, Any]:
        self._current_manifest = current_manifest
        deterministic_frontend_patch = self._build_deterministic_frontend_patch(
            message=message,
            current_manifest=current_manifest,
        )

        if self._is_no_change_request(message):
            return {
                "response": "Okay. The manifest will remain unchanged.",
                "manifest_patch": {},
                "questions": [],
            }

        exact_replace_patch = self._parse_exact_text_replace_command(
            message=message,
            current_manifest=current_manifest,
        )
        if exact_replace_patch is not None:
            return exact_replace_patch

        prompt = self._build_prompt(message=message, current_manifest=current_manifest)

        try:
            raw_content = self._call_llm(prompt=prompt)
            parsed = self._parse_model_output(raw_content)
            normalized = self._normalize_result(parsed)
            if deterministic_frontend_patch:
                existing_patch = normalized.get("manifest_patch")
                base_patch = existing_patch if isinstance(existing_patch, dict) else {}
                merged_patch = self._deep_merge(self._copy_dict(base_patch), deterministic_frontend_patch)
                normalized["manifest_patch"] = merged_patch
                normalized = self._normalize_result(normalized)
            return normalized
        except Exception as exc:
            if deterministic_frontend_patch:
                return {
                    "response": "Applied deterministic frontend patch from your request.",
                    "manifest_patch": deterministic_frontend_patch,
                    "questions": [],
                }
            return {
                "response": f"The LLM interpreter could not process the request safely: {exc}",
                "manifest_patch": {},
                "questions": [],
            }

    def _build_deterministic_frontend_patch(
        self,
        message: str,
        current_manifest: dict[str, Any],
    ) -> dict[str, Any]:
        combined: dict[str, Any] = {}

        landing_patch = self._parse_landing_part_removal_request(
            message=message,
            current_manifest=current_manifest,
        )
        if landing_patch and isinstance(landing_patch.get("manifest_patch"), dict):
            self._deep_merge(combined, landing_patch["manifest_patch"])

        welcome_removal_patch = self._parse_remove_welcome_request(
            message=message,
            current_manifest=current_manifest,
        )
        if welcome_removal_patch:
            self._deep_merge(combined, welcome_removal_patch)

        return self._prune_empty(combined) if isinstance(combined, dict) else {}

    def _parse_exact_text_replace_command(
        self,
        message: str,
        current_manifest: dict[str, Any],
    ) -> dict[str, Any] | None:
        """Parse explicit exact-replacement commands like:
        - change any text saying 'Culture Place' to 'PVL'
        - replace 'Culture Place' with 'PVL'
        """

        quote_fragment = r"\"[^\"]+\"|'[^']+'|\u201c[^\u201d]+\u201d|\u2018[^\u2019]+\u2019"
        # Supports variants like:
        # - change any text saying 'A' to 'B'
        # - change all instances of 'A' to 'B' across ...
        # - replace 'A' with 'B'
        pattern = re.compile(
            rf"\b(?:change|replace|update)\s+(?:(?:any\s+text\s+(?:saying|that\s+says))|(?:all\s+instances\s+of)|(?:all\s+occurrences\s+of)|(?:text\s+saying))?\s*(?P<old>{quote_fragment})\s+(?:to|with)\s+(?P<new>{quote_fragment})",
            flags=re.IGNORECASE,
        )

        match = pattern.search(message)
        if not match:
            return None

        def _clean_quoted(raw: str) -> str:
            value = raw.strip()
            if len(value) < 2:
                return ""
            quote_pairs = [("\"", "\""), ("'", "'"), ("\u201c", "\u201d"), ("\u2018", "\u2019")]
            for left, right in quote_pairs:
                if value.startswith(left) and value.endswith(right):
                    return value[1:-1].strip()
            return value

        old_text = _clean_quoted(match.group("old"))
        new_text = _clean_quoted(match.group("new"))
        if not old_text or not new_text or old_text == new_text:
            return None

        requested_scopes = self._requested_ui_scopes_from_message(message)
        entries = [
            {
                "type": "nl_key_value",
                "scope": scope,
                # Non scope.key target_raw is interpreted downstream as exact literal replacement.
                "target_raw": old_text,
                "value": new_text,
            }
            for scope in requested_scopes
        ]

        existing_extensions = current_manifest.get("extensions")
        merged_extensions: list[dict[str, Any]] = []
        if isinstance(existing_extensions, list):
            for item in existing_extensions:
                if isinstance(item, dict):
                    merged_extensions.append(json.loads(json.dumps(item)))

        for entry in entries:
            replaced = False
            for index, existing in enumerate(merged_extensions):
                if (
                    str(existing.get("type", "")).strip().lower() == "nl_key_value"
                    and str(existing.get("target_raw", "")).strip().lower() == old_text.lower()
                    and str(existing.get("scope", "frontend")).strip().lower()
                    == str(entry.get("scope", "frontend")).strip().lower()
                ):
                    merged_extensions[index] = entry
                    replaced = True
                    break
            if not replaced:
                merged_extensions.append(entry)

        return {
            "response": (
                f"Applied exact text replacement command: '{old_text}' -> '{new_text}' "
                f"for scope(s): {', '.join(requested_scopes)}."
            ),
            "manifest_patch": {
                "extensions": merged_extensions,
            },
            "questions": [],
        }

    def _parse_inline_frontend_request(
        self,
        message: str,
        current_manifest: dict[str, Any],
    ) -> dict[str, Any]:
        patch: dict[str, Any] = {}

        def clean_value(value: str) -> str:
            trimmed = value.strip().strip(",.;")
            if len(trimmed) >= 2 and ((trimmed[0] == '"' and trimmed[-1] == '"') or (trimmed[0] == "'" and trimmed[-1] == "'")):
                trimmed = trimmed[1:-1].strip()
            return trimmed

        hero_patterns = [
            ("hero_1", r"hero\s*1\s*(?:to\s*say|should\s*be|is|=|:)\s*([^,\n]+)"),
            ("hero_2", r"hero\s*2\s*(?:to\s*say|should\s*be|is|=|:)\s*([^,\n]+)"),
            ("hero_3", r"hero\s*3\s*(?:to\s*say|should\s*be|is|=|:)\s*([^,\n]+)"),
            ("hero_description", r"hero\s*description\s*(?:to\s*say|should\s*be|is|=|:)\s*([^,\n]+)"),
        ]

        landing_part_patterns = [
            (r"landing(?:[\s\._-]*)part[\s\._-]*(?P<part>\d+)\s*(?:to\s*say|should\s*be|is|=|:|to|as)\s*(?P<value>[^,\n]+)"),
            (r"part[\s\._-]*(?P<part>\d+)\s*(?:on\s+landing|landing)\s*(?:to\s*say|should\s*be|is|=|:|to|as)\s*(?P<value>[^,\n]+)"),
            (r"(?:change|set|update)\s+landing(?:[\s\._-]*)part[\s\._-]*(?P<part>\d+)\s*(?:to\s*say|should\s*be|is|=|:|to|as)\s*(?P<value>[^,\n]+)"),
            (r"(?:change|set|update)\s+part[\s\._-]*(?P<part>\d+)\s*(?:to\s*say|should\s*be|is|=|:|to|as)\s*(?P<value>[^,\n]+)"),
            (r"landing(?:[\s\._-]*)part[\s\._-]*(?P<part>\d+)\s*(?:-|->|=>|:)\s*(?P<value>[^,\n]+)"),
            (r"part[\s\._-]*(?P<part>\d+)\s*(?:-|->|=>|:)\s*(?P<value>[^,\n]+)"),
        ]

        new_ui_entries: list[dict[str, str]] = []
        for target, pattern in hero_patterns:
            match = re.search(pattern, message, flags=re.IGNORECASE)
            if not match:
                continue
            value = clean_value(match.group(1))
            if not value:
                continue
            new_ui_entries.append(
                {
                    "type": "nl_key_value",
                    "scope": "frontend",
                    "target_raw": f"landing.{target}",
                    "value": value,
                }
            )

        for pattern in landing_part_patterns:
            for match in re.finditer(pattern, message, flags=re.IGNORECASE):
                part = match.group("part").strip()
                value = clean_value(match.group("value"))
                if not part.isdigit() or not value:
                    continue
                new_ui_entries.append(
                    {
                        "type": "nl_key_value",
                        "scope": "frontend",
                        "target_raw": f"landing.part_{int(part)}",
                        "value": value,
                    }
                )

        # Support compact natural lists like:
        # "landing part 21 - Hello; landing part 19 - Bye"
        compact_pairs = re.findall(
            r"landing(?:[\s\._-]*)part[\s\._-]*(\d+)\s*(?:-|->|=>|:|=)\s*([^,;\n]+)",
            message,
            flags=re.IGNORECASE,
        )
        for part, raw_value in compact_pairs:
            value = clean_value(raw_value)
            if part.isdigit() and value:
                new_ui_entries.append(
                    {
                        "type": "nl_key_value",
                        "scope": "frontend",
                        "target_raw": f"landing.part_{int(part)}",
                        "value": value,
                    }
                )

        # Preserve generic natural-language mappings even when target is not indexed/hardcoded.
        # Example: "change promo strip title to Summer Sale"
        generic_kv_entries: list[dict[str, str]] = []
        generic_kv_pattern = re.compile(
            r"\b(?:change|set|update)\s+(?P<target>.+?)\s+(?:to|as|=|:)\s*(?P<value>[^,\n]+)",
            flags=re.IGNORECASE,
        )
        for match in generic_kv_pattern.finditer(message):
            raw_target = clean_value(match.group("target"))
            raw_value = clean_value(match.group("value"))
            if not raw_target or not raw_value:
                continue

            lowered_target = raw_target.lower()
            # Skip targets already covered by structured parsers in this method.
            if re.search(r"\b(hero\s*[123]|hero\s*description)\b", lowered_target):
                continue
            if re.search(r"\blanding(?:[\s\._-]*)part\b|\bpart[\s\._-]*\d+\b", lowered_target):
                continue
            if re.search(r"\bcompany\s+name\b|\bprimary\b|\bsecondary\b", lowered_target):
                continue

            generic_kv_entries.append(
                {
                    "type": "nl_key_value",
                    "scope": "frontend",
                    "target_raw": raw_target,
                    "value": raw_value,
                }
            )

        existing_extensions = current_manifest.get("extensions")
        merged_extensions: list[dict[str, Any]] = []
        if isinstance(existing_extensions, list):
            for item in existing_extensions:
                if isinstance(item, dict):
                    merged_extensions.append(json.loads(json.dumps(item)))

        # Merge all nl_key_value entries (hero/part + generic) with dedup.
        all_kv_entries = new_ui_entries + generic_kv_entries

        if all_kv_entries:
            def same_nl_key_value(left: dict[str, Any], right: dict[str, Any]) -> bool:
                return (
                    str(left.get("type", "")).strip().lower() == "nl_key_value"
                    and str(left.get("target_raw", "")).strip().lower()
                    == str(right.get("target_raw", "")).strip().lower()
                )

            for entry in all_kv_entries:
                replaced = False
                for index, existing in enumerate(merged_extensions):
                    if isinstance(existing, dict) and same_nl_key_value(existing, entry):
                        merged_extensions[index] = entry
                        replaced = True
                        break
                if not replaced:
                    merged_extensions.append(entry)

        # Preserve raw natural-language context to help downstream planner reasoning.
        normalized_message = re.sub(r"\s+", " ", message).strip()
        if normalized_message:
            nl_entry = {
                "type": "nl_instruction",
                "scope": "frontend",
                "value": normalized_message,
            }

            replaced_nl = False
            for index, existing in enumerate(merged_extensions):
                if (
                    isinstance(existing, dict)
                    and str(existing.get("type", "")).strip().lower() == "nl_instruction"
                    and str(existing.get("scope", "")).strip().lower() == "frontend"
                ):
                    merged_extensions[index] = nl_entry
                    replaced_nl = True
                    break
            if not replaced_nl:
                merged_extensions.append(nl_entry)

        if merged_extensions:
            patch["extensions"] = merged_extensions

        categories_patch: dict[str, Any] = {}
        branding_patch: dict[str, Any] = {}
        theme_patch: dict[str, Any] = {}

        company_match = re.search(r"company\s+name\s*(?:is|=|:)\s*([^,\n]+)", message, flags=re.IGNORECASE)
        if company_match:
            company_name = clean_value(company_match.group(1))
            if company_name:
                branding_patch["company_name"] = company_name

        both_theme_match = re.search(
            r"primary\s+([#a-zA-Z0-9_\-]+)\s+and\s+secondary\s+([#a-zA-Z0-9_\-]+)",
            message,
            flags=re.IGNORECASE,
        )
        if both_theme_match:
            primary = clean_value(both_theme_match.group(1))
            secondary = clean_value(both_theme_match.group(2))
            if primary:
                theme_patch["primary"] = primary
            if secondary:
                theme_patch["secondary"] = secondary
        else:
            primary_match = re.search(r"primary(?:\s+theme\s+color)?\s*(?:is|=|:)\s*([#a-zA-Z0-9_\-]+)", message, flags=re.IGNORECASE)
            secondary_match = re.search(r"secondary(?:\s+theme\s+color)?\s*(?:is|=|:)\s*([#a-zA-Z0-9_\-]+)", message, flags=re.IGNORECASE)
            if primary_match:
                primary = clean_value(primary_match.group(1))
                if primary:
                    theme_patch["primary"] = primary
            if secondary_match:
                secondary = clean_value(secondary_match.group(1))
                if secondary:
                    theme_patch["secondary"] = secondary

        remove_login_image = bool(
            re.search(r"\b(remove|hide|disable)\b", message, flags=re.IGNORECASE)
            and re.search(r"\blogin\b|\bonboard\b|\bauth\b", message, flags=re.IGNORECASE)
            and re.search(r"\bimage\b|\bpicture\b|\billustration\b|\bregimg\b", message, flags=re.IGNORECASE)
        )
        if remove_login_image:
            features_patch = categories_patch.get("features")
            if not isinstance(features_patch, dict):
                features_patch = {}
                categories_patch["features"] = features_patch
            features_patch["auth_hide_image"] = True

        if branding_patch:
            categories_patch["branding"] = branding_patch
        if theme_patch:
            categories_patch["theme"] = theme_patch
        if categories_patch:
            patch["categories"] = categories_patch

        return patch

    def _range_overlaps(self, start: int, end: int, left: int, right: int) -> bool:
        return max(start, left) <= min(end, right)

    def _parse_landing_part_removal_request(
        self,
        message: str,
        current_manifest: dict[str, Any],
    ) -> dict[str, Any] | None:
        """
        Deterministic parser for commands like:
        - remove landing parts 6 to 13
        - remove landing part 12
        """
        normalized = message.strip().lower()

        range_match = re.search(
            r"\b(?:remove|disable|hide)\s+landing(?:[\s\._-]*)parts?\s*(?:part[\s\._-]*)?(?P<start>\d+)\s*(?:to|\-|through)\s*(?:landing(?:[\s\._-]*)parts?\s*(?:part[\s\._-]*)?)?(?P<end>\d+)\b",
            normalized,
        )
        dotted_range_match = re.search(
            r"\b(?:remove|disable|hide)\s+landing\.part[_\s\.-]*(?P<start>\d+)\s*(?:to|\-|through)\s*(?:landing\.part[_\s\.-]*)?(?P<end>\d+)\b",
            normalized,
        )
        single_match = re.search(
            r"\b(?:remove|disable|hide)\s+landing(?:[\s\._-]*)part[\s\._-]*(?P<single>\d+)\b",
            normalized,
        )
        dotted_single_match = re.search(
            r"\b(?:remove|disable|hide)\s+landing\.part[_\s\.-]*(?P<single>\d+)\b",
            normalized,
        )

        keep_matches = re.findall(
            r"\bkeep\s+landing(?:[\s\._-]*)part[\s\._-]*(\d+)\b|\bkeep\s+landing\.part[_\s\.-]*(\d+)\b",
            normalized,
        )
        keep_parts: set[int] = set()
        for left, right in keep_matches:
            token = left or right
            if token and token.isdigit():
                keep_parts.add(int(token))

        active_range = range_match or dotted_range_match

        if active_range:
            start = int(active_range.group("start"))
            end = int(active_range.group("end"))
        elif single_match or dotted_single_match:
            chosen = single_match or dotted_single_match
            if chosen is None:
                return None
            start = int(chosen.group("single"))
            end = start
        else:
            return None

        if start > end:
            start, end = end, start

        target_parts = set(range(start, end + 1))
        target_parts -= keep_parts

        feature_patch: dict[str, bool] = {}

        # Landing content blocks.
        if any(6 <= part <= 10 for part in target_parts):
            feature_patch["landing_provide"] = False
        if any(12 <= part <= 12 for part in target_parts):
            feature_patch["landing_hangout"] = False
        if any(13 <= part <= 14 for part in target_parts):
            feature_patch["landing_experts"] = False

        # Existing major sections.
        if any(16 <= part <= 17 for part in target_parts):
            feature_patch["communities"] = False
        if any(18 <= part <= 20 for part in target_parts):
            feature_patch["sessions"] = False

        # If keep parts explicitly request one of these blocks, re-enable it.
        if any(6 <= part <= 10 for part in keep_parts):
            feature_patch["landing_provide"] = True
        if 12 in keep_parts:
            feature_patch["landing_hangout"] = True
        if any(13 <= part <= 14 for part in keep_parts):
            feature_patch["landing_experts"] = True
        if any(16 <= part <= 17 for part in keep_parts):
            feature_patch["communities"] = True
        if any(18 <= part <= 20 for part in keep_parts):
            feature_patch["sessions"] = True

        # Natural language support for login image removal.
        login_image_remove = bool(
            re.search(r"\b(remove|hide|disable)\b", normalized)
            and re.search(r"\blogin\b|\bonboard\b|\bauth\b", normalized)
            and re.search(r"\bimage\b|\bpicture\b|\billustration\b|\bregimg\b", normalized)
        )
        if login_image_remove:
            feature_patch["auth_hide_image"] = True

        if not feature_patch:
            return {
                "response": "No removable landing block matched that request.",
                "manifest_patch": {},
                "questions": [],
            }

        existing_features = self._get_nested_value(current_manifest, "categories.features")
        merged_features: dict[str, Any] = {}
        if isinstance(existing_features, dict):
            merged_features.update(json.loads(json.dumps(existing_features)))
        merged_features.update(feature_patch)

        return {
            "response": f"Applied landing/login visibility changes from your request.",
            "manifest_patch": {
                "categories": {
                    "features": merged_features,
                }
            },
            "questions": [],
        }

    def _parse_remove_welcome_request(
        self,
        message: str,
        current_manifest: dict[str, Any],
    ) -> dict[str, Any] | None:
        normalized = message.strip().lower()
        if not normalized:
            return None

        remove_intent = bool(re.search(r"\b(remove|delete|hide|clear)\b", normalized))
        welcome_intent = bool(re.search(r"\bwelcome\b", normalized))
        if not (remove_intent and welcome_intent):
            return None

        existing_extensions = current_manifest.get("extensions")
        merged_extensions: list[dict[str, Any]] = []
        if isinstance(existing_extensions, list):
            for item in existing_extensions:
                if isinstance(item, dict):
                    merged_extensions.append(json.loads(json.dumps(item)))

        welcome_override = {
            "type": "nl_key_value",
            "scope": "frontend",
            "target_raw": "landing.hero_1",
            "value": "",
        }

        replaced = False
        for index, existing in enumerate(merged_extensions):
            if (
                str(existing.get("type", "")).strip().lower() == "nl_key_value"
                and str(existing.get("scope", "frontend")).strip().lower() == "frontend"
                and str(existing.get("target_raw", "")).strip().lower() in {"landing.hero_1", "landing.hero_headline"}
            ):
                merged_extensions[index] = welcome_override
                replaced = True
                break

        if not replaced:
            merged_extensions.append(welcome_override)

        return {
            "extensions": merged_extensions,
        }

    def _parse_ui_copy_commands_from_message(
        self,
        message: str,
        current_manifest: dict[str, Any],
    ) -> dict[str, Any] | None:
        """
        Deterministic fallback parser for explicit command syntax:
        Set ui_copy scope <scope> target <target> to <value>
        """
        pattern = re.compile(
            r"set\s+ui_copy\s+scope\s+(?P<scope>[a-zA-Z0-9_\-]+)\s+target\s+(?P<target>[a-zA-Z0-9_\-]+)\s+to\s+(?P<value>.*?)(?=(?:\bset\s+ui_copy\s+scope\b)|$)",
            flags=re.IGNORECASE | re.DOTALL,
        )

        matches = list(pattern.finditer(message))
        if not matches:
            return None

        def clean_value(raw: str) -> str:
            value = raw.strip()
            value = re.sub(r"^[\-:\s]+", "", value)
            value = value.strip()
            if len(value) >= 2:
                quote_pairs = [("\"", "\""), ("'", "'"), ("\u201c", "\u201d"), ("\u2018", "\u2019")]
                for left, right in quote_pairs:
                    if value.startswith(left) and value.endswith(right):
                        value = value[1:-1].strip()
                        break
            return value

        parsed_entries: list[dict[str, str]] = []
        for match in matches:
            scope = match.group("scope").strip().lower()
            target = match.group("target").strip().lower()
            value = clean_value(match.group("value"))
            if not value:
                continue
            parsed_entries.append(
                {
                    "type": "nl_key_value",
                    "scope": "frontend",
                    "target_raw": f"{scope}.{target}",
                    "value": value,
                }
            )

        if not parsed_entries:
            return None

        existing_extensions = current_manifest.get("extensions")
        merged_extensions: list[dict[str, Any]] = []
        if isinstance(existing_extensions, list):
            for item in existing_extensions:
                if isinstance(item, dict):
                    merged_extensions.append(json.loads(json.dumps(item)))

        def is_same_nl_kv(left: dict[str, Any], right: dict[str, Any]) -> bool:
            return (
                str(left.get("type", "")).strip().lower() == "nl_key_value"
                and str(left.get("target_raw", "")).strip().lower() == str(right.get("target_raw", "")).strip().lower()
            )

        for entry in parsed_entries:
            replaced = False
            for index, existing in enumerate(merged_extensions):
                if isinstance(existing, dict) and is_same_nl_kv(existing, entry):
                    merged_extensions[index] = entry
                    replaced = True
                    break
            if not replaced:
                merged_extensions.append(entry)

        return {
            "response": f"Applied {len(parsed_entries)} text update(s) from your command.",
            "manifest_patch": {
                "extensions": merged_extensions,
            },
            "questions": [],
        }

    def _build_prompt(self, message: str, current_manifest: dict[str, Any]) -> str:
        manifest_json = json.dumps(current_manifest, indent=2)
        return (
            f"{self.prompt_template}\n\n"
            "Current manifest JSON:\n"
            f"{manifest_json}\n\n"
            "User message:\n"
            f"{message}\n\n"
            "Return exactly one JSON object with this shape:\n"
            "{\n"
            '  "response": "assistant reply shown to the user",\n'
            '  "manifest_patch": { },\n'
            '  "questions": []\n'
            "}\n\n"
            "Rules:\n"
            "- Return only fields that need to change in manifest_patch.\n"
            "- Do not return the full manifest.\n"
            "- Use the manifest categories already defined in the current manifest.\n"
            "- Keep backend logic immutable.\n"
            "- Prefer typed fields under categories over extensions when possible.\n"
            "- If a user request introduces a new tenant field not present in the typed schema, add it under extensions.\n"
            "- Preserve freeform UI copy requests that do not fit the typed schema under extensions, using the user's exact requested wording.\n"
            "- Example extension entry for frontend text: {\"type\": \"nl_key_value\", \"scope\": \"frontend\", \"target_raw\": \"landing.hero_1\", \"value\": \"Safwan welcome\"}.\n"
            "- flow_rules must stay declarative and only use supported preset-style rules.\n"
            "- You are a tenant configuration assistant. Ask follow-up questions only when the request is genuinely ambiguous and cannot be mapped safely.\n"
            "- Do not ask follow-up questions for known frontend alias requests (landing.hero_1/2/3, hero description, landing text keys, topbar/footer/auth text keys, all_sessions/contact/home/my_schedule/my_communities/search text keys, browse_classes/cart_checkout/course_details/community_details/user_settings/all_sessions_live/all_sessions_videos/community_home/community_subscription/media_player/community_commerce/category_sessions/trainer_bio/user_portal/session_management/community_threads/student_registration text keys, visibility toggles, style changes, remove landing parts X-Y with keep part Z, remove login image, company name, primary/secondary colors).\n"
            "- If the user explicitly indicates that no further changes are required, you must stop asking questions and terminate the interaction immediately. Missing fields are acceptable and should remain unchanged.\n"
            "- If the user explicitly requests no changes, return an empty manifest_patch and no questions.\n"
            "- Any follow-up question must appear both inside the response text and inside the questions array.\n"
            "- questions must be an array of plain strings and may be empty if no clarification is needed.\n"
            "- Do not include markdown, code fences, or explanations outside the JSON object."
        )

    def _call_llm(self, prompt: str) -> str:
        api_key = os.getenv("LLM_API_KEY", os.getenv("HF_API_KEY", "")).strip()
        model = os.getenv("LLM_MODEL_ID", os.getenv("HF_MODEL_ID", self.MODEL)).strip() or self.MODEL
        api_url = os.getenv("LLM_API_URL", os.getenv("HF_API_URL", self.API_URL)).strip() or self.API_URL
        provider = os.getenv("LLM_PROVIDER", "").strip().lower() or self._infer_provider(api_url)
        is_anthropic = provider == "anthropic"

        if is_anthropic:
            payload = {
                "model": model,
                "system": "You extract safe tenant manifest patches and must return strict JSON only. If the user explicitly indicates that no further changes are required, you must stop asking questions and terminate the interaction immediately. Missing fields are acceptable and should remain unchanged.",
                "messages": [
                    {"role": "user", "content": prompt},
                ],
                "temperature": 0.1,
                "max_tokens": 1200,
            }
        else:
            payload = {
                "model": model,
                "messages": [
                    {
                        "role": "system",
                        "content": "You extract safe tenant manifest patches and must return strict JSON only. If the user explicitly indicates that no further changes are required, you must stop asking questions and terminate the interaction immediately. Missing fields are acceptable and should remain unchanged.",
                    },
                    {"role": "user", "content": prompt},
                ],
                "temperature": 0.1,
                "max_tokens": 1200,
                "stream": False,
            }

        use_response_format = os.getenv("LLM_USE_RESPONSE_FORMAT", "true").strip().lower() in {
            "1",
            "true",
            "yes",
            "on",
        }
        if use_response_format and not is_anthropic:
            payload["response_format"] = {"type": "json_object"}

        headers = {
            "Content-Type": "application/json",
        }
        if is_anthropic:
            if api_key:
                headers["x-api-key"] = api_key
            headers["anthropic-version"] = "2023-06-01"
        elif api_key:
            headers["Authorization"] = f"Bearer {api_key}"

        req = request.Request(
            api_url,
            data=json.dumps(payload).encode("utf-8"),
            headers=headers,
            method="POST",
        )

        body = ""
        for attempt in range(1, self.max_retries + 2):
            try:
                with request.urlopen(req, timeout=60) as response:
                    body = response.read().decode("utf-8")
                break
            except error.HTTPError as exc:
                details = exc.read().decode("utf-8", errors="ignore")

                # Some local OpenAI-compatible servers may reject response_format.
                if use_response_format and not is_anthropic and exc.code in {400, 422}:
                    payload.pop("response_format", None)
                    retry_req = request.Request(
                        api_url,
                        data=json.dumps(payload).encode("utf-8"),
                        headers=headers,
                        method="POST",
                    )
                    try:
                        with request.urlopen(retry_req, timeout=60) as response:
                            body = response.read().decode("utf-8")
                        break
                    except error.HTTPError as retry_exc:
                        retry_details = retry_exc.read().decode("utf-8", errors="ignore")
                        if (
                            attempt <= self.max_retries
                            and self._is_transient_http_error(retry_exc.code, retry_details)
                        ):
                            time.sleep(self._retry_delay_seconds(attempt, retry_exc))
                            continue
                        raise RuntimeError(f"LLM API returned HTTP {retry_exc.code}: {retry_details}") from retry_exc
                    except error.URLError as retry_exc:
                        raise RuntimeError(f"Could not reach LLM API: {retry_exc.reason}") from retry_exc

                if attempt <= self.max_retries and self._is_transient_http_error(exc.code, details):
                    time.sleep(self._retry_delay_seconds(attempt, exc))
                    continue

                raise RuntimeError(f"LLM API returned HTTP {exc.code}: {details}") from exc
            except error.URLError as exc:
                raise RuntimeError(f"Could not reach LLM API: {exc.reason}") from exc

        if not body:
            raise RuntimeError("LLM API returned an empty response body")

        parsed_body = self._parse_http_json_body(body)
        if is_anthropic:
            content_blocks = parsed_body.get("content", []) if isinstance(parsed_body, dict) else []
            text_parts: list[str] = []
            if isinstance(content_blocks, list):
                for item in content_blocks:
                    if isinstance(item, dict) and item.get("type") == "text":
                        text_parts.append(str(item.get("text", "")))
            content_text = "".join(text_parts).strip()
            if content_text:
                return content_text
            raise RuntimeError("Unexpected response format from Anthropic API")

        content = parsed_body["choices"][0]["message"]["content"]
        if isinstance(content, list):
            text_parts = []
            for item in content:
                if isinstance(item, dict) and item.get("type") == "text":
                    text_parts.append(item.get("text", ""))
            return "".join(text_parts)
        if isinstance(content, str):
            return content
        raise RuntimeError("Unexpected response format from LLM API")

    def _parse_http_json_body(self, body: str) -> dict[str, Any]:
        """
        Parse provider responses that may include extra trailing chunks.
        Some OpenAI-compatible providers can return newline-delimited JSON-like data.
        """
        decoder = json.JSONDecoder()
        stripped = body.strip()
        if not stripped:
            raise RuntimeError("LLM API returned an empty response body")

        try:
            parsed, _ = decoder.raw_decode(stripped)
        except json.JSONDecodeError:
            extracted = self._extract_json_object(stripped)
            parsed = json.loads(extracted)

        if not isinstance(parsed, dict):
            raise RuntimeError("LLM API response was not a JSON object")
        return parsed

    def _parse_model_output(self, raw_content: str) -> dict[str, Any]:
        cleaned = self._clean_llm_json(raw_content)

        parsed = self._decode_first_json_value(cleaned)
        if parsed is None:
            try:
                extracted = self._extract_json_object(cleaned)
                parsed = json.loads(extracted)
            except json.JSONDecodeError as exc:
                raise RuntimeError(f"Invalid JSON returned by model: {exc}") from exc

        if not isinstance(parsed, dict):
            raise RuntimeError("Model output was not a JSON object")
        return parsed

    def _decode_first_json_value(self, content: str) -> Any:
        """
        Decode only the first JSON value from model output and ignore trailing text.
        This prevents failures such as 'Extra data' when providers append content.
        """
        decoder = json.JSONDecoder()
        stripped = content.lstrip()
        if not stripped:
            return None

        try:
            parsed, _ = decoder.raw_decode(stripped)
            return parsed
        except json.JSONDecodeError:
            start_object = stripped.find("{")
            start_array = stripped.find("[")
            starts = [position for position in [start_object, start_array] if position != -1]
            if not starts:
                return None
            start = min(starts)
            try:
                parsed, _ = decoder.raw_decode(stripped[start:])
                return parsed
            except json.JSONDecodeError:
                return None

    def _normalize_result(self, parsed: dict[str, Any]) -> dict[str, Any]:
        if "manifest_patch" in parsed:
            manifest_patch = parsed.get("manifest_patch") or {}
            response = parsed.get("response") or "Manifest patch generated."
            questions = parsed.get("questions") or []
        else:
            manifest_patch = parsed
            response = "Manifest patch generated."
            questions = []

        if not isinstance(manifest_patch, dict):
            raise RuntimeError("manifest_patch must be a JSON object")
        if not isinstance(response, str):
            response = str(response)
        if not isinstance(questions, list):
            raise RuntimeError("questions must be a list")

        normalized_questions = []
        for question in questions:
            if isinstance(question, str):
                stripped = question.strip()
                if stripped:
                    normalized_questions.append(stripped)
            else:
                raise RuntimeError("questions must contain only strings")

        if self.enforce_required_field_questions:
            deterministic_questions = self._collect_missing_required_questions(manifest_patch)
            for question in deterministic_questions:
                if question not in normalized_questions:
                    normalized_questions.append(question)

        response = response.strip()
        if normalized_questions:
            missing_questions = [question for question in normalized_questions if question not in response]
            if missing_questions:
                question_lines = "\n".join(
                    f"{index}. {question}" for index, question in enumerate(normalized_questions, start=1)
                )
                if response:
                    response = f"{response}\n\nI need a few more details:\n{question_lines}"
                else:
                    response = f"I need a few more details:\n{question_lines}"

        cleaned_patch = self._prune_empty(manifest_patch)
        response = self._build_quality_response(
            base_response=response,
            manifest_patch=cleaned_patch if isinstance(cleaned_patch, dict) else {},
            questions=normalized_questions,
        )

        return {
            "response": response,
            "manifest_patch": cleaned_patch,
            "questions": normalized_questions,
        }

    def _format_patch_value(self, value: Any) -> str:
        if isinstance(value, bool):
            return "true" if value else "false"
        if isinstance(value, (int, float)):
            return str(value)
        if isinstance(value, str):
            return value
        return json.dumps(value, ensure_ascii=True)

    def _collect_patch_highlights(self, manifest_patch: dict[str, Any]) -> list[str]:
        highlights: list[str] = []
        categories = manifest_patch.get("categories")
        if isinstance(categories, dict):
            branding = categories.get("branding")
            if isinstance(branding, dict):
                if isinstance(branding.get("company_name"), str) and branding.get("company_name", "").strip():
                    highlights.append(f"Branding company_name -> {branding['company_name'].strip()}")
                if isinstance(branding.get("title"), str) and branding.get("title", "").strip():
                    highlights.append(f"Branding title -> {branding['title'].strip()}")

            theme = categories.get("theme")
            if isinstance(theme, dict):
                for key in ["primary", "secondary", "accent", "font_heading", "font_body", "border_radius"]:
                    if key in theme and self._format_patch_value(theme[key]).strip():
                        highlights.append(f"Theme {key} -> {self._format_patch_value(theme[key])}")

            portals = categories.get("portals")
            if isinstance(portals, dict):
                portal_updates = [
                    f"{key}={self._format_patch_value(value)}"
                    for key, value in portals.items()
                    if key and self._format_patch_value(value).strip()
                ]
                if portal_updates:
                    highlights.append(f"Portals {', '.join(portal_updates)}")

            features = categories.get("features")
            if isinstance(features, dict):
                feature_updates = [
                    f"{key}={self._format_patch_value(value)}"
                    for key, value in features.items()
                    if key and self._format_patch_value(value).strip()
                ]
                if feature_updates:
                    highlights.append(f"Features {', '.join(feature_updates)}")

        extensions = manifest_patch.get("extensions")
        if isinstance(extensions, list) and extensions:
            extension_parts: list[str] = []
            for item in extensions[:4]:
                if not isinstance(item, dict):
                    continue
                item_type = str(item.get("type", "")).strip() or "extension"
                target_raw = str(item.get("target_raw", "")).strip()
                value = item.get("value")
                if target_raw:
                    extension_parts.append(f"{item_type}:{target_raw} -> {self._format_patch_value(value)}")
                else:
                    extension_parts.append(f"{item_type} -> {self._format_patch_value(value)}")
            if extension_parts:
                highlights.append(f"Extensions {'; '.join(extension_parts)}")

        return highlights[:8]

    def _build_quality_response(self, base_response: str, manifest_patch: dict[str, Any], questions: list[str]) -> str:
        response = (base_response or "").strip()

        if questions:
            return response or "I need a few more details before applying safe changes."

        highlights = self._collect_patch_highlights(manifest_patch)
        if not highlights:
            return response or "No manifest fields were changed from this message."

        lines = ["Updated draft manifest:"]
        for item in highlights:
            lines.append(f"- {item}")
        lines.append("Next step: click Confirm, then Execute Implement to apply changes.")

        summary = "\n".join(lines)
        if not response:
            return summary

        # Keep any useful model phrasing, but ensure high-signal structured output is always present.
        return f"{response}\n\n{summary}"

    def _is_no_change_request(self, message: str) -> bool:
        normalized = message.strip().lower()
        return any(re.search(pattern, normalized) for pattern in self.NO_CHANGE_PATTERNS)

    def _collect_missing_required_questions(self, manifest_patch: dict[str, Any]) -> list[str]:
        current_manifest = getattr(self, "_current_manifest", {})
        merged = self._deep_merge(self._copy_dict(current_manifest), manifest_patch)
        questions = []
        for path, question in self.REQUIRED_FIELD_QUESTIONS.items():
            value = self._get_nested_value(merged, path)
            if self._is_missing_value(value):
                questions.append(question)
        return questions

    def _clean_llm_json(self, raw_content: str) -> str:
        cleaned = raw_content.strip()
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.IGNORECASE)
        cleaned = re.sub(r"\s*```$", "", cleaned)
        cleaned = cleaned.replace("\ufeff", "").strip()
        return cleaned

    def _extract_json_object(self, content: str) -> str:
        start = content.find("{")
        if start == -1:
            raise RuntimeError("No JSON object found in model output")

        depth = 0
        in_string = False
        escape = False
        for index in range(start, len(content)):
            char = content[index]

            if in_string:
                if escape:
                    escape = False
                elif char == "\\":
                    escape = True
                elif char == '"':
                    in_string = False
                continue

            if char == '"':
                in_string = True
            elif char == "{":
                depth += 1
            elif char == "}":
                depth -= 1
                if depth == 0:
                    return content[start : index + 1]

        raise RuntimeError("Incomplete JSON object in model output")

    def _prune_empty(self, value: Any) -> Any:
        if isinstance(value, dict):
            cleaned: dict[str, Any] = {}
            entry_type = str(value.get("type", "")).strip().lower()
            for key, inner in value.items():
                pruned = self._prune_empty(inner)
                if key == "value" and isinstance(pruned, str) and pruned == "" and entry_type in {"nl_key_value", "ui_copy"}:
                    cleaned[key] = pruned
                    continue
                if pruned not in ({}, [], ""):
                    cleaned[key] = pruned
            return cleaned
        if isinstance(value, list):
            cleaned_list = []
            for item in value:
                pruned = self._prune_empty(item)
                if pruned not in ({}, [], ""):
                    cleaned_list.append(pruned)
            return cleaned_list
        return value

    def _copy_dict(self, value: dict[str, Any]) -> dict[str, Any]:
        return json.loads(json.dumps(value))

    def _deep_merge(self, target: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
        for key, value in patch.items():
            if isinstance(value, dict) and isinstance(target.get(key), dict):
                self._deep_merge(target[key], value)
            else:
                target[key] = value
        return target

    def _get_nested_value(self, payload: dict[str, Any], dotted_path: str) -> Any:
        current: Any = payload
        for key in dotted_path.split("."):
            if not isinstance(current, dict) or key not in current:
                return None
            current = current[key]
        return current

    def _is_missing_value(self, value: Any) -> bool:
        if value is None:
            return True
        if isinstance(value, str):
            return not value.strip()
        return False
