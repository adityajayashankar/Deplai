// ── Agent: Signal Warden ──────────────────────────────────────────────────────
// Role: Intent Router and Tool-Trigger Gatekeeper
// Goal: Classify every incoming chat turn into exactly one execution mode with
//       >= 97% routing precision.
//
// Internal loop per turn: <thinking> → <critique> → <decision>
// Output: SignalWardenResult JSON

import {
  AgentContext,
  ConnectedProject,
  ExecutionMode,
  SignalWardenResult,
  ToolName,
} from '../types';

// Intent patterns ordered by specificity (most specific first)
const INTENT_PATTERNS: Array<{
  mode: ExecutionMode;
  intent: string;
  pattern: RegExp;
  required_params: string[];
}> = [
  {
    mode: 'tool_call',
    intent: 'run_security_scan',
    pattern: /\b(scan|security scan|audit|sast|sca|run scan|full audit|check (?:my )?(?:code|repo|dependencies|deps))\b/i,
    required_params: ['project_id', 'scan_type'],
  },
  {
    mode: 'tool_call',
    intent: 'navigate_to_results',
    pattern: /\b((?:open|view|show|take me to|go to|navigate to)[\s\S]{0,40}(?:report|results|findings|security analysis|dashboard))\b/i,
    required_params: ['project_id'],
  },
  {
    mode: 'tool_call',
    intent: 'start_remediation',
    pattern: /\b(remediat(?:e|ion)|auto[-\s]?(?:remediat(?:e|ion)|fix)|fix (?:vulns?|vulnerabilities|findings|issues)|patch (?:vulns?|vulnerabilities|issues))\b/i,
    required_params: ['project_id'],
  },
  {
    mode: 'tool_call',
    intent: 'create_github_repo',
    pattern: /\b(create (?:a )?(?:github )?(?:repo|repository)|push (?:to )?github|deploy to github)\b/i,
    required_params: ['repo_name'],
  },
  {
    mode: 'tool_call',
    intent: 'generate_code',
    pattern: /\b(generate|create|write|build)\b.{0,30}\b(code|app|script|project|website|api|service)\b/i,
    required_params: ['spec'],
  },
  {
    mode: 'direct_answer',
    intent: 'general_question',
    pattern: /\b(what|how|why|explain|tell me|describe|list|summarize)\b/i,
    required_params: [],
  },
];

function resolveProjectId(
  text: string,
  history: AgentContext['history'],
  projects: ConnectedProject[],
  active_project_id: string | null,
): string | null {
  // 1. Explicit active project
  if (active_project_id) return active_project_id;

  // 2. Single project — no ambiguity
  if (projects.length === 1) return projects[0].id;

  // 3. Name mention in current text
  const lower = text.toLowerCase();
  for (const p of projects) {
    const names = [p.name, p.repo, p.owner && p.repo ? `${p.owner}/${p.repo}` : null]
      .filter(Boolean) as string[];
    if (names.some(n => lower.includes(n.toLowerCase()))) return p.id;
  }

  // 4. Ordinal resolution ('first', 'second', '1', '2', …)
  const ordinals: Record<string, number> = {
    '1': 0, '1st': 0, 'first': 0,
    '2': 1, '2nd': 1, 'second': 1,
    '3': 2, '3rd': 2, 'third': 2,
  };
  const normalized = lower.trim().replace(/\s+/g, ' ');
  if (normalized in ordinals) {
    return projects[ordinals[normalized]]?.id ?? null;
  }

  // 5. Recent assistant message included a project mention
  for (const turn of [...history].reverse().slice(0, 4)) {
    for (const p of projects) {
      if (p.name && turn.content.toLowerCase().includes(p.name.toLowerCase())) return p.id;
      if (p.repo && turn.content.toLowerCase().includes(p.repo.toLowerCase())) return p.id;
    }
  }

  return null;
}

export function runSignalWarden(ctx: AgentContext): SignalWardenResult {
  // <thinking>
  const { user_text, history, projects, active_project_id } = ctx;

  let matched = INTENT_PATTERNS[INTENT_PATTERNS.length - 1]; // default: direct_answer
  let confidence = 0.6;

  for (const pattern of INTENT_PATTERNS) {
    if (pattern.pattern.test(user_text)) {
      matched = pattern;
      confidence = 0.95;
      break;
    }
  }

  // <critique> — downgrade confidence when context is insufficient
  const selectedProjectId =
    matched.mode === 'tool_call' && matched.required_params.includes('project_id')
      ? resolveProjectId(user_text, history, projects, active_project_id)
      : null;

  const missing: string[] = [];
  for (const param of matched.required_params) {
    if (param === 'project_id' && !selectedProjectId) missing.push('project_id');
    if (param === 'spec' && user_text.trim().split(/\s+/).length < 5) missing.push('spec');
  }

  if (missing.length > 0) {
    confidence = Math.min(confidence, 0.55);
  }
  if (projects.length > 1 && matched.required_params.includes('project_id') && !selectedProjectId) {
    confidence = 0.45; // ambiguous project → clarification required
  }

  // <decision>
  let mode: ExecutionMode = matched.mode;
  if (confidence < 0.5 && missing.includes('project_id') && projects.length > 1) {
    mode = 'clarification';
  }

  const toolNameMap: Record<string, ToolName> = {
    run_security_scan: 'run_scan',
    navigate_to_results: 'navigate_to_results',
    start_remediation: 'start_remediation',
    create_github_repo: 'create_github_repo',
    generate_code: 'generate_code',
  };

  return {
    mode,
    intent: matched.intent,
    confidence: Math.round(confidence * 100) / 100,
    required_params: matched.required_params,
    missing_params: missing,
    selected_project_id: selectedProjectId,
  };
}
