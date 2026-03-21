// ── Agent: Chain Choreographer ────────────────────────────────────────────────
// Role: Multi-Tool Sequence Planner
// Goal: Generate minimal valid execution chains (avg <= 2.5 steps) satisfying
//       user intent with no redundant tool invocations.
//
// Internal loop: <thinking> → <critique> → <decision>
// Output: ChainChoreographerResult (JSON array of steps)

import { AgentContext, ChainChoreographerResult, ChainStep, SignalWardenResult, ToolName } from '../types';

const STEP_BUDGET = 4; // hard cap per chain

// Predefined chains for known multi-step intents
type ChainTemplate = (ctx: AgentContext, signal: SignalWardenResult) => ChainStep[];

const CHAIN_TEMPLATES: Record<string, ChainTemplate> = {
  // "scan and view results"
  scan_then_view: (ctx, signal) => [
    {
      step: 1,
      tool: 'run_scan',
      params: {
        project_id: signal.selected_project_id!,
        project_name: ctx.projects.find(p => p.id === signal.selected_project_id)?.name ?? '',
        scan_type: inferScanType(ctx.user_text),
      },
      preconditions: ['project_id is resolved'],
      success_condition: 'scan status transitions to running',
    },
    {
      step: 2,
      tool: 'navigate_to_results',
      params: {
        project_id: signal.selected_project_id!,
        project_name: ctx.projects.find(p => p.id === signal.selected_project_id)?.name ?? '',
      },
      preconditions: ['step 1 completed'],
      success_condition: 'user is on /dashboard/security-analysis/:id',
    },
  ],

  // "generate code and create repo"
  generate_then_push: (ctx, _signal) => [
    {
      step: 1,
      tool: 'generate_code',
      params: { spec: ctx.user_text },
      preconditions: [],
      success_condition: 'files array is non-empty',
    },
    {
      step: 2,
      tool: 'ask_for_github_pat',
      params: {},
      preconditions: ['github_pat not already provided'],
      success_condition: 'user provides PAT',
    },
    {
      step: 3,
      tool: 'create_github_repo',
      params: { repo_name: deriveRepoName(ctx.user_text), files: '{{files_from_step_1}}' },
      preconditions: ['step 1 files available', 'github_pat provided'],
      success_condition: 'repo URL returned',
    },
  ],

  // "scan and remediate"
  scan_then_remediate: (ctx, signal) => [
    {
      step: 1,
      tool: 'run_scan',
      params: {
        project_id: signal.selected_project_id!,
        project_name: ctx.projects.find(p => p.id === signal.selected_project_id)?.name ?? '',
        scan_type: 'all',
      },
      preconditions: ['project_id is resolved'],
      success_condition: 'scan completed with findings',
    },
    {
      step: 2,
      tool: 'start_remediation',
      params: {
        project_id: signal.selected_project_id!,
        project_name: ctx.projects.find(p => p.id === signal.selected_project_id)?.name ?? '',
      },
      preconditions: ['step 1 completed', 'findings exist'],
      success_condition: 'remediation pipeline started',
    },
  ],
};

function inferScanType(text: string): 'sast' | 'sca' | 'all' {
  const t = text.toLowerCase();
  if (/\b(sca|dependency|dependencies|deps)\b/.test(t)) return 'sca';
  if (/\b(sast|code(?:\s+review)?|source)\b/.test(t)) return 'sast';
  return 'all';
}

function deriveRepoName(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => !['a', 'an', 'the', 'create', 'build', 'make', 'generate'].includes(w))
    .slice(0, 4);
  return words.join('-') || 'my-project';
}

function detectMultiIntent(text: string): string | null {
  const t = text.toLowerCase();
  if (/\b(scan|audit)\b/.test(t) && /\b(remediat|fix|patch)\b/.test(t)) return 'scan_then_remediate';
  if (/\b(scan|audit)\b/.test(t) && /\b(view|open|show|report|results)\b/.test(t)) return 'scan_then_view';
  if (/\b(generate|create|write)\b/.test(t) && /\b(repo|github|push|deploy)\b/.test(t)) return 'generate_then_push';
  return null;
}

export function runChainChoreographer(
  ctx: AgentContext,
  signal: SignalWardenResult,
): ChainChoreographerResult {
  // <thinking> — identify if multi-tool intent exists
  const multiIntent = detectMultiIntent(ctx.user_text);
  if (!multiIntent || signal.mode !== 'multi_tool_chain') return [];

  // <critique> — validate chain prerequisites
  const template = CHAIN_TEMPLATES[multiIntent];
  if (!template) return [];

  const rawChain = template(ctx, signal);

  // Enforce step budget
  const chain = rawChain.slice(0, STEP_BUDGET);

  // <decision> — prune steps whose preconditions are already satisfied
  // (e.g. PAT already provided → skip ask_for_github_pat)
  const recentHistory = ctx.history.slice(-6);
  const historyText = recentHistory.map(m => m.content).join(' ').toLowerCase();
  const hasPatAlready = historyText.includes('ghp_') || historyText.includes('github_pat');

  return chain.filter(step => {
    if (step.tool === 'ask_for_github_pat' && hasPatAlready) return false;
    return true;
  });
}
