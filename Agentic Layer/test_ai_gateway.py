from __future__ import annotations

import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(__file__))

from ai_gateway import bind_ai_context, bound_organization, remediate_text


class RemediateTextProviderTests(unittest.TestCase):
    def test_empty_model_defaults_to_best_coding_without_mapped_provider(self) -> None:
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
        self.assertEqual(kwargs["model"], "best_coding")
        self.assertIsNone(kwargs["provider"])

    def test_explicit_best_alias_does_not_map_provider(self) -> None:
        with patch("ai_gateway.chat_text", return_value=(True, "ok")) as chat:
            remediate_text(
                user_id="user-1",
                prompt="fix this",
                model="best_fast",
                provider="claude",
            )
        kwargs = chat.call_args.kwargs
        self.assertEqual(kwargs["model"], "best_fast")
        self.assertIsNone(kwargs["provider"])

    def test_concrete_model_still_maps_provider(self) -> None:
        with patch("ai_gateway.chat_text", return_value=(True, "ok")) as chat:
            remediate_text(
                user_id="user-1",
                prompt="fix this",
                model="gpt-4.1",
                provider="openai",
            )
        kwargs = chat.call_args.kwargs
        self.assertEqual(kwargs["model"], "gpt-4.1")
        self.assertEqual(kwargs["provider"], "openai")

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

    def test_remediate_text_forwards_credential_id(self) -> None:
        with patch("ai_gateway.chat_text", return_value=(True, "ok")) as chat:
            ok, text = remediate_text(
                user_id="user-1",
                prompt="fix",
                access_mode="byok",
                credential_id="cred-123",
            )
        self.assertTrue(ok)
        self.assertEqual(text, "ok")
        self.assertEqual(chat.call_args.kwargs["credential_id"], "cred-123")
        self.assertEqual(chat.call_args.kwargs["access_mode"], "byok")


if __name__ == "__main__":
    unittest.main()
