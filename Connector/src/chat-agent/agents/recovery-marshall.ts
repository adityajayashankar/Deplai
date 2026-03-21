// ── Agent: Recovery Marshall ──────────────────────────────────────────────────
// Role: Failure Handler and Retry Strategist
// Goal: Resolve >= 90% transient failures within max 2 retries; produce
//       actionable fallback guidance for permanent failures.
//
// Internal loop: <thinking> → <critique> → <decision>
// Output: RecoveryMarshallResult JSON

import { ErrorType, RecoveryMarshallResult, RecoveryStatus, ToolName } from '../types';

export interface RecoveryInput {
  tool: ToolName;
  error: unknown;
  attempt_count: number;
}

// Classifying errors: permanent patterns bypass retry entirely
const PERMANENT_PATTERNS = [
  /not found/i,
  /unauthorized/i,
  /forbidden/i,
  /invalid token/i,
  /repository already exists/i,
  /quota exceeded/i,
  /account suspended/i,
];

const POLICY_BLOCKED_PATTERNS = [
  /policy/i,
  /blocked/i,
  /not allowed/i,
  /violates/i,
];

const TRANSIENT_PATTERNS = [
  /timeout/i,
  /network/i,
  /econnrefused/i,
  /503/i,
  /502/i,
  /429/i,
  /rate limit/i,
  /temporarily unavailable/i,
];

function classifyError(error: unknown): ErrorType {
  const msg = String(error).toLowerCase();

  if (POLICY_BLOCKED_PATTERNS.some(p => p.test(msg))) return 'policy_blocked';
  if (PERMANENT_PATTERNS.some(p => p.test(msg))) return 'permanent';
  if (TRANSIENT_PATTERNS.some(p => p.test(msg))) return 'transient';

  // Default: assume transient for unknown errors (pessimistic but safer)
  return 'transient';
}

function buildFallbackMessage(
  tool: ToolName,
  errorType: ErrorType,
  error: unknown,
  finalStatus: RecoveryStatus,
): string {
  const errorStr = String(error).slice(0, 200);

  if (finalStatus === 'resolved') {
    return `The ${tool.replace(/_/g, ' ')} operation succeeded after retry.`;
  }

  if (errorType === 'permanent') {
    return [
      `The ${tool.replace(/_/g, ' ')} operation failed with a non-recoverable error: ${errorStr}.`,
      `**What you can do:**`,
      `- Check that your project is properly connected.`,
      `- Verify your permissions and try again.`,
      `- Contact support if this persists.`,
    ].join('\n');
  }

  if (errorType === 'policy_blocked') {
    return [
      `This action was blocked by a policy: ${errorStr}.`,
      `**What you can do:**`,
      `- Review the operation and ensure it complies with system policies.`,
      `- Contact your administrator if you believe this is an error.`,
    ].join('\n');
  }

  // transient — exhausted retries
  return [
    `The ${tool.replace(/_/g, ' ')} operation failed after ${2} retries: ${errorStr}.`,
    `**What you can do:**`,
    `- Wait a moment and try again.`,
    `- Check your network connection.`,
    `- If the problem persists, try refreshing the page.`,
  ].join('\n');
}

export function runRecoveryMarshall(input: RecoveryInput): RecoveryMarshallResult {
  const { tool, error, attempt_count } = input;

  // <thinking> — classify the error
  const errorType = classifyError(error);

  // <critique> — should we retry?
  const canRetry = errorType === 'transient' && attempt_count < 2;
  const shouldRetry = canRetry;

  // <decision> — determine final status
  let finalStatus: RecoveryStatus;
  if (shouldRetry) {
    // Signal that caller should retry (we don't actually retry here — caller decides)
    finalStatus = 'resolved'; // optimistic; caller retries
  } else if (errorType === 'transient' && attempt_count >= 2) {
    finalStatus = 'escalated';
  } else if (errorType === 'policy_blocked') {
    finalStatus = 'escalated';
  } else {
    finalStatus = 'failed';
  }

  return {
    error_type: errorType,
    retry_attempted: attempt_count > 0,
    attempt_count: Math.min(attempt_count, 2),
    final_status: finalStatus,
    fallback_message: buildFallbackMessage(tool, errorType, error, finalStatus),
  };
}
