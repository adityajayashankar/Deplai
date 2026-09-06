export const PROVIDER_IDS = [
  'openai',
  'anthropic',
  'minimax',
  'xai',
  'gemini',
  'kimi',
  'glm',
  'groq',
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number] | 'openrouter' | 'ollama' | 'self_hosted';

export type ProviderStatus = 'active' | 'disabled' | 'degraded' | 'unavailable';
export type CredentialType = 'PLATFORM' | 'BYOK' | 'ENTERPRISE' | 'SELF_HOSTED';
export type CredentialState =
  | 'PENDING'
  | 'VALID'
  | 'INVALID'
  | 'EXPIRED'
  | 'REVOKED'
  | 'RATE_LIMITED'
  | 'QUOTA_EXCEEDED'
  | 'ERROR';
export type AccessMode = 'platform' | 'byok' | 'auto';
export type CredentialSource = 'platform' | 'byok' | 'enterprise' | 'self_hosted' | 'ephemeral';
export type ModelLifecycle =
  | 'DISCOVERED'
  | 'PREVIEW'
  | 'ACTIVE'
  | 'DEPRECATED'
  | 'SUNSET_PENDING'
  | 'RETIRED'
  | 'UNAVAILABLE';
export type HealthStatus = 'Healthy' | 'Degraded' | 'Unavailable' | 'Unknown';
export type CapabilitySource = 'provider_declared' | 'platform_verified' | 'benchmark_verified' | 'inferred' | 'unknown';
export type BillingSource = 'platform' | 'byok';
export type AuthenticationType = 'api_key' | 'bearer' | 'query_key' | 'none';

export const LOGICAL_ALIASES = [
  'best',
  'best_reasoning',
  'best_coding',
  'best_agent',
  'best_fast',
  'best_cost',
  'best_long_context',
  'best_multimodal',
  'best_vision',
  'best_structured_output',
] as const;

export type LogicalAlias = (typeof LOGICAL_ALIASES)[number];

export const CAPABILITY_KEYS = [
  'reasoning',
  'coding',
  'agentic',
  'tool_calling',
  'structured_output',
  'vision',
  'audio_input',
  'audio_output',
  'image_generation',
  'long_context',
  'web_search',
  'computer_use',
  'batch',
  'streaming',
  'embeddings',
  'reranking',
  'function_calling',
] as const;

export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

export type CanonicalErrorCode =
  | 'AUTHENTICATION_ERROR'
  | 'AUTHORIZATION_ERROR'
  | 'RATE_LIMIT'
  | 'QUOTA_EXCEEDED'
  | 'MODEL_NOT_FOUND'
  | 'PROVIDER_UNAVAILABLE'
  | 'TIMEOUT'
  | 'INVALID_REQUEST'
  | 'CONTENT_POLICY'
  | 'CONTEXT_LIMIT'
  | 'TOKEN_LIMIT'
  | 'CAPABILITY_UNSUPPORTED'
  | 'POLICY_DENIED'
  | 'UNKNOWN_PROVIDER_ERROR';

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
}

