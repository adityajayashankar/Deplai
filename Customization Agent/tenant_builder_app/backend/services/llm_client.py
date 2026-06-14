from __future__ import annotations

import json
import os
import re
import time
from typing import Any
from urllib import error, request

from services.llm_provider_config import (
    DEFAULT_HF_MODEL,
    HF_API_URL,
    infer_provider,
    resolve_llm_provider_configs,
    LLMProviderConfig,
)


class ProjectLLMClient:
    DEFAULT_API_URL = HF_API_URL
    DEFAULT_MODEL = DEFAULT_HF_MODEL

    def __init__(self, byok_config: Any | None = None) -> None:
        if byok_config is not None:
            # Map BYOK config to LLMProviderConfig just like llm_interpreter
            provider_id = (getattr(byok_config, 'provider', '') or '').strip().lower()
            OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions'
            ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
            OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions'
            MINIMAX_API_URL = 'https://api.minimax.chat/v1/text/chatcompletion_v2'
            
            provider_url_map = {
                'openai': ('openai', OPENAI_API_URL),
                'anthropic': ('anthropic', ANTHROPIC_API_URL),
                'groq': ('openai', 'https://api.groq.com/openai/v1/chat/completions'),
                'openrouter': ('openrouter', OPENROUTER_API_URL),
                'minimax': ('openai', MINIMAX_API_URL),
            }
            provider_norm, api_url = provider_url_map.get(provider_id, (provider_id, OPENAI_API_URL))
            
            jit_config = LLMProviderConfig(
                provider=provider_norm,
                api_url=api_url,
                model=getattr(byok_config, 'model', getattr(byok_config, 'modelId', self.DEFAULT_MODEL)),
                api_key=getattr(byok_config, 'api_key', getattr(byok_config, 'apiKey', '')),
            )
            self.provider_configs = [jit_config]
        else:
            self.provider_configs = resolve_llm_provider_configs()
        first_config = self.provider_configs[0]
        self.api_url = first_config.api_url
        self.model = first_config.model
        self.api_key = first_config.api_key
        self.provider = first_config.provider
        self.use_response_format = os.getenv("LLM_USE_RESPONSE_FORMAT", "true").strip().lower() in {
            "1",
            "true",
            "yes",
            "on",
        }
        self.max_retries = max(0, int(os.getenv("LLM_MAX_RETRIES", "2") or "2"))
        self.request_timeout_seconds = max(
            5,
            int(os.getenv("LLM_REQUEST_TIMEOUT_SECONDS", "20") or "20"),
        )
        self.retry_base_delay_seconds = max(
            0.1,
            float(os.getenv("LLM_RETRY_BASE_DELAY_SECONDS", "1.5") or "1.5"),
        )

    def _infer_provider(self) -> str:
        return infer_provider(self.api_url)

    def _use_provider_config(self, config: Any) -> None:
        self.api_url = config.api_url
        self.model = config.model
        self.api_key = config.api_key
        self.provider = config.provider

    def is_configured(self) -> bool:
        return bool(self.api_url and self.model)

    def _build_payload(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        max_tokens: int,
        temperature: float,
        include_response_format: bool,
    ) -> dict[str, Any]:
        if self.provider == "anthropic":
            return {
                "model": self.model,
                "system": system_prompt,
                "messages": [
                    {"role": "user", "content": user_prompt},
                ],
                "temperature": temperature,
                "max_tokens": max_tokens,
            }

        payload: dict[str, Any] = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        if include_response_format and self.provider != "anthropic":
            payload["response_format"] = {"type": "json_object"}
        return payload

    def _send_request(self, payload: dict[str, Any]) -> str:
        headers = {
            "Content-Type": "application/json",
        }
        if self.provider == "anthropic":
            if self.api_key:
                headers["x-api-key"] = self.api_key
            headers["anthropic-version"] = "2023-06-01"
        elif self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"

        req = request.Request(
            self.api_url,
            data=json.dumps(payload).encode("utf-8"),
            headers=headers,
            method="POST",
        )

        with request.urlopen(req, timeout=self.request_timeout_seconds) as response:
            return response.read().decode("utf-8")

    def _is_transient_http_error(self, code: int, details: str) -> bool:
        if code in {429, 500, 502, 503, 504}:
            return True
        lowered = details.lower()
        return "server_overload" in lowered or "overload" in lowered or "try again later" in lowered

    def _retry_delay_seconds(self, attempt: int, exc: error.HTTPError) -> float:
        retry_after_raw = exc.headers.get("Retry-After") if exc.headers else None
        if retry_after_raw:
            try:
                return max(0.1, float(retry_after_raw))
            except ValueError:
                pass
        return self.retry_base_delay_seconds * (2 ** (attempt - 1))

    def _format_http_error_details(self, details: str) -> str:
        compact = re.sub(r"<[^>]+>", " ", details or "")
        compact = re.sub(r"\s+", " ", compact).strip()
        if not compact:
            return "no response body"
        return compact[:500] + ("..." if len(compact) > 500 else "")

    def complete_json(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        max_tokens: int = 1400,
        temperature: float = 0.1,
    ) -> Any:
        if not self.is_configured():
            raise RuntimeError("LLM client is not configured: set LLM_API_URL and LLM_MODEL_ID.")

        failures: list[str] = []
        for config in self.provider_configs:
            self._use_provider_config(config)
            try:
                return self._complete_json_current_provider(
                    system_prompt=system_prompt,
                    user_prompt=user_prompt,
                    max_tokens=max_tokens,
                    temperature=temperature,
                )
            except RuntimeError as exc:
                failures.append(str(exc))
                continue

        joined = " | ".join(failures[-3:]) if failures else "no provider attempts were made"
        raise RuntimeError(f"All configured LLM providers failed: {joined}")

    def _complete_json_current_provider(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        max_tokens: int,
        temperature: float,
    ) -> Any:
        payload = self._build_payload(
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            max_tokens=max_tokens,
            temperature=temperature,
            include_response_format=self.use_response_format,
        )

        for attempt in range(1, self.max_retries + 2):
            try:
                body = self._send_request(payload)
                break
            except error.HTTPError as exc:
                details = exc.read().decode("utf-8", errors="ignore")

                # Some local OpenAI-compatible servers do not support response_format.
                if self.use_response_format and self.provider != "anthropic" and exc.code in {400, 422}:
                    retry_payload = self._build_payload(
                        system_prompt=system_prompt,
                        user_prompt=user_prompt,
                        max_tokens=max_tokens,
                        temperature=temperature,
                        include_response_format=False,
                    )
                    try:
                        body = self._send_request(retry_payload)
                        break
                    except error.HTTPError as retry_exc:
                        retry_details = retry_exc.read().decode("utf-8", errors="ignore")
                        if (
                            attempt <= self.max_retries
                            and self._is_transient_http_error(retry_exc.code, retry_details)
                        ):
                            time.sleep(self._retry_delay_seconds(attempt, retry_exc))
                            continue
                        raise RuntimeError(
                            f"LLM API returned HTTP {retry_exc.code} on retry "
                            f"(provider={self.provider}, url={self.api_url}): "
                            f"{self._format_http_error_details(retry_details)}"
                        ) from retry_exc
                    except error.URLError as retry_exc:
                        raise RuntimeError(
                            f"Could not reach LLM API on retry (provider={self.provider}, url={self.api_url}): {retry_exc.reason}"
                        ) from retry_exc

                if attempt <= self.max_retries and self._is_transient_http_error(exc.code, details):
                    time.sleep(self._retry_delay_seconds(attempt, exc))
                    continue

                raise RuntimeError(
                    f"LLM API returned HTTP {exc.code} "
                    f"(provider={self.provider}, url={self.api_url}): "
                    f"{self._format_http_error_details(details)}"
                ) from exc
            except error.URLError as exc:
                raise RuntimeError(
                    f"Could not reach LLM API (provider={self.provider}, url={self.api_url}): {exc.reason}"
                ) from exc

        try:
            parsed_body = json.loads(body)
        except json.JSONDecodeError as exc:
            raise RuntimeError("LLM API returned non-JSON response") from exc
        if self.provider == "anthropic":
            content_blocks = parsed_body.get("content", []) if isinstance(parsed_body, dict) else []
            text_parts: list[str] = []
            if isinstance(content_blocks, list):
                for block in content_blocks:
                    if isinstance(block, dict) and block.get("type") == "text":
                        text_parts.append(str(block.get("text", "")))
            raw_text = "".join(text_parts).strip()
            if not raw_text:
                raise RuntimeError("Unexpected response format from Anthropic API")
        else:
            if not isinstance(parsed_body, dict):
                raise RuntimeError("Unexpected response format from LLM API: response body is not an object")
            choices = parsed_body.get("choices")
            if not isinstance(choices, list) or not choices:
                detail = parsed_body.get("error") if isinstance(parsed_body.get("error"), (str, dict)) else parsed_body
                raise RuntimeError(f"Unexpected response format from LLM API: missing choices ({str(detail)[:300]})")
            first_choice = choices[0]
            if not isinstance(first_choice, dict):
                raise RuntimeError("Unexpected response format from LLM API: invalid choices[0]")
            message = first_choice.get("message")
            if not isinstance(message, dict) or "content" not in message:
                raise RuntimeError("Unexpected response format from LLM API: missing message.content")
            content = message["content"]
            raw_text = self._normalize_content(content)
        return self._parse_json(raw_text)

    def _normalize_content(self, content: Any) -> str:
        if isinstance(content, list):
            text_parts: list[str] = []
            for item in content:
                if isinstance(item, dict) and item.get("type") == "text":
                    text_parts.append(item.get("text", ""))
            return "".join(text_parts)
        if isinstance(content, str):
            return content
        raise RuntimeError("Unexpected response format from LLM API")

    def _parse_json(self, raw_content: str) -> Any:
        cleaned = raw_content.strip()
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.IGNORECASE)
        cleaned = re.sub(r"\s*```$", "", cleaned)
        cleaned = cleaned.replace("\ufeff", "").strip()
        try:
            return json.loads(cleaned)
        except json.JSONDecodeError:
            extracted = self._extract_json_block(cleaned)
            return json.loads(extracted)

    def _extract_json_block(self, content: str) -> str:
        object_start = content.find("{")
        array_start = content.find("[")
        starts = [position for position in [object_start, array_start] if position != -1]
        if not starts:
            raise RuntimeError("No JSON content found in model output")
        start = min(starts)

        opening = content[start]
        closing = "}" if opening == "{" else "]"
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
            elif char == opening:
                depth += 1
            elif char == closing:
                depth -= 1
                if depth == 0:
                    return content[start : index + 1]

        raise RuntimeError("Incomplete JSON content in model output")
