"""Tests for precise datastore detection (avoid README/lockfile false positives)."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from repository_analysis.service import _data_store_scanner


class DataStoreScannerTests(unittest.TestCase):
    def test_mysql_only_compose_does_not_invent_other_stores(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "docker-compose.yml").write_text(
                """
services:
  db:
    image: mysql:8.4
  api:
    image: node:20
""",
                encoding="utf-8",
            )
            (root / "README.md").write_text(
                "We evaluated kafka, mongodb, redis, elasticsearch, rabbitmq and postgres before choosing MySQL.",
                encoding="utf-8",
            )
            (root / "package.json").write_text(
                '{"dependencies":{"mysql2":"3.0.0","express":"4.0.0"}}',
                encoding="utf-8",
            )
            (root / "package-lock.json").write_text(
                '{"packages":{"node_modules/kafkajs":{},"node_modules/mongoose":{},"node_modules/ioredis":{}}}',
                encoding="utf-8",
            )
            files = list(root.rglob("*"))
            files = [path for path in files if path.is_file()]
            result = _data_store_scanner(
                root,
                files,
                dependency_names={"mysql2", "express"},
                compose_images=["mysql:8.4", "node:20"],
                env_names={"MYSQL_ROOT_PASSWORD", "DATABASE_URL"},
            )
            types = sorted(item.type for item in result["data_stores"])
            self.assertEqual(types, ["mysql"])
            mysql = result["data_stores"][0]
            self.assertEqual(mysql.version, "8.4")

    def test_prisma_mysql_provider_not_postgresql(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            prisma = root / "prisma"
            prisma.mkdir()
            (prisma / "schema.prisma").write_text(
                """
datasource db {
  provider = "mysql"
  url      = env("DATABASE_URL")
}
""",
                encoding="utf-8",
            )
            files = [prisma / "schema.prisma"]
            result = _data_store_scanner(
                root,
                files,
                dependency_names={"@prisma/client", "prisma"},
                compose_images=[],
                env_names={"DATABASE_URL"},
            )
            types = sorted(item.type for item in result["data_stores"])
            self.assertEqual(types, ["mysql"])

    def test_generic_orm_dependency_alone_is_not_postgresql(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            files: list[Path] = []
            result = _data_store_scanner(
                root,
                files,
                dependency_names={"prisma", "typeorm", "sequelize", "sqlalchemy"},
                compose_images=[],
                env_names={"DATABASE_URL"},
            )
            self.assertEqual(result["data_stores"], [])


if __name__ == "__main__":
    unittest.main()
