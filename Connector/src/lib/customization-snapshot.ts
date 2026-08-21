import fs from 'fs';
import path from 'path';
import { resolveExistingProjectSourceRoot } from '@/lib/project-meta';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const CUSTOMIZATION_AGENT_URL = (
  process.env.CUSTOMIZATION_AGENT_BASE_URL
  || process.env.CUSTOMIZATION_BACKEND_URL
  || 'http://127.0.0.1:8010'
).replace(/\/+$/, '');

export interface CustomizationSnapshotSource {
  kind: 'customization_snapshot';
  project_id: string;
  tenant_id: string;
  snapshot_id: string;
  snapshot_path: string;
  agentic_source_root: string;
  source_tree_hash: string;
  changed_file_hashes: Record<string, CustomizationSnapshotFileChange>;
  created_at: string | null;
  status: 'immutable';
}

export interface CustomizationSnapshotFileChange {
  status: 'added' | 'modified' | 'deleted';
  sha256: string | null;
  base_sha256: string | null;
}

export class SnapshotResolutionError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'SnapshotResolutionError';
    this.status = status;
  }
}

function assertSafeId(value: string, label: string): string {
  const normalized = String(value || '').trim();
  if (!SAFE_ID.test(normalized)) {
    throw new SnapshotResolutionError(`${label} is invalid.`);
  }
  return normalized;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function parseSnapshotFileChanges(value: unknown): Record<string, CustomizationSnapshotFileChange> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SnapshotResolutionError('Snapshot changed-file metadata is missing or invalid.', 409);
  }

  const parsed: Record<string, CustomizationSnapshotFileChange> = {};
  for (const [filePath, changeValue] of Object.entries(value)) {
    if (
      !filePath
      || filePath.includes('\0')
      || filePath.includes('\\')
      || path.posix.isAbsolute(filePath)
      || filePath.split('/').some((segment) => !segment || segment === '.' || segment === '..')
    ) {
      throw new SnapshotResolutionError('Snapshot changed-file metadata contains an unsafe path.', 409);
    }
    if (!changeValue || typeof changeValue !== 'object' || Array.isArray(changeValue)) {
      throw new SnapshotResolutionError(`Snapshot change metadata is invalid for ${filePath}.`, 409);
    }

    const change = changeValue as Record<string, unknown>;
    const status = String(change.status || '');
    if (status !== 'added' && status !== 'modified' && status !== 'deleted') {
      throw new SnapshotResolutionError(`Snapshot change status is invalid for ${filePath}.`, 409);
    }
    const sha256 = change.sha256 === null ? null : String(change.sha256 || '').toLowerCase();
    const baseSha256 = change.base_sha256 === null
      ? null
      : String(change.base_sha256 || '').toLowerCase();
    if (
      (sha256 !== null && !SHA256.test(sha256))
      || (baseSha256 !== null && !SHA256.test(baseSha256))
      || (status === 'added' && (sha256 === null || baseSha256 !== null))
      || (status === 'modified' && (sha256 === null || baseSha256 === null))
      || (status === 'deleted' && (sha256 !== null || baseSha256 === null))
    ) {
      throw new SnapshotResolutionError(`Snapshot hashes are invalid for ${filePath}.`, 409);
    }

    parsed[filePath] = {
      status,
      sha256,
      base_sha256: baseSha256,
    };
  }
  return parsed;
}

export function mapConnectorSourceToAgentic(
  sourcePath: string,
  connectorRoot = process.cwd(),
): string {
  const mappings = [
    {
      connector: path.resolve(connectorRoot, 'tmp', 'repos'),
      agentic: '/repos',
    },
    {
      connector: path.resolve(connectorRoot, 'tmp', 'local-projects'),
      agentic: '/local-projects',
    },
  ];

  for (const mapping of mappings) {
    if (!isWithin(mapping.connector, sourcePath)) continue;
    const relative = path.relative(mapping.connector, path.resolve(sourcePath));
    return path.posix.join(mapping.agentic, ...relative.split(path.sep));
  }

  const normalized = sourcePath.replace(/\\/g, '/');
  for (const [marker, mount] of [
    ['/app/tmp/repos/', '/repos/'],
    ['/app/tmp/local-projects/', '/local-projects/'],
  ] as const) {
    const index = normalized.indexOf(marker);
    if (index >= 0) return `${mount}${normalized.slice(index + marker.length)}`;
  }

  throw new SnapshotResolutionError(
    'Snapshot source is outside the shared repository volumes.',
    409,
  );
}

export async function resolveCustomizationSnapshot(params: {
  userId: string;
  projectId: string;
  tenantId: string;
  snapshotId: string;
}): Promise<CustomizationSnapshotSource> {
  const projectId = assertSafeId(params.projectId, 'project_id');
  const tenantId = assertSafeId(params.tenantId, 'tenant_id');
  const snapshotId = assertSafeId(params.snapshotId, 'snapshot_id');
  const sourceRoot = await resolveExistingProjectSourceRoot(params.userId, projectId);
  if (!sourceRoot) {
    throw new SnapshotResolutionError(
      'The owned project source is unavailable; the snapshot cannot be resolved.',
      404,
    );
  }

  const url = new URL(
    `/api/tenant/snapshots/${encodeURIComponent(snapshotId)}`,
    CUSTOMIZATION_AGENT_URL,
  );
  url.searchParams.set('tenant_id', tenantId);
  url.searchParams.set('base_repo_path', sourceRoot);

  let response: Response;
  try {
    response = await fetch(url, { cache: 'no-store' });
  } catch (error) {
    throw new SnapshotResolutionError(
      `Customization snapshot service is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      502,
    );
  }

  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    throw new SnapshotResolutionError(
      String(payload.detail || payload.error || 'Snapshot could not be resolved.'),
      response.status >= 400 && response.status < 500 ? response.status : 502,
    );
  }

  const raw = (
    payload.snapshot && typeof payload.snapshot === 'object'
      ? payload.snapshot
      : payload
  ) as Record<string, unknown>;
  if (
    String(raw.snapshot_id || '') !== snapshotId
    || String(raw.tenant_id || '') !== tenantId
    || String(raw.status || '') !== 'immutable'
  ) {
    throw new SnapshotResolutionError(
      'Snapshot metadata does not match the requested immutable snapshot.',
      409,
    );
  }

  const snapshotPath = path.resolve(String(raw.snapshot_path || ''));
  const expectedPath = path.resolve(
    path.dirname(sourceRoot),
    '.deplai-snapshots',
    tenantId,
    snapshotId,
  );
  if (snapshotPath !== expectedPath || !fs.existsSync(snapshotPath) || !fs.statSync(snapshotPath).isDirectory()) {
    throw new SnapshotResolutionError(
      'Snapshot source is missing or does not match its validated location.',
      409,
    );
  }

  const sourceTreeHash = String(raw.source_tree_hash || '').trim();
  if (!SHA256.test(sourceTreeHash)) {
    throw new SnapshotResolutionError('Snapshot integrity metadata is missing.', 409);
  }
  const changedFileHashes = parseSnapshotFileChanges(raw.changed_file_hashes);

  return {
    kind: 'customization_snapshot',
    project_id: projectId,
    tenant_id: tenantId,
    snapshot_id: snapshotId,
    snapshot_path: snapshotPath,
    agentic_source_root: mapConnectorSourceToAgentic(snapshotPath),
    source_tree_hash: sourceTreeHash,
    changed_file_hashes: changedFileHashes,
    created_at: raw.created_at ? String(raw.created_at) : null,
    status: 'immutable',
  };
}
