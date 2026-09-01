from __future__ import annotations

import unittest

from aws_discovery.service import discover_aws_environment


class FakeClient:
    def __init__(self, service: str) -> None:
        self.service = service

    def get_caller_identity(self): return {"Account": "123456789012"}
    def describe_vpcs(self): return {"Vpcs": [{"VpcId": "vpc-1", "State": "available", "Tags": [{"Key": "Name", "Value": "prod"}]}]}
    def describe_subnets(self): return {"Subnets": []}
    def describe_nat_gateways(self): return {"NatGateways": []}
    def describe_security_groups(self): return {"SecurityGroups": []}
    def describe_instances(self): return {"Reservations": []}
    def describe_db_instances(self): return {"DBInstances": [{"DBInstanceIdentifier": "prod-db", "Engine": "postgres", "PubliclyAccessible": False}]}
    def list_clusters(self): return {"clusterArns": []}
    def describe_clusters(self, **_kwargs): return {"clusters": []}
    def describe_repositories(self): return {"repositories": []}
    def list_buckets(self): return {"Buckets": []}
    def list_hosted_zones(self): return {"HostedZones": []}
    def list_certificates(self): return {"CertificateSummaryList": []}
    def list_secrets(self): return {"SecretList": [{"Name": "prod/database", "ARN": "arn:secret", "RotationEnabled": True}]}


class FakeSession:
    received = {}

    def __init__(self, **kwargs):
        FakeSession.received = kwargs

    def client(self, service: str, **_kwargs):
        return FakeClient(service)


class AwsDiscoveryTests(unittest.TestCase):
    def test_returns_metadata_and_never_credentials(self) -> None:
        context = discover_aws_environment(
            aws_access_key_id="AKIA_TEST", aws_secret_access_key="super-secret",
            aws_session_token="token", region="eu-north-1", session_factory=FakeSession,
        )
        payload = context.model_dump_json()
        self.assertEqual(context.account_id, "123456789012")
        self.assertEqual(context.status, "complete")
        self.assertNotIn("super-secret", payload)
        self.assertNotIn("AKIA_TEST", payload)
        self.assertTrue(any(item.resource_type == "secret_metadata" for item in context.resources))
        self.assertTrue(any(item.resource_type == "rds" for item in context.reuse_recommendations))


if __name__ == "__main__":
    unittest.main()
