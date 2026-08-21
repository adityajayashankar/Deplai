"""Lightweight checks that decision hashing stays stable for cost freshness."""

from __future__ import annotations

import hashlib
import json
import unittest


def _canonical_component(value: object) -> str:
    raw = str(value or "").strip().lower().replace(" ", "_").replace("-", "_")
    if "alb" in raw or "load_balancer" in raw:
        return "alb"
    if "eip" in raw or "elastic_ip" in raw:
        return "eip"
    if "ec2" in raw:
        return "ec2-instance"
    return raw


def canonical_decision_json(decision: dict) -> str:
    components = [_canonical_component(item) for item in (decision.get("components") or [])]
    components = [item for item in components if item]
    payload = {
        "components": components,
        "need_alb": bool(decision.get("need_alb")) or "alb" in components,
        "need_eip": bool(decision.get("need_eip")) or "eip" in components,
        "intakes": {
            "peak_concurrent_users": (decision.get("intakes") or {}).get("peak_concurrent_users"),
            "monthly_traffic": (decision.get("intakes") or {}).get("monthly_traffic"),
        },
    }
    return json.dumps(payload, sort_keys=True, separators=(",", ":"))


def decision_hash(decision: dict) -> str:
    return hashlib.sha256(canonical_decision_json(decision).encode("utf-8")).hexdigest()


class DecisionHashCostFreshnessTests(unittest.TestCase):
    def test_hash_changes_when_alb_added(self) -> None:
        base = {
            "components": ["ec2"],
            "need_alb": False,
            "need_eip": False,
            "intakes": {"peak_concurrent_users": 200},
        }
        with_alb = {
            "components": ["ec2", "alb", "eip"],
            "need_alb": True,
            "need_eip": True,
            "intakes": {"peak_concurrent_users": 5000},
        }
        self.assertNotEqual(decision_hash(base), decision_hash(with_alb))
        self.assertEqual(decision_hash(with_alb), decision_hash(dict(with_alb)))


if __name__ == "__main__":
    unittest.main()
