from __future__ import annotations

import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(__file__))

from ai_gateway import bind_ai_context, bound_organization, chat_text, remediate_text


class RemediateTextProviderTests(unittest.TestCase):
    def test_run_budget_blocks_dispatch_without_discarding_prior_usage(self) -> None:
        from remediation_pipeline import remediation_store
        store = remediation_store.RemediationRunStore()
        with patch.dict(os.environ, {'MONGODB_URI': '', 'REMEDIATION_RUN_TOKEN_BUDGET': '2000000'}), \
             patch.object(remediation_store, 'remediation_runs', store), \
             patch('ai_gateway.gateway_enabled', return_value=True), \
             patch('ai_gateway.DeplaiAI') as client:
            run_id = store.begin_run(project_id='project', user_id='user', organization_id='org', scope='major')
            remediation_store.bind_remediation_run(run_id)
            try:
                store.reserve_tokens(run_id, 1_999_000)
                ok, message = chat_text(user_id='user', organization_id='org', prompt='Fix source', max_tokens=8192,
                                        metadata={'product': 'security', 'stage': 'remediation'})
                self.assertFalse(ok)
                self.assertIn('RUN_TOKEN_BUDGET', message)
                client.return_value.chat.assert_not_called()
            finally:
                remediation_store.bind_remediation_run(None)

    def test_security_gateway_records_usage_without_loading_scanner_dependencies(self) -> None:
        from remediation_pipeline import remediation_store

        previous = remediation_store.remediation_runs
        remediation_store.remediation_runs = remediation_store.RemediationRunStore()
        try:
            run_id = remediation_store.remediation_runs.begin_run(
                project_id="project-1", user_id="user-1", organization_id="org-1", scope="major"
            )
            remediation_store.bind_remediation_run(run_id)
            with (
                patch("ai_gateway.gateway_enabled", return_value=True),
                patch("ai_gateway.DeplaiAI") as client,
            ):
                client.return_value.chat.return_value = {
                    "output": "{\"summary\": \"patch\"}",
                    "model": "openrouter/free",
                    "provider": "openrouter",
                    "usage": {"inputTokens": 120, "outputTokens": 30},
                }
                ok, text = chat_text(
                    user_id="user-1",
                    organization_id="org-1",
                    prompt="fix",
                    metadata={"product": "security", "stage": "remediation"},
                )
            self.assertTrue(ok)
            self.assertEqual(text, '{"summary": "patch"}')
            self.assertEqual(
                remediation_store.remediation_runs.usage_for_run(run_id),
                {"requests": 1, "input_tokens": 120, "output_tokens": 30},
            )
        finally:
            remediation_store.bind_remediation_run(None)
            remediation_store.remediation_runs = previous

    def test_security_gateway_does_not_fail_when_a_stale_journal_lacks_usage_api(self) -> None:
        from remediation_pipeline import remediation_store

        class LegacyJournal:
            def __init__(self) -> None:
                self.events: list[dict[str, object]] = []

            def append_event(self, run_id, **event) -> None:
                self.events.append({"run_id": run_id, **event})

        previous = remediation_store.remediation_runs
        legacy = LegacyJournal()
        remediation_store.remediation_runs = legacy
        try:
            remediation_store.bind_remediation_run("run-legacy")
            with (
                patch("ai_gateway.gateway_enabled", return_value=True),
                patch("ai_gateway.DeplaiAI") as client,
            ):
                client.return_value.chat.return_value = {
                    "output": "patch",
                    "usage": {"inputTokens": 120, "outputTokens": 30},
                }
                ok, text = chat_text(
                    user_id="user-1",
                    organization_id="org-1",
                    prompt="fix",
                    metadata={"product": "security", "stage": "remediation"},
                )
            self.assertTrue(ok)
            self.assertEqual(text, "patch")
            self.assertTrue(any(event["message_type"] == "warning" for event in legacy.events))
        finally:
            remediation_store.bind_remediation_run(None)
            remediation_store.remediation_runs = previous

    def test_empty_model_uses_the_openrouter_free_router(self) -> None:
        with patch("ai_gateway.chat_text", return_value=(True, "ok")) as chat:
            ok, text = remediate_text(
                user_id="user-1",
                prompt="fix this",
                model=None,
                provider="openai",
            )
        self.assertTrue(ok)
        self.assertEqual(text, "ok")
        kwargs = chat.call_args.kwargs
        self.assertEqual(kwargs["model"], "openrouter/free")
        self.assertEqual(kwargs["provider"], "openrouter")
        self.assertEqual(kwargs["access_mode"], "platform")

    def test_explicit_model_preference_is_ignored_for_the_free_router(self) -> None:
        with patch("ai_gateway.chat_text", return_value=(True, "ok")) as chat:
            remediate_text(
                user_id="user-1",
                prompt="fix this",
                model="best_fast",
                provider="claude",
            )
        kwargs = chat.call_args.kwargs
        self.assertEqual(kwargs["model"], "openrouter/free")
        self.assertEqual(kwargs["provider"], "openrouter")
        self.assertEqual(kwargs["access_mode"], "platform")

    def test_non_free_concrete_model_cannot_bypass_the_free_router(self) -> None:
        with patch("ai_gateway.chat_text", return_value=(True, "ok")) as chat:
            remediate_text(
                user_id="user-1",
                prompt="fix this",
                model="gpt-4.1",
                provider="openai",
            )
        kwargs = chat.call_args.kwargs
        self.assertEqual(kwargs["model"], "openrouter/free")
        self.assertEqual(kwargs["provider"], "openrouter")
        self.assertEqual(kwargs["access_mode"], "platform")

    def test_gateway_ready_requires_organization_by_default(self) -> None:
        with patch.dict(os.environ, {"DEPLAI_AI_GATEWAY_URL": "http://connector.test"}, clear=False):
            bind_ai_context(user_id="user-1", organization_id="org-1")
            from ai_gateway import gateway_ready
            self.assertTrue(gateway_ready())
            bind_ai_context(user_id="user-1", organization_id="")
            self.assertFalse(gateway_ready())

    def test_remediate_text_forwards_organization_id(self) -> None:
        with patch("ai_gateway.chat_text", return_value=(True, "ok")) as chat:
            ok, text = remediate_text(
                user_id="user-1",
                organization_id="org-9",
                prompt="fix",
            )
        self.assertTrue(ok)
        self.assertEqual(text, "ok")
        self.assertEqual(chat.call_args.kwargs["organization_id"], "org-9")

    def test_remediate_text_drops_byok_credential_and_forces_platform(self) -> None:
        with patch("ai_gateway.chat_text", return_value=(True, "ok")) as chat:
            ok, text = remediate_text(
                user_id="user-1",
                prompt="fix",
                access_mode="byok",
                credential_id="cred-123",
            )
        self.assertTrue(ok)
        self.assertEqual(text, "ok")
        self.assertNotIn("credential_id", chat.call_args.kwargs)
        self.assertNotIn("api_key", chat.call_args.kwargs)
        self.assertEqual(chat.call_args.kwargs["provider"], "openrouter")
        self.assertEqual(chat.call_args.kwargs["access_mode"], "platform")


if __name__ == "__main__":
    unittest.main()
