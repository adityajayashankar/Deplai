'use client';

import { createContext, useContext, useState, useRef, useCallback, useMemo, useEffect } from 'react';

const WS_BASE_URL = (process.env.NEXT_PUBLIC_AGENTIC_WS_URL || '').trim();
const SCAN_CONTEXT_STORAGE_KEY = 'deplai.scan-context.v1';
const MAX_PROJECT_ENTRIES = 40;
const MAX_MESSAGES_PER_PROJECT = 500;
const MAX_STORED_REMEDIATION_MESSAGES = 160;
const MAX_STORED_MESSAGE_CONTENT_CHARS = 2_000;
const WEBSOCKET_CONNECT_TIMEOUT_MS = 15_000;

type OperationState = 'idle' | 'running' | 'waiting_decision' | 'waiting_approval' | 'completed' | 'error';
export type ScanState = OperationState;
export type RemediationState = OperationState;
export type VulnStatus = 'not_initiated' | 'found' | 'not_found';

export interface CachedScanResults {
  status: VulnStatus;
  data: { supply_chain: unknown[]; code_security: unknown[] } | null;
}

export interface ScanMessage {
  index: number;
  total: number;
  type: string;
  content: string;
  timestamp: string;
}

interface SocketPayload {
  type?: string;
  data?: ScanMessage;
  status?: string;
  error?: string;
}

interface ProjectScanState {
  state: ScanState;
  messages: ScanMessage[];
  projectName: string;
}

interface ProjectRemediationState {
  state: RemediationState;
  messages: ScanMessage[];
}

interface PersistedScanContextSnapshot {
  scanStates?: Record<string, ProjectScanState>;
  remediationStates?: Record<string, ProjectRemediationState>;
  resultsCache?: Record<string, CachedScanResults>;
}

interface ScanContextValue {
  startScan: (projectId: string, projectName: string) => Promise<void>;
  getScanState: (projectId: string) => ProjectScanState;
  activeScanIds: string[];
  resetAll: () => void;
  startRemediation: (
    projectId: string,
    githubToken?: string,
    llmProvider?: string,
    llmApiKey?: string,
    llmModel?: string,
    remediationScope?: 'major' | 'all',
  ) => Promise<void>;
  continueRemediationRound: (projectId: string) => void;
  pushCurrentRemediationChanges: (projectId: string) => void;
  approveRemediationPush: (projectId: string) => void;
  getRemediationState: (projectId: string) => ProjectRemediationState;
  resetRemediation: (projectId: string) => void;
  isAnyRemediating: boolean;
  activeRemediationIds: string[];
  getCachedResults: (projectId: string) => CachedScanResults | null;
  setCachedResults: (projectId: string, results: CachedScanResults) => void;
}

const ScanContext = createContext<ScanContextValue | null>(null);

export function useScan() {
  const context = useContext(ScanContext);
  if (!context) {
    throw new Error('useScan must be used within a ScanProvider');
  }
  return context;
}

async function fetchWsToken(projectId: string): Promise<string> {
  const res = await fetch(`/api/scan/ws-token?project_id=${encodeURIComponent(projectId)}`, { cache: 'no-store' });
  const data = await res.json().catch(() => ({})) as { token?: string; error?: string };
  if (!res.ok) {
    const fallback = res.status === 401
      ? 'Your session is not authorized to stream remediation logs. Sign in again and reopen the project from the dashboard.'
      : 'Failed to issue remediation WebSocket token.';
    throw new Error(String(data.error || fallback));
  }
  const token = String(data.token || '').trim();
  if (!token) {
    throw new Error('Remediation WebSocket token response was empty.');
  }
  return token;
}

let resolvedWsBaseCache: string | null = null;
let wsBaseFetchInFlight: Promise<string> | null = null;

function normalizeWsBase(input: string): string {
  return input.replace(/\/+$/, '');
}

