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

/** Hostnames that must never be sent to browsers as the public WebSocket origin. */
export function isInternalHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().split(':')[0] || '';
  if (!normalized) return true;
  if (normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '0.0.0.0') {
    return true;
  }
  if (normalized === 'connector' || normalized.endsWith('.internal')) return true;
  return false;
}

export function isInternalHttpOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    return isInternalHostname(parsed.hostname);
  } catch {
    return true;
  }
}

/**
 * Resolve the browser-visible HTTP origin for a request behind Caddy/reverse proxies.
 * Falls back to NEXT_PUBLIC_APP_URL when the app only sees its container listen address.
 */
export function resolvePublicHttpOrigin(options: {
  requestOrigin?: string;
  forwardedHost?: string | null;
  forwardedProto?: string | null;
  hostHeader?: string | null;
  publicAppUrl?: string | null;
}): string | null {
  const forwardedHost = options.forwardedHost?.split(',')[0]?.trim();
  const forwardedProto = options.forwardedProto?.split(',')[0]?.trim();
  if (forwardedHost && forwardedProto) {
    return `${forwardedProto}://${forwardedHost}`;
  }

  const hostHeader = options.hostHeader?.trim();
  if (hostHeader && !isInternalHostname(hostHeader.split(':')[0] || '')) {
    const proto = forwardedProto
      || (options.requestOrigin?.startsWith('https://') ? 'https' : 'https');
    return `${proto}://${hostHeader}`;
  }

  const requestOrigin = options.requestOrigin?.trim();
  if (requestOrigin && !isInternalHttpOrigin(requestOrigin)) {
    return requestOrigin;
  }

  const publicAppUrl = options.publicAppUrl?.trim().replace(/\/+$/, '');
  if (publicAppUrl && !isInternalHttpOrigin(publicAppUrl)) {
    return publicAppUrl;
  }

  return requestOrigin || publicAppUrl || null;
}

export function normalizeHttpOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, '');
}

/**
 * CSRF check for browser POSTs behind Caddy. `request.nextUrl.origin` is the
 * Connector container listen address (http://connector:3000); the browser Origin
 * is https://APP_DOMAIN. Compare against the public origin, not the listen URL.
 */
export function isAllowedBrowserOrigin(
  origin: string | null | undefined,
  options: {
    requestOrigin?: string;
    forwardedHost?: string | null;
    forwardedProto?: string | null;
    hostHeader?: string | null;
    publicAppUrl?: string | null;
    corsOrigins?: string | null;
  },
): boolean {
  const raw = origin?.trim();
  if (!raw) return true;
  let candidate: string;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    candidate = normalizeHttpOrigin(parsed.origin);
  } catch {
    return false;
  }

  const allowed = new Set<string>();
  const add = (value: string | null | undefined) => {
    const trimmed = value?.trim();
    if (!trimmed) return;
    try {
      allowed.add(normalizeHttpOrigin(new URL(trimmed).origin));
    } catch {
      if (/^https?:\/\//i.test(trimmed)) allowed.add(normalizeHttpOrigin(trimmed));
    }
  };

  add(resolvePublicHttpOrigin(options));
  add(options.publicAppUrl);
  for (const item of (options.corsOrigins || '').split(',')) add(item);
  return allowed.has(candidate);
}

/** True when the browser should connect straight to FastAPI (no /agentic prefix). */
export function isDirectLocalAgenticWsBase(wsBase: string): boolean {
  const normalized = normalizeAgenticWsBase(wsBase);
  if (!normalized || normalized.endsWith(AGENTIC_PUBLIC_PATH_PREFIX)) return false;
  try {
    return isInternalHostname(new URL(normalized).hostname);
  } catch {
    return false;
  }
}

function resolveConfiguredAgenticWsBase(publicEnvWsUrl?: string): string | null {
  const publicWs = normalizeAgenticWsBase(publicEnvWsUrl || '');
  if (!publicWs) return null;
  if (isDirectLocalAgenticWsBase(publicWs)) return publicWs;
  if (!publicWs.endsWith(AGENTIC_PUBLIC_PATH_PREFIX)) return null;
  try {
    if (!isInternalHostname(new URL(publicWs).hostname)) {
      return publicWs;
    }
  } catch {
    return null;
  }
  return null;
}

export function resolveAgenticWsBaseFromConfig(options: {
  requestOrigin?: string;
  forwardedHost?: string | null;
  forwardedProto?: string | null;
  hostHeader?: string | null;
  publicAppUrl?: string | null;
  publicEnvWsUrl?: string;
  browser?: { protocol: string; host: string };
}): string {
  const configuredWs = resolveConfiguredAgenticWsBase(options.publicEnvWsUrl);
  if (configuredWs && isDirectLocalAgenticWsBase(configuredWs)) {
    const browser = options.browser;
    if (!browser || isInternalHostname(browser.host.split(':')[0] || '')) {
      return configuredWs;
    }
  }

  const publicHttpOrigin = resolvePublicHttpOrigin({
    requestOrigin: options.requestOrigin,
    forwardedHost: options.forwardedHost,
    forwardedProto: options.forwardedProto,
    hostHeader: options.hostHeader,
    publicAppUrl: options.publicAppUrl,
  });
  if (publicHttpOrigin && !isInternalHttpOrigin(publicHttpOrigin)) {
    const fromOrigin = toWebSocketBaseFromHttpOrigin(publicHttpOrigin);
    if (fromOrigin) {
      return `${fromOrigin}${AGENTIC_PUBLIC_PATH_PREFIX}`;
    }
  }

  if (configuredWs) {
    const browser = options.browser;
    if (!browser || isDirectLocalAgenticWsBase(configuredWs) || wsBaseMatchesHost(configuredWs, browser.host)) {
      return configuredWs;
    }
  }

  const publicWs = normalizeAgenticWsBase(options.publicEnvWsUrl || '');
  if (publicWs.endsWith(AGENTIC_PUBLIC_PATH_PREFIX)) {
    try {
      if (!isInternalHostname(new URL(publicWs).hostname)) {
        const browser = options.browser;
        if (!browser || wsBaseMatchesHost(publicWs, browser.host)) {
          return publicWs;
        }
      }
    } catch {
      // ignore invalid public ws url
    }
  }

  const browser = options.browser;
  if (browser) {
    const browserHostname = browser.host.split(':')[0] || '';
    if (isInternalHostname(browserHostname)) {
      const externalWs = resolveConfiguredAgenticWsBase(options.publicEnvWsUrl);
      if (externalWs && !isDirectLocalAgenticWsBase(externalWs)) {
        return externalWs;
      }
    }
    return sameOriginAgenticWsBase(browser);
  }

  return `ws://127.0.0.1:8000`;
}

/**
 * Browser-side WebSocket base resolution.
 * On a public hostname (deplai.in), always use same-origin /agentic and never
 * trust container-internal origins from /api/pipeline/ws-config.
 */
export function resolveBrowserAgenticWsBase(options: {
  browser: { protocol: string; host: string };
  publicEnvWsUrl?: string;
}): string {
  const browserHostname = options.browser.host.split(':')[0] || '';
  if (!isInternalHostname(browserHostname)) {
    return sameOriginAgenticWsBase(options.browser);
  }

  return resolveAgenticWsBaseFromConfig({
    publicEnvWsUrl: options.publicEnvWsUrl,
    browser: options.browser,
  });
}
