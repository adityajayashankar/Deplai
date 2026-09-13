import difflib
import unittest
from remediation_pipeline.patch_assembly import assemble_patches
from remediation_pipeline.validator import DiffValidator


def diff(before, after):
    return ''.join(difflib.unified_diff(before.splitlines(keepends=True), after.splitlines(keepends=True), fromfile='a/package.json', tofile='b/package.json'))

class PatchAssemblyTests(unittest.TestCase):
    def test_json_independent_keys_on_same_line(self):
        import json
        source = '{"a":1,"b":1}\n'
        result = assemble_patches(source, [diff(source, '{"a":2,"b":1}\n'), diff(source, '{"a":1,"b":2}\n')], DiffValidator._apply_unified_diff)
        self.assertEqual(json.loads(result), {'a':2,'b':2})

    def test_json_conflicting_versions_are_not_selected(self):
        source = '{"version":"1"}\n'
        with self.assertRaises(ValueError):
            assemble_patches(source, [diff(source, '{"version":"2"}\n'), diff(source, '{"version":"3"}\n')], DiffValidator._apply_unified_diff)

    def test_independent_edits_with_shared_context_and_duplicates(self):
        source = '{\n  "a": "1",\n  "b": "1"\n}\n'
        a = diff(source, source.replace('"a": "1"', '"a": "2"'))
        b = diff(source, source.replace('"b": "1"', '"b": "2"'))
        result = assemble_patches(source, [a, b, a], DiffValidator._apply_unified_diff)
        self.assertEqual(result, source.replace('"1"', '"2"'))

    def test_conflicting_versions_are_not_silently_overwritten(self):
        source = 'version=1\n'
        with self.assertRaisesRegex(ValueError, 'Conflicting patches'):
            assemble_patches(source, [diff(source,'version=2\n'),diff(source,'version=3\n')], DiffValidator._apply_unified_diff)

    def test_explicit_sequential_rounds(self):
        source, next_source, final = 'one\n', 'two\n', 'three\n'
        self.assertEqual(assemble_patches(source, [diff(source,next_source),diff(next_source,final)], DiffValidator._apply_unified_diff), final)

    def test_stale_patch_still_fails(self):
        with self.assertRaises(ValueError):
            assemble_patches('changed\n', [diff('original\n','fixed\n')], DiffValidator._apply_unified_diff)

    def test_crlf_sources(self):
        self.assertEqual(assemble_patches('one\r\n', [diff('one\n','two\n')], DiffValidator._apply_unified_diff), 'two\n')
