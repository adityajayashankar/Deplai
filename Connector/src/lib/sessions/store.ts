import { randomBytes } from 'node:crypto';
import { query } from '@/lib/db';
import {
  isSessionLogLevel,
  isSessionService,
  isSessionStatus,
  type SessionListQuery,
  type SessionLogLevel,
  type SessionService,
  type SessionStatus,
  type WorkspaceSession,
  type WorkspaceSessionLog,
} from './types';

const SESSION_ID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

type SessionRow = {
  id: string;
  user_id: string;
  project_id: string | null;
  service: string;
  title: string;
  repo: string | null;
  status: string;
  current_stage: string | null;
  started_at: Date | string;
  completed_at: Date | string | null;
  changed_files_count: number | string | null;
  triggered_by: string;
  external_id: string | null;
  metadata_json: string | Record<string, unknown> | null;
};

type LogRow = {
  id: string;
  session_id: string;
  ts: Date | string;
  level: string;
  message: string;
  stage: string | null;
};

type CountRow = { n: number | string };

export type CreateSessionInput = {
  userId: string;
  projectId?: string | null;
  service: SessionService;
  title: string;
  repo?: string | null;
  status?: SessionStatus;
  currentStage?: string | null;
  triggeredBy?: string;
  externalId?: string | null;
  metadata?: Record<string, unknown>;
  changedFilesCount?: number;
};

export type SessionPatch = {
  status?: SessionStatus;
  currentStage?: string | null;
  title?: string;
  repo?: string | null;
  changedFilesCount?: number;
  completedAt?: Date | string | null;
  externalId?: string | null;
  metadata?: Record<string, unknown>;
};

export type SessionLogInput = {
  level?: SessionLogLevel;
  message: string;
  ts?: Date | string;
  stage?: string | null;
};

const TABLES = [
  `CREATE TABLE IF NOT EXISTS workspace_sessions (
    id VARCHAR(40) PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL,
    project_id VARCHAR(36) NULL,
    service VARCHAR(32) NOT NULL,
    title VARCHAR(255) NOT NULL,
    repo VARCHAR(255) NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'running',
    current_stage VARCHAR(64) NULL,
    started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME NULL,
    changed_files_count INT NOT NULL DEFAULT 0,
    triggered_by VARCHAR(36) NOT NULL,
    external_id VARCHAR(191) NULL,
    metadata_json JSON NULL,
    INDEX idx_workspace_sessions_user_started (user_id, started_at),
    INDEX idx_workspace_sessions_user_service (user_id, service, started_at),
    INDEX idx_workspace_sessions_user_status (user_id, status),
    INDEX idx_workspace_sessions_project (user_id, project_id, started_at),
    INDEX idx_workspace_sessions_external (user_id, service, external_id),
    CONSTRAINT fk_workspace_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS workspace_session_logs (
    id VARCHAR(40) PRIMARY KEY,
    session_id VARCHAR(40) NOT NULL,
    ts TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    level VARCHAR(16) NOT NULL DEFAULT 'info',
    message TEXT NOT NULL,
    stage VARCHAR(64) NULL,
    INDEX idx_workspace_session_logs_session_ts (session_id, ts),
    CONSTRAINT fk_workspace_session_logs_session FOREIGN KEY (session_id) REFERENCES workspace_sessions(id) ON DELETE CASCADE
  )`,
];

let ready: Promise<void> | null = null;

function mintPrefixedId(prefix: string, length: number): string {
  const bytes = randomBytes(length);
  let out = prefix;
  for (const byte of bytes) {
    out += SESSION_ID_ALPHABET[byte % SESSION_ID_ALPHABET.length];
  }
  return out;
}

export function mintSessionId(): string {
  return mintPrefixedId('ses_', 27);
}

function mintLogId(): string {
  return mintPrefixedId('slg_', 24);
}

function toIso(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function toMysqlDateTime(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 23).replace('T', ' ');
  return date.toISOString().slice(0, 23).replace('T', ' ');
}

