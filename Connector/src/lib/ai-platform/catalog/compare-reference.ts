/** BYOK Compare reference content — updated September 1, 2026. */

export const COMPARE_UPDATED = '2026-09-01';

/** Top callout: best peak performance for DeplAI jobs (September 2026). */
export const COMPARE_PERFORMANCE_RECOMMENDATION = {
  title: 'Best performance',
  effortLabel: 'high or extrahigh reasoning effort',
  models: [
    {
      modelId: 'MiniMax-M3',
      providerId: 'minimax',
      displayName: 'MiniMax M3',
      note: 'Adaptive thinking on by default; set high or extrahigh for security, deploy, and agent loops.',
    },
    {
      modelId: 'grok-4.6',
      providerId: 'xai',
      displayName: 'Grok 4.6',
      note: 'Reasoning always on; use high or extrahigh (xhigh) for flagship coding and agentic work.',
    },
  ],
  summary:
    'For peak DeplAI performance in September 2026, use MiniMax M3 or Grok 4.6 with high or extrahigh reasoning effort. Both lead on agentic deploy, security analysis, and multi-step tool use at this catalog refresh.',
} as const;

export const COMPARE_BASELINE = {
  modelId: 'gpt-5.6-sol',
  displayName: 'GPT-5.6 Sol',
  providerId: 'openai',
  note:
    'DeplAI uses GPT-5.6 Sol as the agreed platform baseline for internal routing and cost accounting. Rankings below are relative to DeplAI jobs—not a generic chat leaderboard.',
} as const;

export type ThinkingEffortTier = 'low' | 'medium' | 'high' | 'extrahigh' | 'ultra';

export type ThinkingEffortProfile = {
  providerId: string;
  parameter: string;
  /** API / documented effort values. `extrahigh` maps to provider `xhigh`. */
  tiers: ThinkingEffortTier[];
  defaultTier: ThinkingEffortTier;
  /** Provider-specific tiers beyond the shared ladder (e.g. OpenAI `none`, Anthropic `max`). */
  extendedTiers?: string[];
  notes: string;
};

/** Shared ladder shown in Compare; providers may expose additional API values. */
export const THINKING_EFFORT_LADDER: ThinkingEffortTier[] = ['low', 'medium', 'high', 'extrahigh', 'ultra'];

export const THINKING_EFFORT_BY_PROVIDER: ThinkingEffortProfile[] = [
  {
    providerId: 'openai',
    parameter: 'reasoning.effort (Responses API)',
    tiers: ['low', 'medium', 'high', 'extrahigh'],
    defaultTier: 'medium',
    extendedTiers: ['none', 'max'],
    notes:
      'Sol, Terra, and Luna share the API ladder. `extrahigh` is `xhigh` in the API; ChatGPT labels it Extra High. `max` exceeds xhigh for hardest single-model work. `ultra` is a ChatGPT Work / Codex product mode that coordinates parallel sub-agents—not an API effort value. Pro mode (`reasoning.mode: pro`) is separate from effort.',
  },
  {
    providerId: 'anthropic',
    parameter: 'output_config.effort',
    tiers: ['low', 'medium', 'high', 'extrahigh'],
    defaultTier: 'high',
    extendedTiers: ['max'],
    notes:
      'Opus 5, Sonnet 5, and Fable 5 run adaptive thinking on by default. `extrahigh` is `xhigh` in the API. `max` is Opus/Fable-class only. Disabling thinking with xhigh or max effort returns HTTP 400. Fable 5 adds safety classifiers that may refuse high-risk categories.',
  },
  {
    providerId: 'xai',
    parameter: 'reasoning_effort',
    tiers: ['low', 'medium', 'high', 'extrahigh'],
    defaultTier: 'high',
    notes:
      'Grok 4.6 cannot disable reasoning; `high` is the default. `extrahigh` is `xhigh` in the API. No documented `max` or `ultra` tier. Reasoning tokens bill as output; long prompts (≥200k) use a higher price tier.',
  },
  {
    providerId: 'gemini',
    parameter: 'thinking_level (Gemini 3.x)',
    tiers: ['low', 'medium', 'high'],
    defaultTier: 'medium',
    notes:
      'Gemini 3.1 Pro exposes thinking_level on supported surfaces. No documented extrahigh or ultra tier. Long prompts above 200k tokens bill at the higher Pro rate for the entire request.',
  },
  {
    providerId: 'minimax',
    parameter: 'thinking.type (M3) · always-on (M2.x)',
    tiers: ['low', 'medium', 'high', 'extrahigh'],
    defaultTier: 'medium',
    notes:
      'MiniMax M3 supports enabled, adaptive, and disabled thinking modes; map high/extrahigh to enabled with maximum depth for DeplAI jobs. M2.7 always reasons—use M2.7-highspeed when latency matters.',
  },
];

export function formatEffortTier(tier: ThinkingEffortTier): string {
  if (tier === 'extrahigh') return 'Extra high (xhigh)';
  if (tier === 'ultra') return 'Ultra (product mode)';
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

export function effortTiersForModel(metadata: Record<string, unknown> | undefined): ThinkingEffortTier[] | null {
  const raw = metadata?.thinkingEffort;
  if (!raw || typeof raw !== 'object') return null;
  const tiers = (raw as { tiers?: unknown }).tiers;
  if (!Array.isArray(tiers)) return null;
  return tiers.filter((item): item is ThinkingEffortTier =>
    item === 'low' || item === 'medium' || item === 'high' || item === 'extrahigh' || item === 'ultra',
  );
}

export function effortNotesForModel(metadata: Record<string, unknown> | undefined): string | null {
  const raw = metadata?.thinkingEffort;
  if (!raw || typeof raw !== 'object') return null;
  const notes = (raw as { notes?: unknown }).notes;
  return typeof notes === 'string' && notes.trim() ? notes.trim() : null;
}
