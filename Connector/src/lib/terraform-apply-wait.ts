export const TERRAFORM_APPLY_POLL_TIMEOUT_MS = 55 * 60 * 1000;
export const TERRAFORM_APPLY_POLL_INTERVAL_MS = 5_000;

export type TerraformApplyStatusSnapshot = {
  status?: string;
  result?: Record<string, unknown> | null;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isTerminalTerraformApplyStatus(status: string | null | undefined): boolean {
  const value = String(status || '').trim().toLowerCase();
  return value === 'completed' || value === 'error' || value === 'awaiting_plan_confirmation';
}

export function terraformApplyNeedsPolling(payload: Record<string, unknown> | null | undefined): boolean {
  const status = String(payload?.status || '').trim().toLowerCase();
  return status === 'running' || status === 'accepted';
}

export async function waitForTerraformApplyResult(params: {
  fetchStatus: () => Promise<TerraformApplyStatusSnapshot>;
  timeoutMs?: number;
  intervalMs?: number;
  sleepFn?: (ms: number) => Promise<void>;
}): Promise<{
  status: string;
  result: Record<string, unknown> | null;
  timedOut: boolean;
}> {
  const timeoutMs = Math.max(1, params.timeoutMs ?? TERRAFORM_APPLY_POLL_TIMEOUT_MS);
  const intervalMs = Math.max(1, params.intervalMs ?? TERRAFORM_APPLY_POLL_INTERVAL_MS);
  const pause = params.sleepFn || sleep;
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 'idle';

  while (Date.now() < deadline) {
    try {
      const snapshot = await params.fetchStatus();
      lastStatus = String(snapshot.status || lastStatus || 'idle');
      const snapshotResult = snapshot.result && typeof snapshot.result === 'object'
        ? snapshot.result
        : null;
      if (isTerminalTerraformApplyStatus(lastStatus)) {
        return { status: lastStatus, result: snapshotResult, timedOut: false };
      }
      if (lastStatus === 'idle' && snapshotResult) {
        return { status: lastStatus, result: snapshotResult, timedOut: false };
      }
    } catch {
      // Apply is still in-flight when the long POST drops. Keep polling.
    }
    if (Date.now() >= deadline) break;
    await pause(intervalMs);
  }

  return { status: lastStatus, result: null, timedOut: true };
}
