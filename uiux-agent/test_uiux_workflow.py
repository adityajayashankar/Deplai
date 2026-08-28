"""Tests for UI/UX workflow scaffolding."""

from __future__ import annotations

import pytest

from workflows.context import parse_run_context, split_user_message


def test_split_user_message():
    raw = "Modernize dashboard\n\n--- trusted execution context ---\nrepo_root: /tmp/repo\nproject_id: p1"
    user, trusted = split_user_message(raw)
    assert user == "Modernize dashboard"
    assert "repo_root: /tmp/repo" in trusted


def test_parse_run_context():
    raw = (
        "Enterprise SaaS settings panel\n\n"
        "--- trusted execution context ---\n"
        "repo_root: C:/projects/Connector/src\n"
        "project_id: demo-project"
    )
    ctx = parse_run_context(raw)
    assert ctx.user_message.startswith("Enterprise SaaS")
    assert ctx.repo_root.replace("\\", "/").endswith("Connector/src")
    assert ctx.project_id == "demo-project"


def test_workflow_has_executable_stages():
    from agno.db.mongo import MongoDb
    from workflows.uiux_refactor import build_uiux_refactor_workflow

    workflow = build_uiux_refactor_workflow(
        MongoDb(db_url="mongodb://localhost:27017", db_name="agno_test")
    )
    assert workflow.steps
    assert len(workflow.steps) >= 10
