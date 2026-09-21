import { z } from 'zod';
export const ANALYST_SECTIONS = ['domain_modules', 'services', 'frontend', 'backend', 'apis', 'databases', 'auth', 'roles', 'queues', 'workers', 'jobs', 'realtime', 'storage', 'integrations', 'test_strategy'] as const;
const finding = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), description: z.string().min(1).max(1500),
  confidence: z.number().min(0).max(1), evidence_paths: z.array(z.string().min(1).max(512)).min(1).max(8),
  uncertainty: z.string().max(1500),
});
export const analystReportSchema = z.strictObject({
  schema_version: z.literal(1), purpose: finding,
  sections: z.strictObject(Object.fromEntries(ANALYST_SECTIONS.map(key => [key, z.array(finding).max(30)])) as Record<typeof ANALYST_SECTIONS[number], z.ZodArray<typeof finding>>),
  relationships: z.array(z.strictObject({ from: z.string().max(64), to: z.string().max(64), description: z.string().min(1).max(1000), evidence_paths: z.array(z.string().max(512)).min(1).max(8), confidence: z.number().min(0).max(1), uncertainty: z.string().max(1000) })).max(100),
  unknowns: z.array(z.string().min(1).max(1000)).max(50),
});
