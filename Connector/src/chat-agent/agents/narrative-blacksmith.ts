// ── Agent: Narrative Blacksmith ───────────────────────────────────────────────
// Role: User-Facing Response Composer
// Goal: Convert internal tool/agent state into concise, truthful, context-aware
//       user responses with 0 unverifiable claims.
//
// Internal loop: <thinking> → <critique> → <decision>
// Output: NarrativeBlacksmithResult (Markdown)

import {
  ActionUIBinderResult,
  AdversarialVerifierResult,
  AgentContext,
  NarrativeBlacksmithResult,
  RecoveryMarshallResult,
  SignalWardenResult,
  ToolContractResult,
  ToolName,
} from '../types';

export interface NarrativeInput {
  ctx: AgentContext;
  signal: SignalWardenResult;
  tool_contract?: ToolContractResult;
  adversarial?: AdversarialVerifierResult;
  action_ui: ActionUIBinderResult;
  recovery?: RecoveryMarshallResult;
  direct_answer?: string;
}

function formatStatus(signal: SignalWardenResult, recovery?: RecoveryMarshallResult): string {
  if (recovery && recovery.final_status !== 'resolved') return '**Status:** Failed';
  if (signal.mode === 'direct_answer') return '**Status:** Answered';
  if (signal.mode === 'clarification') return '**Status:** Needs clarification';
  return '**Status:** Completed';
}

function formatWhatIDid(
  signal: SignalWardenResult,
  tool_contract?: ToolContractResult,
  adversarial?: AdversarialVerifierResult,
): string {
  if (signal.mode === 'direct_answer') {
    return '**What I Did:** Answered your question directly from context.';
  }
  if (signal.mode === 'clarification') {
    return '**What I Did:** Identified missing information needed to proceed.';
  }
  const toolName = tool_contract?.tool_name ?? (signal.intent as ToolName);
  const friendly = String(toolName).replace(/_/g, ' ');
  if (adversarial?.challenge_status === 'rejected') {
    return `**What I Did:** Evaluated your request to ${friendly} and determined it should not proceed at this time.`;
  }
  return `**What I Did:** Triggered \`${friendly}\` with validated parameters.`;
}

function formatWhatHappened(
  signal: SignalWardenResult,
  action_ui: ActionUIBinderResult,
  recovery?: RecoveryMarshallResult,
  adversarial?: AdversarialVerifierResult,
  direct_answer?: string,
): string {
  if (signal.mode === 'direct_answer' && direct_answer) {
    return `**What Happened:** ${direct_answer}`;
  }

  if (signal.mode === 'clarification') {
    const missingList = signal.missing_params.map(p => `\`${p}\``).join(', ');
    return `**What Happened:** Could not determine ${missingList}. ${
      signal.missing_params.includes('project_id') && signal.required_params.includes('project_id')
        ? 'Please specify which project you mean.'
        : 'Please provide the missing details.'
    }`;
  }

  if (recovery && recovery.final_status !== 'resolved') {
    return `**What Happened:** ${recovery.fallback_message}`;
  }

  if (adversarial?.challenge_status === 'needs_human_review') {
    return `**What Happened:** This action requires your confirmation before proceeding (risk score: ${adversarial.risk_score}/100).`;
  }
  if (adversarial?.challenge_status === 'rejected') {
    return `**What Happened:** The requested action was blocked. Reason: ${adversarial.counterarguments[0] ?? 'policy'}`;
  }

  if (action_ui.route_push) {
    return `**What Happened:** Navigating to \`${action_ui.route_push}\`.`;
  }

  if (action_ui.cards.length > 0) {
    const card = action_ui.cards[0];
    if (card.type === 'scan_started') return '**What Happened:** Security scan is running. Results will appear shortly.';
    if (card.type === 'scan_completed') return '**What Happened:** Scan complete. Findings are ready to review.';
    if (card.type === 'remediation_started') return '**What Happened:** AI remediation pipeline has started.';
    if (card.type === 'repo_created') return `**What Happened:** Repository created at \`${card.data.repo_url}\`.`;
    if (card.type === 'error') return `**What Happened:** ${card.data.message}`;
  }

  return '**What Happened:** Operation initiated.';
}

function formatWhatYouCanDoNext(
  signal: SignalWardenResult,
  action_ui: ActionUIBinderResult,
  adversarial?: AdversarialVerifierResult,
): string {
  const lines = ['**What You Can Do Next:**'];

  if (signal.mode === 'clarification') {
    lines.push('- Tell me which project you want to scan or analyze.');
    return lines.join('\n');
  }

  if (adversarial?.challenge_status === 'needs_human_review') {
    lines.push('- Reply "yes" or "confirm" to proceed with this action.');
    lines.push('- Reply "cancel" to abort.');
    return lines.join('\n');
  }

  for (const btn of action_ui.buttons) {
    lines.push(`- **${btn.label}** — click the button above, or ask me to do it.`);
  }

  if (lines.length === 1) {
    lines.push('- Ask me to scan a project, view results, or remediate vulnerabilities.');
  }

  return lines.join('\n');
}

export function runNarrativeBlacksmith(input: NarrativeInput): NarrativeBlacksmithResult {
  const { ctx, signal, tool_contract, adversarial, action_ui, recovery, direct_answer } = input;

  // <thinking> — gather all evidence
  const hasTool = signal.mode === 'tool_call' || signal.mode === 'multi_tool_chain';
  const hasError = recovery && recovery.final_status !== 'resolved';

  // <critique> — ensure no unverifiable claims
  // Only reference tool names/results we have evidence for
  const refs: string[] = [ctx.event_id];
  if (tool_contract?.tool_name) refs.push(`tool:${tool_contract.tool_name}`);
  if (recovery) refs.push(`recovery:${recovery.final_status}`);

  // <decision> — compose sections
  const status = formatStatus(signal, recovery);
  const whatIDid = formatWhatIDid(signal, tool_contract, adversarial);
  const whatHappened = formatWhatHappened(signal, action_ui, recovery, adversarial, direct_answer);
  const whatNext = formatWhatYouCanDoNext(signal, action_ui, adversarial);

  const sections = [status, '', whatIDid, '', whatHappened, '', whatNext];
  if (refs.length > 0) {
    sections.push('', `**Refs:** \`${refs.join('`, `')}\``);
  }

  const markdown = sections.join('\n');

  const overallStatus: NarrativeBlacksmithResult['status'] = hasError
    ? 'failed'
    : signal.mode === 'clarification'
    ? 'partial'
    : hasTool
    ? 'completed'
    : 'completed';

  return { markdown, status: overallStatus, refs };
}
