import os
import unittest
from unittest.mock import patch

from pymongo.errors import OperationFailure, ServerSelectionTimeoutError
from security_run_store import SecurityRunStore


class SecurityRunStoreTests(unittest.TestCase):
    def test_storage_connection_failures_are_safe_retryable_and_close_client(self):
        for error in (ServerSelectionTimeoutError("private-host TLS failure"),
                      OperationFailure("private credential rejected")):
            with self.subTest(error=type(error).__name__), patch.dict(
                os.environ, {"MONGODB_URI": "mongodb://fixture.invalid", "APP_ENV": "development"}
            ), patch("pymongo.MongoClient") as factory:
                client = factory.return_value
                db = client.__getitem__.return_value
                db.command.side_effect = error
                store = SecurityRunStore()
                with self.assertRaisesRegex(RuntimeError, "Scan storage is unavailable") as raised:
                    store.db()
                self.assertNotIn("private", str(raised.exception))
                self.assertIsNone(store._db)
                client.close.assert_called_once()
                db.security_runs.create_index.assert_not_called()
                # A later attempt can recover; failures are not cached.
                db.command.side_effect = None
                self.assertIs(store.db(), db)
                self.assertEqual(factory.call_count, 2)

    def test_index_failure_does_not_cache_partially_initialized_storage(self):
        with patch.dict(os.environ, {"MONGODB_URI": "mongodb://fixture.invalid"}), patch(
            "pymongo.MongoClient"
        ) as factory:
            db = factory.return_value.__getitem__.return_value
            db.security_events.create_index.side_effect = OperationFailure("index permission denied")
            store = SecurityRunStore()
            with self.assertRaisesRegex(RuntimeError, "Scan storage is unavailable"):
                store.db()
            self.assertIsNone(store._db)
            factory.return_value.close.assert_called_once()

    def test_production_cannot_silently_use_memory_without_storage(self):
        with patch.dict(os.environ, {"MONGODB_URI": "", "APP_ENV": "production"}):
            with self.assertRaisesRegex(RuntimeError, "requires MONGODB_URI"):
                SecurityRunStore().db()

    def test_atlas_connections_use_a_longer_timeout(self):
        with patch.dict(os.environ, {"MONGODB_URI": "mongodb+srv://fixture.mongodb.net"}), patch(
            "pymongo.MongoClient"
        ) as factory:
            SecurityRunStore().db()
            kwargs = factory.call_args.kwargs
            self.assertGreaterEqual(kwargs["serverSelectionTimeoutMS"], 10000)
            self.assertGreaterEqual(kwargs["connectTimeoutMS"], 10000)

    def test_index_option_conflict_does_not_block_scan_storage(self):
        with patch.dict(os.environ, {"MONGODB_URI": "mongodb://fixture.invalid"}), patch(
            "pymongo.MongoClient"
        ) as factory:
            db = factory.return_value.__getitem__.return_value
            db.security_events.create_index.side_effect = OperationFailure("index options", code=85)
            store = SecurityRunStore()
            self.assertIs(store.db(), db)
            self.assertIs(store._db, db)


if __name__ == "__main__":
    unittest.main()
