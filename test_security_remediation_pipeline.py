from __future__ import annotations

import sys
import types
import unittest


if "utils" not in sys.modules:
    utils_stub = types.ModuleType("utils")
    utils_stub.CODEBASE_VOLUME = "codebase"
    utils_stub.decode_output = lambda value: value.decode() if isinstance(value, bytes) else str(value)
    utils_stub.find_volume_file = lambda *args, **kwargs: None
    utils_stub.get_docker_client = lambda *args, **kwargs: None
    utils_stub.read_volume_file = lambda *args, **kwargs: None
    utils_stub.resolve_host_projects_dir = lambda: None
    utils_stub.set_current_project_id = lambda *args, **kwargs: None
    sys.modules["utils"] = utils_stub

if "claude_remediator" not in sys.modules:
    claude_stub = types.ModuleType("claude_remediator")
    claude_stub._call_claude_sdk = lambda *args, **kwargs: (False, "stubbed")
    sys.modules["claude_remediator"] = claude_stub

from remediation_pipeline.generator import FixGenerator
from remediation_pipeline.models import Fix, Snippet, SnippetBundle, Vulnerability
from remediation_pipeline.orchestrator import RemediationOrchestrator


class _UnexpectedRouter:
    def route(self, *args, **kwargs):
        raise AssertionError("deterministic SCA fixes must not call the LLM router")


def _sca_bundle(
    source_text: str,
    *,
    filepath: str = "requirements.txt",
    package_name: str = "pyyaml",
    fix_version: str = "5.4",
) -> tuple[SnippetBundle, dict[str, Vulnerability]]:
    vuln = Vulnerability(
        id="sca-1",
        file=filepath,
        line_start=1,
        line_end=1,
        rule_id="GHSA-1234",
        severity="critical",
        description="Dependency vulnerability",
        package_name=package_name,
        installed_version="5.3",
        fix_version=fix_version,
        type="sca",
    )
    bundle = SnippetBundle(
        filepath=filepath,
        language="Text",
        source_text=source_text,
        imports_block="",
        snippets=[
            Snippet(
                vuln_id="sca-1",
                line_start=1,
                line_end=1,
                code=f"# VULN: {package_name}\n{source_text.strip()}",
            )
        ],
        token_estimate=32,
    )
    return bundle, {"sca-1": vuln}


class SecurityRemediationPipelineTests(unittest.TestCase):
    def test_requirements_fix_uses_scanner_fix_version_without_llm(self) -> None:
        bundle, lookup = _sca_bundle("pyyaml==5.3\nflask==3.0.0\n")

        fix = FixGenerator(_UnexpectedRouter()).generate(bundle, lookup)

        self.assertEqual(fix.provider_used, "deterministic")
        self.assertEqual(fix.status, "auto")
        self.assertIn("-pyyaml==5.3", fix.diff)
        self.assertIn("+pyyaml==5.4", fix.diff)

    def test_package_json_fix_preserves_semver_prefix(self) -> None:
        source = '{\n  "dependencies": {\n    "lodash": "^4.17.20"\n  }\n}\n'
        bundle, lookup = _sca_bundle(source, filepath="package.json", package_name="lodash", fix_version="4.17.21")

        fix = FixGenerator(_UnexpectedRouter()).generate(bundle, lookup)

        self.assertEqual(fix.provider_used, "deterministic")
        self.assertIn('-    "lodash": "^4.17.20"', fix.diff)
        self.assertIn('+    "lodash": "^4.17.21"', fix.diff)

    def test_package_json_fix_patches_fixable_sca_subset_without_llm(self) -> None:
        source = '{\n  "dependencies": {\n    "lodash": "^4.17.20",\n    "left-pad": "^1.3.0"\n  }\n}\n'
        bundle, lookup = _sca_bundle(source, filepath="package.json", package_name="lodash", fix_version="4.17.21")
        unfixed = Vulnerability(
            id="sca-2",
            file="package.json",
            line_start=4,
            line_end=4,
            rule_id="GHSA-unfixed",
            severity="critical",
            description="No fixed version published",
            package_name="left-pad",
            installed_version="1.3.0",
            fix_version=None,
            type="sca",
        )
        bundle = bundle.model_copy(update={
            "snippets": [
                *bundle.snippets,
                Snippet(vuln_id="sca-2", line_start=4, line_end=4, code='# VULN: left-pad\n    "left-pad": "^1.3.0"'),
            ],
        })
        lookup["sca-2"] = unfixed

        fix = FixGenerator(_UnexpectedRouter()).generate(bundle, lookup)

        self.assertEqual(fix.provider_used, "deterministic")
        self.assertEqual(fix.vulns_addressed, ["sca-1"])
        self.assertIn("Some SCA findings", fix.warnings[0])

    def test_patched_files_apply_multiple_diffs_for_same_file_in_order(self) -> None:
        orchestrator = RemediationOrchestrator()
        original = "a = 1\nb = 2\n"
        fixes = [
            Fix(
                filepath="src/example.py",
                diff="--- a/src/example.py\n+++ b/src/example.py\n@@ -1,2 +1,2 @@\n-a = 1\n+a = 10\n b = 2",
                vulns_addressed=["v1"],
                provider_used="deterministic",
                tokens_used=0,
                status="auto",
            ),
            Fix(
                filepath="src/example.py",
                diff="--- a/src/example.py\n+++ b/src/example.py\n@@ -1,2 +1,2 @@\n a = 10\n-b = 2\n+b = 20",
                vulns_addressed=["v2"],
                provider_used="deterministic",
                tokens_used=0,
                status="auto",
            ),
        ]

        patched = orchestrator._build_patched_files(fixes, lambda _: original)

        self.assertEqual(patched["src/example.py"], "a = 10\nb = 20\n")


if __name__ == "__main__":
    unittest.main()