export interface ChatTool {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface CapabilityScore {
  value: number;
  source: CapabilitySource;
}

export interface ModelCapabilities {
  reasoning: boolean;
  coding: boolean;
  agents: boolean;
  tools: boolean;
  vision: boolean;
  audio: boolean;
  embeddings: boolean;
  structured_output: boolean;
  streaming: boolean;
  batch: boolean;
  multimodal: boolean;
  scores: Partial<Record<CapabilityKey, CapabilityScore>>;
}

export interface ModelPricing {
  inputPerMillionUsd: number | null;
  outputPerMillionUsd: number | null;
  cachedInputPerMillionUsd?: number | null;
  currency: 'USD';
  source: CapabilitySource;
}

export interface ProviderDefinition {
  id: ProviderId;
  name: string;
  displayName: string;
  status: ProviderStatus;
  documentationUrl: string;
  apiBaseUrl: string;
  supportsPlatformCredentials: boolean;
  supportsByok: boolean;
  supportsModelDiscovery: boolean;
  supportsStreaming: boolean;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsAudio: boolean;
  supportsEmbeddings: boolean;
  supportsBatch: boolean;
  supportsReasoning: boolean;
  supportsStructuredOutput: boolean;
  supportsOpenaiCompatibility: boolean;
  authenticationType: AuthenticationType;
  credentialSchema: {
    secretLabel: string;
    placeholder: string;
    helpUrl: string;
  };
  envKeyNames: string[];
  brandColor: string;
}

export interface CanonicalModel {
  id: string;
  providerId: ProviderId;
  providerModelId: string;
  displayName: string;
  family: string;
  version: string;
  aliases: string[];
  status: ProviderStatus;
  lifecycle: ModelLifecycle;
  releaseDate: string | null;
  deprecationDate: string | null;
  retirementDate: string | null;
  replacementModelId: string | null;
  contextWindow: number;
  maxOutputTokens: number;
  capabilities: ModelCapabilities;
  latencyProfile: 'fast' | 'balanced' | 'slow';
  pricing: ModelPricing;
  regionSupport: string[];
  complianceTags: string[];
  modelOwner: string | null;
  metadata: Record<string, unknown>;
  discoveredAt: string | null;
  updatedAt: string | null;
}

export interface DiscoveredModel {
  providerModelId: string;
  displayName?: string;
  ownedBy?: string;
  contextWindow?: number;
  metadata?: Record<string, unknown>;
}

export interface OrganizationPolicy {
  userId: string;
  allowedProviders: ProviderId[] | null;
  allowedModels: string[] | null;
  allowedCredentialModes: AccessMode[];
  byokRequired: boolean;
  platformCredentialsAllowed: boolean;
  fallbackAllowed: boolean;
  crossProviderFallbackAllowed: boolean;
  maxTokenLimit: number | null;
  maxMonthlySpendUsd: number | null;
  maxRequestCostUsd: number | null;
  allowedRegions: string[] | null;
  complianceRestrictions: string[];
  promptLogging: boolean;
  responseLogging: boolean;
}

export interface RoutingWeights {
  capability: number;
  reliability: number;
  policy: number;
  credential: number;
  latency: number;
  cost: number;
  preference: number;
}

export interface RoutingPolicy {
  id: string;
  userId: string;
  name: string;
  taskType: string;
  primaryAlias: string;
  secondaryAlias: string | null;
  fallbackModelId: string | null;
  accessMode: AccessMode;
  allowedProviders: ProviderId[];
  weights: RoutingWeights;
  isDefault: boolean;
}

export interface CredentialRecord {
  id: string;
  userId: string;
  providerId: ProviderId;
  name: string;
  type: CredentialType;
  status: CredentialState;
  secretMasked: string;
  environment: 'production' | 'development' | 'security' | 'other';
  scope: string | null;
  allowedModelIds: string[] | null;
  createdBy: string;
  createdAt: string;
  lastValidatedAt: string | null;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

export interface ResolvedCredential {
  source: CredentialSource;
  credentialId: string | null;
  providerId: ProviderId;
  secret: string;
  masked: string;
}

export interface UsageBreakdown {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  toolCalls: number;
  estimated: boolean;
}

export interface CostBreakdown {
  providerCostUsd: number;
  platformCostUsd: number;
  customerChargeUsd: number;
  billingSource: BillingSource;
  estimated: boolean;
}

export interface NormalizedChatRequest {
  model: string;
  messages: ChatMessage[];
  accessMode: AccessMode;
  routingPolicy: string;
  stream: boolean;
  temperature?: number;
  maxTokens?: number;
  tools?: ChatTool[];
  responseFormat?: JsonSchemaResponseFormat;
  task?: string;
  metadata?: Record<string, unknown>;
  ephemeralApiKey?: string;
  ephemeralProvider?: ProviderId;
  credentialId?: string;
}

export interface NormalizedChatResponse {
  requestId: string;
  traceId: string;
  providerRequestId: string | null;
  model: string;
  provider: ProviderId;
  credentialSource: CredentialSource;
  output: string;
  toolCalls: Array<{ name: string; arguments: string }>;
  finishReason: string | null;
  usage: UsageBreakdown;
  cost: CostBreakdown;
  latencyMs: number;
  timeToFirstTokenMs: number | null;
  routingExplanation: string[];
  skipped: Array<{ model: string; reason: string }>;
  fallback: {
    count: number;
    primaryProvider: ProviderId | null;
    primaryModel: string | null;
    failureReason: string | null;
  };
}

export type CanonicalStreamEvent =
  | { type: 'stream.started'; requestId: string; provider: ProviderId; model: string }
  | { type: 'output.delta'; text: string }
  | { type: 'tool_call.started'; name: string; id: string }
  | { type: 'tool_call.delta'; id: string; argumentsDelta: string }
  | { type: 'tool_call.completed'; id: string; name: string; arguments: string }
  | { type: 'stream.completed'; response: NormalizedChatResponse }
  | { type: 'stream.error'; code: CanonicalErrorCode; message: string };

export interface AdapterChatRequest {
  secret: string;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  tools?: ChatTool[];
  responseFormat?: JsonSchemaResponseFormat;
  signal?: AbortSignal;
}

export interface JsonSchemaResponseFormat {
  type: 'json_schema';
  json_schema: {
    name: string;
    strict: true;
    schema: Record<string, unknown>;
  };
}

export interface AdapterChatResponse {
  text: string;
  toolCalls: Array<{ name: string; arguments: string }>;
  finishReason: string | null;
  usage: UsageBreakdown;
  providerRequestId: string | null;
}

export interface ProviderHealthSnapshot {
  providerId: ProviderId;
  status: HealthStatus;
  availability: number;
  latencyMs: number | null;
  errorRate: number;
  rateLimitRate: number;
  timeoutRate: number;
  checkedAt: string;
  detail: string | null;
}

export interface ModelHealthSnapshot {
  modelId: string;
  providerId: ProviderId;
  status: HealthStatus;
  detail: string | null;
  checkedAt: string;
}

export interface RoutingCandidate {
  model: CanonicalModel;
  score: number;
  reasons: string[];
  skipReason?: string;
}

export interface GatewayContext {
  userId: string;
  organizationId: string;
  projectId?: string;
  workspaceId?: string;
  actor?: string;
  source?: 'ui' | 'chat' | 'security' | 'customization' | 'terraform' | 'internal';
}

export const DEFAULT_ROUTING_WEIGHTS: RoutingWeights = {
  capability: 0.4,
  reliability: 0.25,
  policy: 0.1,
  credential: 0.05,
  latency: 0.1,
  cost: 0.1,
  preference: 0.0,
};

export const DEFAULT_ORGANIZATION_POLICY: Omit<OrganizationPolicy, 'userId'> = {
  allowedProviders: null,
  allowedModels: null,
  allowedCredentialModes: ['platform', 'byok', 'auto'],
  byokRequired: false,
  platformCredentialsAllowed: true,
  fallbackAllowed: true,
  crossProviderFallbackAllowed: true,
  maxTokenLimit: null,
  maxMonthlySpendUsd: null,
  maxRequestCostUsd: null,
  allowedRegions: null,
  complianceRestrictions: [],
  promptLogging: false,
  responseLogging: false,
};
