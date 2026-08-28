import json
import os
import sys
import types
import unittest

sys.path.insert(0, os.path.dirname(__file__))

if "docker" not in sys.modules:
    docker_stub = types.ModuleType("docker")

    class _NotFound(Exception):
        pass

    docker_stub.errors = types.SimpleNamespace(NotFound=_NotFound)
    docker_stub.DockerClient = object
    sys.modules["docker"] = docker_stub

from result_parser import build_scan_payload, _parse_secrets_report, _parse_checkov_report


BEARER_REPORT = json.dumps({
    "critical": [
        {
            "cwe_ids": ["918"],
            "title": "Server-Side Request Forgery",
            "filename": "/tmp/scan/proj/app/proxy.py",
            "line_number": 12,
            "code_extract": "requests.get(url)",
            "documentation_url": "https://example.test/ssrf",
        }
    ],
    "high": [],
    "medium": [],
    "low": [],
})

GRYPE_REPORT = json.dumps({
    "matches": [
        {
            "vulnerability": {
                "id": "CVE-2024-1234",
                "severity": "High",
                "epss": [{"epss": 0.42}],
                "fix": {"versions": ["1.2.4"]},
            },
            "artifact": {
                "name": "left-pad",
                "type": "npm",
                "version": "1.2.3",
                "purl": "pkg:npm/left-pad@1.2.3",
            },
        }
    ]
})

SYFT_REPORT = json.dumps({
    "artifacts": [
        {"id": "a", "name": "left-pad", "version": "1.2.3"},
        {"id": "b", "name": "express", "version": "4.18.0"},
    ]
})

SECRETS_REPORT = json.dumps([
    {
        "Description": "AWS Access Key",
        "StartLine": 4,
        "File": "/src/proj/.env",
        "RuleID": "aws-access-key",
        "Fingerprint": "proj.env:4:aws-access-key",
        "Secret": "AKIA1234567890FAKE",
        "Match": "AKIA1234567890FAKE",
    }
])

CHECKOV_REPORT = json.dumps({
    "check_type": "terraform",
    "results": {
        "failed_checks": [
            {
                "check_id": "CKV_AWS_20",
                "check_name": "S3 Bucket has a public ACL",
                "severity": "HIGH",
                "file_path": "/src/proj/infra/s3.tf",
                "file_line_range": [10, 18],
                "resource": "aws_s3_bucket.public",
                "guideline": "https://docs.bridgecrew.io/docs/s3-bucket-public-acl",
            }
        ]
    },
})

CONTAINER_REPORT = json.dumps({
    "check_type": "dockerfile",
    "results": {
        "failed_checks": [
            {
                "check_id": "CKV_DOCKER_2",
                "check_name": "Dockerfile HEALTHCHECK missing",
                "severity": "LOW",
                "file_path": "/src/proj/Dockerfile",
                "file_line_range": [1, 8],
                "resource": "Dockerfile",
            }
        ]
    },
})

KUBERNETES_REPORT = json.dumps({
    "check_type": "kubernetes",
    "results": {
        "failed_checks": [
            {
                "check_id": "CKV_K8S_21",
                "check_name": "Service account token mounted",
                "severity": "MEDIUM",
                "file_path": "/src/proj/k8s/deployment.yaml",
                "file_line_range": [4, 20],
                "resource": "Deployment.default.api",
            }
        ]
    },
})

CICD_REPORT = json.dumps({
    "check_type": "github_actions",
    "results": {
        "failed_checks": [
            {
                "check_id": "CKV_GHA_1",
                "check_name": "Pull request workflow executes untrusted code",
                "severity": "HIGH",
                "file_path": "/src/proj/.github/workflows/ci.yml",
                "file_line_range": [1, 12],
                "resource": "workflow.ci",
            }
        ]
    },
})

