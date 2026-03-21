// ── Agent: Memory Forensics Keeper ───────────────────────────────────────────
// Role: Session Context Integrity Auditor
// Goal: Maintain context coherence with 0 orphan references across the last
//       N turns.
//
// Internal loop: <thinking> → <critique> → <decision>
// Output: MemoryForensicsResult JSON

import {
  AgentContext,
  ConnectedProject,
  MemoryConflict,
  MemoryForensicsResult,
  MemoryRepair,
} from '../types';

const CONTEXT_WINDOW = 8; // turns to audit

interface ResolvedEntities {
  project_id?: string;
  project_name?: string;
  scan_type?: string;
  repo_name?: string;
}

function extractEntitiesFromHistory(
  history: AgentContext['history'],
  projects: ConnectedProject[],
): ResolvedEntities {
  const entities: ResolvedEntities = {};
  const recent = history.slice(-CONTEXT_WINDOW);

  for (const turn of [...recent].reverse()) {
    const text = turn.content.toLowerCase();

    // Resolve project mentions
    if (!entities.project_id) {
      for (const p of projects) {
        if (
          (p.name && text.includes(p.name.toLowerCase())) ||
          (p.repo && text.includes(p.repo.toLowerCase()))
        ) {
          entities.project_id = p.id;
          entities.project_name = p.name || p.repo;
          break;
        }
      }
    }

    // Resolve scan type
    if (!entities.scan_type) {
      if (/\bsast\b/.test(text)) entities.scan_type = 'sast';
      else if (/\bsca\b|\bdep/.test(text)) entities.scan_type = 'sca';
      else if (/\ball\b|\bfull\b|\baudit\b/.test(text)) entities.scan_type = 'all';
    }
  }

  return entities;
}

function detectStaleEntities(
  resolved: ResolvedEntities,
  projects: ConnectedProject[],
): string[] {
  const stale: string[] = [];

  if (resolved.project_id) {
    const stillExists = projects.some(p => p.id === resolved.project_id);
    if (!stillExists) stale.push('project_id');
  }

  return stale;
}

function detectConflicts(
  resolved: ResolvedEntities,
  history: AgentContext['history'],
  projects: ConnectedProject[],
): MemoryConflict[] {
  const conflicts: MemoryConflict[] = [];

  // Check if multiple project names were mentioned in the same turn
  const recentUserTurns = history
    .filter(m => m.role === 'user')
    .slice(-CONTEXT_WINDOW);

  for (const turn of recentUserTurns) {
    const text = turn.content.toLowerCase();
    const mentioned = projects.filter(
      p =>
        (p.name && text.includes(p.name.toLowerCase())) ||
        (p.repo && text.includes(p.repo.toLowerCase())),
    );
    if (mentioned.length > 1) {
      conflicts.push({
        entity: 'project_id',
        reason: `Multiple projects mentioned in same turn: ${mentioned.map(p => p.name || p.repo).join(', ')}`,
      });
    }
  }

  return conflicts;
}

function buildRepairs(
  stale: string[],
  conflicts: MemoryConflict[],
): MemoryRepair[] {
  const repairs: MemoryRepair[] = [];

  for (const entity of stale) {
    repairs.push({ entity, action: 'remove' });
  }

  for (const conflict of conflicts) {
    if (!stale.includes(conflict.entity)) {
      repairs.push({ entity: conflict.entity, action: 'remove' });
    }
  }

  return repairs;
}

export function runMemoryForensicsKeeper(ctx: AgentContext): MemoryForensicsResult {
  // <thinking> — resolve entities from history
  const resolved = extractEntitiesFromHistory(ctx.history, ctx.projects);

  // <critique> — detect stale/conflicting entities
  const stale = detectStaleEntities(resolved, ctx.projects);
  const conflicts = detectConflicts(resolved, ctx.history, ctx.projects);

  const hasIssues = stale.length > 0 || conflicts.length > 0;

  // <decision>
  const repairs = buildRepairs(stale, conflicts);

  // Apply active_project override if provided
  const finalResolved: ResolvedEntities = { ...resolved };
  if (ctx.active_project_id) {
    const activeProject = ctx.projects.find(p => p.id === ctx.active_project_id);
    if (activeProject) {
      finalResolved.project_id = activeProject.id;
      finalResolved.project_name = activeProject.name || activeProject.repo;
    }
  }

  return {
    context_ok: !hasIssues,
    resolved_entities: finalResolved as Record<string, unknown>,
    stale_entities: stale,
    conflicts,
    recommended_repairs: repairs,
  };
}
