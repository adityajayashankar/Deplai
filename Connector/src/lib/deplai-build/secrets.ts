import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { assertIdentifier, assertOwnership, type BuildScope } from './contracts';
import { artifactSchemas } from './artifact-schemas';

export const secretDeclaration = artifactSchemas['secrets.schema.yaml'].shape.secrets.element;
export type SecretDeclaration = z.infer<typeof secretDeclaration>;
export type SecretMetadata = SecretDeclaration & { reference: string; preview_id: string | null };
export type SecretRecord = { scope: BuildScope; metadata: SecretMetadata; ciphertext: string | null };
export type SecretAudit = { reference: string; session_id: string; consumer: string | null; category: 'create' | 'update' | 'delete' | 'preview-injection'; timestamp: string };
export interface SecretTransaction {
  get(reference: string): Promise<SecretRecord | null>;
  list(): Promise<SecretRecord[]>;
  put(record: SecretRecord): Promise<void>;
  remove(reference: string): Promise<void>;
  audit(event: SecretAudit): Promise<void>;
}
export type RuntimeGrant = { scope: BuildScope; preview_id: string; consumer: string; bindings: Record<string, string> };
export type SecretDependencies = {
  authorize: (actor: string, scope: BuildScope, write: boolean) => Promise<void>;
  transaction: <T>(scope: BuildScope, work: (tx: SecretTransaction) => Promise<T>) => Promise<T>;
  encrypt: (value: string) => string;
  decrypt: (value: string) => string;
  authorizeRuntime: (grant: RuntimeGrant) => Promise<void>;
};
const refPattern = /^secret:\/\/(?:session|project|integration|deployment)\/[a-zA-Z0-9_-]{1,64}$/;
function reference(value: string) { if (!refPattern.test(value)) throw new Error('Invalid secret reference'); }
function plain(value: string) {
  if (typeof value !== 'string' || !value.length || Buffer.byteLength(value) > 16384 || value.includes('\0')) throw new Error('Invalid secret input');
}
function scoped(scope: BuildScope, record: SecretRecord | null): SecretRecord {
  if (!record) throw new Error('Secret not found');
  assertOwnership(scope, record.scope); return record;
}

