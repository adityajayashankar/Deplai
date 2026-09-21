"""Strict internal preview launch contract, constructed after Connector review.

This is not a browser authorization format. A host launch must additionally check
its authenticated control-plane capability and locally registered worktree owner.
"""
import re


class PreviewError(RuntimeError):
    def __init__(self, code, stage=None):
        super().__init__(code)
        self.code, self.stage = code, stage


FAILURES = frozenset([
    'CONTRACT_INVALID', 'SANDBOX_CREATE_FAILED', 'WORKSPACE_MOUNT_FAILED',
    'DEPENDENCY_INSTALL_FAILED', 'SECRET_RESOLUTION_FAILED', 'DATABASE_START_FAILED',
    'MIGRATION_FAILED', 'BACKEND_START_FAILED', 'BACKEND_HEALTH_FAILED',
    'FRONTEND_START_FAILED', 'FRONTEND_HEALTH_FAILED', 'PROXY_CONFIGURATION_FAILED',
    'COOKIE_VALIDATION_FAILED', 'WEBSOCKET_VALIDATION_FAILED', 'REVISION_MISMATCH',
    'RESOURCE_LIMIT_EXCEEDED', 'PREVIEW_TIMEOUT', 'CANCELLED', 'CLEANUP_FAILED',
])


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}', value):
        raise PreviewError('CONTRACT_INVALID')
    return value


def fields(value, required, optional=()):
    if not isinstance(value, dict) or set(value) - set(required) - set(optional) or set(required) - set(value):
        raise PreviewError('CONTRACT_INVALID')


def integer(value, minimum, maximum):
    if type(value) is not int or not minimum <= value <= maximum:
        raise PreviewError('CONTRACT_INVALID')
    return value


def relative(value):
    if value == '.':
        return value
    if not isinstance(value, str) or len(value) > 256 or any(part in ('', '.', '..') for part in value.split('/')) or re.search(r'[\\:\x00-\x1f]', value):
        raise PreviewError('CONTRACT_INVALID')
    return value


def command(value):
    if not isinstance(value, list) or not 1 <= len(value) <= 64 or any(not isinstance(arg, str) or not arg or len(arg) > 2048 or re.search(r'[\x00\r\n]', arg) for arg in value):
        raise PreviewError('CONTRACT_INVALID')
    return value


def validate(manifest):
    fields(manifest, ['schema_version', 'scope', 'revision', 'worktree_id', 'runtime_manifest_sha256', 'preview_manifest_sha256', 'services', 'resources', 'quota'])
    if manifest['schema_version'] != 1:
        raise PreviewError('CONTRACT_INVALID')
    fields(manifest['scope'], ['owner_user_id', 'organization_id', 'project_id', 'session_id'])
    for value in manifest['scope'].values():
        identifier(value)
    identifier(manifest['worktree_id'])
    for key, pattern in [('revision', r'(?:[a-f0-9]{40}|[a-f0-9]{64})'), ('runtime_manifest_sha256', r'[a-f0-9]{64}'), ('preview_manifest_sha256', r'[a-f0-9]{64}')]:
        if not isinstance(manifest[key], str) or not re.fullmatch(pattern, manifest[key]):
            raise PreviewError('CONTRACT_INVALID')
    maxima = dict(cpu=8, memory_mb=16384, disk_mb=32768, pids=512,
                  idle_seconds=3600, lifetime_seconds=14400, startup_seconds=900,
                  runtime_resources=16, concurrent_previews=4)
    limits = manifest['quota']; fields(limits, maxima)
    for key, maximum in maxima.items():
        if key == 'cpu':
            if type(limits[key]) not in (int, float) or not 0.5 <= limits[key] <= maximum:
                raise PreviewError('CONTRACT_INVALID')
        else:
            integer(limits[key], 1, maximum)
    if limits['idle_seconds'] > limits['lifetime_seconds'] or limits['startup_seconds'] > limits['lifetime_seconds'] or limits['memory_mb'] < 512 or limits['disk_mb'] < 64 or limits['pids'] < 64:
        raise PreviewError('CONTRACT_INVALID')
    services, resources = manifest['services'], manifest['resources']
    if not isinstance(services, list) or not 1 <= len(services) <= 2 or not isinstance(resources, list) or len(resources) > 1:
        raise PreviewError('CONTRACT_INVALID')
    if len(services) + len(resources) > limits['runtime_resources']:
        raise PreviewError('RESOURCE_LIMIT_EXCEEDED')
    seen, roles, ports = set(), set(), set()
    for service in services:
        fields(service, ['id', 'role', 'framework', 'directory', 'install', 'start', 'migration', 'port', 'health_path', 'environment_keys'])
        identifier(service['id']); relative(service['directory'])
        integer(service['port'], 1024, 65535)
        if service['port'] in (5432, 18080):
            raise PreviewError('CONTRACT_INVALID')
        if not isinstance(service['role'], str) or not isinstance(service['framework'], str):
            raise PreviewError('CONTRACT_INVALID')
        if service['id'] in seen or service['role'] in roles or service['port'] in ports:
            raise PreviewError('CONTRACT_INVALID')
        seen.add(service['id']); roles.add(service['role']); ports.add(service['port'])
        supported = {'frontend': ['react-vite', 'next'], 'backend': ['node', 'fastapi']}
        if service['framework'] not in supported.get(service['role'], []):
            raise PreviewError('CONTRACT_INVALID')
        integer(service['port'], 1024, 65535)
        for key in ['install', 'start']:
            command(service[key])
        if service['migration'] is not None:
            command(service['migration'])
        if not isinstance(service['health_path'], str) or not re.fullmatch(r'/[a-zA-Z0-9/_-]*', service['health_path']):
            raise PreviewError('CONTRACT_INVALID')
        keys = service['environment_keys']
        if not isinstance(keys, list) or len(keys) > 100 or any(not isinstance(key, str) or not re.fullmatch(r'[A-Z][A-Z0-9_]{0,127}', key) for key in keys) or len(set(keys)) != len(keys):
            raise PreviewError('CONTRACT_INVALID')
    if 'frontend' not in roles:
        raise PreviewError('CONTRACT_INVALID')
    for resource in resources:
        fields(resource, ['id', 'kind'])
        identifier(resource['id'])
        if resource['kind'] != 'postgres' or resource['id'] in seen:
            raise PreviewError('CONTRACT_INVALID')
    return manifest
