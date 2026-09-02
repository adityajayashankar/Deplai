'use client';

import { createContext, useContext, useState, useRef, useCallback, useMemo, useEffect } from 'react';
import { createWorkspaceSession, persistSessionProgress } from '@/lib/sessions/client';
import type { SessionLogLevel, SessionStatus } from '@/lib/sessions/types';
import {
  buildAgenticWebSocketUrl,
  isInternalHostname,
  isMixedContentWebSocket,
  normalizeAgenticWsBase,
  resolveAgenticWsBaseFromConfig,
  resolveBrowserAgenticWsBase,
  wsBaseMatchesHost,
} from '@/lib/agentic-websocket';

const WS_BASE_URL = (process.env.NEXT_PUBLIC_AGENTIC_WS_URL || '').trim();
const SCAN_CONTEXT_STORAGE_KEY = 'deplai.scan-context.v1';
const MAX_PROJECT_ENTRIES = 40;
const MAX_MESSAGES_PER_PROJECT = 500;
const MAX_STORED_REMEDIATION_MESSAGES = 160;
const MAX_STORED_MESSAGE_CONTENT_CHARS = 2_000;
const WEBSOCKET_CONNECT_TIMEOUT_MS = 15_000;

function scanMessageLevel(type: string): SessionLogLevel {
  if (type === 'error') return 'error';
  if (type === 'warning') return 'warn';
  return 'info';
}

function operationToSessionStatus(state: string): SessionStatus | null {
  if (state === 'running') return 'running';
  if (state === 'completed') return 'completed';
  if (state === 'error') return 'failed';
  if (state === 'waiting_decision' || state === 'waiting_approval') return 'needs_review';
  return null;
}

type OperationState = 'idle' | 'running' | 'waiting_decision' | 'waiting_approval' | 'completed' | 'error';
export type ScanState = OperationState;
export type RemediationState = OperationState;
export type VulnStatus = 'not_initiated' | 'found' | 'not_found';

