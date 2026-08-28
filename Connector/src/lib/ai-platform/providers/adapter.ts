import type {
  AdapterChatRequest,
  AdapterChatResponse,
  CanonicalStreamEvent,
  DiscoveredModel,
  ProviderDefinition,
  ProviderHealthSnapshot,
} from '../types';
import { AiPlatformError } from '../errors';

export interface CredentialValidation {
  ok: boolean;
  code: 'valid' | 'authentication_failed' | 'provider_unavailable';
  message: string;
  modelsDiscovered: number;
}

export interface AIProviderAdapter {
  readonly definition: ProviderDefinition;

  validateCredentials(secret: string): Promise<CredentialValidation>;
  listModels(secret: string): Promise<DiscoveredModel[]>;
  healthCheck(secret: string): Promise<ProviderHealthSnapshot>;
  chat(input: AdapterChatRequest): Promise<AdapterChatResponse>;
  stream(input: AdapterChatRequest): AsyncGenerator<CanonicalStreamEvent>;
  embeddings?(input: { secret: string; model: string; input: string[] }): Promise<{ vectors: number[][] }>;
  normalizeError(error: unknown): AiPlatformError;
}
