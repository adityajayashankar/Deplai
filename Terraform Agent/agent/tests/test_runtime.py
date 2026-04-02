from __future__ import annotations

import unittest

from terraform_agent.agent.engine.runtime import extract_provider_version


class RuntimeTests(unittest.TestCase):
    def test_extract_provider_version(self) -> None:
        lock_text = """
provider "registry.terraform.io/hashicorp/aws" {
  version     = "5.54.1"
  constraints = "~> 5.40"
  hashes = [
    "h1:example",
  ]
}
"""
        self.assertEqual(extract_provider_version(lock_text), "5.54.1")
