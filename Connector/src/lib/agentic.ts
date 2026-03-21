export const AGENTIC_URL = process.env.AGENTIC_LAYER_URL || 'http://localhost:8000';
export const AGENTIC_API_KEY = process.env.DEPLAI_SERVICE_KEY;

export function agenticHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers = { ...extra };
  if (AGENTIC_API_KEY) {
    headers['X-API-Key'] = AGENTIC_API_KEY;
  }
  return headers;
}
