import type { ScanMessage } from '@/lib/scan-context';
import {
  PIPELINE_MODULES,
  type ScanResultsPayload,
  type SecurityModule,
  type SecurityModuleId,
  type SecurityModuleStatus,
  type UnifiedFinding,
} from './types';

const TERMINAL_MODULE_STATUSES = new Set<SecurityModuleStatus>([
  'COMPLETED',
  'FAILED',
  'SKIPPED',
  'CANCELLED',
  'TIMED OUT',
]);

export function pipelineProducedWork(
  live: Partial<Record<SecurityModuleId, SecurityModule>>,
): boolean {
  return Object.values(live).some((module) => (
    module?.status === 'COMPLETED' || module?.status === 'FAILED'
  ));
}

export function pipelineModulesSettled(
  live: Partial<Record<SecurityModuleId, SecurityModule>>,
): boolean {
  const modules = Object.values(live).filter((module): module is SecurityModule => Boolean(module));
  if (modules.length === 0) return false;
  return modules.every((module) => TERMINAL_MODULE_STATUSES.has(module.status))
    && pipelineProducedWork(live);
}

export function parseModuleEvents(messages: ScanMessage[]): Partial<Record<SecurityModuleId, SecurityModule>> {
  const next: Partial<Record<SecurityModuleId, SecurityModule>> = {};
  for (const message of messages) {
    if (message.type !== 'module') continue;
    try {
      const payload = JSON.parse(message.content) as {
        module?: SecurityModuleId;
        status?: SecurityModuleStatus;
        reason?: string;
        error?: string;
        finding_count?: number;
        component_count?: number;
      };
      if (!payload.module || !payload.status) continue;
      next[payload.module] = {
        id: payload.module,
        status: payload.status,
        reason: payload.reason,
        error: payload.error,
        finding_count: payload.finding_count,
        component_count: payload.component_count,
      };
    } catch {
      // Ignore malformed live module payloads.
    }
  }
  return next;
}

export function mergeModules(
  fromResults: SecurityModule[] | undefined,
  live: Partial<Record<SecurityModuleId, SecurityModule>>,
  options?: { scanning?: boolean; scopedTo?: SecurityModuleId[] | null },
): SecurityModule[] {
  const scanning = Boolean(options?.scanning);
  const scoped = (options?.scopedTo || []).filter(Boolean);
  const catalog = scanning && scoped.length
    ? PIPELINE_MODULES.filter((item) => scoped.includes(item.id))
    : PIPELINE_MODULES;

  return catalog.map(({ id }) => {
    const resultModule = (fromResults || []).find((item) => item.id === id);
    const liveModule = live[id];
    if (liveModule) {
      return {
        ...resultModule,
        ...liveModule,
        finding_count: liveModule.finding_count ?? resultModule?.finding_count,
        component_count: liveModule.component_count ?? resultModule?.component_count,
        severity_breakdown: resultModule?.severity_breakdown,
      };
    }
    if (resultModule && !(scanning && scoped.includes(id))) {
      return resultModule;
    }
    return {
      id,
      status: scanning ? 'QUEUED' : 'SKIPPED',
      finding_count: resultModule?.finding_count || 0,
      reason: scanning ? undefined : 'No scan has been run for this module yet.',
    };
  });
}

export function postureFromFindings(findings: UnifiedFinding[]) {
  const posture = { critical: 0, high: 0, medium: 0, low: 0, total: findings.length };
  for (const finding of findings) {
    const severity = String(finding.severity || '').toLowerCase();
    if (severity === 'critical' || severity === 'high' || severity === 'medium' || severity === 'low') {
      posture[severity] += 1;
    }
  }
  return posture;
}

export function uniqueFindingIds<T extends { id?: string }>(findings: T[]): T[] {
  const seen = new Map<string, number>();
  return findings.map((finding) => {
    const base = String(finding.id || 'finding').trim() || 'finding';
    const count = seen.get(base) || 0;
    seen.set(base, count + 1);
    if (count === 0) return finding;
    return { ...finding, id: `${base}#${count}` };
  });
}

export function findingRenderKey(finding: { id?: string }, index: number): string {
  return `${String(finding.id || 'finding')}::${index}`;
}

export function findingsFromLegacy(results: ScanResultsPayload | null | undefined): UnifiedFinding[] {
  if (Array.isArray(results?.findings) && results.findings.length > 0) {
    return uniqueFindingIds(results.findings);
  }
  return [];
}
