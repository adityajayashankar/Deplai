import { getErrorMessage, parseJsonSafe } from './utils';
import type {
  CustomizationMode,
  DiffEntry,
  EngineLlmSelection,
  FrontendFileListing,
  FrontendRunView,
} from './types';

const ENGINE_BASE = '/api/customization/frontend-customization';

export async function startFrontendRun(input: {
  projectId: string;
  tenantId: string;
  goal: string;
  mode: CustomizationMode;
  selectedScreens?: string[];
  llm?: EngineLlmSelection | null;
}): Promise<FrontendRunView> {
  const response = await fetch(`${ENGINE_BASE}/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      project_id: input.projectId,
      tenant_id: input.tenantId,
      goal: input.goal,
      mode: input.mode,
      selected_screens: input.selectedScreens || [],
      llm_config: {
        access_mode: input.llm?.accessMode || 'auto',
        model: input.llm?.model || 'best',
        provider: input.llm?.provider || '',
      },
    }),
  });
  const payload = await parseJsonSafe<FrontendRunView & { error?: string; detail?: string }>(response);
  if (!response.ok || !payload?.run_id) {
    throw new Error(getErrorMessage(payload, 'Failed to start the frontend customization run.'));
  }
  return payload;
}

export async function readFrontendRun(runId: string): Promise<FrontendRunView> {
  const response = await fetch(`${ENGINE_BASE}/runs/${encodeURIComponent(runId)}`, { cache: 'no-store' });
  const payload = await parseJsonSafe<FrontendRunView & { error?: string; detail?: string }>(response);
  if (!response.ok || !payload) {
    throw new Error(getErrorMessage(payload, 'Failed to load the customization run.'));
  }
  return payload;
}

export async function continueFrontendRun(runId: string, input: {
  userInput?: Record<string, string>;
  confirmed?: boolean;
}): Promise<FrontendRunView> {
  const response = await fetch(`${ENGINE_BASE}/runs/${encodeURIComponent(runId)}/continue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_input: input.userInput || {}, confirmed: Boolean(input.confirmed) }),
  });
  const payload = await parseJsonSafe<FrontendRunView & { error?: string; detail?: string }>(response);
  if (!response.ok || !payload) {
    throw new Error(getErrorMessage(payload, 'Failed to continue the customization run.'));
  }
  return payload;
}

export async function restoreFrontendCheckpoint(runId: string, checkpointId: string): Promise<FrontendRunView> {
  const response = await fetch(`${ENGINE_BASE}/runs/${encodeURIComponent(runId)}/restore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ checkpoint_id: checkpointId }),
  });
  const payload = await parseJsonSafe<FrontendRunView & { error?: string; detail?: string }>(response);
  if (!response.ok || !payload) {
    throw new Error(getErrorMessage(payload, 'Failed to restore that checkpoint.'));
  }
  return payload;
}

export async function listFrontendFiles(runId: string): Promise<FrontendFileListing> {
  const response = await fetch(`${ENGINE_BASE}/runs/${encodeURIComponent(runId)}/files`, { cache: 'no-store' });
  const payload = await parseJsonSafe<FrontendFileListing & { error?: string }>(response);
  if (!response.ok || !payload) {
    throw new Error(getErrorMessage(payload, 'Failed to load changed files.'));
  }
  return payload;
}

export async function listFrontendDiffs(runId: string, file?: string): Promise<DiffEntry[]> {
  const query = file ? `?file=${encodeURIComponent(file)}` : '';
  const response = await fetch(`${ENGINE_BASE}/runs/${encodeURIComponent(runId)}/diff${query}`, { cache: 'no-store' });
  const payload = await parseJsonSafe<{ entries?: DiffEntry[]; error?: string }>(response);
  if (!response.ok || !payload) {
    throw new Error(getErrorMessage(payload, 'Failed to load diffs.'));
  }
  return Array.isArray(payload.entries) ? payload.entries : [];
}

export async function finalizeFrontendRun(runId: string, input: { projectId: string; tenantId: string }): Promise<Record<string, unknown>> {
  const response = await fetch(`${ENGINE_BASE}/runs/${encodeURIComponent(runId)}/finalize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: input.projectId, tenant_id: input.tenantId }),
  });
  const payload = await parseJsonSafe<Record<string, unknown> & { error?: string; detail?: string }>(response);
  if (!response.ok || !payload) {
    throw new Error(getErrorMessage(payload, 'Failed to finalize the customized repository.'));
  }
  return payload;
}

export function frontendZipUrl(runId: string): string {
  return `${ENGINE_BASE}/runs/${encodeURIComponent(runId)}/zip`;
}

export function isEngineBusy(status?: string): boolean {
  return status === 'queued' || status === 'running';
}