function parseMetadata(raw: SessionRow['metadata_json']): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function mapSession(row: SessionRow): WorkspaceSession {
  return {
    id: row.id,
    user_id: row.user_id,
    project_id: row.project_id,
    service: isSessionService(row.service) ? row.service : 'deploy',
    title: row.title,
    repo: row.repo,
    status: isSessionStatus(row.status) ? row.status : 'running',
    current_stage: row.current_stage,
    started_at: toIso(row.started_at) || new Date().toISOString(),
    completed_at: toIso(row.completed_at),
    changed_files_count: Number(row.changed_files_count || 0),
    triggered_by: row.triggered_by,
    external_id: row.external_id,
    metadata: parseMetadata(row.metadata_json),
  };
}

function mapLog(row: LogRow): WorkspaceSessionLog {
  return {
    id: row.id,
    session_id: row.session_id,
    ts: toIso(row.ts) || new Date().toISOString(),
    level: isSessionLogLevel(row.level) ? row.level : 'info',
    message: row.message,
    stage: row.stage,
  };
}

async function runEnsure(): Promise<void> {
  for (const statement of TABLES) {
    await query(statement);
  }
}

export async function ensureWorkspaceSessionsSchema(): Promise<void> {
  if (!ready) {
    ready = runEnsure().catch((error) => {
      ready = null;
      throw error;
    });
  }
  return ready;
}

function isTerminalStatus(status: SessionStatus): boolean {
  return status === 'completed' || status === 'failed';
}

