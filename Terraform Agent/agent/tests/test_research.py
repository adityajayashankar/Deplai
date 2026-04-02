from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone

from terraform_agent.agent.engine.research import is_cache_stale


class ResearchTests(unittest.TestCase):
    def test_cache_stale_when_old(self) -> None:
        entry = {
            "provider_version": "5.54.1",
            "fetched_at": (datetime.now(timezone.utc) - timedelta(days=8)).isoformat(),
        }
        self.assertTrue(is_cache_stale(entry, "5.54.1"))

    def test_cache_valid_when_fresh(self) -> None:
        entry = {
            "provider_version": "5.54.1",
            "fetched_at": datetime.now(timezone.utc).isoformat(),
        }
        self.assertFalse(is_cache_stale(entry, "5.54.1"))
