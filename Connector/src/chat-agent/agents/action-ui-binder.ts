// ── Agent: Action-UI Binder ───────────────────────────────────────────────────
// Role: Tool-to-UI Behavior Mapper
// Goal: Guarantee 100% deterministic mapping from tool outcomes to UI
//       actions/cards/buttons.
//
// Internal loop: <thinking> → <critique> → <decision>
// Output: ActionUIBinderResult JSON

import {
  ActionUIBinderResult,
  AgentContext,
  ExecutionMode,
  ToolName,
  UIButton,
  UICard,
  UIEvent,
} from '../types';
import { TOOL_REGISTRY } from '../tools';

interface ToolOutcome {
  tool: ToolName;
  status: 'success' | 'failure' | 'pending';
  result?: Record<string, unknown>;
  error?: string;
}

// Deterministic mapping table: tool × status → UI artifacts
const UI_MAP: Record<
  ToolName,
  Record<
    'success' | 'failure' | 'pending',
    (outcome: ToolOutcome, ctx: AgentContext) => {
      events: UIEvent[];
      route_push: string | null;
      cards: UICard[];
      buttons: UIButton[];
    }
  >
> = {
  run_scan: {
    pending: (o, _ctx) => ({
      events: [{ type: 'scan_started', payload: { project_id: o.result?.project_id } }],
      route_push: null,
      cards: [{ type: 'scan_started', data: { project_id: o.result?.project_id, project_name: o.result?.project_name } }],
      buttons: [],
    }),
    success: (o, _ctx) => ({
      events: [{ type: 'scan_completed', payload: { project_id: o.result?.project_id } }],
      route_push: null,
      cards: [{ type: 'scan_completed', data: { project_id: o.result?.project_id, project_name: o.result?.project_name } }],
      buttons: [
        { label: 'View Report', action: 'navigate_to_results', variant: 'primary', payload: { project_id: o.result?.project_id } },
        { label: 'Auto-Remediate', action: 'start_remediation', variant: 'secondary', payload: { project_id: o.result?.project_id } },
      ],
    }),
    failure: (o, _ctx) => ({
      events: [{ type: 'scan_failed', payload: { error: o.error } }],
      route_push: null,
      cards: [{ type: 'error', data: { message: o.error ?? 'Scan failed' } }],
      buttons: [{ label: 'Retry Scan', action: 'run_scan', variant: 'secondary', payload: { project_id: o.result?.project_id } }],
    }),
  },

  navigate_to_results: {
    pending: (_o, _ctx) => ({ events: [], route_push: null, cards: [], buttons: [] }),
    success: (o, _ctx) => ({
      events: [{ type: 'navigate', payload: { path: `/dashboard/security-analysis/${o.result?.project_id}` } }],
      route_push: `/dashboard/security-analysis/${o.result?.project_id}`,
      cards: [],
      buttons: [],
    }),
    failure: (o, _ctx) => ({
      events: [{ type: 'navigate_failed', payload: { error: o.error } }],
      route_push: null,
      cards: [{ type: 'error', data: { message: 'Could not open report — project ID unavailable' } }],
      buttons: [],
    }),
  },

  start_remediation: {
    pending: (o, _ctx) => ({
      events: [{ type: 'remediation_started', payload: { project_id: o.result?.project_id } }],
      route_push: null,
      cards: [{ type: 'remediation_started', data: { project_id: o.result?.project_id } }],
      buttons: [],
    }),
    success: (o, _ctx) => ({
      events: [{ type: 'remediation_completed', payload: { project_id: o.result?.project_id } }],
      route_push: null,
      cards: [{ type: 'scan_completed', data: { message: 'Remediation complete. Re-scan recommended.' } }],
      buttons: [{ label: 'Re-run Scan', action: 'run_scan', variant: 'primary', payload: { project_id: o.result?.project_id } }],
    }),
    failure: (o, _ctx) => ({
      events: [{ type: 'remediation_failed', payload: { error: o.error } }],
      route_push: null,
      cards: [{ type: 'error', data: { message: o.error ?? 'Remediation failed' } }],
      buttons: [{ label: 'Retry', action: 'start_remediation', variant: 'secondary', payload: { project_id: o.result?.project_id } }],
    }),
  },

  plan_deployment: {
    pending: (_o, _ctx) => ({ events: [], route_push: null, cards: [], buttons: [] }),
    success: (o, _ctx) => ({
      events: [{ type: 'navigate', payload: { path: '/dashboard/pipeline', project_id: o.result?.project_id } }],
      route_push: '/dashboard/pipeline',
      cards: [],
      buttons: [],
    }),
    failure: (o, _ctx) => ({
      events: [{ type: 'deployment_planning_failed', payload: { error: o.error } }],
      route_push: null,
      cards: [{ type: 'error', data: { message: o.error ?? 'Deployment planning failed' } }],
      buttons: [],
    }),
  },

  create_github_repo: {
    pending: (_o, _ctx) => ({ events: [], route_push: null, cards: [], buttons: [] }),
    success: (o, _ctx) => ({
      events: [{ type: 'repo_created', payload: { repo_url: o.result?.repo_url } }],
      route_push: null,
      cards: [{ type: 'repo_created', data: { repo_url: o.result?.repo_url, pages_url: o.result?.pages_url } }],
      buttons: [],
    }),
    failure: (o, _ctx) => ({
      events: [{ type: 'repo_creation_failed', payload: { error: o.error } }],
      route_push: null,
      cards: [{ type: 'error', data: { message: o.error ?? 'Repository creation failed' } }],
      buttons: [],
    }),
  },

  ask_for_github_pat: {
    pending: (_o, _ctx) => ({ events: [{ type: 'show_pat_input', payload: {} }], route_push: null, cards: [], buttons: [] }),
    success: (_o, _ctx) => ({ events: [], route_push: null, cards: [], buttons: [] }),
    failure: (_o, _ctx) => ({ events: [], route_push: null, cards: [], buttons: [] }),
  },

  generate_code: {
    pending: (_o, _ctx) => ({ events: [], route_push: null, cards: [], buttons: [] }),
    success: (o, _ctx) => ({
      events: [{ type: 'files_generated', payload: { count: (o.result?.files as unknown[])?.length ?? 0 } }],
      route_push: null,
      cards: [],
      buttons: [],
    }),
    failure: (o, _ctx) => ({
      events: [{ type: 'generation_failed', payload: { error: o.error } }],
      route_push: null,
      cards: [{ type: 'error', data: { message: o.error ?? 'Code generation failed' } }],
      buttons: [],
    }),
  },
};

export function runActionUIBinder(
  ctx: AgentContext,
  outcome: ToolOutcome,
): ActionUIBinderResult {
  // <thinking> — find mapping
  const toolMap = UI_MAP[outcome.tool];
  if (!toolMap) {
    // <decision> — emit recoverable fallback
    return {
      ui_events: [{ type: 'unknown_tool_outcome', payload: { tool: outcome.tool } }],
      route_push: null,
      cards: [{ type: 'error', data: { message: `No UI mapping for tool: ${outcome.tool}` } }],
      buttons: [],
    };
  }

  // <critique> — validate route targets have required IDs
  const mapping = toolMap[outcome.status];
  const raw = mapping(outcome, ctx);

  // Guard: never push a route that contains undefined
  const route_push = raw.route_push?.includes('undefined') ? null : raw.route_push ?? null;

  // <decision>
  return {
    ui_events: raw.events,
    route_push,
    cards: raw.cards,
    buttons: raw.buttons,
  };
}
