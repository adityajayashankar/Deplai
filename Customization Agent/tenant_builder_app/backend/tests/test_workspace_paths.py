from __future__ import annotations

import unittest

from services.repo_service import containerize_connector_workspace_path


class ConnectorWorkspacePathTests(unittest.TestCase):
    def test_windows_host_clone_maps_to_container_repos(self) -> None:
        raw = r"C:\Users\adity\Deplai_AJ\Connector\tmp\repos\adityajayashankar\ifca-"
        self.assertEqual(
            containerize_connector_workspace_path(raw),
            "/app/tmp/repos/adityajayashankar/ifca-",
        )

    def test_posix_host_clone_maps_to_container_repos(self) -> None:
        raw = "/Users/adity/Deplai_AJ/Connector/tmp/repos/acme/app"
        self.assertEqual(
            containerize_connector_workspace_path(raw),
            "/app/tmp/repos/acme/app",
        )

    def test_already_container_path_stays_stable(self) -> None:
        raw = "/app/tmp/repos/adityajayashankar/ifca-"
        self.assertEqual(containerize_connector_workspace_path(raw), raw)

    def test_local_projects_map(self) -> None:
        raw = r"C:\Users\adity\Deplai_AJ\Connector\tmp\local-projects\demo"
        self.assertEqual(
            containerize_connector_workspace_path(raw),
            "/app/tmp/local-projects/demo",
        )


if __name__ == "__main__":
    unittest.main()
