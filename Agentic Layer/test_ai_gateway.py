from __future__ import annotations

import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(__file__))

from ai_gateway import remediate_text


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


if __name__ == "__main__":
    unittest.main()
