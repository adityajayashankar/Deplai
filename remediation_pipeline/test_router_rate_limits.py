import unittest
from unittest.mock import patch

from remediation_pipeline.router import LLMRouter


class RouterPlatformOnlyTests(unittest.TestCase):
    def test_direct_remediation_is_rejected_without_authenticated_context(self):
        with self.assertRaisesRegex(RuntimeError, "platform OpenRouter context"):
            LLMRouter().route("fix", 10)

    @patch("remediation_pipeline.router.record_llm_dispatch")
    @patch("ai_gateway.remediate_text", return_value=(True, "patch"))
    def test_authenticated_remediation_uses_platform_gateway_only(self, gateway, _journal):
        response, provider, tokens = LLMRouter().route(
            "fix",
            10,
            user_id="user-1",
            organization_id="org-1",
            preferred_provider="groq",
            preferred_api_key="must-not-forward",
            access_mode="byok",
        )
        self.assertEqual(response, "patch")
        self.assertEqual(provider, "gateway:platform-openrouter")
        self.assertEqual(tokens, 10)
        self.assertEqual(gateway.call_args.kwargs["access_mode"], "platform")
        self.assertNotIn("api_key", gateway.call_args.kwargs)
        self.assertNotIn("provider", gateway.call_args.kwargs)


if __name__ == "__main__":
    unittest.main()
