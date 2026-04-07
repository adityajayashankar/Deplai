from __future__ import annotations

import json
import os
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from threading import Lock
from urllib import error as urlerror
from urllib import request as urlrequest

from remediation_pipeline.models import ProviderQuota, ProviderStatusResponse


DEFAULT_TIMEOUT_SECONDS = 10


@dataclass
class ProviderConfig:
    name: str
    model: str
    quota_daily: int
    priority: int


class LLMRouter:
    """Route requests through free-tier providers with quota-aware fallback."""

    def __init__(self) -> None:
        self._configs: list[ProviderConfig] = [
            ProviderConfig("groq", os.getenv("REMEDIATION_GROQ_MODEL", "llama-3.3-70b-versatile"), int(os.getenv("REMEDIATION_GROQ_DAILY_QUOTA", "14400")), 1),
            ProviderConfig("openrouter", os.getenv("REMEDIATION_OPENROUTER_MODEL", "deepseek/deepseek-chat-v3-0324:free"), int(os.getenv("REMEDIATION_OPENROUTER_DAILY_QUOTA", "50")), 2),
            ProviderConfig("ollama", os.getenv("OLLAMA_MODEL", "qwen2.5-coder:7b"), int(os.getenv("REMEDIATION_OLLAMA_DAILY_QUOTA", "1000000")), 3),
            ProviderConfig("opencode", os.getenv("OPENCODE_MODEL", "gpt-4o-mini"), int(os.getenv("REMEDIATION_OPENCODE_DAILY_QUOTA", "1000000")), 4),
        ]
        self._used_today: dict[str, int] = {cfg.name: 0 for cfg in self._configs}
        self._reset_at_utc = self._next_midnight_utc()
        self._lock = Lock()

    def route(self, prompt: str, estimated_tokens: int) -> tuple[str, str, int]:
        self._reset_if_needed()

        errors: list[str] = []
        for cfg in sorted(self._configs, key=lambda item: item.priority):
            if not self._has_quota(cfg):
                continue

            ok, response = self._dispatch(cfg, prompt)
            if ok:
                with self._lock:
                    self._used_today[cfg.name] = self._used_today.get(cfg.name, 0) + 1
                tokens_used = max(estimated_tokens, len(response) // 4)
                return response, cfg.name, tokens_used

            errors.append(f"{cfg.name}: {response}")
            if "429" in response.lower() or "rate limit" in response.lower():
                continue

        raise RuntimeError("All remediation providers failed: " + " | ".join(errors))

    def status(self) -> ProviderStatusResponse:
        self._reset_if_needed()
        providers = [
            ProviderQuota(
                provider=cfg.name,
                model=cfg.model,
                quota_daily=cfg.quota_daily,
                calls_used_today=self._used_today.get(cfg.name, 0),
                reset_at_utc=self._reset_at_utc,
            )
            for cfg in sorted(self._configs, key=lambda item: item.priority)
        ]
        return ProviderStatusResponse(providers=providers)

    def _has_quota(self, cfg: ProviderConfig) -> bool:
        used = self._used_today.get(cfg.name, 0)
        return used < cfg.quota_daily

    def _reset_if_needed(self) -> None:
        now = datetime.now(UTC)
        with self._lock:
            if now < self._reset_at_utc:
                return
            self._used_today = {cfg.name: 0 for cfg in self._configs}
            self._reset_at_utc = self._next_midnight_utc()

    @staticmethod
    def _next_midnight_utc() -> datetime:
        now = datetime.now(UTC)
        tomorrow = now.date() + timedelta(days=1)
        return datetime.combine(tomorrow, datetime.min.time(), tzinfo=UTC)

    def _dispatch(self, cfg: ProviderConfig, prompt: str) -> tuple[bool, str]:
        if cfg.name == "groq":
            api_key = os.getenv("GROQ_API_KEY", "").strip()
            if not api_key:
                return False, "Missing GROQ_API_KEY"
            base = os.getenv("GROQ_BASE_URL", "https://api.groq.com/openai/v1").rstrip("/")
            return self._openai_compatible_chat(
                url=f"{base}/chat/completions",
                api_key=api_key,
                model=cfg.model,
                prompt=prompt,
            )

        if cfg.name == "openrouter":
            api_key = os.getenv("OPENROUTER_API_KEY", "").strip()
            if not api_key:
                return False, "Missing OPENROUTER_API_KEY"
            base = os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1").rstrip("/")
            extra = {
                "HTTP-Referer": os.getenv("NEXT_PUBLIC_APP_URL", "http://localhost:3000"),
                "X-Title": os.getenv("OPENROUTER_APP_NAME", "deplai-agentic"),
            }
            return self._openai_compatible_chat(
                url=f"{base}/chat/completions",
                api_key=api_key,
                model=cfg.model,
                prompt=prompt,
                extra_headers=extra,
            )

        if cfg.name == "ollama":
            api_key = os.getenv("OLLAMA_API_KEY", "").strip()
            if not api_key:
                return False, "Missing OLLAMA_API_KEY"
            endpoint = os.getenv("OLLAMA_CLOUD_CHAT_ENDPOINT", "https://ollama.com/api/chat")
            payload = {
                "model": cfg.model,
                "messages": [{"role": "user", "content": prompt}],
                "stream": False,
                "options": {"temperature": 0.1, "num_predict": 1400},
            }
            headers = {
                "Content-Type": "application/json",
                "Authorization": f"Bearer {api_key}",
                "User-Agent": "deplai-agentic/1.0",
            }
            return self._raw_chat(endpoint, payload, headers, response_path=("message", "content"))

        if cfg.name == "opencode":
            api_key = os.getenv("OPENCODE_API_KEY", "").strip()
            if not api_key:
                return False, "Missing OPENCODE_API_KEY"
            base = os.getenv("OPENCODE_BASE_URL", "https://api.openai.com/v1").rstrip("/")
            return self._openai_compatible_chat(
                url=f"{base}/chat/completions",
                api_key=api_key,
                model=cfg.model,
                prompt=prompt,
            )

        return False, f"Unsupported provider: {cfg.name}"

    def _openai_compatible_chat(
        self,
        *,
        url: str,
        api_key: str,
        model: str,
        prompt: str,
        extra_headers: dict[str, str] | None = None,
    ) -> tuple[bool, str]:
        payload = {
            "model": model,
            "temperature": 0.1,
            "max_tokens": 1400,
            "messages": [{"role": "user", "content": prompt}],
        }
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
            "User-Agent": "deplai-agentic/1.0",
        }
        if extra_headers:
            headers.update(extra_headers)
        return self._raw_chat(url, payload, headers, response_path=("choices", 0, "message", "content"))

    @staticmethod
    def _raw_chat(
        url: str,
        payload: dict,
        headers: dict[str, str],
        response_path: tuple,
    ) -> tuple[bool, str]:
        req = urlrequest.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        try:
            with urlrequest.urlopen(req, timeout=DEFAULT_TIMEOUT_SECONDS) as response:
                body = response.read().decode("utf-8")
                data = json.loads(body)
        except urlerror.HTTPError as exc:
            raw = exc.read().decode("utf-8", errors="replace")
            return False, f"HTTP {exc.code}: {raw}"
        except Exception as exc:
            return False, str(exc)

        value: object = data
        try:
            for key in response_path:
                if isinstance(key, int):
                    value = value[key]  # type: ignore[index]
                else:
                    value = value[key]  # type: ignore[index]
        except Exception:
            return False, "Malformed LLM response payload"

        text = str(value or "").strip()
        if not text:
            return False, "Empty LLM response"
        return True, text
