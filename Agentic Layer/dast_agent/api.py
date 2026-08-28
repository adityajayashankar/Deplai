"""Agentic Layer DAST APIs: ownership checks, scan status, cancel."""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from dast_agent import store
from dast_agent.ownership import verify_dns, verify_http
from dast_agent.service import cancel_scan

router = APIRouter(prefix="/api/dast", tags=["dast"])


class DnsCheckRequest(BaseModel):
    domain: str
    expected_token_hash: str


class HttpCheckRequest(BaseModel):
    hostname: str
    token: str
    expected_token_hash: str
    scheme: str = "https"


class CancelRequest(BaseModel):
    scan_id: str = Field(min_length=1, max_length=80)


@router.post("/ownership/dns")
def dns_ownership_check(body: DnsCheckRequest) -> dict[str, Any]:
    result = verify_dns(body.domain, body.expected_token_hash)
    return {
        "ok": result.ok,
        "method": result.method,
        "status": result.status,
        "code": result.code,
        "message": result.message,
        "evidence_hash": result.evidence_hash,
    }


@router.post("/ownership/http")
def http_ownership_check(body: HttpCheckRequest) -> dict[str, Any]:
    result = verify_http(
        body.hostname,
        body.token,
        body.expected_token_hash,
        scheme=body.scheme or "https",
    )
    return {
        "ok": result.ok,
        "method": result.method,
        "status": result.status,
        "code": result.code,
        "message": result.message,
        "evidence_hash": result.evidence_hash,
    }


@router.get("/scans/{scan_id}")
def get_scan(scan_id: str) -> dict[str, Any]:
    latest = store.read_latest(scan_id)
    if not latest:
        raise HTTPException(status_code=404, detail="Scan not found")
    return {"scan_id": scan_id, "checkpoint": latest}


@router.get("/scans/{scan_id}/audit")
def get_scan_audit(scan_id: str) -> dict[str, Any]:
    return {"scan_id": scan_id, "events": store.read_audit(scan_id)}


@router.post("/scans/{scan_id}/cancel")
def post_cancel(scan_id: str, body: Optional[CancelRequest] = None) -> dict[str, Any]:
    cancel_scan(scan_id)
    return {"ok": True, "scan_id": scan_id, "status": "cancelled"}
