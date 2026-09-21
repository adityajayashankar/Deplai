import copy
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from boundary import CHECKS, hardened_args, image_digest, lifecycle, proof_passed, public_target, quota
from egress_broker import target
from run_proof import Controller


class BoundaryTests(unittest.TestCase):
    def test_proof_requires_every_observed_gate(self):
        complete = {key: 'PASS' for key in CHECKS}
        self.assertTrue(proof_passed(complete))
        for key in CHECKS:
            for status in ['FAILED', 'NOT_RUN', True, None]:
                self.assertFalse(proof_passed({**complete, key: status}))
            missing = dict(complete); del missing[key]
            self.assertFalse(proof_passed(missing))

    def test_quotas_and_hardening_are_bounded(self):
        for key in quota():
            for value in [0, -1, float('inf'), float('nan'), True, 100000]:
                with self.assertRaises(ValueError):
                    quota(**{key: value})
        image = 'python@sha256:' + 'a' * 64
        args = hardened_args('proof-' + 'b' * 32 + '-api', 'b' * 32, image, quota())
        self.assertIn('--runtime=runsc', args)
        self.assertEqual(args[args.index('--network') + 1], 'none')
        self.assertIn('--read-only', args); self.assertIn('--cap-drop=ALL', args)
        self.assertNotIn('--privileged', args); self.assertNotIn('-p', args)
        for bad in ['python:latest', 'python@sha256:short', '--privileged']:
            with self.assertRaises(ValueError):
                image_digest(bad)

    def test_hard_ttl_is_not_extended_by_activity(self):
        record = dict(state='RUNNING', created_at=100, last_activity_at=105, idle_seconds=10, hard_seconds=30)
        self.assertEqual(lifecycle(record, 110), 'RUNNING')
        self.assertEqual(lifecycle(record, 115), 'STOPPED')
        self.assertEqual(lifecycle({**record, 'last_activity_at': 129}, 130), 'STOPPED')
        self.assertEqual(lifecycle(record, 99), 'STOPPED')
        self.assertEqual(lifecycle({**record, 'state': 'DESTROYED'}, 200), 'DESTROYED')

    def test_egress_refuses_private_mixed_dns_rebinding_and_credentials(self):
        for ip in ['127.0.0.1', '169.254.169.254', '10.0.0.1', '172.17.0.1', '192.168.0.1', '::1', 'fd00::1', '::ffff:8.8.8.8', '224.0.0.1']:
            with self.assertRaises(ValueError):
                public_target('registry.npmjs.org', ['8.8.8.8', ip], {'registry.npmjs.org'})
        def dns(*_args, **_kwargs):
            return [(2, 1, 6, '', ('8.8.8.8', 443))]
        host, address, path = target('https://registry.npmjs.org/-/ping', {'registry.npmjs.org'}, dns)
        self.assertEqual((host, address, path), ('registry.npmjs.org', '8.8.8.8', '/-/ping'))
        for url in ['http://registry.npmjs.org/', 'https://user:pass@registry.npmjs.org/', 'https://registry.npmjs.org:8443/', 'https://registry.npmjs.org.evil.invalid/', 'https://registry.npmjs.org/\r\nInjected: value']:
            with self.assertRaises(ValueError):
                target(url, {'registry.npmjs.org'}, dns)

    def test_controller_restart_and_gc_are_label_scoped_and_durable(self):
        run_id = 'a' * 32
        name = 'proof-' + run_id + '-app'
        container = dict(Id='fixed-id', Name='/' + name, Config={'Labels': {'deplai.proof': run_id}})
        calls = []
        def docker(*args):
            calls.append(args)
            if args[0] == 'ps': return 'fixed-id'
            if args[0] == 'inspect':
                import json
                return json.dumps([container])
            return ''
        with tempfile.TemporaryDirectory() as directory, patch('run_proof.docker', docker):
            controller = Controller(Path(directory), run_id)
            controller.register(name, quota())
            controller.records[name]['created_at'] = 0
            from run_proof import atomic_json
            atomic_json(controller.registry, controller.records)
            reopened = Controller(Path(directory), run_id)
            reopened.gc()
            self.assertEqual(reopened.records[name]['state'], 'DESTROYED')
            self.assertIn(('rm', '-f', 'fixed-id'), calls)
            container['Config']['Labels']['deplai.proof'] = 'another-owner'
            calls.clear()
            with self.assertRaises(RuntimeError):
                reopened.destroy(copy.deepcopy(container))
            self.assertFalse(any(call[0] == 'rm' for call in calls))


if __name__ == '__main__':
    unittest.main()
