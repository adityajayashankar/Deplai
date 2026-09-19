"""Offline checks: no credentials, production services, or cloud calls."""
import pathlib
import re
import subprocess
import unittest

import yaml

ROOT = pathlib.Path(__file__).resolve().parents[1]


class ProductionRegressionTests(unittest.TestCase):
    def test_scan_storage_is_private_persistent_and_health_gated(self):
        config = yaml.safe_load((ROOT / 'docker-compose.production.yml').read_text())
        mongo = config['services']['security-mongo']
        self.assertNotIn('ports', mongo)
        self.assertIn('security_mongo_data:/data/db', mongo['volumes'])
        agent = config['services']['agentic-layer']
        self.assertEqual(agent['depends_on']['security-mongo']['condition'], 'service_healthy')
        self.assertEqual(agent['environment']['MONGODB_URI'], '${MONGODB_URI:-mongodb://security-mongo:27017}')
        self.assertEqual(agent['environment']['SECURITY_DURABLE_REQUIRED'], 'true')
        self.assertIn('agentic_runtime:/workspace/runtime', agent['volumes'])
        self.assertEqual(agent['environment']['DEPLAI_DEPLOYMENT_PACKAGE_ROOT'], '/workspace/runtime/deployment_packages')

    def test_tracked_files_have_no_mongodb_credentials(self):
        names = subprocess.check_output(['git', 'ls-files', '-z'], cwd=ROOT).decode().split('\0')
        failures = []
        for name in filter(None, names):
            path = ROOT / name
            if not path.is_file():
                continue
            for uri in re.findall(r'mongodb(?:\+srv)?://[^\s\"\x27`]+', path.read_text(errors='replace')):
                if '@' in uri and not any(token in uri.lower() for token in ('<', 'example', 'username', 'user:pass')):
                    failures.append(name)
        # Never print the matched URI, even when this assertion fails.
        self.assertEqual(failures, [], 'Credential-bearing MongoDB URI found; paths only: ' + ', '.join(failures))


if __name__ == '__main__':
    unittest.main()
