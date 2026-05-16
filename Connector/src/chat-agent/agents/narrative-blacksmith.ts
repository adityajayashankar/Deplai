// ── Agent: Narrative Blacksmith ───────────────────────────────────────────────
// Role: User-Facing Response Composer
// Goal: Convert internal tool/agent state into concise, truthful, context-aware
//       user responses with 0 unverifiable claims.
//
// Uses the LLM to produce natural, conversational responses rather than a
// rigid template. Falls back to a minimal template if the LLM is unavailable.

import {
  ActionUIBinderResult,
  AdversarialVerifierResult,
  AgentContext,
  NarrativeBlacksmithResult,
  RecoveryMarshallResult,
  SignalWardenResult,
  ToolContractResult,
} from '../types';

export interface NarrativeInput {
  ctx: AgentContext;
  signal: SignalWardenResult;
  tool_contract?: ToolContractResult;
  adversarial?: AdversarialVerifierResult;
  action_ui: ActionUIBinderResult;
  recovery?: RecoveryMarshallResult;
  /** The direct answer text from the LLM (already generated upstream for direct_answer mode) */
  direct_answer?: string;
}

// ── Fallback: minimal template used when no LLM answer is available ───────────

function buildFallbackResponse(input: NarrativeInput): string {
  const { signal, recovery, adversarial, action_ui, direct_answer } = input;

  if (signal.mode === 'direct_answer' && direct_answer) {
    return direct_answer;
  }

  if (signal.mode === 'clarification') {
    const missing = signal.missing_params.map((p) => `\`${p}\``).join(', ');
    return `I need a bit more info to continue — could you tell me ${missing}?${
      signal.missing_params.includes('project_id') ? ' Which project did you have in mind?' : ''
    }`;
  }

  if (recovery && recovery.final_status !== 'resolved') {
    return recovery.fallback_message;
  }

  if (adversarial?.challenge_status === 'rejected') {
    return `I can't proceed with that action right now. ${adversarial.counterarguments[0] ?? ''}`.trim();
  }

  if (adversarial?.challenge_status === 'needs_human_review') {
    return `This action needs your confirmation before I proceed (risk score: ${adversarial.risk_score}/100). Reply "yes" to continue or "cancel" to abort.`;
  }

  if (action_ui.route_push) {
    return `Navigating to \`${action_ui.route_push}\` now.`;
  }

  if (action_ui.cards.length > 0) {
    const card = action_ui.cards[0];
    if (card.type === 'scan_started') return 'Security scan is running. Results will appear shortly.';
    if (card.type === 'scan_completed') return 'Scan complete — findings are ready to review.';
    if (card.type === 'remediation_started') return 'AI remediation pipeline has started.';
    if (card.type === 'repo_created') return `Repository created at \`${card.data.repo_url}\`.`;
    if (card.type === 'error') return String(card.data.message ?? 'Something went wrong.');
  }

  return 'Done.';
}

// ── Build a concise context summary for the LLM ───────────────────────────────

function buildContextSummary(input: NarrativeInput): string {
  const { signal, tool_contract, adversarial, action_ui, recovery, direct_answer } = input;
  const lines: string[] = [];

  lines.push(`User intent: ${signal.intent} (mode: ${signal.mode}, confidence: ${signal.confidence})`);

  if (signal.mode === 'direct_answer' && direct_answer) {
    lines.push(`Direct answer already generated: ${direct_answer}`);
  }

  if (signal.mode === 'clarification') {
    lines.push(`Missing params: ${signal.missing_params.join(', ')}`);
  }

  if (tool_contract) {
    lines.push(`Tool: ${tool_contract.tool_name}, valid: ${tool_contract.valid}`);
    if (tool_contract.errors.length > 0) {
      lines.push(`Tool errors: ${tool_contract.errors.map((e) => e.message).join('; ')}`);
    }
  }

  if (adversarial) {
    lines.push(`Adversarial check: ${adversarial.challenge_status} (risk: ${adversarial.risk_score}/100)`);
    if (adversarial.counterarguments.length > 0) {
      lines.push(`Reason: ${adversarial.counterarguments[0]}`);
    }
  }

  if (recovery) {
    lines.push(`Recovery: ${recovery.final_status} — ${recovery.fallback_message}`);
  }

  if (action_ui.route_push) {
    lines.push(`Navigating to: ${action_ui.route_push}`);
  }

  if (action_ui.cards.length > 0) {
    const card = action_ui.cards[0];
    lines.push(`UI card: ${card.type}`);
    if (card.type === 'repo_created') lines.push(`Repo URL: ${card.data.repo_url}`);
    if (card.type === 'error') lines.push(`Error: ${card.data.message}`);
  }

  if (action_ui.buttons.length > 0) {
    lines.push(`Available actions: ${action_ui.buttons.map((b) => b.label).join(', ')}`);
  }

  return lines.join('\n');
}

