import os
import sys
import types
import unittest

sys.path.insert(0, os.path.dirname(__file__))

if "docker" not in sys.modules:
    docker_stub = types.ModuleType("docker")

    class _NotFound(Exception):
        pass

    docker_stub.errors = types.ModuleType("errors")
    docker_stub.errors.NotFound = _NotFound
    docker_stub.DockerClient = object
    sys.modules["docker"] = docker_stub
    sys.modules["docker.errors"] = docker_stub.errors

from pydantic import ValidationError

from models import ScanValidationRequest, ScanValidationResponse, public_scan_validation


def _cloud_request(**overrides):
    payload = {
        "project_id": "proj-cloud-1",
        "project_name": "demo",
        "project_type": "local",
        "user_id": "user-1",
        "enabled_modules": ["cloud"],
        "aws_access_key_id": "AKIATESTKEYID0000000",
        "aws_secret_access_key": "w" * 40,
        "aws_region": "eu-north-1",
    }
    payload.update(overrides)
    return ScanValidationRequest(**payload)


class ScanValidationResponseTests(unittest.TestCase):
    def test_inbound_cloud_request_requires_secret(self):
        with self.assertRaises(ValidationError):
            _cloud_request(aws_secret_access_key=None)

    def test_public_response_strips_secrets_without_rerunning_cloud_validator(self):
        request = _cloud_request(aws_session_token="session-token")
        public = public_scan_validation(request)
        self.assertIsNone(public["aws_secret_access_key"])
        self.assertIsNone(public["aws_session_token"])
        self.assertEqual(public["enabled_modules"], ["cloud"])
        self.assertEqual(public["aws_access_key_id"], "AKIATESTKEYID0000000")
        response = ScanValidationResponse(
            success=True,
            message="ok",
            data=public,
        )
        self.assertTrue(response.success)
        self.assertIsNone(response.data["aws_secret_access_key"])

    def test_model_copy_strip_still_fails_if_nested_request_is_revalidated(self):
        request = _cloud_request()
        public = request.model_copy(update={
            "aws_secret_access_key": None,
            "aws_session_token": None,
            "dast_authorization": None,
        })
        with self.assertRaises(ValidationError):
            ScanValidationRequest.model_validate(public.model_dump())


if __name__ == "__main__":
    unittest.main()
