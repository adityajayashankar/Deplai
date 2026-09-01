export const APPLY_UNREACHABLE_MESSAGE = 'Connector could not reach the deployment runtime service.';
export const APPLY_TIMEOUT_MESSAGE = 'Deployment runtime timed out before Terraform apply completed.';

function flattenErrorParts(err: unknown, depth = 0): string[] {
  if (depth > 4 || err == null) return [];
  if (typeof err === 'string') return err.trim() ? [err] : [];
  if (typeof err !== 'object') return [String(err)];
  const rec = err as { name?: unknown; message?: unknown; cause?: unknown };
  const parts: string[] = [];
  if (typeof rec.name === 'string' && rec.name.trim()) parts.push(rec.name);
  if (typeof rec.message === 'string' && rec.message.trim()) parts.push(rec.message);
  if ('cause' in rec) parts.push(...flattenErrorParts(rec.cause, depth + 1));
  return parts;
}

export function classifyUpstreamError(err: unknown): {
  error: string;
  hint: string;
  upstreamError: string;
} {
  const parts = flattenErrorParts(err);
  const raw = parts.join(' ') || (err instanceof Error ? err.message : String(err || 'unknown upstream error'));
  const lowered = raw.toLowerCase();

  if (
    lowered.includes('timeouterror')
    || lowered.includes('aborted due to timeout')
    || lowered.includes('timed out')
    || lowered.includes('timeout')
  ) {
    return {
      error: APPLY_TIMEOUT_MESSAGE,
      hint: 'The apply may still be in-flight. Check Connector logs and AWS console, then retry if nothing is active.',
      upstreamError: raw,
    };
  }
  if (
    lowered.includes('fetch failed')
    || lowered.includes('econnrefused')
    || lowered.includes('enotfound')
    || lowered.includes('network')
  ) {
    return {
      error: APPLY_UNREACHABLE_MESSAGE,
      hint: 'Verify AGENTIC_LAYER_URL is reachable from the Connector runtime and that the Agentic Layer service is healthy.',
      upstreamError: raw,
    };
  }

  return {
    error: 'Deployment runtime request failed before Terraform apply response was received.',
    hint: 'Check Connector and Agentic Layer logs for transport/proxy/server timeout issues.',
    upstreamError: raw,
  };
}

function detailsRecord(data: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!data?.details || typeof data.details !== 'object' || Array.isArray(data.details)) return null;
  return data.details as Record<string, unknown>;
}

export function applyLooksInFlight(result: Record<string, unknown> | null | undefined): boolean {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  const status = String(result.status || '').trim().toLowerCase();
  const details = detailsRecord(result);
  return Boolean(
    result.apply_accepted === true
    || details?.apply_still_running === true
    || status === 'running'
    || status === 'applying'
    || status === 'accepted',
  );
}

export function isApplyStillRunningResponse(
  httpStatus: number,
  data: Record<string, unknown> | null | undefined,
): boolean {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const status = String(data.status || '').trim().toLowerCase();
  const details = detailsRecord(data);
  const stillRunning = Boolean(
    data.apply_accepted === true
    || details?.apply_still_running === true
    || status === 'running'
    || status === 'accepted'
    || status === 'applying',
  );
  if (!stillRunning) return false;
  if (httpStatus === 202) return true;
  if ((httpStatus === 200 || httpStatus === 201) && data.success === true) return true;
  if (httpStatus === 504) return true;
  return false;
}

const TRANSPORT_FALSE_FAIL_RE =
  /could not reach the deployment runtime|deployment runtime timed out|fetch failed|econnrefused|enotfound|timed out|timeout|aborted due to timeout|apply is still running|still running|network/i;

export function isTransportFalseFailureMessage(message: string | null | undefined): boolean {
  return TRANSPORT_FALSE_FAIL_RE.test(String(message || ''));
}

export function isRecoverableApplyTransportError(
  httpStatus: number,
  data: Record<string, unknown> | null | undefined,
  thrownMessage?: string,
): boolean {
  if (isApplyStillRunningResponse(httpStatus, data)) return true;
  const details = detailsRecord(data);
  const blob = [
    data?.error,
    details?.hint,
    details?.upstream_error,
    thrownMessage,
  ].filter(Boolean).join(' ');
  if (!TRANSPORT_FALSE_FAIL_RE.test(blob)) return false;
  if (httpStatus === 0 || httpStatus === 502 || httpStatus === 503 || httpStatus === 504 || httpStatus === 500) {
    return true;
  }
  return /could not reach the deployment runtime|deployment runtime timed out|apply is still running/i.test(blob);
}

export function mergeAcceptedApplyResult(
  current: Record<string, unknown> | null | undefined,
  incoming?: Record<string, unknown> | null,
): Record<string, unknown> {
  const detailsCurrent = detailsRecord(current) || {};
  const detailsIncoming = detailsRecord(incoming) || {};
  const merged: Record<string, unknown> = {
    ...(current || {}),
    ...(incoming || {}),
    success: true,
    status: String(incoming?.status || current?.status || 'running'),
    apply_accepted: true,
    details: {
      ...detailsCurrent,
      ...detailsIncoming,
      apply_still_running: true,
    },
  };
  delete merged.error;
  return merged;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function splitLogTail(value: unknown): string[] {
  const text = String(value || '').trim();
  if (!text) return [];
  return text.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
}

/** Collect terraform apply log lines from status payloads, error bodies, or result details. */
export function extractApplyLogLines(payload: unknown): string[] {
  const root = asRecord(payload);
  if (!root) return [];

  const lines: string[] = [];
  const pushUnique = (candidate: unknown) => {
    for (const line of Array.isArray(candidate) ? candidate : splitLogTail(candidate)) {
      const text = String(line || '').trimEnd();
      if (!text || lines.includes(text)) continue;
      lines.push(text);
    }
  };

  pushUnique(root.logs);
  pushUnique(root.apply_logs);

  const details = detailsRecord(root) || asRecord(root.result);
  if (details) {
    pushUnique(details.logs);
    pushUnique(details.apply_logs);
    pushUnique(details.apply_log_tail);
    pushUnique(details.upstream_raw_response_tail);
  }

  const result = asRecord(root.result);
  if (result) {
    pushUnique(result.logs);
    const resultDetails = detailsRecord(result);
    if (resultDetails) {
      pushUnique(resultDetails.apply_log_tail);
      pushUnique(resultDetails.logs);
    }
  }

  return lines;
}
