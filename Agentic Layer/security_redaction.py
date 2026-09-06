"""Dependency-free redaction for scanner output and persisted events."""
import re


def redact(text: str) -> str:
    text = re.sub(r"(?i)(https?://)[^/@\s]+:[^/@\s]+@", r"\1[redacted]@", text)
    text = re.sub(r"(?i)\b(?:bearer\s+)[a-z0-9._-]+", "Bearer [redacted]", text)
    text = re.sub(r"(?i)\b(?:sk-|gsk_|ghp_|github_pat_|AKIA)[a-z0-9_-]{8,}", "[redacted]", text)
    return re.sub(r"(?i)(\b(?:password|passwd|api[_-]?key|secret|token)\b\s*[:=]\s*)[^\s,;]+", r"\1[redacted]", text)