export interface CachedScanResults {
  status: VulnStatus;
  data: unknown;
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
  startScan: (projectId: string, projectName: string, options?: { preserveRemediation?: boolean }) => Promise<void>;
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
    accessMode?: 'platform' | 'byok' | 'auto',
    llmCredentialId?: string,
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

async function resolveWsBaseUrl(): Promise<string> {
  if (typeof window !== 'undefined') {
    const browser = { protocol: window.location.protocol, host: window.location.host };
    const browserHostname = browser.host.split(':')[0] || '';

    // Server-side env is authoritative for local dev (avoids stale NEXT_PUBLIC bundles).
    if (isInternalHostname(browserHostname)) {
      try {
        const res = await fetch('/api/pipeline/ws-config', { cache: 'no-store' });
        if (res.ok) {
          const data = await res.json() as { ws_base?: string };
          const fromServer = normalizeAgenticWsBase(String(data.ws_base || '').trim());
          if (fromServer && !isMixedContentWebSocket(fromServer, browser.protocol)) {
            resolvedWsBaseCache = fromServer;
            return fromServer;
          }
        }
      } catch {
        // Fall through to client-side resolution.
      }
    }

    const direct = resolveBrowserAgenticWsBase({ browser, publicEnvWsUrl: WS_BASE_URL });
    if (
      !resolvedWsBaseCache
      || resolvedWsBaseCache !== direct
      || !wsBaseMatchesHost(resolvedWsBaseCache, browser.host)
    ) {
      resolvedWsBaseCache = direct;
    }
    if (!isMixedContentWebSocket(resolvedWsBaseCache, browser.protocol)) {
      return resolvedWsBaseCache;
    }
  }

  if (
    resolvedWsBaseCache
    && typeof window !== 'undefined'
    && !isMixedContentWebSocket(resolvedWsBaseCache, window.location.protocol)
    && wsBaseMatchesHost(resolvedWsBaseCache, window.location.host)
  ) {
    return resolvedWsBaseCache;
  }
  if (wsBaseFetchInFlight) return wsBaseFetchInFlight;

  wsBaseFetchInFlight = (async () => {
    try {
      const res = await fetch('/api/pipeline/ws-config', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json() as { ws_base?: string };
        const fromServer = normalizeAgenticWsBase(String(data.ws_base || '').trim());
        if (
          fromServer
          && typeof window !== 'undefined'
          && !isMixedContentWebSocket(fromServer, window.location.protocol)
          && wsBaseMatchesHost(fromServer, window.location.host)
        ) {
          resolvedWsBaseCache = fromServer;
          return resolvedWsBaseCache;
        }
      }
    } catch {
      // ignore and fallback
    }
    resolvedWsBaseCache = resolveAgenticWsBaseFromConfig({
      publicEnvWsUrl: WS_BASE_URL,
      browser: typeof window !== 'undefined'
        ? { protocol: window.location.protocol, host: window.location.host }
        : undefined,
    });
    return resolvedWsBaseCache;
  })();

  try {
    return await wsBaseFetchInFlight;
  } finally {
    wsBaseFetchInFlight = null;
  }
}

function messagesIndicateSettledScan(messages: ScanMessage[]): boolean {
  const latest = new Map<string, string>();
  for (const message of messages) {
    if (message.type !== 'module') continue;
    try {
      const payload = JSON.parse(message.content) as { module?: string; status?: string };
      if (payload.module && payload.status) latest.set(payload.module, payload.status);
    } catch {
      // Ignore malformed live module payloads.
    }
  }
  if (latest.size === 0) return false;
  const terminal = new Set(['COMPLETED', 'FAILED', 'SKIPPED', 'CANCELLED', 'TIMED OUT']);
  const statuses = [...latest.values()];
  return statuses.every((status) => terminal.has(status))
    && statuses.some((status) => status === 'COMPLETED' || status === 'FAILED');
}

function connectWebSocket(
  wsBaseUrl: string,
  path: '/ws/scan' | '/ws/remediate' | '/ws/pipeline',
  projectId: string,
  onMessage: (projectId: string, msg: ScanMessage) => void,
  onStatus: (projectId: string, status: string) => void,
  onError: (projectId: string, error?: string) => void,
  onClose: (projectId: string, detail?: { code?: number; reason?: string }) => void,
  wsToken: string,
): WebSocket {
  const endpoint = path.replace('/ws/', '') as 'scan' | 'remediate' | 'pipeline';
  const wsUrl = buildAgenticWebSocketUrl(wsBaseUrl, endpoint, projectId, wsToken);
  const workflowLabel = endpoint === 'remediate' ? 'remediation' : endpoint === 'pipeline' ? 'pipeline' : 'scan';
  const ws = new WebSocket(wsUrl);
  let opened = false;
  let reportedError = false;
  let closeCode: number | undefined;
  let closeReason = '';
  const reportError = (detail: string) => {
    if (reportedError) return;
    reportedError = true;
    onError(projectId, detail);
  };
  const connectTimeout = window.setTimeout(() => {
    if (opened || ws.readyState !== WebSocket.CONNECTING) return;
    reportError(`The live ${workflowLabel} connection timed out. Verify the production WebSocket URL and reverse proxy, then retry.`);
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
          reportedError = true;
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
    window.setTimeout(() => {
      if (reportedError || opened) return;
      const suffix = closeReason ? ` ${closeReason}` : '';
      reportError(
        `WebSocket transport error while streaming ${workflowLabel} logs (${wsUrl.split('?')[0]}).` +
        ` Close code ${closeCode ?? 'unknown'}.${suffix}`,
      );
    }, 0);
  };
  ws.onclose = (event) => {
    window.clearTimeout(connectTimeout);
    closeCode = event.code;
    closeReason = event.reason?.trim() || '';
    if (!opened && !reportedError) {
      const suffix = closeReason ? ` ${closeReason}` : '';
      reportError(
        `WebSocket closed before the live ${workflowLabel} stream connected (${wsUrl.split('?')[0]}).` +
        ` Code ${event.code || 0}.${suffix}`,
      );
    }
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
  const securitySessionIdsRef = useRef<Record<string, string>>({});

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
      const restored = state.state || 'idle';
      const wasOrphanedRun = restored === 'running';
      out[projectId] = {
        // Restored "running" is leftover from a previous visit, not a live websocket.
        // Drop it so Security Agent opens idle until the user clicks Scan.
        state: wasOrphanedRun ? 'idle' : restored,
        projectName: String(state.projectName || ''),
        messages: wasOrphanedRun ? [] : trimMessages(Array.isArray(state.messages) ? state.messages : []),
      };
    }
    return clampMapSize(out);
  }, [clampMapSize, trimMessages]);

