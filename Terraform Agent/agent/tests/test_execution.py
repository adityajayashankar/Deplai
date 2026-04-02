from __future__ import annotations

import unittest

from terraform_agent.agent.engine.execution import (
    extract_apply_errors,
    extract_diagnostics,
    extract_failed_resource_types,
    parse_json_stream,
)


class ExecutionTests(unittest.TestCase):
    def test_extract_diagnostics_from_json_stream(self) -> None:
        stream = "\n".join(
            [
                '{"type":"diagnostic","diagnostic":{"severity":"error","summary":"Unsupported argument","detail":"Argument \\"foo\\" is not expected here."}}',
                '{"type":"change_summary","changes":{"add":1}}',
            ]
        )
        events = parse_json_stream(stream)
        diagnostics = extract_diagnostics(events)
        self.assertEqual(len(diagnostics), 1)
        self.assertEqual(diagnostics[0]["summary"], "Unsupported argument")

    def test_extract_failed_resource_types(self) -> None:
        failures = extract_apply_errors(
            [
                {"type": "apply_errored", "resource_addr": "aws_db_instance.main"},
                {"type": "apply_errored", "resource_type": "aws_instance"},
            ]
        )
        self.assertEqual(extract_failed_resource_types(failures), ["aws_db_instance", "aws_instance"])
