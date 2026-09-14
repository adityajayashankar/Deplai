"""Offline configuration gate tests. Never reads deploy/.env or invokes real Docker."""
import os
import pathlib
import shutil
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parent
BASH = shutil.which('bash') if os.name != 'nt' else r'C:\Program Files\Git\bin\bash.exe'


class PreflightTests(unittest.TestCase):
    def run_gate(self, changes):
        names = '''APP_DOMAIN NEXT_PUBLIC_APP_URL NEXT_PUBLIC_AGENTIC_WS_URL CORS_ORIGINS
        DEPLAI_SERVICE_KEY WS_TOKEN_SECRET SESSION_SECRET ADMIN_ACCESS_KEY ADMIN_EMAILS
        AI_CREDENTIAL_ENCRYPTION_KEY MYSQL_DATABASE MYSQL_USER MYSQL_PASSWORD MYSQL_ROOT_PASSWORD
        GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET GITHUB_APP_ID GITHUB_PRIVATE_KEY GITHUB_WEBHOOK_SECRET
        DOCKER_GID MONGODB_URI OPENROUTER_API_KEY ADMIN_SESSION_SECRET ADMIN_AUDIT_HMAC_SECRET
        ADMIN_MFA_ENCRYPTION_KEY BILLING_ENFORCEMENT NEXT_PUBLIC_BILLING_ENFORCEMENT'''.split()
        values = {key: f'offline-test-{key}' for key in names}
        values.update(APP_DOMAIN='release.invalid', NEXT_PUBLIC_APP_URL='https://release.invalid',
                      NEXT_PUBLIC_AGENTIC_WS_URL='wss://release.invalid/agentic',
                      CORS_ORIGINS='https://release.invalid', DOCKER_GID='999',
                      BILLING_ENFORCEMENT='true', NEXT_PUBLIC_BILLING_ENFORCEMENT='true')
        values.update(changes)
        with tempfile.TemporaryDirectory(prefix='deplai-preflight-') as directory:
            directory = pathlib.Path(directory)
            env_path = directory / 'test.env'
            env_path.write_text('\n'.join(f'{key}={value}' for key, value in values.items()), encoding='utf-8')
            stub = directory / 'docker'
            stub.write_text('#!/bin/sh\nexit 0\n', encoding='utf-8')
            stub.chmod(0o700)
            # Set PATH inside Bash so Git Bash translates Windows paths correctly.
            result = subprocess.run([BASH, '-c', 'export PATH="$1:$PATH"; bash "$2" "$3"',
                                     'test', directory.as_posix(), (ROOT / 'preflight.sh').as_posix(), env_path.as_posix()],
                                    capture_output=True, text=True)
            self.assertNotIn('offline-test-', result.stdout + result.stderr)
            return result

    def test_valid_config(self):
        result = self.run_gate({})
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_missing_required_services_and_disabled_enforcement(self):
        for key in ['MONGODB_URI', 'OPENROUTER_API_KEY', 'ADMIN_SESSION_SECRET', 'BILLING_ENFORCEMENT']:
            with self.subTest(key=key):
                result = self.run_gate({key: ''})
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(key, result.stderr)

    def test_quoted_empty_secret_rejected(self):
        self.assertNotEqual(self.run_gate({'OPENROUTER_API_KEY': '""'}).returncode, 0)


if __name__ == '__main__':
    unittest.main()
