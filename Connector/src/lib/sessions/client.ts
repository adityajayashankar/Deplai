'use client';

import type {
  SessionLogLevel,
  SessionService,
  SessionStatus,
} from './types';

type CreateClientSessionInput = {
  service: SessionService;
  project_id?: string | null;
  title: string;
  repo?: string | null;
  status?: SessionStatus;
  current_stage?: string | null;
  external_id?: string | null;
  metadata?: Record<string, unknown>;
};

type PersistLine = {
  level?: SessionLogLevel;
  message: string;
  ts?: string;
  stage?: string | null;
};

type PersistPayload = {
  lines?: PersistLine[];
  status?: SessionStatus;
  current_stage?: string | null;
  changed_files_count?: number;
  completed?: boolean;
};

type BufferEntry = {
  timer: ReturnType<typeof setTimeout> | null;
  payload: PersistPayload;
};

const buffers = new Map<string, BufferEntry>();
const FLUSH_MS = 280;

async function postJson(url: string, body: unknown): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      keepalive: true,
      body: JSON.stringify(body),
    });
    if (!response.ok) return null;
    return await response.json().catch(() => ({}));
  } catch {
    return null;
  }
}

export async function createWorkspaceSession(input: CreateClientSessionInput): Promise<string | null> {
  const payload = await postJson('/api/sessions', input);
  const session = payload?.session && typeof payload.session === 'object'
    ? payload.session as { id?: unknown }
    : null;
  return typeof session?.id === 'string' ? session.id : null;
}

function mergePayload(target: PersistPayload, incoming: PersistPayload): PersistPayload {
  const lines = [...(target.lines || []), ...(incoming.lines || [])].slice(-200);
  return {
    lines,
    status: incoming.status || target.status,
    current_stage: incoming.current_stage !== undefined ? incoming.current_stage : target.current_stage,
    changed_files_count: incoming.changed_files_count ?? target.changed_files_count,
    completed: incoming.completed || target.completed,
  };
}

function flushSession(sessionId: string): void {
  const entry = buffers.get(sessionId);
  if (!entry) return;
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  buffers.delete(sessionId);
  const body = entry.payload;
  if (!body.lines?.length && !body.status && body.current_stage === undefined && !body.completed) {
    return;
  }
  void postJson(`/api/sessions/${encodeURIComponent(sessionId)}/logs`, body);
}

export function persistSessionProgress(sessionId: string | null | undefined, incoming: PersistPayload & { line?: PersistLine }): void {
  const id = String(sessionId || '').trim();
  if (!id) return;
  const payload: PersistPayload = {
    lines: incoming.line ? [incoming.line, ...(incoming.lines || [])] : incoming.lines,
    status: incoming.status,
    current_stage: incoming.current_stage,
    changed_files_count: incoming.changed_files_count,
    completed: incoming.completed,
  };
  const existing = buffers.get(id);
  if (existing) {
    existing.payload = mergePayload(existing.payload, payload);
  } else {
    buffers.set(id, { timer: null, payload });
  }
  const next = buffers.get(id);
  if (!next) return;
  if (payload.completed || payload.status === 'completed' || payload.status === 'failed') {
    flushSession(id);
    return;
  }
  if (next.timer) clearTimeout(next.timer);
  next.timer = setTimeout(() => flushSession(id), FLUSH_MS);
}

export function finalizeWorkspaceSession(
  sessionId: string | null | undefined,
  patch: {
    status: SessionStatus;
    current_stage?: string | null;
    changed_files_count?: number;
    message?: string;
    level?: SessionLogLevel;
  },
): void {
  persistSessionProgress(sessionId, {
    status: patch.status,
    current_stage: patch.current_stage,
    changed_files_count: patch.changed_files_count,
    completed: true,
    line: patch.message
      ? { level: patch.level || (patch.status === 'failed' ? 'error' : 'info'), message: patch.message }
      : undefined,
  });
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    for (const id of [...buffers.keys()]) flushSession(id);
  });
}
