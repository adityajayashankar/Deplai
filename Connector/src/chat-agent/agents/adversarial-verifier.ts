// ── Agent: Adversarial Verifier ───────────────────────────────────────────────
// Role: False-Positive Destroyer for Tool Decisions
// Goal: Challenge every proposed tool call, reduce incorrect invocations to
//       < 1% across production traces.
//
// Internal loop: <thinking> → <critique> (min 2 disproofs) → <decision>
// Output: AdversarialVerifierResult JSON

import {
  AdversarialVerifierResult,
  AgentContext,
  ChallengeStatus,
  SignalWardenResult,
  ToolName,
} from '../types';
import { TOOL_REGISTRY } from '../tools';

interface DisproofAttempt {
  strategy: string;
  result: 'disproved' | 'upheld';
  note: string;
}

// High-impact tools require extra scrutiny
const HIGH_IMPACT_TOOLS = new Set<ToolName>([
  'start_remediation',
  'create_github_repo',
]);

function disproofStrategy1_IsConversational(
  ctx: AgentContext,
  toolName: ToolName,
): DisproofAttempt {
  // Strategy: could this be answered without calling a tool?
  const conversationalSignals = [
    /\b(what is|how does|can you explain|tell me about)\b/i,
    /\b(list the|show me the list|what are)\b/i,
  ];
  const isConversational = conversationalSignals.some(re => re.test(ctx.user_text));

  return {
    strategy: 'conversational_check',
    result: isConversational ? 'disproved' : 'upheld',
    note: isConversational
      ? `"${ctx.user_text.slice(0, 60)}" looks conversational — tool may be unnecessary`
      : 'Not conversational — tool call justified',
  };
}

function disproofStrategy2_SimilarPriorFailed(
  ctx: AgentContext,
  toolName: ToolName,
): DisproofAttempt {
  // Strategy: did a similar tool call fail recently in this session?
  const errorSignals = ['failed', 'error', 'could not', 'unable to'];
  const recentAssistant = ctx.history
    .filter(m => m.role === 'assistant')
    .slice(-4)
    .map(m => m.content.toLowerCase());

  const hasPriorFailure = recentAssistant.some(msg =>
    errorSignals.some(sig => msg.includes(sig)) &&
    msg.includes(toolName.replace('_', ' ')),
  );

  return {
    strategy: 'prior_failure_check',
    result: hasPriorFailure ? 'disproved' : 'upheld',
    note: hasPriorFailure
      ? `Recent failure detected for ${toolName} — retry may not resolve underlying issue`
      : 'No recent failures for this tool',
  };
}

function disproofStrategy3_PolicyContradiction(
  ctx: AgentContext,
  toolName: ToolName,
  params: Record<string, unknown>,
): DisproofAttempt {
  // Strategy: does this call violate any policy?
  const def = TOOL_REGISTRY[toolName];
  const violations: string[] = [];

  if (def.risk_level === 'high') {
    // High-risk tools need explicit confirmation signal in conversation
    const confirmSignals = ['yes', 'go ahead', 'do it', 'confirm', 'proceed', 'please'];
    const recentUserMessages = ctx.history
      .filter(m => m.role === 'user')
      .slice(-2)
      .map(m => m.content.toLowerCase());
    const hasConfirmation = recentUserMessages.some(msg =>
      confirmSignals.some(sig => msg.includes(sig)),
    ) || confirmSignals.some(sig => ctx.user_text.toLowerCase().includes(sig));

    if (!hasConfirmation) {
      violations.push(`High-risk tool '${toolName}' called without explicit confirmation`);
    }
  }

  return {
    strategy: 'policy_check',
    result: violations.length > 0 ? 'disproved' : 'upheld',
    note: violations.length > 0 ? violations.join('; ') : 'Policy check passed',
  };
}

export function runAdversarialVerifier(
  ctx: AgentContext,
  toolName: ToolName,
  params: Record<string, unknown>,
  signal: SignalWardenResult,
): AdversarialVerifierResult {
  // <thinking> — collect disproof attempts
  const attempts: DisproofAttempt[] = [
    disproofStrategy1_IsConversational(ctx, toolName),
    disproofStrategy2_SimilarPriorFailed(ctx, toolName),
    disproofStrategy3_PolicyContradiction(ctx, toolName, params),
  ];

  // <critique> — tally results
  const disprovedCount = attempts.filter(a => a.result === 'disproved').length;
  const isHighImpact = HIGH_IMPACT_TOOLS.has(toolName);

  // Risk score: base 10, +20 per disproof, +30 if high-impact without confirmation
  let riskScore = 10;
  riskScore += disprovedCount * 20;
  if (isHighImpact) riskScore += 20;
  if (signal.confidence < 0.7) riskScore += 15;
  riskScore = Math.min(100, riskScore);

  // <decision>
  let status: ChallengeStatus;
  if (disprovedCount === 0) {
    status = 'approved';
  } else if (disprovedCount >= 2 || (isHighImpact && disprovedCount >= 1)) {
    status = riskScore >= 80 ? 'needs_human_review' : 'rejected';
  } else {
    status = riskScore >= 60 ? 'needs_human_review' : 'approved';
  }

  return {
    tool_name: toolName,
    challenge_status: status,
    counterarguments: attempts
      .filter(a => a.result === 'disproved')
      .map(a => `[${a.strategy}] ${a.note}`),
    risk_score: riskScore,
    rationale: `${attempts.filter(a => a.result === 'upheld').length}/${attempts.length} disproof strategies failed; risk=${riskScore}; status=${status}`,
  };
}
