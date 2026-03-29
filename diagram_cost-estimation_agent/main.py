from __future__ import annotations

import json

from graph import build_graph
from state import AgentState


def build_example_state() -> AgentState:
    return {
        "infra_plan": {
            "compute": "ec2",
            "services": ["web_server"],
            "database": None,
            "cache": None,
            "networking": "default_vpc",
            "cdn": "cloudfront",
            "storage": ["website_bucket", "security_logs_bucket"],
            "logging": "cloudwatch",
            "security_groups": ["web_security_group"],
            "region": "ap-south-1",
            "state_backend": "s3_dynamodb",
        },
        "budget_cap_usd": 100.00,
        "pipeline_run_id": "run_abc123",
        "environment": "dev",
        "diagram_nodes": [],
        "diagram_edges": [],
        "cost_line_items": [],
        "total_monthly_usd": 0.0,
        "estimate_type": "live_runtime",
        "budget_gate": {"cap_usd": 0.0, "total_usd": 0.0, "percent_used": 0.0, "status": "PASS"},
        "approval_payload": None,
        "warnings": [],
    }


def main() -> None:
    app = build_graph()
    initial_state = build_example_state()
    result = app.invoke(initial_state)
    print(json.dumps(result["approval_payload"], indent=2))


if __name__ == "__main__":
    main()

