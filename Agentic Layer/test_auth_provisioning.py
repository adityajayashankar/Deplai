from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(__file__))

from auth_provisioning import detect_auth_requirements, public_url_bootstrap_bash
from deployment_packager import DeploymentPackage
from ec2_app_renderer import render_ec2_app_bundle


class AuthProvisioningTests(unittest.TestCase):
    def test_detects_nextauth_google_github_from_env_and_deps(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "package.json").write_text(
                '{"dependencies":{"next-auth":"^4.0.0","next":"14.0.0"}}',
                encoding="utf-8",
            )
            (root / ".env.example").write_text(
                "\n".join(
                    [
                        "NEXTAUTH_URL=",
                        "NEXTAUTH_SECRET=",
                        "GOOGLE_CLIENT_ID=",
                        "GOOGLE_CLIENT_SECRET=",
                        "GITHUB_CLIENT_ID=",
                        "GITHUB_CLIENT_SECRET=",
                    ]
                ),
                encoding="utf-8",
            )
            req = detect_auth_requirements(
                root,
                user_answers={"oauth": {"GOOGLE_CLIENT_ID": "gid", "GOOGLE_CLIENT_SECRET": "gsec"}},
            )
            self.assertIn("nextauth", req.providers)
            self.assertIn("google", req.providers)
            self.assertIn("github", req.providers)
            self.assertIn("GOOGLE_CLIENT_ID", req.supplied_secrets)
            self.assertIn("GITHUB_CLIENT_ID", req.missing_secret_keys)
            self.assertTrue(any("/api/auth/callback/google" in p for p in req.callback_paths))

    def test_renderer_injects_public_url_and_oauth_secrets(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "package.json").write_text(
                '{"scripts":{"start":"node server.js"},"dependencies":{"next-auth":"4.0.0"}}',
                encoding="utf-8",
            )
            (root / "server.js").write_text("console.log('ok')", encoding="utf-8")
            (root / ".env.example").write_text(
                "GOOGLE_CLIENT_ID=\nGOOGLE_CLIENT_SECRET=\nNEXTAUTH_URL=\n",
                encoding="utf-8",
            )
            package = DeploymentPackage(
                package_id="auth-demo",
                source_root=str(root),
                app_kind="node",
                app_port=3000,
                health_path="/",
                build_command="",
                start_command="npm run start",
                package_base64="cGFja2FnZQ==",
                package_file_count=1,
                package_bytes=8,
                selected_root=".",
                package_tarball_path="",
                manifest_path="",
                warnings=[],
            )
            rendered = render_ec2_app_bundle(
                project_name="auth-demo",
                aws_region="eu-north-1",
                deployment_package=package,
                user_answers={
                    "oauth": {
                        "GOOGLE_CLIENT_ID": "demo-google-id",
                        "GOOGLE_CLIENT_SECRET": "demo-google-secret",
                    }
                },
            )
            main_tf = next(item["content"] for item in rendered["files"] if item["path"] == "terraform/main.tf")
            self.assertIn("public_url_injected", main_tf)
            self.assertIn("NEXTAUTH_URL=", main_tf)
            self.assertIn("GOOGLE_CLIENT_ID=demo-google-id", main_tf)
            self.assertIn("GOOGLE_CLIENT_SECRET=demo-google-secret", main_tf)
            self.assertIn("NEXTAUTH_SECRET=", main_tf)
            self.assertTrue(any("Missing OAuth/auth secrets" in w for w in rendered.get("warnings") or []))

    def test_public_url_bootstrap_mentions_metadata(self) -> None:
        script = public_url_bootstrap_bash(["/api/auth/callback/google"])
        self.assertIn("169.254.169.254", script)
        self.assertIn("NEXTAUTH_URL=", script)
        self.assertIn("/api/auth/callback/google", script)
        # Must be Terraform-escaped for <<-USERDATA heredocs.
        self.assertIn("$${APP_BASE_URL}", script)
        self.assertNotIn("${APP_BASE_URL}", script.replace("$${APP_BASE_URL}", ""))


if __name__ == "__main__":
    unittest.main()
