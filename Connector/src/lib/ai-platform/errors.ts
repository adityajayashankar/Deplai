import type { CanonicalErrorCode } from './types';

export class AiPlatformError extends Error {
  readonly code: CanonicalErrorCode;
  readonly status: number;
  readonly providerId?: string;
  readonly retryable: boolean;
  readonly sanitizedProviderDetail?: string;

  constructor(
    code: CanonicalErrorCode,
    message: string,
    options?: {
      status?: number;
      providerId?: string;
      retryable?: boolean;
      sanitizedProviderDetail?: string;
      cause?: unknown;
    },
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = 'AiPlatformError';
    this.code = code;
    this.status = options?.status ?? statusForCode(code);
    this.providerId = options?.providerId;
    this.retryable = options?.retryable ?? isRetryableCode(code);
    this.sanitizedProviderDetail = options?.sanitizedProviderDetail;
  }
}

export class CapabilityError extends AiPlatformError {
  readonly capability: string;

  constructor(providerId: string, capability: string) {
    super('CAPABILITY_UNSUPPORTED', `${providerId} does not support ${capability}`, {
      status: 400,
      providerId,
      retryable: false,
    });
    this.name = 'CapabilityError';
    this.capability = capability;
  }
}

export function statusForCode(code: CanonicalErrorCode): number {
  switch (code) {
    case 'AUTHENTICATION_ERROR':
      return 401;
    case 'AUTHORIZATION_ERROR':
    case 'POLICY_DENIED':
      return 403;
    case 'MODEL_NOT_FOUND':
      return 404;
    case 'RATE_LIMIT':
      return 429;
    case 'QUOTA_EXCEEDED':
    case 'TOKEN_LIMIT':
    case 'CONTEXT_LIMIT':
    case 'INVALID_REQUEST':
    case 'CONTENT_POLICY':
    case 'CAPABILITY_UNSUPPORTED':
      return 400;
    case 'TIMEOUT':
      return 504;
    case 'PROVIDER_UNAVAILABLE':
      return 503;
    default:
      return 502;
  }
}

export function isRetryableCode(code: CanonicalErrorCode): boolean {
  return code === 'RATE_LIMIT' || code === 'PROVIDER_UNAVAILABLE' || code === 'TIMEOUT';
}

export function classifyHttpStatus(status: number): CanonicalErrorCode {
  if (status === 401) return 'AUTHENTICATION_ERROR';
  if (status === 403) return 'AUTHORIZATION_ERROR';
  if (status === 404) return 'MODEL_NOT_FOUND';
  if (status === 408 || status === 504) return 'TIMEOUT';
  if (status === 429) return 'RATE_LIMIT';
  if (status === 400) return 'INVALID_REQUEST';
  if (status >= 500) return 'PROVIDER_UNAVAILABLE';
  return 'UNKNOWN_PROVIDER_ERROR';
}

export function classifyProviderMessage(status: number, body: string): CanonicalErrorCode {
  const text = body.toLowerCase();
  if (status === 401 || /invalid api key|incorrect api key|unauthorized|authentication/.test(text)) {
    return 'AUTHENTICATION_ERROR';
  }
  if (/quota|billing|insufficient_quota|exceeded your current quota/.test(text)) {
    return 'QUOTA_EXCEEDED';
  }
  if (status === 429 || /rate limit|too many requests|rpm|tpm/.test(text)) {
    return 'RATE_LIMIT';
  }
  if (/context length|maximum context|too many tokens|prompt is too long/.test(text)) {
    return 'CONTEXT_LIMIT';
  }
  if (/max_tokens|output token|token limit/.test(text)) {
    return 'TOKEN_LIMIT';
  }
  if (/content.?policy|safety|blocked/.test(text)) {
    return 'CONTENT_POLICY';
  }
  if (/model.?not.?found|does not exist|unknown model/.test(text)) {
    return 'MODEL_NOT_FOUND';
  }
  return classifyHttpStatus(status);
}

export function sanitizeProviderBody(body: string): string {
  return body
    .replace(/sk-[A-Za-z0-9_\-]{8,}/g, '[redacted]')
    .replace(/gsk_[A-Za-z0-9_\-]{8,}/g, '[redacted]')
    .replace(/sk-ant-[A-Za-z0-9_\-]{8,}/g, '[redacted]')
    .replace(/AIza[A-Za-z0-9_\-]{8,}/g, '[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer [redacted]')
    .slice(0, 400);
}
