export const SESSION_SERVICES = [
  'security_agent',
  'uiux_customizer',
  'deploy',
  'code_reviewer',
] as const;

export type SessionService = (typeof SESSION_SERVICES)[number];

export const SESSION_STATUSES = [
  'queued',
  'running',
  'completed',
  'failed',
  'needs_review',
] as const;

export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const SESSION_LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export type SessionLogLevel = (typeof SESSION_LOG_LEVELS)[number];

export type WorkspaceSession = {
  id: string;
  user_id: string;
  project_id: string | null;
  service: SessionService;
  title: string;
  repo: string | null;
  status: SessionStatus;
  current_stage: string | null;
  started_at: string;
  completed_at: string | null;
  changed_files_count: number;
  triggered_by: string;
  external_id: string | null;
  metadata: Record<string, unknown>;
};

export type WorkspaceSessionLog = {
  id: string;
  session_id: string;
  ts: string;
  level: SessionLogLevel;
  message: string;
  stage: string | null;
};

export type SessionListQuery = {
  search?: string;
  service?: SessionService | '';
  status?: SessionStatus | '';
  limit?: number;
  offset?: number;
};

export function isSessionService(value: unknown): value is SessionService {
  return typeof value === 'string' && (SESSION_SERVICES as readonly string[]).includes(value);
}

export function isSessionStatus(value: unknown): value is SessionStatus {
  return typeof value === 'string' && (SESSION_STATUSES as readonly string[]).includes(value);
}

export function isSessionLogLevel(value: unknown): value is SessionLogLevel {
  return typeof value === 'string' && (SESSION_LOG_LEVELS as readonly string[]).includes(value);
}

export function serviceLabel(service: SessionService): string {
  switch (service) {
    case 'security_agent':
      return 'Security Agent';
    case 'uiux_customizer':
      return 'UI/UX customizer';
    case 'deploy':
      return 'Deploy';
    case 'code_reviewer':
      return 'Code Reviewer';
    default:
      return service;
  }
}

export function statusLabel(status: SessionStatus): string {
  switch (status) {
    case 'needs_review':
      return 'Needs review';
    case 'queued':
      return 'Queued';
    case 'running':
      return 'Running';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    default:
      return status;
  }
}
