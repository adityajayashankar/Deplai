export const AGENTIC_URL = process.env.AGENTIC_LAYER_URL || 'http://localhost:8000';
export const AGENTIC_API_KEY = process.env.DEPLAI_SERVICE_KEY;

export function formatAgenticFetchError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || '');
  const lowered = message.toLowerCase();
  if (
    lowered.includes('fetch failed')
    || lowered.includes('econnrefused')
    || lowered.includes('enotfound')
    || lowered.includes('network')
  ) {
    return `Could not reach the Agentic Layer at ${AGENTIC_URL}. Start the Agentic Layer service and retry remediation.`;
  }
  if (lowered.includes('timeout') || lowered.includes('aborted')) {
    return 'Agentic Layer request timed out. Check that the service is healthy and retry.';
  }
  return message || 'Agentic Layer request failed';
}

export function agenticHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers = { ...extra };
  if (AGENTIC_API_KEY) {
    headers['X-API-Key'] = AGENTIC_API_KEY;
  }
  return headers;
}
