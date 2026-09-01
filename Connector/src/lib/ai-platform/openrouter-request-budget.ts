import { createHash } from 'node:crypto';

import { AiPlatformError } from './errors';
import type { ChatMessage, ChatTool } from './types';

const WINDOW_MS = 60_000;
const DEFAULT_REQUEST_TOKEN_CAP = 7_500;
const DEFAULT_RPM = 8;
const DEFAULT_TPM = 60_000;
const MIN_COMPLETION_TOKENS = 256;

type Reservation = { at: number; tokens: number };

type GlobalOpenRouterBudget = typeof globalThis & {
  __deplaiOpenRouterRequestBudget?: Map<string, Reservation[]>;
};

const globalForOpenRouterBudget = globalThis as GlobalOpenRouterBudget;

function buckets(): Map<string, Reservation[]> {
  if (!globalForOpenRouterBudget.__deplaiOpenRouterRequestBudget) {
    globalForOpenRouterBudget.__deplaiOpenRouterRequestBudget = new Map();
  }
  return globalForOpenRouterBudget.__deplaiOpenRouterRequestBudget;
}

function envInteger(name: string, fallback: number, minimum: number, maximum?: number): number {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  const normalized = Math.max(minimum, Math.floor(value));
  return maximum == null ? normalized : Math.min(maximum, normalized);
}

/**
 * OpenRouter free variants have a shared account quota. The MiniMax and
 * Nemotron models below also receive this cap when paid, because upstream
 * provider rate limits are dynamic and are not published by OpenRouter.
 */
export function isOpenRouterLowQuotaModel(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return normalized.endsWith(':free')
    || normalized.startsWith('minimax/minimax-m3')
    || normalized.startsWith('minimax/minimax-m2.7')
    || normalized.startsWith('nvidia/nemotron');
}

export function openRouterRequestTokenCap(): number {
  // Keep a margin below the upstream 8K-request threshold.
  return envInteger('OPENROUTER_LOW_QUOTA_REQUEST_TOKEN_CAP', DEFAULT_REQUEST_TOKEN_CAP, 512, 8_191);
}

export function estimateOpenRouterInputTokens(messages: ChatMessage[], tools?: ChatTool[]): number {
  const messageBytes = messages.reduce(
    (sum, message) => sum + Buffer.byteLength(message.content, 'utf8') + Buffer.byteLength(message.role, 'utf8') + 12,
    0,
  );
  const toolBytes = tools?.length ? Buffer.byteLength(JSON.stringify(tools), 'utf8') : 0;
  // Tokenizers cannot emit more ordinary input tokens than their UTF-8 byte
  // stream. Reserving one token per byte therefore keeps code, JSON, and
  // non-ASCII source safely below the configured upstream request ceiling.
  return Math.max(1, messageBytes + toolBytes + 24);
}

function keyForSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 24);
}

function retryAfterFor(events: Reservation[], now: number): number {
  const earliest = events.reduce((minimum, event) => Math.min(minimum, event.at), now + WINDOW_MS);
  return Math.max(1, Math.ceil((earliest + WINDOW_MS - now) / 1000));
}

export function reserveOpenRouterRateBudget(input: {
  secret: string;
  tokens: number;
  now?: number;
}): { allowed: boolean; retryAfterSeconds: number } {
  const now = input.now ?? Date.now();
  const rpm = envInteger('OPENROUTER_LOW_QUOTA_RPM', DEFAULT_RPM, 1);
  const tpm = envInteger('OPENROUTER_LOW_QUOTA_TPM', DEFAULT_TPM, openRouterRequestTokenCap());
  const key = keyForSecret(input.secret);
  const active = (buckets().get(key) || []).filter((event) => event.at > now - WINDOW_MS);
  const requestedTokens = Math.max(1, Math.ceil(input.tokens));
  const activeTokens = active.reduce((sum, event) => sum + event.tokens, 0);

  if (active.length >= rpm || activeTokens + requestedTokens > tpm) {
    buckets().set(key, active);
    return { allowed: false, retryAfterSeconds: retryAfterFor(active, now) };
  }

  active.push({ at: now, tokens: requestedTokens });
  buckets().set(key, active);
  return { allowed: true, retryAfterSeconds: 0 };
}

export function constrainOpenRouterRequest(input: {
  secret: string;
  model: string;
  messages: ChatMessage[];
  requestedMaxTokens?: number;
  tools?: ChatTool[];
}): { maxTokens: number | undefined; reservedTokens: number } {
  const requestedMaxTokens = Math.max(1, Math.floor(input.requestedMaxTokens || 4096));
  if (!isOpenRouterLowQuotaModel(input.model)) {
    return { maxTokens: input.requestedMaxTokens, reservedTokens: 0 };
  }

  const inputTokens = estimateOpenRouterInputTokens(input.messages, input.tools);
  const cap = openRouterRequestTokenCap();
  const remainingOutputTokens = cap - inputTokens;
  if (remainingOutputTokens < MIN_COMPLETION_TOKENS) {
    throw new AiPlatformError(
      'TOKEN_LIMIT',
      `OpenRouter request exceeds the ${cap}-token low-quota safety budget before completion tokens are reserved`,
      { retryable: false, detail: { tokenCap: cap, estimatedInputTokens: inputTokens } },
    );
  }

  const maxTokens = Math.min(requestedMaxTokens, remainingOutputTokens);
  const reservation = reserveOpenRouterRateBudget({
    secret: input.secret,
    tokens: inputTokens + maxTokens,
  });
  if (!reservation.allowed) {
    throw new AiPlatformError(
      'RATE_LIMIT',
      'OpenRouter low-quota RPM/TPM safety budget is temporarily exhausted',
      {
        retryable: false,
        detail: {
          retryAfterSeconds: reservation.retryAfterSeconds,
          rpm: envInteger('OPENROUTER_LOW_QUOTA_RPM', DEFAULT_RPM, 1),
          tpm: envInteger('OPENROUTER_LOW_QUOTA_TPM', DEFAULT_TPM, cap),
        },
      },
    );
  }
  return { maxTokens, reservedTokens: inputTokens + maxTokens };
}

export function resetOpenRouterRequestBudgetForTests(): void {
  buckets().clear();
}
