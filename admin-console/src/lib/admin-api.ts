'use client';

function getCsrfToken(): string | null {
  if (typeof document === 'undefined') return null;
  const names = ['deplai_admin_csrf', '__Host-deplai_admin_csrf'];
  for (const name of names) {
    const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=([^;]+)`));
    if (match) return decodeURIComponent(match[1]);
  }
  return null;
}

export type StepUpScope =
  | 'user.disable'
  | 'user.delete'
  | 'user.email_change'
  | 'user.revoke_sessions'
  | 'project.delete'
  | 'api_key.revoke_all'
  | 'refund.create'
  | 'subscription.cancel'
  | 'credits.adjust'
  | 'org.destructive'
  | 'owner.credentials';

export async function confirmStepUp(scope: StepUpScope, password?: string): Promise<void> {
  const value = password ?? (typeof window !== 'undefined' ? window.prompt('Confirm owner password for step-up') : null);
  if (!value) throw new Error('Step-up cancelled');
  await adminFetch('/api/auth/step-up', {
    method: 'POST',
    body: JSON.stringify({ password: value, scope }),
  });
}

export async function adminFetch<T>(input: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers || {});
  if (!headers.has('Content-Type') && init?.body) {
    headers.set('Content-Type', 'application/json');
  }
  const csrf = getCsrfToken();
  if (csrf && init?.method && init.method !== 'GET' && init.method !== 'HEAD') {
    headers.set('x-csrf-token', csrf);
  }

  const response = await fetch(input, { ...init, headers, credentials: 'same-origin' });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error((payload as { error?: string }).error || `Request failed (${response.status})`);
  }
  return payload as T;
}
