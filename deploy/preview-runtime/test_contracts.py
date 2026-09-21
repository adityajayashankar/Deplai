import copy
import unittest
from contracts import PreviewError, validate
from fixture import manifest
from install_proxy import resolve


class Contracts(unittest.TestCase):
    def example(self):
        return manifest('a' * 40, dict(owner_user_id='u', organization_id='o', project_id='p', session_id='s'))

    def test_exact_scope_and_revision_are_mandatory(self):
        value = self.example()
        self.assertIs(validate(value), value)
        for field in value:
            bad = copy.deepcopy(value); del bad[field]
            with self.assertRaises(PreviewError):
                validate(bad)
        for revision in ['main', 'HEAD', 'a' * 39, '', '../other']:
            bad = copy.deepcopy(value); bad['revision'] = revision
            with self.assertRaises(PreviewError):
                validate(bad)

    def test_service_paths_commands_secrets_and_ports_are_narrow(self):
        for field, inputs in dict(directory=['../outside', '/tmp', 'C:/tmp', 'a\\b', 'a//b'],
                                  start=[[], ['node\nmalicious'], ['']], port=[True, 0, 5432, 18080, 65536],
                                  environment_keys=[['key'], ['KEY', 'KEY'], [['bad']]]).items():
            for value in inputs:
                candidate = self.example(); candidate['services'][0][field] = value
                with self.assertRaises(PreviewError):
                    validate(candidate)
        candidate = self.example(); candidate['services'][0]['environment'] = {'TOKEN': 'not-accepted'}
        with self.assertRaises(PreviewError):
            validate(candidate)

    def test_unknown_architectures_and_over_quota_resources_cannot_launch(self):
        candidate = self.example(); candidate['services'][1]['framework'] = 'unknown'
        with self.assertRaises(PreviewError):
            validate(candidate)
        candidate = self.example(); candidate['quota']['runtime_resources'] = 2
        with self.assertRaisesRegex(PreviewError, 'RESOURCE_LIMIT_EXCEEDED'):
            validate(candidate)
        for key in self.example()['quota']:
            for value in [0, -1, True, float('inf'), float('nan')]:
                candidate = self.example(); candidate['quota'][key] = value
                with self.assertRaises(PreviewError):
                    validate(candidate)

    def test_install_proxy_pins_public_addresses_and_rejects_mixed_dns(self):
        def dns(ip):
            return lambda *_args, **_kwargs: [(2, 1, 6, '', (ip, 443))]
        allowed = {'registry.npmjs.org'}
        self.assertEqual(resolve('registry.npmjs.org:443', allowed, dns('8.8.8.8'))[-1], ('8.8.8.8', 443))
        for authority in ['169.254.169.254:443', 'registry.npmjs.org:80', 'registry.npmjs.org.evil:443', 'user@registry.npmjs.org:443', 'registry.npmjs.org:443\r\n']:
            with self.assertRaises(ValueError):
                resolve(authority, allowed, dns('8.8.8.8'))
        for address in ['127.0.0.1', '169.254.169.254', '10.0.0.1', '::1', 'fd00::1', '::ffff:8.8.8.8', '224.0.0.1']:
            with self.assertRaises(ValueError):
                resolve('registry.npmjs.org:443', allowed, lambda *_a, **_k: [*dns('8.8.8.8')(), *dns(address)()])


if __name__ == '__main__':
    unittest.main()