API_REPORT = json.dumps({
    "check_type": "openapi",
    "results": {
        "failed_checks": [
            {
                "check_id": "CKV_OPENAPI_4",
                "check_name": "Endpoint is unauthenticated",
                "severity": "HIGH",
                "file_path": "/src/proj/openapi.yaml",
                "file_line_range": [40, 55],
                "resource": "/users/{id}",
            }
        ]
    },
})

DAST_REPORT = json.dumps({
    "site": [
        {
            "@name": "https://staging.example.com",
            "alerts": [
                {
                    "pluginid": "10021",
                    "alert": "X-Content-Type-Options Header Missing",
                    "riskdesc": "Low (Medium)",
                    "cweid": "693",
                    "count": "1",
                    "instances": [
                        {
                            "uri": "https://staging.example.com/login",
                            "method": "GET",
                            "evidence": "X-Content-Type-Options",
                            "attack": "should-not-appear",
                        }
                    ],
                }
            ],
        }
    ]
})

CLOUD_REPORT = json.dumps([
    {
        "CheckID": "s3_bucket_public_access",
        "CheckTitle": "S3 bucket is publicly accessible",
        "Status": "FAIL",
        "Severity": "high",
        "ResourceId": "payments-assets",
        "Region": "eu-north-1",
        "ServiceName": "s3",
        "StatusExtended": "Bucket allows public list.",
    },
    {
        "CheckID": "iam_root_mfa",
        "CheckTitle": "Root account has MFA",
        "Status": "PASS",
        "Severity": "critical",
        "ResourceId": "root",
        "Region": "eu-north-1",
        "ServiceName": "iam",
    },
])


