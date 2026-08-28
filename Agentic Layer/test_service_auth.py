import unittest

from service_auth import api_key_matches


class ApiKeyMatchesTests(unittest.TestCase):
    def test_accepts_matching_key(self):
        self.assertTrue(api_key_matches("secret-key", "secret-key"))

    def test_rejects_mismatch_and_missing(self):
        self.assertFalse(api_key_matches("secret-key", "other-key"))
        self.assertFalse(api_key_matches(None, "secret-key"))
        self.assertFalse(api_key_matches("", "secret-key"))
        self.assertFalse(api_key_matches("short", "longer-secret"))


if __name__ == "__main__":
    unittest.main()
