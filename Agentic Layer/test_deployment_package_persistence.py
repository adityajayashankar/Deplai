import base64
import importlib
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import deployment_packager


class DeploymentPackagePersistenceTests(unittest.TestCase):
    def test_fresh_worker_loads_archive_from_configured_persistent_store(self):
        original = deployment_packager.PACKAGE_STORE_ROOT
        try:
            with tempfile.TemporaryDirectory() as directory, patch.dict(
                os.environ, {'DEPLAI_DEPLOYMENT_PACKAGE_ROOT': directory}
            ):
                package_dir = Path(directory) / 'fixture-revision'
                package_dir.mkdir()
                (package_dir / 'app.tgz').write_bytes(b'archive-fixture')
                importlib.reload(deployment_packager)
                files = deployment_packager.attach_app_artifact_to_tf_files(
                    [], package_id='fixture-revision'
                )
                self.assertEqual(files[0]['path'], 'terraform/artifacts/app.tgz')
                self.assertEqual(base64.b64decode(files[0]['content']), b'archive-fixture')
        finally:
            deployment_packager.PACKAGE_STORE_ROOT = original


if __name__ == '__main__':
    unittest.main()