export async function createSession(input: CreateSessionInput): Promise<WorkspaceSession> {
  await ensureWorkspaceSessionsSchema();
  const id = mintSessionId();
  const status = input.status && isSessionStatus(input.status) ? input.status : 'running';
  const triggeredBy = input.triggeredBy || input.userId;
  const completedAt = isTerminalStatus(status) ? toMysqlDateTime(new Date()) : null;
  await query(
    `INSERT INTO workspace_sessions (
      id, user_id, project_id, service, title, repo, status, current_stage,
      completed_at, changed_files_count, triggered_by, external_id, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.userId,
      input.projectId || null,
      input.service,
      String(input.title || 'Untitled session').slice(0, 255),
      input.repo ? String(input.repo).slice(0, 255) : null,
      status,
      input.currentStage ? String(input.currentStage).slice(0, 64) : null,
      completedAt,
      Number.isFinite(input.changedFilesCount) ? Number(input.changedFilesCount) : 0,
      triggeredBy,
      input.externalId ? String(input.externalId).slice(0, 191) : null,
      JSON.stringify(input.metadata || {}),
    ],
  );
  const created = await getSession(id);
  if (!created) {
    throw new Error('Failed to load workspace session after insert');
  }
  return created;
}

export async function tryCreateSession(input: CreateSessionInput): Promise<WorkspaceSession | null> {
  try {
    return await createSession(input);
  } catch (error) {
    console.error('[sessions] create failed', error);
    return null;
  }
}

export async function getSession(id: string): Promise<WorkspaceSession | null> {
  await ensureWorkspaceSessionsSchema();
  const rows = await query<SessionRow[]>(
    `SELECT id, user_id, project_id, service, title, repo, status, current_stage,
            started_at, completed_at, changed_files_count, triggered_by, external_id, metadata_json
     FROM workspace_sessions WHERE id = ? LIMIT 1`,
    [id],
  );
  return rows[0] ? mapSession(rows[0]) : null;
}

export async function getOwnedSession(id: string, userId: string): Promise<WorkspaceSession | null> {
  const session = await getSession(id);
  if (!session || session.user_id !== userId) return null;
  return session;
}

export async function findLatestSession(options: {
  userId: string;
  projectId?: string | null;
  service: SessionService;
  externalId?: string | null;
}): Promise<WorkspaceSession | null> {
  await ensureWorkspaceSessionsSchema();
  const params: unknown[] = [options.userId, options.service];
  let sql = `SELECT id, user_id, project_id, service, title, repo, status, current_stage,
                    started_at, completed_at, changed_files_count, triggered_by, external_id, metadata_json
             FROM workspace_sessions
             WHERE user_id = ? AND service = ?`;
  if (options.projectId) {
    sql += ' AND project_id = ?';
    params.push(options.projectId);
  }
  if (options.externalId) {
    sql += ' AND external_id = ?';
    params.push(options.externalId);
  }
  sql += ' ORDER BY started_at DESC LIMIT 1';
  const rows = await query<SessionRow[]>(sql, params);
  return rows[0] ? mapSession(rows[0]) : null;
}

export async function resolveOrCreateSession(
  existingId: string | null | undefined,
  input: CreateSessionInput,
): Promise<WorkspaceSession | null> {
  const incoming = String(existingId || '').trim();
  if (incoming) {
    const owned = await getOwnedSession(incoming, input.userId);
    if (owned) {
      try {
        return await updateSession(owned.id, {
          status: input.status,
          currentStage: input.currentStage,
          title: input.title,
          repo: input.repo || undefined,
          externalId: input.externalId || undefined,
        });
      } catch (error) {
        console.error('[sessions] update existing failed', error);
        return owned;
      }
    }
  }
  return tryCreateSession(input);
}

export async function updateSession(id: string, patch: SessionPatch): Promise<WorkspaceSession> {
  await ensureWorkspaceSessionsSchema();
  const current = await getSession(id);
  if (!current) {
    throw new Error('Session not found');
  }
  const nextStatus = patch.status && isSessionStatus(patch.status) ? patch.status : current.status;
  let completedAt: string | null = current.completed_at
    ? toMysqlDateTime(current.completed_at)
    : null;
  if (patch.completedAt === null) {
    completedAt = null;
  } else if (patch.completedAt) {
    completedAt = toMysqlDateTime(patch.completedAt);
  } else if (isTerminalStatus(nextStatus) && !completedAt) {
    completedAt = toMysqlDateTime(new Date());
  } else if (!isTerminalStatus(nextStatus)) {
    completedAt = null;
  }
  const metadata = patch.metadata
    ? { ...current.metadata, ...patch.metadata }
    : current.metadata;
  await query(
    `UPDATE workspace_sessions
     SET status = ?, current_stage = ?, title = ?, repo = ?, changed_files_count = ?,
         completed_at = ?, external_id = ?, metadata_json = ?
     WHERE id = ?`,
    [
      nextStatus,
      patch.currentStage !== undefined
        ? (patch.currentStage ? String(patch.currentStage).slice(0, 64) : null)
        : current.current_stage,
      patch.title ? String(patch.title).slice(0, 255) : current.title,
      patch.repo !== undefined
        ? (patch.repo ? String(patch.repo).slice(0, 255) : null)
        : current.repo,
      patch.changedFilesCount !== undefined
        ? Number(patch.changedFilesCount)
        : current.changed_files_count,
      completedAt,
      patch.externalId !== undefined
        ? (patch.externalId ? String(patch.externalId).slice(0, 191) : null)
        : current.external_id,
      JSON.stringify(metadata),
      id,
    ],
  );
  const updated = await getSession(id);
  if (!updated) {
    throw new Error('Failed to load workspace session after update');
  }
  return updated;
}

export async function tryUpdateSession(id: string, patch: SessionPatch): Promise<WorkspaceSession | null> {
  try {
    return await updateSession(id, patch);
  } catch (error) {
    console.error('[sessions] update failed', error);
    return null;
  }
}

export async function appendSessionLogs(
  sessionId: string,
  lines: SessionLogInput[],
): Promise<number> {
  await ensureWorkspaceSessionsSchema();
  const session = await getSession(sessionId);
  if (!session) return 0;
  let written = 0;
  for (const line of lines) {
    const message = String(line.message || '').trim();
    if (!message) continue;
    const level = line.level && isSessionLogLevel(line.level) ? line.level : 'info';
    await query(
      `INSERT INTO workspace_session_logs (id, session_id, ts, level, message, stage)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        mintLogId(),
        sessionId,
        line.ts ? toMysqlDateTime(line.ts) : toMysqlDateTime(new Date()),
        level,
        message.slice(0, 8000),
        line.stage ? String(line.stage).slice(0, 64) : null,
      ],
    );
    written += 1;
  }
  return written;
}