// ── Async LLM-powered narrative generation ────────────────────────────────────

export async function runNarrativeBlacksmithAsync(
  input: NarrativeInput,
  callLLM: (messages: Array<{ role: string; content: string }>, system: string, maxTokens: number, temperature: number) => Promise<string | null>,
): Promise<NarrativeBlacksmithResult> {
  const { ctx, signal, tool_contract, recovery } = input;

  const refs: string[] = [ctx.event_id];
  if (tool_contract?.tool_name) refs.push(`tool:${tool_contract.tool_name}`);
  if (recovery) refs.push(`recovery:${recovery.final_status}`);

  const hasError = Boolean(recovery && recovery.final_status !== 'resolved');
  const overallStatus: NarrativeBlacksmithResult['status'] = hasError
    ? 'failed'
    : signal.mode === 'clarification'
    ? 'partial'
    : 'completed';

  // For direct_answer mode, the LLM already produced the answer upstream — use it directly.
  if (signal.mode === 'direct_answer' && input.direct_answer) {
    return {
      markdown: input.direct_answer,
      status: overallStatus,
      refs,
    };
  }

  const contextSummary = buildContextSummary(input);
  const recentHistory = ctx.history.slice(-6);
  const historyText = recentHistory
    .map((turn) => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.content}`)
    .join('\n');

  const system = `You are DeplAI, an elite security engineer AI. Write a short, natural, conversational reply to the user.

Rules:
- Be direct and concise — 1 to 3 sentences max unless the situation genuinely needs more.
- Never use rigid headers like "Status:", "What I Did:", "What Happened:", "What You Can Do Next:".
- Match the tone to the situation: confident for success, empathetic for errors, clear for clarifications.
- If a tool was triggered, briefly confirm what's happening and what the user should expect next.
- If clarification is needed, ask a single focused question.
- If there was an error, explain it plainly and suggest the next step.
- Never expose internal event IDs, agent names, or raw JSON.
- Write in plain prose. Use markdown sparingly (bold for emphasis, code for identifiers).`;

  const userPrompt = `Recent conversation:\n${historyText || '(no prior messages)'}\n\nUser's latest message: "${ctx.user_text}"\n\nWhat happened internally:\n${contextSummary}\n\nWrite a natural reply to the user.`;

  try {
    const llmResponse = await callLLM(
      [{ role: 'user', content: userPrompt }],
      system,
      512,
      0.7,
    );

    if (llmResponse?.trim()) {
      return {
        markdown: llmResponse.trim(),
        status: overallStatus,
        refs,
      };
    }
  } catch {
    // Fall through to fallback
  }

  // Fallback when LLM is unavailable
  return {
    markdown: buildFallbackResponse(input),
    status: overallStatus,
    refs,
  };
}

// ── Synchronous shim (kept for backward compatibility with non-async callers) ──
// Returns a minimal fallback immediately. Prefer runNarrativeBlacksmithAsync.

export function runNarrativeBlacksmith(input: NarrativeInput): NarrativeBlacksmithResult {
  const { ctx, signal, tool_contract, recovery } = input;

  const refs: string[] = [ctx.event_id];
  if (tool_contract?.tool_name) refs.push(`tool:${tool_contract.tool_name}`);
  if (recovery) refs.push(`recovery:${recovery.final_status}`);

  const hasError = Boolean(recovery && recovery.final_status !== 'resolved');
  const overallStatus: NarrativeBlacksmithResult['status'] = hasError
    ? 'failed'
    : signal.mode === 'clarification'
    ? 'partial'
    : 'completed';

  return {
    markdown: buildFallbackResponse(input),
    status: overallStatus,
    refs,
  };
}
