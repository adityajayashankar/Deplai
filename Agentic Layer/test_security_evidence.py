import json
import unittest
from sdlc_pipeline import validate_report, TOOLS, SDLC_PHASES
from security_redaction import redact


class EvidenceTests(unittest.TestCase):
    def test_all_tools_have_one_phase(self):
        scheduled = [tool for _, _, group in SDLC_PHASES for tool in group]
        self.assertCountEqual(scheduled, TOOLS)
        self.assertEqual(len(scheduled), len(set(scheduled)))

    def test_missing_and_wrong_reports_never_pass(self):
        for tool in TOOLS:
            for raw in (None, '', '{broken', '{"error":"scanner failed"}'):
                with self.subTest(tool=tool, raw=raw), self.assertRaises((ValueError, TypeError)):
                    validate_report(tool, raw)

    def test_zero_targets_are_not_clean_coverage(self):
        result = validate_report('iac', json.dumps({'results': {'passed_checks': [], 'failed_checks': []}}))
        self.assertEqual(result['coverage'], 'not_applicable')
        result = validate_report('secrets', '[]')
        self.assertIsNone(result['checked_target_count'])

    def test_empty_bearer_object_is_a_valid_zero_finding_report(self):
        result = validate_report('sast', '{}')
        self.assertTrue(result['report_validated'])
        self.assertEqual(result['coverage'], 'evaluated')

    def test_checkov_empty_framework_summary_is_not_applicable(self):
        result = validate_report('iac', json.dumps({
            'passed': 0, 'failed': 0, 'skipped': 0, 'parsing_errors': 0,
            'resource_count': 0, 'checkov_version': '3.2.334',
        }))
        self.assertEqual(result['coverage'], 'not_applicable')
        with self.assertRaises(ValueError):
            validate_report('iac', json.dumps({
                'passed': 0, 'failed': 0, 'skipped': 0, 'parsing_errors': 1,
                'resource_count': 0, 'checkov_version': '3.2.334',
            }))

    def test_parse_errors_are_failures_even_with_passed_checks(self):
        with self.assertRaises(ValueError):
            validate_report('iac', json.dumps({'results': {'passed_checks': [{}], 'parsing_errors': ['main.tf']}}))

    def test_scanner_secrets_redacted(self):
        for raw in ('token=abcdefghi', 'Bearer abcdefghi', 'https://user:password@example.test', 'ghp_12345678901234'):
            self.assertIn('[redacted]', redact(raw))


if __name__ == '__main__':
    unittest.main()
