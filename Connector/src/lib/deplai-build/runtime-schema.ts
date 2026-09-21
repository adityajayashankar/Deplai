import { z } from 'zod';
export const COMMAND_CLASSES = ['SAFE_METADATA', 'REQUIRES_SANDBOX', 'REQUIRES_NETWORK', 'REQUIRES_SECRET', 'UNSAFE'] as const;
export const runtimeInferenceSchema = z.strictObject({
  content_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  commands: z.array(z.strictObject({ service_id: z.string(), kind: z.enum(['install', 'dev', 'build', 'production', 'migration']), argv: z.array(z.string()).min(1), classifications: z.array(z.enum(COMMAND_CLASSES)).min(1), evidence_path: z.string() })).max(1000),
  environment: z.array(z.strictObject({ service_id: z.string(), key: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/), kind: z.enum(['GENERATED_PREVIEW', 'USER_PROVIDED_SECRET', 'OPTIONAL_SETTING', 'INTERNAL_SERVICE_URL']), evidence_paths: z.array(z.string()).min(1), required: z.boolean(), review_required: z.boolean() })).max(1000),
  boot_order: z.array(z.string()).max(1000),
  boot_steps: z.array(z.strictObject({ id: z.string(), kind: z.enum(['resource', 'install', 'migration', 'service']), target: z.string(), dependencies: z.array(z.string()) })).max(1000),
  evidence: z.array(z.strictObject({ service_id: z.string(), field: z.string(), path: z.string(), confidence: z.number().min(0).max(1) })).max(2000),
  blockers: z.array(z.string()).max(1000),
  launch_authorized: z.literal(false),
});
