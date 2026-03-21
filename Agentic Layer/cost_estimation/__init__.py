"""
Cost estimation dispatcher.
Usage:
    from cost_estimation import estimate_cost
    result = estimate_cost(architecture_json, provider="aws", access_key="...", secret_key="...")
"""

from typing import Any


def estimate_cost(architecture_json: dict, provider: str = "aws", **kwargs: Any) -> dict:
    """
    Dispatch cost estimation to the appropriate cloud provider module.

    Args:
        architecture_json: Architecture nodes/edges dict.
        provider: "aws" | "azure" | "gcp"
        **kwargs: Provider-specific credentials.
            AWS: access_key, secret_key
            Azure: (no creds needed — uses public Retail Prices API)
            GCP: (no creds needed — rule-based approximations)

    Returns:
        {"success": bool, "provider": str, "total_monthly_usd": float,
         "currency": str, "breakdown": [...], "errors": [...]}
    """
    p = provider.strip().lower()

    if p == "aws":
        from cost_estimation.aws import estimate_cost as _aws
        return _aws(
            architecture_json,
            access_key=kwargs.get("access_key", ""),
            secret_key=kwargs.get("secret_key", ""),
        )

    if p == "azure":
        from cost_estimation.azure import estimate_cost as _azure
        return _azure(architecture_json)

    if p == "gcp":
        from cost_estimation.gcp import estimate_cost as _gcp
        return _gcp(architecture_json)

    return {
        "success": False,
        "provider": provider,
        "error": f"Unsupported provider '{provider}'. Use aws, azure, or gcp.",
    }
