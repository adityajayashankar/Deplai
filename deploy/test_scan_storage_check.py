"""Offline checks: no environment files or live database connections."""
import importlib.util
import os
from pathlib import Path
import unittest
from unittest.mock import patch

from pymongo.errors import ConfigurationError, OperationFailure, ServerSelectionTimeoutError

spec = importlib.util.spec_from_file_location("storage_check", Path(__file__).with_name("check-scan-storage.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ScanStorageCheckTests(unittest.TestCase):
    def test_missing_uri(self):
        with patch.dict(os.environ, {"MONGODB_URI": ""}), patch.object(module, "MongoClient") as factory:
            code, message = module.check_storage()
            self.assertEqual(code, 1)
            self.assertIn("MISSING_URI", message)
            factory.assert_not_called()

    def test_failures_are_classified_without_leaking_driver_details(self):
        cases = [
            (OperationFailure("secret-host-password", code=18), "AUTHENTICATION"),
            (OperationFailure("secret-host-password", code=13), "AUTHORIZATION"),
            (OperationFailure("secret-host-password", code=86), "INDEX_CONFLICT"),
            (ServerSelectionTimeoutError("secret-host-password"), "UNREACHABLE"),
            (ConfigurationError("secret-host-password"), "CONFIGURATION"),
            (ValueError("secret-host-password"), "STORAGE_ERROR"),
        ]
        for error, expected in cases:
            with self.subTest(expected=expected), patch.dict(os.environ, {"MONGODB_URI": "mongodb://fixture.invalid"}), patch.object(module, "MongoClient") as factory:
                factory.return_value.__getitem__.return_value.command.side_effect = error
                code, message = module.check_storage()
                self.assertEqual(code, 1)
                self.assertTrue(message.startswith(expected + ":"), message)
                self.assertNotIn("secret", message)
                factory.return_value.close.assert_called_once()

    def test_checks_indexes_and_closes_connection(self):
        with patch.dict(os.environ, {"MONGODB_URI": "mongodb://fixture.invalid"}), patch.object(module, "MongoClient") as factory:
            self.assertEqual(module.check_storage()[0], 0)
            db = factory.return_value.__getitem__.return_value
            db.security_events.create_index.assert_called_once_with([("run_id", 1), ("sequence", 1)], unique=True)
            factory.return_value.close.assert_called_once()

    def test_index_error_is_not_success(self):
        with patch.dict(os.environ, {"MONGODB_URI": "mongodb://fixture.invalid"}), patch.object(module, "MongoClient") as factory:
            factory.return_value.__getitem__.return_value.security_events.create_index.side_effect = OperationFailure("private", code=13)
            code, message = module.check_storage()
            self.assertEqual(code, 1)
            self.assertTrue(message.startswith("AUTHORIZATION:"))


if __name__ == "__main__":
    unittest.main()
