from __future__ import annotations

import json
import os
from pathlib import Path
import re
import time
from typing import Any
from urllib import error, request

from dotenv import load_dotenv


BACKEND_DIR = Path(__file__).resolve().parents[1]
load_dotenv(BACKEND_DIR / ".env")


class ProjectLLMClient:
    DEFAULT_API_URL = "https://router.huggingface.co/v1/chat/completions"
    DEFAULT_MODEL = "Qwen/Qwen2.5-Coder-32B-Instruct"

    def __init__(self) -> None:
        self.api_url = os.getenv("LLM_API_URL", os.getenv("HF_API_URL", self.DEFAULT_API_URL)).strip()
        self.model = os.getenv("LLM_MODEL_ID", os.getenv("HF_MODEL_ID", self.DEFAULT_MODEL)).strip()
        self.api_key = os.getenv("LLM_API_KEY", os.getenv("HF_API_KEY", "")).strip()
        self.provider = os.getenv("LLM_PROVIDER", "").strip().lower() or self._infer_provider()
        self.use_response_format = os.getenv("LLM_USE_RESPONSE_FORMAT", "true").strip().lower() in {
            "1",
            "true",
            "yes",
            "on",
        }
        self.max_retries = max(0, int(os.getenv("LLM_MAX_RETRIES", "2") or "2"))
        self.retry_base_delay_seconds = max(
            0.1,
            float(os.getenv("LLM_RETRY_BASE_DELAY_SECONDS", "1.5") or "1.5"),
        )

    def _infer_provider(self) -> str:
        lowered = self.api_url.lower()
        if "anthropic" in lowered:
            return "anthropic"
        if "127.0.0.1" in lowered or "localhost" in lowered:
            return "local"
        if "huggingface" in lowered:
            return "huggingface"
        return "generic"

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

        with request.urlopen(req, timeout=60) as response:
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
                            f"LLM API returned HTTP {retry_exc.code} on retry (provider={self.provider}, url={self.api_url}): {retry_details}"
                        ) from retry_exc
                    except error.URLError as retry_exc:
                        raise RuntimeError(
                            f"Could not reach LLM API on retry (provider={self.provider}, url={self.api_url}): {retry_exc.reason}"
                        ) from retry_exc

                if attempt <= self.max_retries and self._is_transient_http_error(exc.code, details):
                    time.sleep(self._retry_delay_seconds(attempt, exc))
                    continue

                raise RuntimeError(
                    f"LLM API returned HTTP {exc.code} (provider={self.provider}, url={self.api_url}): {details}"
                ) from exc
            except error.URLError as exc:
                raise RuntimeError(
                    f"Could not reach LLM API (provider={self.provider}, url={self.api_url}): {exc.reason}"
                ) from exc

        parsed_body = json.loads(body)
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
            content = parsed_body["choices"][0]["message"]["content"]
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