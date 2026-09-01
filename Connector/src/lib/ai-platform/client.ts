import { executeChat, toGatewayMessages } from './gateway';
import { canonicalizeProviderId } from './providers/definitions';
import type { AccessMode, GatewayContext, NormalizedChatResponse } from './types';

export async function aiChat(input: {
  userId: string;
  organizationId: string;
  projectId?: string;
  model?: string;
  messages: Array<{ role: string; content: string }>;
  system?: string;
  accessMode?: AccessMode;
  task?: string;
  apiKey?: string;
  provider?: string;
  source?: GatewayContext['source'];
  temperature?: number;
  maxTokens?: number;
}): Promise<NormalizedChatResponse> {
  return executeChat(
    {
      userId: input.userId,
      organizationId: input.organizationId,
      projectId: input.projectId,
      source: input.source || 'internal',
    },
    {
      model: input.model || 'best',
      messages: toGatewayMessages(input.messages, input.system),
      accessMode: input.accessMode || 'auto',
      routingPolicy: input.task === 'security_analysis' ? 'security_analysis' : 'default',
      stream: false,
      temperature: input.temperature,
      maxTokens: input.maxTokens,
      task: input.task,
      ephemeralApiKey: input.apiKey,
      ephemeralProvider: canonicalizeProviderId(input.provider || '') || undefined,
    },
  );
}

export { executeChat, streamChat, toGatewayMessages } from './gateway';