class ScanModuleParserTests(unittest.TestCase):
    def test_unified_payload_covers_phase1_modules(self):
        payload = build_scan_payload(
            bearer_raw=BEARER_REPORT,
            grype_raw=GRYPE_REPORT,
            syft_raw=SYFT_REPORT,
            secrets_raw=SECRETS_REPORT,
            checkov_raw=CHECKOV_REPORT,
            containers_raw=CONTAINER_REPORT,
            pipeline_raw=json.dumps({
                "completed_at": "2026-08-26T12:00:00+00:00",
                "modules": [
                    {"id": "sast", "status": "COMPLETED"},
                    {"id": "sca", "status": "COMPLETED"},
                    {"id": "sbom", "status": "COMPLETED"},
                    {"id": "secrets", "status": "COMPLETED"},
                    {"id": "iac", "status": "COMPLETED"},
                    {"id": "containers", "status": "COMPLETED"},
                ],
            }),
        )

        self.assertEqual(payload["posture"]["critical"], 1)
        self.assertEqual(payload["posture"]["high"], 3)
        self.assertEqual(payload["sbom"]["component_count"], 2)
        self.assertEqual({module["id"] for module in payload["modules"]}, {
            "sast", "sca", "sbom", "secrets", "iac", "containers",
            "kubernetes", "cicd", "api", "dast", "cloud",
        })
        categories = {finding["category"] for finding in payload["findings"]}
        self.assertEqual(categories, {"sast", "sca", "secrets", "iac", "containers"})
        self.assertTrue(payload["code_security"])
        self.assertTrue(payload["supply_chain"])
        self.assertEqual(payload["risk"]["level"], "high")
        self.assertTrue(any("Internet-exposed" in reason for reason in payload["risk"]["reasons"]))
        self.assertTrue(payload["attack_paths"])
        self.assertTrue(payload["sbom"]["components"])

    def test_secrets_never_include_secret_values(self):
        parsed = _parse_secrets_report(SECRETS_REPORT)
        self.assertEqual(len(parsed), 1)
        blob = json.dumps(parsed)
        self.assertNotIn("AKIA1234567890FAKE", blob)
        self.assertNotIn("Secret", blob)
        self.assertNotIn("Match", blob)

        payload = build_scan_payload(secrets_raw=SECRETS_REPORT)
        unified = json.dumps(payload["findings"])
        self.assertNotIn("AKIA1234567890FAKE", unified)
        self.assertEqual(payload["findings"][0]["evidence_source"], "Secret Scanning")
        self.assertEqual(payload["findings"][0]["scanner"], "Gitleaks")

    def test_skipped_iac_without_report(self):
        payload = build_scan_payload(
            bearer_raw=BEARER_REPORT,
            pipeline_raw=json.dumps({
                "modules": [
                    {"id": "sast", "status": "COMPLETED"},
                    {"id": "iac", "status": "SKIPPED", "reason": "No supported infrastructure files detected."},
                    {"id": "containers", "status": "SKIPPED", "reason": "No container definition files detected."},
                ]
            }),
        )
        modules = {item["id"]: item for item in payload["modules"]}
        self.assertEqual(modules["iac"]["status"], "SKIPPED")
        self.assertEqual(modules["iac"]["reason"], "No supported infrastructure files detected.")
        self.assertEqual(modules["iac"]["finding_count"], 0)
        self.assertEqual(modules["sast"]["finding_count"], 1)

    def test_checkov_splits_by_category(self):
        iac = _parse_checkov_report(CHECKOV_REPORT, "iac")
        containers = _parse_checkov_report(CONTAINER_REPORT, "containers")
        self.assertEqual(iac[0]["check_id"], "CKV_AWS_20")
        self.assertEqual(containers[0]["check_id"], "CKV_DOCKER_2")
        self.assertTrue(iac[0]["file"].endswith("infra/s3.tf") or iac[0]["file"] == "infra/s3.tf")

    def test_container_frameworks_are_valid_for_pinned_checkov(self):
        from iac_scan import (
            API_FRAMEWORKS,
            CICD_FRAMEWORKS,
            CONTAINER_FRAMEWORKS,
            IAC_FRAMEWORKS,
            KUBERNETES_FRAMEWORKS,
        )

        # Checkov 3.2.334 has no docker_compose CheckType. That value makes the
        # container module exit 2 even when Dockerfiles are present.
        checkov_3_2_runners = {
            "ansible", "argo_workflows", "arm", "azure_pipelines", "bicep",
            "bitbucket_pipelines", "cdk", "circleci_pipelines", "cloudformation",
            "dockerfile", "github_configuration", "github_actions",
            "gitlab_configuration", "gitlab_ci", "bitbucket_configuration",
            "helm", "json", "yaml", "kubernetes", "kustomize", "openapi",
            "sca_package", "sca_image", "secrets", "serverless", "terraform",
            "terraform_json", "terraform_plan",
        }
        for name in ",".join([
            CONTAINER_FRAMEWORKS, IAC_FRAMEWORKS, KUBERNETES_FRAMEWORKS, CICD_FRAMEWORKS, API_FRAMEWORKS,
        ]).split(","):
            self.assertIn(name.strip(), checkov_3_2_runners)
        self.assertNotIn("docker_compose", CONTAINER_FRAMEWORKS.split(","))
        self.assertNotIn("kubernetes", IAC_FRAMEWORKS.split(","))

    def test_extended_modules_normalize_without_secret_leak(self):
        payload = build_scan_payload(
            kubernetes_raw=KUBERNETES_REPORT,
            cicd_raw=CICD_REPORT,
            api_raw=API_REPORT,
            dast_raw=DAST_REPORT,
            pipeline_raw=json.dumps({
                "modules": [
                    {"id": "kubernetes", "status": "COMPLETED"},
                    {"id": "cicd", "status": "COMPLETED"},
                    {"id": "api", "status": "COMPLETED"},
                    {"id": "dast", "status": "COMPLETED"},
                ]
            }),
        )
        categories = {finding["category"] for finding in payload["findings"]}
        self.assertEqual(categories, {"kubernetes", "cicd", "api", "dast"})
        blob = json.dumps(payload)
        self.assertNotIn("should-not-appear", blob)
        self.assertEqual(payload["dast"][0]["uri"], "https://staging.example.com/login")
        self.assertTrue(any(path["hops"][0]["label"] == "Internet" for path in payload["attack_paths"]))

    def test_dast_only_pipeline_keeps_prior_sast_report(self):
        payload = build_scan_payload(
            bearer_raw=BEARER_REPORT,
            dast_raw=DAST_REPORT,
            pipeline_raw=json.dumps({
                "modules": [
                    {"id": "dast", "status": "COMPLETED"},
                    {"id": "sast", "status": "SKIPPED", "reason": "Not part of this dynamic testing run."},
                ]
            }),
        )
        modules = {item["id"]: item for item in payload["modules"]}
        self.assertEqual(modules["sast"]["status"], "COMPLETED")
        self.assertEqual(modules["dast"]["status"], "COMPLETED")
        self.assertTrue(any(item["category"] == "sast" for item in payload["findings"]))
        self.assertTrue(any(item["category"] == "dast" for item in payload["findings"]))

    def test_cloud_report_keeps_only_failed_checks(self):
        payload = build_scan_payload(cloud_raw=CLOUD_REPORT)
        self.assertEqual(len(payload["cloud"]), 1)
        self.assertEqual(payload["cloud"][0]["resource"], "payments-assets")
        self.assertTrue(any(item["category"] == "cloud" for item in payload["findings"]))
        blob = json.dumps(payload)
        self.assertNotIn("Root account has MFA", blob)

    def test_cloud_ocsf_report_keeps_only_failed_checks(self):
        ocsf = json.dumps([
            {
                "status_code": "FAIL",
                "severity": "High",
                "message": "S3 bucket is publicly accessible",
                "status_detail": "Bucket allows public list.",
                "metadata": {"event_code": "s3_bucket_public_access"},
                "finding_info": {"title": "S3 bucket is publicly accessible"},
                "resources": [{"uid": "payments-assets", "name": "payments-assets", "region": "eu-north-1", "group": {"name": "s3"}}],
                "cloud": {"region": "eu-north-1"},
            },
            {
                "status_code": "PASS",
                "severity": "Critical",
                "message": "Root account has MFA",
                "metadata": {"event_code": "iam_root_mfa"},
                "finding_info": {"title": "Root account has MFA"},
                "resources": [{"uid": "root", "region": "eu-north-1"}],
            },
        ])
        payload = build_scan_payload(cloud_raw=ocsf)
        self.assertEqual(len(payload["cloud"]), 1)
        self.assertEqual(payload["cloud"][0]["check_id"], "s3_bucket_public_access")
        blob = json.dumps(payload)
        self.assertNotIn("Root account has MFA", blob)

    def test_legacy_checkov_kubernetes_is_reclassified(self):
        mixed = json.dumps([
            json.loads(CHECKOV_REPORT),
            json.loads(KUBERNETES_REPORT),
        ])
        payload = build_scan_payload(checkov_raw=mixed)
        self.assertEqual(payload["iac"][0]["check_id"], "CKV_AWS_20")
        self.assertEqual(payload["kubernetes"][0]["check_id"], "CKV_K8S_21")

    def test_empty_reports_are_clean(self):
        payload = build_scan_payload(
            bearer_raw="{}",
            grype_raw='{"matches":[]}',
            secrets_raw="[]",
            pipeline_raw=json.dumps({"modules": [{"id": "sast", "status": "COMPLETED"}]}),
        )
        self.assertEqual(payload["findings"], [])
        self.assertEqual(payload["posture"]["total"], 0)

    def test_duplicate_sca_matches_get_unique_finding_ids(self):
        duplicate = json.loads(GRYPE_REPORT)
        duplicate["matches"].append(duplicate["matches"][0])
        payload = build_scan_payload(grype_raw=json.dumps(duplicate))
        ids = [item["id"] for item in payload["findings"] if item["category"] == "sca"]
        self.assertEqual(len(ids), 2)
        self.assertEqual(len(set(ids)), 2)
        self.assertTrue(ids[0].startswith("sca:CVE-2024-1234:left-pad:1.2.3:"))
        self.assertNotEqual(ids[0], ids[1])


if __name__ == "__main__":
    unittest.main()
