'use client';

import { createContext, useContext, useState, useRef, useCallback, useMemo, useEffect } from 'react';

const WS_BASE_URL = process.env.NEXT_PUBLIC_AGENTIC_WS_URL || 'ws://localhost:8000';
const SCAN_CONTEXT_STORAGE_KEY = 'deplai.scan-context.v1';
const MAX_PROJECT_ENTRIES = 40;
const MAX_MESSAGES_PER_PROJECT = 500;

type OperationState = 'idle' | 'running' | 'waiting_approval' | 'completed' | 'error';
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
    cortexContext?: string,
    githubToken?: string,
    llmProvider?: string,
    llmApiKey?: string,
    llmModel?: string,
    remediationScope?: 'major' | 'all',
  ) => Promise<void>;
  approveRemediationRescan: (projectId: string) => void;
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
  try {
    const res = await fetch(`/api/scan/ws-token?project_id=${encodeURIComponent(projectId)}`);
    if (!res.ok) return '';
    const data = await res.json();
    return data.token || '';
  } catch {
    return '';
  }
}

function connectWebSocket(
  path: string,
  projectId: string,
  onMessage: (projectId: string, msg: ScanMessage) => void,
  onStatus: (projectId: string, status: string) => void,
  onError: (projectId: string) => void,
  onClose: (projectId: string) => void,
  wsToken: string,
): WebSocket {
  const base = `${WS_BASE_URL}${path}/${projectId}`;
  const ws = new WebSocket(wsToken ? `${base}?token=${encodeURIComponent(wsToken)}` : base);

  ws.onopen = () => {
    ws.send(JSON.stringify({ action: 'start' }));
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    switch (data.type) {
      case 'message':
        onMessage(projectId, data.data as ScanMessage);
        break;
      case 'status':
        if (['running', 'waiting_approval', 'completed', 'error'].includes(data.status)) {
          onStatus(projectId, data.status);
        }
        break;
    }
  };

  ws.onerror = (event) => { console.error('WebSocket error:', event); onError(projectId); };
  ws.onclose = () => onClose(projectId);

  return ws;
}

export function ScanProvider({ children }: { children: React.ReactNode }) {
  const [scanStates, setScanStates] = useState<Record<string, ProjectScanState>>({});
  const [remediationStates, setRemediationStates] = useState<Record<string, ProjectRemediationState>>({});
  const [resultsCache, setResultsCache] = useState<Record<string, CachedScanResults>>({});
  const wsRefs = useRef<Record<string, WebSocket>>({});
  const remWsRefs = useRef<Record<string, WebSocket>>({});

  const trimMessages = useCallback((messages: ScanMessage[]) => {
    if (!Array.isArray(messages)) return [];
    return messages.slice(-MAX_MESSAGES_PER_PROJECT);
  }, []);

  const clampMapSize = useCallback(<T,>(input: Record<string, T>): Record<string, T> => {
    const entries = Object.entries(input || {});
    if (entries.length <= MAX_PROJECT_ENTRIES) return input || {};
    return Object.fromEntries(entries.slice(entries.length - MAX_PROJECT_ENTRIES));
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
    try {
      const raw = localStorage.getItem(SCAN_CONTEXT_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as PersistedScanContextSnapshot;
      setScanStates(normalizeScanStates(parsed.scanStates));
      setRemediationStates(normalizeRemediationStates(parsed.remediationStates));
      setResultsCache(normalizeResultsCache(parsed.resultsCache));
    } catch {
      // Ignore corrupted client cache.
    }
  }, [normalizeRemediationStates, normalizeResultsCache, normalizeScanStates]);

  useEffect(() => {
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
  }, [normalizeRemediationStates, normalizeResultsCache, normalizeScanStates]);

  useEffect(() => {
    const snapshot: PersistedScanContextSnapshot = {
      scanStates: normalizeScanStates(scanStates),
      remediationStates: normalizeRemediationStates(remediationStates),
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
  }, [normalizeRemediationStates, normalizeResultsCache, normalizeScanStates, remediationStates, resultsCache, scanStates]);

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

    const wsToken = await fetchWsToken(projectId);
    wsRefs.current[projectId] = connectWebSocket(
      '/ws/scan', projectId,
      appendScanMessage,
      updateScanStatus,
      (id) => updateScanStatus(id, 'error'),
      (id) => {
        // If WS closes while scan is still running, mark as error so UI doesn't get stuck
        setScanStates(prev => {
          const cur = prev[id];
          if (cur && cur.state === 'running') {
            return { ...prev, [id]: { ...cur, state: 'error' } };
          }
          return prev;
        });
        delete wsRefs.current[id];
      },
      wsToken,
    );
  }, [appendScanMessage, updateScanStatus]);

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
    cortexContext?: string,
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
          cortex_context: cortexContext || null,
          github_token: githubToken || null,
          llm_provider: llmProvider || null,
          llm_api_key: llmApiKey || null,
          llm_model: llmModel || null,
          remediation_scope: remediationScope,
        }),
      });
      if (!res.ok) {
        updateRemediationStatus(projectId, 'error');
        return;
      }
    } catch {
      updateRemediationStatus(projectId, 'error');
      return;
    }

    const wsToken = await fetchWsToken(projectId);
    remWsRefs.current[projectId] = connectWebSocket(
      '/ws/remediate', projectId,
      appendRemediationMessage,
      updateRemediationStatus,
      (id) => updateRemediationStatus(id, 'error'),
      (id) => {
        // If WS closes while remediation is still running, mark as error
        setRemediationStates(prev => {
          const cur = prev[id];
          if (cur && cur.state === 'running') {
            return { ...prev, [id]: { ...cur, state: 'error' } };
          }
          return prev;
        });
        delete remWsRefs.current[id];
      },
      wsToken,
    );
  }, [appendRemediationMessage, updateRemediationStatus]);

  const approveRemediationRescan = useCallback((projectId: string) => {
    const ws = remWsRefs.current[projectId];
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ action: 'approve_rescan' }));
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
    approveRemediationRescan,
    getRemediationState,
    resetRemediation,
    isAnyRemediating,
    activeRemediationIds,
    getCachedResults,
    setCachedResults,
  }), [startScan, getScanState, activeScanIds, resetAll, startRemediation, approveRemediationRescan, getRemediationState, resetRemediation, isAnyRemediating, activeRemediationIds, getCachedResults, setCachedResults]);

  return (
    <ScanContext.Provider value={value}>
      {children}
    </ScanContext.Provider>
  );
}
