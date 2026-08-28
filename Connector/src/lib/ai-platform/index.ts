export { aiChat, executeChat, streamChat } from './client';
export { ensureAiPlatformSchema } from './schema';
export { listAdapters, getAdapter, canonicalizeProviderId } from './providers/registry';
export { LOGICAL_ALIASES } from './types';
export type { NormalizedChatResponse, CanonicalModel, ProviderId } from './types';
