import 'server-only';
import { withTransaction } from '../db';
import { requireProjectPermission } from '../organizations/store';
import { encryptSecret, decryptSecret } from '../ai-platform/crypto';
import { buildSessions } from './store';
import { createSecretStore, type SecretMetadata, type SecretRecord } from './secrets';

function encryptionReady() {
  // Reuse the platform AES-GCM backend, but never its development/session-key fallback.
  const key = process.env.AI_CREDENTIAL_ENCRYPTION_KEY?.trim();
  if (!key || key.length < 32 || /^(?:change|example|placeholder|deplai-dev)/i.test(key)) throw new Error('Build secret encryption is not configured');
}

const vault = createSecretStore({
  authorize: async (actor, scope, write) => {
    await buildSessions.get(actor, scope);
    await requireProjectPermission({ userId: actor, projectId: scope.project_id, action: write ? 'secret.update' : 'secret.read_metadata' });
  },
  encrypt: value => { encryptionReady(); return encryptSecret(value); },
  decrypt: value => { encryptionReady(); return decryptSecret(value); },
  authorizeRuntime: async () => { throw new Error('Preview runtime authorization is not implemented'); },
  transaction: (scope, work) => withTransaction(async exec => {
    const params = [scope.session_id, scope.owner_user_id, scope.organization_id, scope.project_id];
    const where = 'session_id = ? AND owner_user_id = ? AND organization_id = ? AND project_id = ?';
    const sessions = await exec<Array<{ state: string }>>(`SELECT state FROM build_sessions WHERE ${where} FOR UPDATE`, params);
    if (!sessions[0] || ['CANCELLED', 'FAILED', 'READY_TO_DEPLOY'].includes(sessions[0].state)) throw new Error('Build secret scope is unavailable');
    async function records(ref?: string): Promise<SecretRecord[]> {
      const rows = await exec<Array<{ reference_id: string; metadata_json: SecretMetadata | string; ciphertext: string | null }>>(
        `SELECT m.reference_id, m.metadata_json, v.ciphertext FROM build_secret_metadata m LEFT JOIN build_secret_values v ON v.reference_id = m.reference_id
         WHERE m.session_id = ? AND m.owner_user_id = ? AND m.organization_id = ? AND m.project_id = ?${ref ? ' AND m.reference_id = ?' : ''}`, ref ? [...params, ref] : params);
      return rows.map(row => ({ scope: { ...scope }, metadata: typeof row.metadata_json === 'string' ? JSON.parse(row.metadata_json) : row.metadata_json, ciphertext: row.ciphertext }));
    }
    return work({
      get: async ref => (await records(ref))[0] || null,
      list: () => records(),
      put: async record => {
        if (record.metadata.preview_id) {
          const preview = await exec<Array<{ resource_id: string }>>(`SELECT resource_id FROM build_resources WHERE resource_id = ? AND kind = 'preview' AND ${where}`, [record.metadata.preview_id, ...params]);
          if (!preview[0]) throw new Error('Preview secret scope is unavailable');
        }
        await exec(`INSERT INTO build_secret_metadata (reference_id, session_id, owner_user_id, organization_id, project_id, metadata_json)
          VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE metadata_json = VALUES(metadata_json), updated_at = CURRENT_TIMESTAMP(3)`, [record.metadata.reference, ...params, JSON.stringify(record.metadata)]);
        if (record.ciphertext) await exec('INSERT INTO build_secret_values (reference_id, ciphertext) VALUES (?, ?) ON DUPLICATE KEY UPDATE ciphertext = VALUES(ciphertext)', [record.metadata.reference, record.ciphertext]);
      },
      remove: async ref => { await exec(`DELETE FROM build_secret_metadata WHERE reference_id = ? AND ${where}`, [ref, ...params]); },
      audit: async event => { await exec('INSERT INTO build_secret_audit (reference_id, session_id, consumer_service, category) VALUES (?, ?, ?, ?)', [event.reference, scope.session_id, event.consumer, event.category]); },
    });
  }),
});

export const buildSecretMetadata = vault.metadataReader;
export const buildSecretEditor = {
  async createSecret(...args: Parameters<typeof vault.editor.createSecret>) {
    await requireProjectPermission({ userId: args[0], projectId: args[1].project_id, action: 'secret.create' });
    return vault.editor.createSecret(...args);
  },
  updateSecret: vault.editor.updateSecret,
  async deleteSecret(...args: Parameters<typeof vault.editor.deleteSecret>) {
    await requireProjectPermission({ userId: args[0], projectId: args[1].project_id, action: 'secret.delete' });
    return vault.editor.deleteSecret(...args);
  },
};
// Deliberately no runtimeResolver export: the real preview capability issuer is a later phase.