function browserWsFallbackBase(): string {
  if (typeof window === 'undefined') return 'ws://localhost:8000';
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}`;
}

async function resolveWsBaseUrl(): Promise<string> {
  if (resolvedWsBaseCache) return resolvedWsBaseCache;
  if (WS_BASE_URL) {
    resolvedWsBaseCache = normalizeWsBase(WS_BASE_URL);
    return resolvedWsBaseCache;
  }
  if (wsBaseFetchInFlight) return wsBaseFetchInFlight;

  wsBaseFetchInFlight = (async () => {
    try {
      const res = await fetch('/api/pipeline/ws-config', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json() as { ws_base?: string };
        const fromServer = String(data.ws_base || '').trim();
        if (fromServer) {
          resolvedWsBaseCache = normalizeWsBase(fromServer);
          return resolvedWsBaseCache;
        }
      }
    } catch {
      // ignore and fallback
    }
    resolvedWsBaseCache = normalizeWsBase(browserWsFallbackBase());
    return resolvedWsBaseCache;
  })();

  try {
    return await wsBaseFetchInFlight;
  } finally {
    wsBaseFetchInFlight = null;
  }
}

function connectWebSocket(
  wsBaseUrl: string,
  path: string,
  projectId: string,
  onMessage: (projectId: string, msg: ScanMessage) => void,
  onStatus: (projectId: string, status: string) => void,
  onError: (projectId: string, error?: string) => void,
  onClose: (projectId: string, detail?: { code?: number; reason?: string }) => void,
  wsToken: string,
): WebSocket {
  const base = `${normalizeWsBase(wsBaseUrl)}${path}/${projectId}`;
  const workflowLabel = path.includes('/remediate') ? 'remediation' : 'scan';
  const ws = new WebSocket(wsToken ? `${base}?token=${encodeURIComponent(wsToken)}` : base);
  let opened = false;
  const connectTimeout = window.setTimeout(() => {
    if (opened || ws.readyState !== WebSocket.CONNECTING) return;
    onError(projectId, `The live ${workflowLabel} connection timed out. Verify the production WebSocket URL and reverse proxy, then retry.`);
    ws.close();
  }, WEBSOCKET_CONNECT_TIMEOUT_MS);

  ws.onopen = () => {
    opened = true;
    window.clearTimeout(connectTimeout);
    ws.send(JSON.stringify({ action: 'start' }));
  };

  ws.onmessage = (event) => {
    let data: SocketPayload;
    try {
      const parsed = JSON.parse(event.data) as unknown;
      if (!parsed || typeof parsed !== 'object') throw new Error('Invalid websocket payload');
      data = parsed as SocketPayload;
    } catch {
      onMessage(projectId, {
        index: Date.now(),
        total: Date.now(),
        type: 'error',
        content: 'Received malformed websocket payload from remediation backend.',
        timestamp: new Date().toISOString(),
      });
      onStatus(projectId, 'error');
      return;
    }
    switch (data.type) {
      case 'message':
        onMessage(projectId, data.data as ScanMessage);
        break;
      case 'status':
        const status = typeof data.status === 'string' ? data.status : '';
        if (status === 'error' && typeof data.error === 'string' && data.error.trim()) {
          onMessage(projectId, {
            index: Date.now(),
            total: Date.now(),
            type: 'error',
            content: data.error.trim(),
            timestamp: new Date().toISOString(),
          });
        }
        if (['running', 'waiting_decision', 'waiting_approval', 'completed', 'error'].includes(status)) {
          onStatus(projectId, status);
        }
        break;
    }
  };

  ws.onerror = () => {
    onError(projectId, `WebSocket transport error while streaming ${workflowLabel} logs. Verify the production WebSocket URL and reverse proxy, then retry.`);
  };
  ws.onclose = (event) => {
    window.clearTimeout(connectTimeout);
    onClose(projectId, { code: event.code, reason: event.reason });
  };

  return ws;
}

function trimMessageList(messages: ScanMessage[]): ScanMessage[] {
  if (!Array.isArray(messages)) return [];
  return messages.slice(-MAX_MESSAGES_PER_PROJECT);
}

function truncateStoredContent(content: string): string {
  if (content.length <= MAX_STORED_MESSAGE_CONTENT_CHARS) return content;
  return `${content.slice(0, MAX_STORED_MESSAGE_CONTENT_CHARS)}\n[truncated for browser storage]`;
}

function sanitizeRemediationMessageForStorage(message: ScanMessage): ScanMessage {
  const content = String(message.content || '');
  if (message.type !== 'changed_files') {
    return { ...message, content: truncateStoredContent(content) };
  }
  if (content.length > MAX_STORED_MESSAGE_CONTENT_CHARS) {
    return { ...message, content: '[]' };
  }

  try {
    const payload = JSON.parse(content) as unknown;
    if (!Array.isArray(payload)) {
      return { ...message, content: '[]' };
    }
    const lightweight = payload
      .map((item) => {
        const entry = item && typeof item === 'object' ? item as Record<string, unknown> : {};
        const path = String(entry.path || '').trim();
        if (!path) return null;
        const reason = typeof entry.reason === 'string' ? entry.reason : undefined;
        return { path, reason, diff_omitted: true };
      })
      .filter(Boolean);
    return { ...message, content: JSON.stringify(lightweight) };
  } catch {
    return { ...message, content: '[]' };
  }
}

function sanitizeRemediationMessagesForStorage(messages: ScanMessage[]): ScanMessage[] {
  return trimMessageList(messages)
    .slice(-MAX_STORED_REMEDIATION_MESSAGES)
    .map(sanitizeRemediationMessageForStorage);
}

function clampRecordSize<T>(input: Record<string, T>): Record<string, T> {
  const entries = Object.entries(input || {});
  if (entries.length <= MAX_PROJECT_ENTRIES) return input || {};
  return Object.fromEntries(entries.slice(entries.length - MAX_PROJECT_ENTRIES));
}

function normalizeRemediationStatesForStorage(input: Record<string, ProjectRemediationState> | undefined): Record<string, ProjectRemediationState> {
  const out: Record<string, ProjectRemediationState> = {};
  for (const [projectId, state] of Object.entries(input || {})) {
    if (!projectId || !state) continue;
    out[projectId] = {
      state: state.state || 'idle',
      messages: sanitizeRemediationMessagesForStorage(Array.isArray(state.messages) ? state.messages : []),
    };
  }
  return clampRecordSize(out);
}

function readPersistedSnapshot(): PersistedScanContextSnapshot | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(SCAN_CONTEXT_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PersistedScanContextSnapshot;
  } catch {
    return null;
  }
}

export function ScanProvider({ children }: { children: React.ReactNode }) {
  // Keep the initial client render identical to the server render. Restoring
  // localStorage here would make a persisted scan state appear before React
  // hydrates and trigger a production hydration mismatch.
  const [scanStates, setScanStates] = useState<Record<string, ProjectScanState>>({});
  const [remediationStates, setRemediationStates] = useState<Record<string, ProjectRemediationState>>({});
  const [resultsCache, setResultsCache] = useState<Record<string, CachedScanResults>>({});
  const [storageHydrated, setStorageHydrated] = useState(false);
  const wsRefs = useRef<Record<string, WebSocket>>({});
  const remWsRefs = useRef<Record<string, WebSocket>>({});

  const trimMessages = useCallback((messages: ScanMessage[]) => {
    return trimMessageList(messages);
  }, []);

  const clampMapSize = useCallback(<T,>(input: Record<string, T>): Record<string, T> => {
    return clampRecordSize(input);
  }, []);

  const normalizeScanStates = useCallback((input: Record<string, ProjectScanState> | undefined) => {
    const out: Record<string, ProjectScanState> = {};
    for (const [projectId, state] of Object.entries(input || {})) {
      if (!projectId || !state) continue;
      out[projectId] = {
        state: state.state || 'idle',
        projectName: String(state.projectName || ''),
        messages: trimMessages(Array.isArray(state.messages) ? state.messages : []),
      };
    }
    return clampMapSize(out);
  }, [clampMapSize, trimMessages]);

  const normalizeRemediationStates = useCallback((input: Record<string, ProjectRemediationState> | undefined) => {
    const out: Record<string, ProjectRemediationState> = {};
    for (const [projectId, state] of Object.entries(input || {})) {
      if (!projectId || !state) continue;
      out[projectId] = {
        state: state.state || 'idle',
        messages: trimMessages(Array.isArray(state.messages) ? state.messages : []),
      };
    }
    return clampMapSize(out);
  }, [clampMapSize, trimMessages]);

  const normalizeResultsCache = useCallback((input: Record<string, CachedScanResults> | undefined) => {
    const out: Record<string, CachedScanResults> = {};
    for (const [projectId, cached] of Object.entries(input || {})) {
      if (!projectId || !cached) continue;
      out[projectId] = {
        status: cached.status || 'not_initiated',
        data: cached.data ?? null,
      };
    }
    return clampMapSize(out);
  }, [clampMapSize]);

  useEffect(() => {
    const restoreTimer = window.setTimeout(() => {
      const snapshot = readPersistedSnapshot();
      if (snapshot) {
        setScanStates(normalizeScanStates(snapshot.scanStates));
        setRemediationStates(normalizeRemediationStates(snapshot.remediationStates));
        setResultsCache(normalizeResultsCache(snapshot.resultsCache));
      }
      setStorageHydrated(true);
    }, 0);
    return () => window.clearTimeout(restoreTimer);
  }, [normalizeRemediationStates, normalizeResultsCache, normalizeScanStates]);

  useEffect(() => {
    if (!storageHydrated) return;
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== SCAN_CONTEXT_STORAGE_KEY) return;
      if (!event.newValue) {
        setScanStates({});
        setRemediationStates({});
        setResultsCache({});
        return;
      }
      try {
        const parsed = JSON.parse(event.newValue) as PersistedScanContextSnapshot;
        setScanStates(normalizeScanStates(parsed.scanStates));
        setRemediationStates(normalizeRemediationStates(parsed.remediationStates));
        setResultsCache(normalizeResultsCache(parsed.resultsCache));
      } catch {
        // Ignore malformed cross-tab updates.
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, [normalizeRemediationStates, normalizeResultsCache, normalizeScanStates, storageHydrated]);

  useEffect(() => {
    if (!storageHydrated) return;
    const snapshot: PersistedScanContextSnapshot = {
      scanStates: normalizeScanStates(scanStates),
      remediationStates: normalizeRemediationStatesForStorage(remediationStates),
      resultsCache: normalizeResultsCache(resultsCache),
    };

    try {
      localStorage.setItem(SCAN_CONTEXT_STORAGE_KEY, JSON.stringify(snapshot));
    } catch {
      // Fallback: keep statuses/messages, drop heavy result payloads if quota exceeded.
      try {
        const lightweight: PersistedScanContextSnapshot = {
          scanStates: snapshot.scanStates,
          remediationStates: snapshot.remediationStates,
          resultsCache: Object.fromEntries(
            Object.entries(snapshot.resultsCache || {}).map(([projectId, value]) => [
              projectId,
              { status: value.status, data: null },
            ]),
          ),
        };
        localStorage.setItem(SCAN_CONTEXT_STORAGE_KEY, JSON.stringify(lightweight));
      } catch {
        // No-op if storage is unavailable.
      }
    }
  }, [normalizeRemediationStates, normalizeResultsCache, normalizeScanStates, remediationStates, resultsCache, scanStates, storageHydrated]);

  // ── Scan ──

  const appendScanMessage = useCallback((projectId: string, message: ScanMessage) => {
    setScanStates(prev => {
      const existing = prev[projectId];
      if (!existing) return prev;
      return { ...prev, [projectId]: { ...existing, messages: trimMessages([...existing.messages, message]) } };
    });
  }, [trimMessages]);

  const updateScanStatus = useCallback((projectId: string, status: string) => {
    setScanStates(prev => {
      const existing = prev[projectId];
      if (!existing) return prev;
      return { ...prev, [projectId]: { ...existing, state: status as ScanState } };
    });
  }, []);

  const reconcileScanStatusAfterSocketClose = useCallback(async (projectId: string) => {
    try {
      const res = await fetch(`/api/scan/status?project_id=${encodeURIComponent(projectId)}`, { cache: 'no-store' });
      if (!res.ok) {
        updateScanStatus(projectId, 'error');
        return;
      }
      const payload = await res.json() as { status?: string };
      const status = String(payload.status || 'not_initiated');
      if (status === 'running') {
        updateScanStatus(projectId, 'running');
      } else if (status === 'found' || status === 'not_found') {
        updateScanStatus(projectId, 'completed');
      } else if (status === 'error') {
        updateScanStatus(projectId, 'error');
      } else {
        setScanStates(prev => {
          const existing = prev[projectId];
          if (!existing) return prev;
          if (existing.state !== 'running') return prev;
          const nextMessages = trimMessages([
            ...existing.messages,
            {
              index: existing.messages.length + 1,
              total: 0,
              type: 'error',
              content: 'Scan connection closed before the backend reported progress. Please retry once.',
              timestamp: new Date().toISOString(),
            },
          ]);
          return {
            ...prev,
            [projectId]: {
              ...existing,
              state: 'error',
              messages: nextMessages,
            },
          };
        });
      }
    } catch {
      updateScanStatus(projectId, 'error');
    }
  }, [trimMessages, updateScanStatus]);

  const startScan = useCallback(async (projectId: string, projectName: string) => {
    const existingWs = wsRefs.current[projectId];
    if (existingWs && existingWs.readyState === WebSocket.OPEN) existingWs.close();

    setScanStates(prev => ({
      ...prev,
      [projectId]: { state: 'running', messages: [], projectName },
    }));

    // Invalidate cached results so post-scan fetch gets fresh data
    setResultsCache(prev => {
      const next = { ...prev };
      delete next[projectId];
      return next;
    });

    // Reset any prior remediation state so stale remediationDone=true doesn't
    // interfere with rendering the new scan's results or terminal.
    setRemediationStates(prev => {
      if (!prev[projectId]) return prev;
      const next = { ...prev };
      delete next[projectId];
      return next;
    });

    try {
      const wsBaseUrl = await resolveWsBaseUrl();
      const wsToken = await fetchWsToken(projectId);
      wsRefs.current[projectId] = connectWebSocket(
        wsBaseUrl,
        '/ws/scan', projectId,
        appendScanMessage,
        updateScanStatus,
        (id, detail) => {
          appendScanMessage(id, {
            index: Date.now(),
            total: Date.now(),
            type: 'error',
            content: detail || 'Failed to connect to the live scan stream.',
            timestamp: new Date().toISOString(),
          });
          updateScanStatus(id, 'error');
        },
        (id) => {
          // Reconcile with backend status to avoid false failures when the WS drops
          // during server restarts/reloads while scan workers may still be running.
          void reconcileScanStatusAfterSocketClose(id);
          delete wsRefs.current[id];
        },
        wsToken,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Failed to connect to the live scan stream.';
      appendScanMessage(projectId, {
        index: Date.now(),
        total: Date.now(),
        type: 'error',
        content: detail,
        timestamp: new Date().toISOString(),
      });
      updateScanStatus(projectId, 'error');
      throw error;
    }
  }, [appendScanMessage, reconcileScanStatusAfterSocketClose, updateScanStatus]);

  const getScanState = useCallback((projectId: string): ProjectScanState => {
    return scanStates[projectId] || { state: 'idle', messages: [], projectName: '' };
  }, [scanStates]);

  const activeScanIds = useMemo(() => {
    return Object.entries(scanStates)
      .filter(([, s]) => s.state === 'running')
      .map(([id]) => id);
  }, [scanStates]);

  // ── Remediation ──

  const appendRemediationMessage = useCallback((projectId: string, message: ScanMessage) => {
    setRemediationStates(prev => {
      const existing = prev[projectId];
      if (!existing) return prev;
      return { ...prev, [projectId]: { ...existing, messages: trimMessages([...existing.messages, message]) } };
    });
  }, [trimMessages]);

  const updateRemediationStatus = useCallback((projectId: string, status: string) => {
    setRemediationStates(prev => {
      const existing = prev[projectId];
      if (!existing) return prev;
      return { ...prev, [projectId]: { ...existing, state: status as RemediationState } };
    });
  }, []);

  const startRemediation = useCallback(async (
    projectId: string,
    githubToken?: string,
    llmProvider?: string,
    llmApiKey?: string,
    llmModel?: string,
    remediationScope: 'major' | 'all' = 'all',
  ) => {
    const existingRemWs = remWsRefs.current[projectId];
    if (existingRemWs && existingRemWs.readyState === WebSocket.OPEN) existingRemWs.close();

    setRemediationStates(prev => ({
      ...prev,
      [projectId]: { state: 'running', messages: [] },
    }));

    try {
      const res = await fetch('/api/remediate/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: projectId,
          github_token: githubToken || null,
          llm_provider: llmProvider || null,
          llm_api_key: llmApiKey || null,
          llm_model: llmModel || null,
          remediation_scope: remediationScope,
        }),
      });
      if (!res.ok) {
        let detail = 'Failed to start remediation.';
        try {
          const payload = await res.json();
          if (typeof payload?.error === 'string' && payload.error.trim()) detail = payload.error.trim();
        } catch {
          // ignore body parse failures
        }
        appendRemediationMessage(projectId, {
          index: Date.now(),
          total: Date.now(),
          type: 'error',
          content: detail,
          timestamp: new Date().toISOString(),
        });
        updateRemediationStatus(projectId, 'error');
        return;
      }
    } catch (error) {
      appendRemediationMessage(projectId, {
        index: Date.now(),
        total: Date.now(),
        type: 'error',
        content: error instanceof Error ? error.message : 'Failed to start remediation.',
        timestamp: new Date().toISOString(),
      });
      updateRemediationStatus(projectId, 'error');
      return;
    }

    try {
      const wsBaseUrl = await resolveWsBaseUrl();
      const wsToken = await fetchWsToken(projectId);
      remWsRefs.current[projectId] = connectWebSocket(
        wsBaseUrl,
        '/ws/remediate', projectId,
        appendRemediationMessage,
        updateRemediationStatus,
        (id, detail) => {
          if (detail) {
            appendRemediationMessage(id, {
              index: Date.now(),
              total: Date.now(),
              type: 'error',
              content: detail,
              timestamp: new Date().toISOString(),
            });
          }
          updateRemediationStatus(id, 'error');
        },
        (id, detail) => {
          // If WS closes while remediation is still running, mark as error
          setRemediationStates(prev => {
            const cur = prev[id];
            if (cur && !['completed', 'error', 'idle'].includes(cur.state)) {
              const reason = detail?.reason?.trim();
              const message = reason
                ? `WebSocket closed unexpectedly (${detail?.code || 1006}): ${reason}`
                : `WebSocket closed unexpectedly (${detail?.code || 1006}).`;
              const alreadyLogged = cur.messages.some((entry) => entry.type === 'error' && entry.content === message);
              return {
                ...prev,
                [id]: {
                  ...cur,
                  state: 'error',
                  messages: alreadyLogged
                    ? cur.messages
                    : trimMessages([
                        ...cur.messages,
                        {
                          index: Date.now(),
                          total: Date.now(),
                          type: 'error',
                          content: message,
                          timestamp: new Date().toISOString(),
                        },
                      ]),
                },
              };
            }
            return prev;
          });
          delete remWsRefs.current[id];
        },
        wsToken,
      );
    } catch (error) {
      appendRemediationMessage(projectId, {
        index: Date.now(),
        total: Date.now(),
        type: 'error',
        content: error instanceof Error ? error.message : 'Failed to connect remediation log stream.',
        timestamp: new Date().toISOString(),
      });
      updateRemediationStatus(projectId, 'error');
    }
  }, [appendRemediationMessage, trimMessages, updateRemediationStatus]);

  const continueRemediationRound = useCallback((projectId: string) => {
    const ws = remWsRefs.current[projectId];
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ action: 'continue_round' }));
  }, []);

  const pushCurrentRemediationChanges = useCallback((projectId: string) => {
    const ws = remWsRefs.current[projectId];
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ action: 'push_current' }));
  }, []);

  const approveRemediationPush = useCallback((projectId: string) => {
    const ws = remWsRefs.current[projectId];
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ action: 'approve_push' }));
  }, []);

  const getRemediationState = useCallback((projectId: string): ProjectRemediationState => {
    return remediationStates[projectId] || { state: 'idle', messages: [] };
  }, [remediationStates]);

  const isAnyRemediating = useMemo(() => {
    return Object.values(remediationStates).some(s => s.state === 'running');
  }, [remediationStates]);

  const activeRemediationIds = useMemo(() => {
    return Object.entries(remediationStates)
      .filter(([, s]) => s.state === 'running')
      .map(([id]) => id);
  }, [remediationStates]);

  // ── Results Cache ──

  const getCachedResults = useCallback((projectId: string): CachedScanResults | null => {
    return resultsCache[projectId] || null;
  }, [resultsCache]);

  const setCachedResults = useCallback((projectId: string, results: CachedScanResults) => {
    setResultsCache(prev => ({ ...prev, [projectId]: results }));
  }, []);

  // ── Reset ──

  const closeAllWebSockets = useCallback(() => {
    Object.values(wsRefs.current).forEach(ws => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    });
    Object.values(remWsRefs.current).forEach(ws => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    });
    wsRefs.current = {};
    remWsRefs.current = {};
  }, []);

  // Cleanup all WebSockets on unmount
  useEffect(() => {
    return () => closeAllWebSockets();
  }, [closeAllWebSockets]);

  const resetAll = useCallback(() => {
    closeAllWebSockets();
    setScanStates({});
    setRemediationStates({});
    setResultsCache({});
    try {
      localStorage.removeItem(SCAN_CONTEXT_STORAGE_KEY);
    } catch {
      // Ignore local storage failures.
    }
  }, [closeAllWebSockets]);

  const resetRemediation = useCallback((projectId: string) => {
    const ws = remWsRefs.current[projectId];
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) ws.close();
    delete remWsRefs.current[projectId];
    setRemediationStates(prev => {
      const next = { ...prev };
      delete next[projectId];
      return next;
    });
    // Keep resultsCache intact — it holds post-remediation results that Findings
    // should continue serving until the next explicit scan clears it.
  }, []);

  const value = useMemo<ScanContextValue>(() => ({
    startScan,
    getScanState,
    activeScanIds,
    resetAll,
    startRemediation,
    continueRemediationRound,
    pushCurrentRemediationChanges,
    approveRemediationPush,
    getRemediationState,
    resetRemediation,
    isAnyRemediating,
    activeRemediationIds,
    getCachedResults,
    setCachedResults,
  }), [startScan, getScanState, activeScanIds, resetAll, startRemediation, continueRemediationRound, pushCurrentRemediationChanges, approveRemediationPush, getRemediationState, resetRemediation, isAnyRemediating, activeRemediationIds, getCachedResults, setCachedResults]);

  return (
    <ScanContext.Provider value={value}>
      {children}
    </ScanContext.Provider>
  );
}
