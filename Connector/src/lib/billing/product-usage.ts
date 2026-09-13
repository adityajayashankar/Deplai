import { debitOrganizationCredits } from './organization-credits';

export type ProductUsageKind =
  | 'security_scan'
  | 'dast'
  | 'remediation'
  | 'deployment'
  | 'uiux';

export type ProductUsageOutcome = 'succeeded' | 'failed';

export type ProductUsageTokens = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
};

export type ProductUsageInput = {
  kind: ProductUsageKind;
  outcome: ProductUsageOutcome;
  organizationId: string;
  userId?: string | null;
  projectId?: string | null;
  runId: string;
  /** A DAST-only run is charged by the DAST policy, not the base scan policy. */
  dastOnly?: boolean;
  usage?: ProductUsageTokens | null;
  now?: Date;
  dynamicCreditsPerMillionTokens?: number;
};

export type ProductUsageQuote = {
  credits: number;
  source: string;
  idempotencyKey: string;
  reason: string;
};

const SCAN_SUCCESS_CREDITS = 0.5;
const DAST_SUCCESS_CREDITS = 1;
const REMEDIATION_FAILURE_CREDITS = 0.5;
const DEPLOYMENT_DAILY_CREDITS = 3;
const DEFAULT_DYNAMIC_CREDITS_PER_MILLION_TOKENS = 1;

function nonNegativeNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function configuredDynamicCreditsPerMillionTokens(value?: number): number {
  if (value !== undefined) return nonNegativeNumber(value);
  return nonNegativeNumber(process.env.DEPLAI_DYNAMIC_CREDITS_PER_MILLION_TOKENS)
    || DEFAULT_DYNAMIC_CREDITS_PER_MILLION_TOKENS;
}

/** Charge in hundredths so the debit is never hidden by the two-decimal UI. */
export function roundProductCredits(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.ceil((value - Number.EPSILON) * 100) / 100;
}

export function usageTokenCount(usage?: ProductUsageTokens | null): number {
  if (!usage) return 0;
  const input = nonNegativeNumber(usage.input_tokens ?? usage.prompt_tokens ?? usage.inputTokens);
  const output = nonNegativeNumber(usage.output_tokens ?? usage.completion_tokens ?? usage.outputTokens);
  if (input || output) return input + output;
  return nonNegativeNumber(usage.total_tokens ?? usage.totalTokens);
}

export function dynamicUsageCredits(
  usage?: ProductUsageTokens | null,
  dynamicCreditsPerMillionTokens?: number,
): number {
  const tokens = usageTokenCount(usage);
  if (!tokens) return 0;
  return roundProductCredits(tokens * configuredDynamicCreditsPerMillionTokens(dynamicCreditsPerMillionTokens) / 1_000_000);
}

export function utcUsageDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function required(value: string | null | undefined, field: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`${field} is required for product usage metering`);
  return normalized;
}

export function quoteProductUsage(input: ProductUsageInput): ProductUsageQuote {
  const organizationId = required(input.organizationId, 'organizationId');
  const runId = required(input.runId, 'runId');
  const projectId = String(input.projectId || '').trim() || 'workspace';
  const succeeded = input.outcome === 'succeeded';

  switch (input.kind) {
    case 'security_scan':
      return {
        credits: succeeded && !input.dastOnly ? SCAN_SUCCESS_CREDITS : 0,
        source: 'security_scan',
        idempotencyKey: `product-usage:security-scan:${organizationId}:${runId}`,
        reason: succeeded
          ? input.dastOnly ? 'DAST-only scans use the DAST rate.' : 'Successful security scan minimum.'
          : 'Failed scans are not charged.',
      };
    case 'dast':
      return {
        credits: succeeded ? DAST_SUCCESS_CREDITS : 0,
        source: 'security_dast',
        idempotencyKey: `product-usage:dast:${organizationId}:${runId}`,
        reason: succeeded ? 'Successful dynamic application security test.' : 'Failed DAST runs are not charged.',
      };
    case 'remediation':
      return {
        credits: succeeded
          ? dynamicUsageCredits(input.usage, input.dynamicCreditsPerMillionTokens)
          : REMEDIATION_FAILURE_CREDITS,
        source: 'security_remediation',
        idempotencyKey: `product-usage:remediation:${organizationId}:${runId}`,
        reason: succeeded ? 'Successful remediation token usage.' : 'Failed remediation run charge.',
      };
    case 'deployment':
      return {
        credits: succeeded ? DEPLOYMENT_DAILY_CREDITS : 0,
        source: 'deployment_daily',
        idempotencyKey: `product-usage:deployment:${organizationId}:${projectId}:${utcUsageDay(input.now)}`,
        reason: succeeded ? 'Verified deployment daily charge.' : 'Unverified deployments are not charged.',
      };
    case 'uiux':
      return {
        credits: succeeded
          ? dynamicUsageCredits(input.usage, input.dynamicCreditsPerMillionTokens)
          : 0,
        source: 'uiux_customization',
        idempotencyKey: `product-usage:uiux:${organizationId}:${runId}`,
        reason: succeeded ? 'Successful UI/UX token usage.' : 'Failed UI/UX runs are not charged.',
      };
  }
}

export async function settleProductUsage(input: ProductUsageInput): Promise<ProductUsageQuote & {
  debited: number;
  available: number | null;
  duplicate: boolean;
}> {
  const quote = quoteProductUsage(input);
  if (quote.credits <= 0) {
    return { ...quote, debited: 0, available: null, duplicate: false };
  }
  const result = await debitOrganizationCredits({
    organizationId: input.organizationId,
    userId: input.userId || null,
    credits: quote.credits,
    source: quote.source,
    idempotencyKey: quote.idempotencyKey,
  });
  return { ...quote, ...result };
}

export const PRODUCT_USAGE_PRICING = {
  scanSuccessCredits: SCAN_SUCCESS_CREDITS,
  dastSuccessCredits: DAST_SUCCESS_CREDITS,
  remediationFailureCredits: REMEDIATION_FAILURE_CREDITS,
  deploymentDailyCredits: DEPLOYMENT_DAILY_CREDITS,
  defaultDynamicCreditsPerMillionTokens: DEFAULT_DYNAMIC_CREDITS_PER_MILLION_TOKENS,
} as const;
