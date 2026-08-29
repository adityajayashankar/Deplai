/** Public browser prefix routed by Caddy before proxying to Agentic Layer. */
export const AGENTIC_PUBLIC_PATH_PREFIX = '/agentic';

export type AgenticWebSocketEndpoint = 'scan' | 'remediate' | 'pipeline';

/** Normalize `wss://host/agentic` (no trailing slash). */
export function normalizeAgenticWsBase(input: string): string {
  return input.trim().replace(/\/+$/, '');
}

/**
 * Build the browser-facing WebSocket URL.
 * Example: wss://deplai.in/agentic/ws/scan/{projectId}?token=...
 */
export function buildAgenticWebSocketUrl(
  wsBaseUrl: string,
  endpoint: AgenticWebSocketEndpoint,
  projectId: string,
  token?: string,
): string {
  const base = `${normalizeAgenticWsBase(wsBaseUrl)}/ws/${endpoint}/${encodeURIComponent(projectId)}`;
  const trimmedToken = token?.trim();
  return trimmedToken ? `${base}?token=${encodeURIComponent(trimmedToken)}` : base;
}

/** Path FastAPI receives after Caddy strips `/agentic`. */
export function agenticUpstreamWebSocketPath(
  endpoint: AgenticWebSocketEndpoint,
  projectId: string,
): string {
  return `/ws/${endpoint}/${encodeURIComponent(projectId)}`;
}

/**
 * Apply the same `/agentic` strip Caddy uses (`uri strip_prefix /agentic` or
 * `handle_path /agentic/*`). Returns null when the path is not under /agentic.
 */
export function stripAgenticPublicPrefix(publicPath: string): string | null {
  const pathOnly = publicPath.split('?')[0] || '';
  if (pathOnly === AGENTIC_PUBLIC_PATH_PREFIX) return '/';
  if (!pathOnly.startsWith(`${AGENTIC_PUBLIC_PATH_PREFIX}/`)) return null;
  const stripped = pathOnly.slice(AGENTIC_PUBLIC_PATH_PREFIX.length);
  return stripped.startsWith('/') ? stripped : `/${stripped}`;
}

export function toWebSocketBaseFromHttpOrigin(origin: string): string | null {
  try {
    const parsed = new URL(origin);
    if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
    else if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
    else if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return null;
    parsed.pathname = '';
    parsed.search = '';
    parsed.hash = '';
    return normalizeAgenticWsBase(parsed.toString());
  } catch {
    return null;
  }
}

export function sameOriginAgenticWsBase(browser: { protocol: string; host: string }): string {
  const scheme = browser.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${normalizeAgenticWsBase(`${scheme}//${browser.host}`)}${AGENTIC_PUBLIC_PATH_PREFIX}`;
}

export function isMixedContentWebSocket(wsBase: string, pageProtocol: string): boolean {
  return pageProtocol === 'https:' && wsBase.startsWith('ws://');
}

export function wsBaseMatchesHost(wsBase: string, host: string): boolean {
  try {
    return new URL(wsBase).host === host;
  } catch {
    return false;
  }
}

export function resolveAgenticWsBaseFromConfig(options: {
  requestOrigin?: string;
  publicEnvWsUrl?: string;
  browser?: { protocol: string; host: string };
}): string {
  const requestOrigin = options.requestOrigin?.trim();
  if (requestOrigin) {
    const fromOrigin = toWebSocketBaseFromHttpOrigin(requestOrigin);
    if (fromOrigin) {
      return `${fromOrigin}${AGENTIC_PUBLIC_PATH_PREFIX}`;
    }
  }

  const publicWs = normalizeAgenticWsBase(options.publicEnvWsUrl || '');
  const browser = options.browser;
  if (
    publicWs.endsWith(AGENTIC_PUBLIC_PATH_PREFIX)
    && browser
    && !isMixedContentWebSocket(publicWs, browser.protocol)
    && wsBaseMatchesHost(publicWs, browser.host)
  ) {
    return publicWs;
  }

  if (browser) {
    return sameOriginAgenticWsBase(browser);
  }

  return `ws://127.0.0.1:8000`;
}
