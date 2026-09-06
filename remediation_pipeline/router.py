from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from remediation_pipeline.models import ProviderQuota, ProviderStatusResponse
from remediation_pipeline.remediation_store import record_llm_dispatch


@dataclass(frozen=True)
class ProviderConfig:
    """Compatibility shape for remediation provider status responses."""

    name: str
    model: str
    quota_daily: int
    priority: int


class LLMRouter:
    """Security-remediation inference gateway.

    This class deliberately has no direct provider SDK or HTTP fallback. Every
    request must enter Connector's authenticated AI platform, which selects a
    live OpenRouter ``:free`` model, meters it, and owns retries/cooldowns.
    """

    _config = ProviderConfig("openrouter", "best_coding", 0, 1)

    def route(
        self,
        prompt: str,
        estimated_tokens: int,
        *,
        preferred_provider: str | None = None,
        preferred_api_key: str | None = None,
        preferred_model: str | None = None,
        force_claude: bool = False,
        user_id: str | None = None,
        organization_id: str | None = None,
        access_mode: str | None = None,
        llm_credential_id: str | None = None,
    ) -> tuple[str, str, int]:
        if not user_id:
            raise RuntimeError(
                "Security remediation requires authenticated platform OpenRouter context; "
                "direct provider fallback is disabled."
            )

        model = preferred_model or "best_coding"
        try:
            from ai_gateway import bound_organization, remediate_text

            record_llm_dispatch(
                stage="pipeline_targeted",
                provider="openrouter",
                model=model,
                access_mode="platform",
            )
            ok, response = remediate_text(
                user_id=str(user_id),
                organization_id=str(organization_id or bound_organization() or "").strip() or None,
                prompt=prompt,
                model=model,
                # Caller API keys, providers, and modes are intentionally not
                # forwarded. remediate_text enforces platform OpenRouter.
                access_mode="platform",
            )
            record_llm_dispatch(
                stage="pipeline_targeted",
                provider="openrouter",
                model=model,
                access_mode="platform",
                success=ok,
                error=None if ok else response,
            )
        except Exception as exc:
            record_llm_dispatch(
                stage="pipeline_targeted",
                provider="openrouter",
                model=model,
                access_mode="platform",
                success=False,
                error=str(exc),
            )
            raise RuntimeError(f"Platform OpenRouter remediation failed: {exc}") from exc

        if not ok:
            raise RuntimeError(f"Platform OpenRouter remediation failed: {response}")
        return response, "gateway:platform-openrouter", max(estimated_tokens, len(response) // 4)

    def status(self) -> ProviderStatusResponse:
        tomorrow = datetime.now(UTC).date() + timedelta(days=1)
        return ProviderStatusResponse(
            providers=[
                ProviderQuota(
                    provider=self._config.name,
                    model=self._config.model,
                    # Shared platform quota is enforced by Connector instead
                    # of an inaccurate worker-local daily counter.
                    quota_daily=0,
                    calls_used_today=0,
                    reset_at_utc=datetime.combine(tomorrow, datetime.min.time(), tzinfo=UTC),
                )
            ]
        )
