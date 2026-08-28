"""Production DAST agent: authorization, ownership, SSRF, and ZAP orchestration."""

from dast_agent.authorization import authorize_target, sign_grant, verify_grant_signature
from dast_agent.codes import POLICY_VERSION
from dast_agent.service import cancel_scan, execute_dast_scan
from dast_agent.ssrf import inspect_outbound_target, validate_outbound_target

__all__ = [
    "POLICY_VERSION",
    "authorize_target",
    "cancel_scan",
    "execute_dast_scan",
    "inspect_outbound_target",
    "sign_grant",
    "validate_outbound_target",
    "verify_grant_signature",
]
