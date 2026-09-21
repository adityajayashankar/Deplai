import { z } from 'zod';
import { BUILD_STATES } from './contracts';
import { analystReportSchema } from './analyst-schema';
import { runtimeInferenceSchema } from './runtime-schema';

const text = z.string().trim().min(1).max(8192);
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/).refine(v => !['__proto__', 'constructor', 'prototype'].includes(v));
const list = <T extends z.ZodType>(item: T) => z.array(item).max(1000);
const object = z.strictObject;
const version = { schema_version: z.literal(1) };
const revision = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const relativePath = z.string().min(1).max(256).refine(v => v === '.' || (
  !v.startsWith('/') && !v.includes('\\') && !v.includes(':') && !/[\x00-\x1f]/.test(v)
  && v.split('/').every(part => part !== '' && part !== '..' && part !== '.')
), 'Use a contained relative path');
const routePath = z.string().regex(/^\/(?:[a-zA-Z0-9_/-]*)$/).refine(v => !v.includes('//'));
const envKey = z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/);
const command = z.array(z.string().min(1).max(2048).refine(v => !/[\x00\r\n]/.test(v))).min(1).max(64);
const item = object({ id, description: text });
const items = list(item);
const reference = list(id);
const secretReference = z.string().regex(/^secret:\/\/(?:session|project|integration|deployment)\/[a-zA-Z0-9_-]{1,64}$/);
const secretReferences = list(z.union([id, secretReference]));
const decision = object({
  selected: z.boolean(), technology: text.nullable(), reason: text,
  requirement_ids: reference,
  alternatives: list(object({ technology: text, rejection_reason: text })),
  implementation_complexity: text, preview_complexity: text, operating_cost: text,
}).refine(v => !v.selected || v.technology !== null, 'Selected component requires a technology');
export const COMPONENTS = ['frontend', 'backend', 'database', 'cache', 'queue', 'workers', 'scheduler', 'realtime', 'storage', 'search', 'vector_store', 'ai', 'auth_rbac', 'integrations'] as const;
const components = object(Object.fromEntries(COMPONENTS.map(key => [key, decision])) as Record<typeof COMPONENTS[number], typeof decision>);
const route = object({ path: routePath, target: id });
const health = z.discriminatedUnion('type', [
  object({ type: z.literal('http'), path: routePath, port: z.number().int().min(1).max(65535), timeout_seconds: z.number().int().min(1).max(120) }),
  object({ type: z.literal('command'), argv: command, timeout_seconds: z.number().int().min(1).max(120) }),
]);
const service = object({
  id, type: z.enum(['frontend', 'backend', 'worker', 'scheduler', 'supporting-service']),
  framework: text, directory: relativePath,
  install: command.nullable(), dev: command.nullable(), build: command.nullable(), production: command.nullable(),
  port: z.number().int().min(1).max(65535).nullable(), public: z.boolean(),
  dependencies: reference, health_check: health.nullable(), required_environment_keys: list(envKey), secret_references: secretReferences,
}).refine(v => !v.public || v.port !== null, 'Public service requires a port');
const resource = object({ id, type: z.enum(['postgres', 'mongodb', 'redis', 'queue', 'object-storage', 'search', 'vector-store']), technology: text, dependencies: reference, secret_references: secretReferences });
const evidence = object({ path: relativePath, description: text, confidence: z.number().min(0).max(1) });
const positive = z.number().int().positive();