/** Factories are trusted wiring. Only metadataReader is suitable for agent tools. */
export function createSecretStore(deps: SecretDependencies) {
  function seal(scope: BuildScope, ref: string, value: string) { plain(value); return deps.encrypt(JSON.stringify({ scope, reference: ref, value })); }
  function audit(tx: SecretTransaction, scope: BuildScope, ref: string, category: SecretAudit['category'], consumer: string | null = null) {
    return tx.audit({ reference: ref, session_id: scope.session_id, consumer, category, timestamp: new Date().toISOString() });
  }
  const metadataReader = {
    async getMetadata(actor: string, scope: BuildScope, ref: string) {
      await deps.authorize(actor, scope, false); reference(ref);
      return deps.transaction(scope, async tx => structuredClone(scoped(scope, await tx.get(ref)).metadata));
    },
    async listRequiredSecrets(actor: string, scope: BuildScope) {
      await deps.authorize(actor, scope, false);
      return deps.transaction(scope, async tx => (await tx.list()).map(r => structuredClone(scoped(scope, r).metadata)).filter(m => m.required || m.required_for_preview || m.required_for_deployment));
    },
  };
  const editor = {
    ...metadataReader,
    /** Internal declaration API; UI can fill declared slots but cannot change consumers. */
    async createSecret(actor: string, scope: BuildScope, input: SecretDeclaration, options: { value?: string; preview_id?: string } = {}) {
      await deps.authorize(actor, scope, true);
      const declaration = secretDeclaration.safeParse(input);
      if (!declaration.success) throw new Error('Invalid secret metadata');
      const metadata = declaration.data;
      if (!metadata.consumers.length || new Set(metadata.consumers).size !== metadata.consumers.length) throw new Error('Declare unique authorized consumers');
      const generated = metadata.classification === 'GENERATED_PREVIEW';
      if (generated && (metadata.scope !== 'session' || !options.preview_id || options.value !== undefined || metadata.required_for_deployment)) throw new Error('Generated secrets require preview-only session scope');
      if (!generated && options.preview_id) throw new Error('Preview ID is reserved for generated secrets');
      if (options.preview_id) assertIdentifier(options.preview_id);
      const ref = `secret://${metadata.scope}/${randomUUID()}`;
      const value = generated ? randomBytes(32).toString('base64url') : options.value;
      const record: SecretRecord = { scope: { ...scope }, metadata: { ...metadata, reference: ref, configured: value !== undefined, preview_id: options.preview_id || null }, ciphertext: value === undefined ? null : seal(scope, ref, value) };
      return deps.transaction(scope, async tx => {
        if ((await tx.list()).some(r => r.metadata.id === metadata.id)) throw new Error('Secret identifier already exists');
        await tx.put(record); await audit(tx, scope, ref, 'create'); return structuredClone(record.metadata);
      });
    },
    async updateSecret(actor: string, scope: BuildScope, ref: string, value: string) {
      await deps.authorize(actor, scope, true); reference(ref); plain(value);
      return deps.transaction(scope, async tx => {
        const record = scoped(scope, await tx.get(ref));
        if (!['USER_PROVIDED', 'INTEGRATION', 'DEPLOYMENT_ONLY'].includes(record.metadata.classification)) throw new Error('This secret is managed internally');
        record.ciphertext = seal(scope, ref, value); record.metadata.configured = true;
        await tx.put(record); await audit(tx, scope, ref, 'update'); return structuredClone(record.metadata);
      });
    },
    async deleteSecret(actor: string, scope: BuildScope, ref: string) {
      await deps.authorize(actor, scope, true); reference(ref);
      await deps.transaction(scope, async tx => { scoped(scope, await tx.get(ref)); await tx.remove(ref); await audit(tx, scope, ref, 'delete'); });
    },
  };
  const runtimeResolver = {
    /** Trusted runtime only. Audit commits before the environment is returned. No HTTP/agent exposure. */
    async resolveForRuntime(input: RuntimeGrant): Promise<Record<string, string>> {
      const grant = structuredClone(input);
      await deps.authorizeRuntime(grant);
      assertIdentifier(grant.preview_id); assertIdentifier(grant.consumer);
      if (Object.keys(grant.bindings).length > 64) throw new Error('Too many runtime secrets');
      return deps.transaction(grant.scope, async tx => {
        const environment: Record<string, string> = Object.create(null);
        for (const [key, ref] of Object.entries(grant.bindings)) {
          if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(key) || /^(?:PATH|HOME|NODE_OPTIONS|LD_.*|DYLD_.*|PYTHONPATH|BASH_ENV|ENV)$/.test(key)) throw new Error('Forbidden secret environment key');
          reference(ref);
          const record = scoped(grant.scope, await tx.get(ref)); const m = record.metadata;
          if (!m.configured || !record.ciphertext || !m.consumers.includes(grant.consumer) || ['SYSTEM_INTERNAL', 'DEPLOYMENT_ONLY'].includes(m.classification) || (m.preview_id !== null && m.preview_id !== grant.preview_id)) throw new Error('Secret is unavailable for this preview consumer');
          let payload: { scope: BuildScope; reference: string; value: string };
          try { payload = JSON.parse(deps.decrypt(record.ciphertext)); assertOwnership(grant.scope, payload.scope); if (payload.reference !== ref) throw new Error(); plain(payload.value); }
          catch { throw new Error('Secret integrity check failed'); }
          environment[key] = payload.value;
          await audit(tx, grant.scope, ref, 'preview-injection', grant.consumer);
        }
        return environment;
      });
    },
  };
  return { metadataReader, editor, runtimeResolver };
}
