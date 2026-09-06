from __future__ import annotations

import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(__file__))

from ai_gateway import bind_ai_context, bound_organization, remediate_text


class RemediateTextProviderTests(unittest.TestCase):
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