export const artifactSchemas = {
  'product.yaml': object({ ...version, purpose: text, users: items, roles: items, features: items,
    journeys: items, pages: items, business_rules: items, domain_entities: items, integrations: items,
    kpis: items, assumptions: items, non_functional_requirements: items, acceptance_criteria: items }),
  'repository.yaml': object({ ...version, source_revision: revision, policy: z.literal('PRESERVE_EXISTING'),
    frameworks: items, modules: items, services: items, apis: items, databases: items, auth: items,
    workers: items, queues: items, jobs: items, storage: items, integrations: items,
    relationships: list(object({ from: id, to: id, description: text })), evidence: list(evidence),
    analysis: analystReportSchema.optional() }),
  'architecture.yaml': object({ ...version, style: text, components }),
  'runtime.yaml': object({ ...version, services: list(service).min(1), resources: list(resource), routes: list(route),
    source_revision: revision.optional(), worktree_id: id.optional(), inference: runtimeInferenceSchema.optional(),
  }).refine(v => !v.inference || !!(v.source_revision && v.worktree_id), 'Inferred runtime requires source revision and worktree identity').superRefine((runtime, ctx) => {
    const inference = runtime.inference;
    if (!inference) return;
    const bad = () => ctx.addIssue({ code: 'custom', message: 'Inconsistent runtime inference graph or references' });
    const serviceIds = new Set(runtime.services.map(s => s.id));
    const resourceIds = new Set(runtime.resources.map(r => r.id));
    const stepIds = new Set(inference.boot_steps.map(s => s.id));
    if (serviceIds.size !== runtime.services.length || resourceIds.size !== runtime.resources.length || [...serviceIds].some(id => resourceIds.has(id))) bad();
    if (stepIds.size !== inference.boot_steps.length || inference.boot_order.length !== stepIds.size || new Set(inference.boot_order).size !== stepIds.size || inference.boot_order.some(id => !stepIds.has(id))) bad();
    for (const step of inference.boot_steps) {
      if (!(step.kind === 'resource' ? resourceIds : serviceIds).has(step.target)) bad();
      if (step.dependencies.some(id => !stepIds.has(id) || inference.boot_order.indexOf(id) >= inference.boot_order.indexOf(step.id))) bad();
    }
    for (const id of serviceIds) if (!inference.boot_steps.some(step => step.id === id && step.target === id && step.kind === 'service')) bad();
    if (inference.commands.some(c => !serviceIds.has(c.service_id)) || inference.environment.some(e => !serviceIds.has(e.service_id))) bad();
  }),
  'preview.yaml': object({ ...version,
    origin: z.url().refine(v => { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password && u.pathname === '/' && !u.search && !u.hash; }, 'Use an HTTPS origin without credentials or path'),
    routes: list(route), source_revision: revision, worktree_id: id,
    isolation_profile: z.enum(['local-docker', 'gvisor']),
    network_policy: object({ public_egress: z.enum(['deny', 'policy-proxy']), host: z.literal(false), metadata: z.literal(false), private_networks: z.literal(false), sibling_previews: z.literal(false) }),
    hot_reload: z.boolean(), websockets: z.boolean(), sse: z.boolean(),
    cookie_strategy: z.enum(['isolated-origin', 'gateway-rewrite']),
    idle_ttl_seconds: positive.max(3600), hard_ttl_seconds: positive.max(14400), resource_profile: id,
  }).refine(v => v.idle_ttl_seconds <= v.hard_ttl_seconds, 'Idle TTL exceeds hard TTL'),
  'secrets.schema.yaml': object({ ...version, secrets: list(object({ id, name: text, purpose: text, required: z.boolean(),
    classification: z.enum(['SYSTEM_INTERNAL', 'USER_PROVIDED', 'GENERATED_PREVIEW', 'INTEGRATION', 'DEPLOYMENT_ONLY']),
    scope: z.enum(['session', 'project', 'integration', 'deployment']), consumers: reference,
    required_for_preview: z.boolean(), required_for_deployment: z.boolean(), configured: z.boolean(),
    reference: secretReference.optional(), preview_id: id.nullable().optional(),
  }).refine(v => v.classification !== 'DEPLOYMENT_ONLY' || !v.required_for_preview, 'Deployment-only secret cannot be required for preview')) }),
  'session.yaml': object({ ...version, session_id: id, owner_user_id: id, organization_id: id, project_id: id,
    source_type: z.enum(['NEW_PROJECT', 'IMPORT_REPOSITORY']), source_revision: revision.nullable(), state: z.enum(BUILD_STATES),
    active_worktree_id: id.nullable(), active_preview_revision: revision.nullable(), preview_id: id.nullable(), secret_scope_id: id, quota_profile_id: id,
  }).refine(v => v.source_type !== 'IMPORT_REPOSITORY' || v.source_revision !== null, 'Imported session requires a revision'),
  'task-graph.json': object({ ...version, tasks: list(object({ id, objective: text, specialist: id, dependencies: reference,
    read_paths: list(relativePath), write_paths: list(relativePath), required_skills: reference, required_tools: reference,
    expected_artifacts: list(relativePath), acceptance_criteria: reference, verification_commands: list(command), rollback_boundary: relativePath,
  })) }),
};
export type ArtifactName = keyof typeof artifactSchemas;
export type ArtifactBundle = { [K in ArtifactName]: z.infer<typeof artifactSchemas[K]> };
export const ARTIFACT_DIRECTORIES = ['design', 'database', 'api', 'analytics', 'testing', 'security', 'verification', 'build'] as const;
export const ARTIFACT_NAMES = Object.keys(artifactSchemas) as ArtifactName[];

/** Portable definitions for future workers; no runtime capability is granted by a schema. */
export function jsonSchemaFor(name: ArtifactName) {
  return z.toJSONSchema(artifactSchemas[name]);
}