export async function tryAppendSessionLogs(
  sessionId: string,
  lines: SessionLogInput[],
): Promise<number> {
  try {
    return await appendSessionLogs(sessionId, lines);
  } catch (error) {
    console.error('[sessions] append logs failed', error);
    return 0;
  }
}

export async function listSessionLogs(sessionId: string, limit = 2000): Promise<WorkspaceSessionLog[]> {
  await ensureWorkspaceSessionsSchema();
  const safeLimit = Math.min(Math.max(Number(limit) || 2000, 1), 5000);
  const rows = await query<LogRow[]>(
    `SELECT id, session_id, ts, level, message, stage
     FROM workspace_session_logs
     WHERE session_id = ?
     ORDER BY ts ASC, id ASC
     LIMIT ${safeLimit}`,
    [sessionId],
  );
  return rows.map(mapLog);
}

export async function listSessions(
  userId: string,
  filters: SessionListQuery = {},
): Promise<{ sessions: WorkspaceSession[]; total: number; limit: number; offset: number }> {
  await ensureWorkspaceSessionsSchema();
  const limit = Math.min(Math.max(Number(filters.limit) || 20, 1), 100);
  const offset = Math.max(Number(filters.offset) || 0, 0);
  const clauses = ['user_id = ?'];
  const params: unknown[] = [userId];

  if (filters.service && isSessionService(filters.service)) {
    clauses.push('service = ?');
    params.push(filters.service);
  }
  if (filters.status && isSessionStatus(filters.status)) {
    clauses.push('status = ?');
    params.push(filters.status);
  }
  const search = String(filters.search || '').trim().slice(0, 80).replace(/[%_]/g, '');
  if (search) {
    clauses.push('(title LIKE ? OR id LIKE ? OR IFNULL(repo, \'\') LIKE ?)');
    const needle = `%${search}%`;
    params.push(needle, needle, needle);
  }

  const where = clauses.join(' AND ');
  const countRows = await query<CountRow[]>(
    `SELECT COUNT(*) AS n FROM workspace_sessions WHERE ${where}`,
    params,
  );
  const total = Number(countRows[0]?.n || 0);
  const rows = await query<SessionRow[]>(
    `SELECT id, user_id, project_id, service, title, repo, status, current_stage,
            started_at, completed_at, changed_files_count, triggered_by, external_id, metadata_json
     FROM workspace_sessions
     WHERE ${where}
     ORDER BY started_at DESC
     LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  return {
    sessions: rows.map(mapSession),
    total,
    limit,
    offset,
  };
}

export function mapUiuxRunStatus(
  status: string | undefined,
  requiresUserInput?: boolean,
): SessionStatus {
  const normalized = String(status || '').toUpperCase();
  if (requiresUserInput || normalized === 'PAUSED' || normalized === 'WAITING' || normalized === 'AWAITING_REVIEW') return 'needs_review';
  if (normalized === 'ERROR' || normalized === 'FAILED' || normalized === 'BLOCKED') return 'failed';
  if (normalized === 'COMPLETED' || normalized === 'SUCCESS' || normalized === 'DONE') return 'completed';
  if (normalized === 'QUEUED' || normalized === 'PENDING') return 'queued';
  return 'running';
}

export function isReusableSecuritySession(session: WorkspaceSession): boolean {
  if (session.service !== 'security_agent') return false;
  if (session.status === 'failed') return false;
  if (session.status === 'running' || session.status === 'needs_review' || session.status === 'queued') {
    return true;
  }
  if (session.status === 'completed') {
    const started = new Date(session.started_at).getTime();
    return Number.isFinite(started) && Date.now() - started < 7 * 24 * 60 * 60 * 1000;
  }
  return false;
}