  const normalizeRemediationStates = useCallback((input: Record<string, ProjectRemediationState> | undefined) => {
    const out: Record<string, ProjectRemediationState> = {};
    const interruptedMessage = {
      index: Date.now(),
      total: Date.now(),
      type: 'error' as const,
      content: 'Remediation session was interrupted (page refresh or backend reload). Reset and start again from Agent setup.',
      timestamp: new Date().toISOString(),
    };
    for (const [projectId, state] of Object.entries(input || {})) {
      if (!projectId || !state) continue;
      const restored = state.state || 'idle';
      const wasLiveSession = ['running', 'waiting_decision', 'waiting_approval'].includes(restored);
      const messages = trimMessages(Array.isArray(state.messages) ? state.messages : []);
      out[projectId] = {
        state: wasLiveSession ? 'error' : restored,
        messages: wasLiveSession
          ? trimMessages([...messages, interruptedMessage])
          : messages,
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
    const sessionId = securitySessionIdsRef.current[projectId];
    if (sessionId && message.content) {
      persistSessionProgress(sessionId, {
        line: {
          level: scanMessageLevel(message.type),
          message: message.content,
          ts: message.timestamp,
          stage: 'scan',
        },
      });
    }
  }, [trimMessages]);

  const updateScanStatus = useCallback((projectId: string, status: string) => {
    setScanStates(prev => {
      const existing = prev[projectId];
      if (!existing) return prev;
      return { ...prev, [projectId]: { ...existing, state: status as ScanState } };
    });
    const sessionId = securitySessionIdsRef.current[projectId];
    const mapped = operationToSessionStatus(status);
    if (sessionId && mapped) {
      persistSessionProgress(sessionId, {
        status: mapped,
        current_stage: mapped === 'completed' ? 'results' : mapped === 'failed' ? 'scan' : 'scan',
        completed: mapped === 'completed' || mapped === 'failed',
      });
    }
  }, []);

  const reconcileScanStatusAfterSocketClose = useCallback(async (projectId: string) => {
    const markFromMessages = () => {
      setScanStates(prev => {
        const existing = prev[projectId];
        if (!existing) return prev;
        if (existing.state === 'completed') return prev;
        if (messagesIndicateSettledScan(existing.messages)) {
          return { ...prev, [projectId]: { ...existing, state: 'completed' } };
        }
        if (existing.state !== 'running') return prev;
        const alreadyLogged = existing.messages.some((entry) => (
          entry.type === 'error' && entry.content.includes('Scan connection closed before the backend reported progress')
        ));
        const closedMessage = 'Scan connection closed before the backend reported progress. Results stay available if this run already finished.';
        if (!alreadyLogged) {
          const sessionId = securitySessionIdsRef.current[projectId];
          if (sessionId) {
            persistSessionProgress(sessionId, {
              status: 'failed',
              current_stage: 'scan',
              completed: true,
              line: { level: 'error', message: closedMessage, stage: 'scan' },
            });
          }
        }
        const nextMessages = alreadyLogged ? existing.messages : trimMessages([
          ...existing.messages,
          {
            index: existing.messages.length + 1,
            total: 0,
            type: 'error',
            content: closedMessage,
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
    };

    try {
      const res = await fetch(`/api/scan/status?project_id=${encodeURIComponent(projectId)}`, { cache: 'no-store' });
      const payload = await res.json().catch(() => ({})) as { status?: string };
      const status = String(payload.status || (res.ok ? 'not_initiated' : 'error'));
      if (status === 'running') {
        updateScanStatus(projectId, 'running');
      } else if (status === 'found' || status === 'not_found') {
        updateScanStatus(projectId, 'completed');
      } else {
        markFromMessages();
      }
    } catch {
      markFromMessages();
    }
  }, [trimMessages, updateScanStatus]);

  const startScan = useCallback(async (
    projectId: string,
    projectName: string,
    options?: { preserveRemediation?: boolean },
  ) => {
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
    // Verification reruns after a PR keep remediation/PR state intact.
    if (!options?.preserveRemediation) {
      setRemediationStates(prev => {
        if (!prev[projectId]) return prev;
        const next = { ...prev };
        delete next[projectId];
        return next;
      });
    }

    try {
      const sessionId = await createWorkspaceSession({
        service: 'security_agent',
        project_id: projectId,
        title: `Security scan · ${projectName}`,
        repo: projectName,
        status: 'running',
        current_stage: 'scan',
      });
      if (sessionId) securitySessionIdsRef.current[projectId] = sessionId;
      const wsBaseUrl = await resolveWsBaseUrl();
      const wsToken = await fetchWsToken(projectId);
      appendScanMessage(projectId, {
        index: Date.now(),
        total: Date.now(),
        type: 'info',
        content: `Connecting to the live scanner at ${buildAgenticWebSocketUrl(wsBaseUrl, 'scan', projectId).split('?')[0]}…`,
        timestamp: new Date().toISOString(),
      });
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
    const sessionId = securitySessionIdsRef.current[projectId];
    if (sessionId && message.content && message.type !== 'changed_files') {
      persistSessionProgress(sessionId, {
        line: {
          level: scanMessageLevel(message.type),
          message: message.content,
          ts: message.timestamp,
          stage: 'remediate_run',
        },
      });
    }
  }, [trimMessages]);

  const updateRemediationStatus = useCallback((projectId: string, status: string) => {
    setRemediationStates(prev => {
      const existing = prev[projectId];
      if (!existing) return prev;
      return { ...prev, [projectId]: { ...existing, state: status as RemediationState } };
    });
    const sessionId = securitySessionIdsRef.current[projectId];
    const mapped = operationToSessionStatus(status);
    if (sessionId && mapped) {
      const stage = mapped === 'needs_review'
        ? 'approval'
        : mapped === 'completed'
          ? 'pr_rescan'
          : 'remediate_run';
      persistSessionProgress(sessionId, {
        status: mapped,
        current_stage: stage,
        completed: mapped === 'completed' || mapped === 'failed',
      });
    }
  }, []);

  const startRemediation = useCallback(async (
    projectId: string,
    githubToken?: string,
    llmProvider?: string,
    llmApiKey?: string,
    llmModel?: string,
    remediationScope: 'major' | 'all' = 'major',
    accessMode: 'platform' | 'byok' | 'auto' = 'auto',
    llmCredentialId?: string,
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
          llm_access_mode: accessMode || 'auto',
          llm_credential_id: llmCredentialId || null,
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
      const startPayload = await res.json().catch(() => ({})) as { workspace_session_id?: string };
      const remSessionId = typeof startPayload.workspace_session_id === 'string'
        ? startPayload.workspace_session_id
        : securitySessionIdsRef.current[projectId];
      if (remSessionId) {
        securitySessionIdsRef.current[projectId] = remSessionId;
        persistSessionProgress(remSessionId, {
          status: 'running',
          current_stage: 'remediate_run',
          line: { level: 'info', message: 'Remediation started.', stage: 'remediate_run' },
        });
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
          // A browser/proxy can drop the WebSocket (often code 1006) while the
          // server continues the remediation. Keep the UI recoverable and ask
          // the authenticated status endpoint for the durable server truth.
          setRemediationStates(prev => {
            const cur = prev[id];
            if (cur && !['completed', 'error', 'idle'].includes(cur.state)) {
              const reason = detail?.reason?.trim();
              const message = reason
                ? `Live log connection closed (${detail?.code || 1006}): ${reason}. Checking server-side remediation status…`
                : `Live log connection closed (${detail?.code || 1006}). Checking server-side remediation status…`;
              const alreadyLogged = cur.messages.some((entry) => entry.type === 'warning' && entry.content === message);
              return {
                ...prev,
                [id]: {
                  ...cur,
                  state: 'running',
                  messages: alreadyLogged
                    ? cur.messages
                    : trimMessages([
                        ...cur.messages,
                        {
                          index: Date.now(),
                          total: Date.now(),
                          type: 'warning',
                          content: message,
                          timestamp: new Date().toISOString(),
                        },
                      ]),
                },
              };
            }
            return prev;
          });
          void fetch(`/api/remediate/status/${encodeURIComponent(id)}`, { cache: 'no-store' })
            .then(async (response) => {
              if (!response.ok) return null;
              return response.json() as Promise<{
                run?: { status?: string };
                events?: Array<{ sequence?: number; type?: string; content?: string; created_at?: string }>;
              }>;
            })
            .then((payload) => {
              const rawStatus = String(payload?.run?.status || '');
              const recoveredState: RemediationState | null = rawStatus === 'failed'
                ? 'error'
                : ['running', 'waiting_decision', 'waiting_approval', 'completed', 'error'].includes(rawStatus)
                  ? rawStatus as RemediationState
                  : null;
              if (!recoveredState) return;
              setRemediationStates(prev => {
                const current = prev[id];
                if (!current) return prev;
                const recoveredMessages = (payload?.events || [])
                  .filter((event) => event.content && event.type !== 'changed_files')
                  .map((event, offset) => ({
                    index: Number(event.sequence || Date.now() + offset),
                    total: Date.now(),
                    type: String(event.type || 'info'),
                    content: String(event.content),
                    timestamp: String(event.created_at || new Date().toISOString()),
                  })) as ScanMessage[];
                const known = new Set(current.messages.map((event) => `${event.type}:${event.content}`));
                const newMessages = recoveredMessages.filter((event) => !known.has(`${event.type}:${event.content}`));
                return {
                  ...prev,
                  [id]: {
                    ...current,
                    state: recoveredState,
                    messages: trimMessages([...current.messages, ...newMessages]),
                  },
                };
              });
              updateRemediationStatus(id, recoveredState);
            })
            .catch(() => {
              // The warning above already tells the user how to recover. Do
              // not convert a transport hiccup into a false remediation fail.
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
