from remediation_pipeline.models import (
    FileGroup,
    Fix,
    ProviderStatusResponse,
    RemediationNavigateRequest,
    RemediationPRRequest,
    RemediationPRResponse,
    RemediationRefreshRequest,
    RemediationRunRequest,
    Snippet,
    SnippetBundle,
    Vulnerability,
)

__all__ = [
    "FileGroup",
    "Fix",
    "ProviderStatusResponse",
    "RemediationNavigateRequest",
    "RemediationPRRequest",
    "RemediationPRResponse",
    "RemediationRefreshRequest",
    "RemediationRunRequest",
    "Snippet",
    "SnippetBundle",
    "Vulnerability",
    "RemediationOrchestrator",
    "RemediationTrackRunner",
]


def __getattr__(name: str):
    """Load runner dependencies only for callers that need the full pipeline.

    The AI gateway imports the durable remediation journal after each model
    response. That bookkeeping path must not require Docker-backed scanner
    dependencies just to load ``remediation_pipeline.remediation_store``.
    """
    if name == "RemediationOrchestrator":
        from remediation_pipeline.orchestrator import RemediationOrchestrator
        globals()[name] = RemediationOrchestrator
        return RemediationOrchestrator
    if name == "RemediationTrackRunner":
        from remediation_pipeline.track_runner import RemediationTrackRunner
        globals()[name] = RemediationTrackRunner
        return RemediationTrackRunner
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
