'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Copy,
  Database,
  Download,
  Loader2,
  LogOut,
  Mail,
} from 'lucide-react';
import { DEFAULT_PUBLIC_USER_SETTINGS, type PublicUserSettings } from '@/lib/user-settings';
import { COMPANY_CONTACTS, COMPANY_LEGAL_LINKS } from '@/lib/company-contact';
import { LOGIN_HREF } from '@/lib/auth-providers';
import { AppThemeToggle } from '@/features/workspace/AppThemeToggle';
import {
  appBtnInk,
  appBtnPaper,
  appInput,
  applyUserChrome,
  setProductTelemetryEnabled,
} from '@/features/workspace/theme';

type TabKey = 'contact' | 'preferences' | 'privacy' | 'session' | 'workspace';

type UserSettings = PublicUserSettings['user'];

type PublicSettings = PublicUserSettings;

type ServerConfig = {
  githubAppConfigured?: boolean;
  githubWebhookConfigured?: boolean;
  awsRuntimeConfigured?: boolean;
  sessionSecretConfigured?: boolean;
  serviceKeyConfigured?: boolean;
  cleanupEnabled?: boolean;
};

type SettingsResponse = {
  settings?: PublicSettings;
  serverConfig?: ServerConfig;
  access?: { canManageWorkspace?: boolean };
  updatedAt?: string | null;
  success?: boolean;
  error?: string;
};

type AuthUser = {
  id?: string;
  githubId?: number;
  login?: string;
  email?: string;
  name?: string;
  avatarUrl?: string;
};

const FIELD = appInput;

const DEFAULT_SETTINGS: PublicSettings = {
  ...DEFAULT_PUBLIC_USER_SETTINGS,
  integrations: {
    ...DEFAULT_PUBLIC_USER_SETTINGS.integrations,
    githubAppActive: false,
  },
};

const DEFAULT_SERVER_CONFIG: ServerConfig = {
  githubAppConfigured: false,
  githubWebhookConfigured: false,
  awsRuntimeConfigured: false,
  sessionSecretConfigured: false,
  serviceKeyConfigured: false,
  cleanupEnabled: false,
};

const SETTINGS_NAV: Array<{ id: TabKey; label: string; adminOnly?: boolean }> = [
  { id: 'contact', label: 'Contact info' },
  { id: 'preferences', label: 'Preferences' },
  { id: 'privacy', label: 'Privacy & data' },
  { id: 'session', label: 'Sign-in' },
  { id: 'workspace', label: 'Workspace', adminOnly: true },
];

const ELSEWHERE_LINKS = [
  { href: '/profile', label: 'Profile' },
  { href: '/dashboard/integrations', label: 'Integrations' },
  { href: '/dashboard/subscription', label: 'Subscription' },
  { href: '/dashboard/credits', label: 'Credits' },
  { href: '/dashboard/ai', label: 'BYOK keys' },
  { href: '/dashboard/usage', label: 'Usage' },
];

function formatTimestamp(value: string | null): string {
  if (!value) return 'Never';
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return 'Unknown';
  return new Date(parsed).toLocaleString();
}

function initialsFrom(name: string, fallback = 'D') {
  const trimmed = name.trim();
  if (!trimmed) return fallback;
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0][0] || ''}${parts[1][0] || ''}`.toUpperCase();
  }
  return trimmed.slice(0, 2).toUpperCase();
}

function SettingSection({
  title,
  description,
  badge,
  children,
}: {
  title: string;
  description?: string;
  badge?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="app-paper mb-6 bg-white text-black">
      <div className="flex items-start justify-between border-b border-black p-6">
        <div>
          <h3 className="text-base font-semibold text-black">{title}</h3>
          {description ? <p className="mt-1 text-sm text-neutral-600">{description}</p> : null}
        </div>
        {badge}
      </div>
      <div className="flex flex-col gap-6 p-6">{children}</div>
    </div>
  );
}

function SettingField({
  label,
  children,
  layout = 'horizontal',
}: {
  label: string;
  children: React.ReactNode;
  layout?: 'horizontal' | 'vertical';
}) {
  return (
    <div className={layout === 'horizontal' ? 'flex flex-col items-start justify-between gap-8 sm:flex-row' : 'flex flex-col gap-2'}>
      <label className={`shrink-0 text-sm font-medium text-black ${layout === 'horizontal' ? 'pt-2 sm:w-1/3' : ''}`}>{label}</label>
      <div className={layout === 'horizontal' ? 'w-full flex-1' : 'w-full'}>{children}</div>
    </div>
  );
}

function EditableToggle({ active, onToggle, disabled }: { active: boolean; onToggle: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      className={`h-5 w-10 rounded-none border-[3px] px-0.5 transition-all disabled:opacity-50 ${active ? 'border-black bg-black' : 'border-black bg-white'}`}
      aria-pressed={active}
    >
      <span className={`block h-3.5 w-3.5 rounded-none transition-all ${active ? 'translate-x-5 bg-white' : 'translate-x-0 bg-black'}`} />
    </button>
  );
}

function EnvStatus({ label, ok }: { label: string; ok: boolean }) {
  return (
    <div className="border-[3px] border-black bg-white px-3 py-2 text-sm">
      <p className="text-black">{label}</p>
      <p className="mt-1 text-xs text-zinc-500">{ok ? 'Configured' : 'Missing'}</p>
    </div>
  );
}

function CopyEmailButton({ email }: { email: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      className={appBtnPaper}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(email);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1600);
        } catch {
          setCopied(false);
        }
      }}
    >
      <Copy className="h-3.5 w-3.5" />
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

function ContactInfoTab() {
  return (
    <div>
      <div className="mb-8">
        <h2 className="text-2xl font-bold tracking-tight text-black">Contact info</h2>
        <p className="mt-1 text-sm text-zinc-500">How to reach Deplai. Your own name and email live on Profile.</p>
      </div>

      <SettingSection title="Inboxes" description="These are live mailto links. Pick the desk that matches what you need.">
        <div className="flex flex-col gap-3">
          {COMPANY_CONTACTS.map((contact) => (
            <div key={contact.email} className="flex flex-col gap-3 border-[3px] border-black bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-black">
                  {contact.label}
                  {contact.badge ? (
                    <span className="border-2 border-black bg-black px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white">
                      {contact.badge}
                    </span>
                  ) : null}
                </p>
                <p className="mt-1 text-[13px] text-neutral-600">{contact.description}</p>
                <a href={`mailto:${contact.email}`} className="mt-2 inline-block font-mono text-[13px] text-black underline">
                  {contact.email}
                </a>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                <a href={`mailto:${contact.email}`} className={appBtnInk}>
                  <Mail className="h-3.5 w-3.5" />
                  Email
                </a>
                <CopyEmailButton email={contact.email} />
              </div>
            </div>
          ))}
        </div>
      </SettingSection>

      <SettingSection title="Legal">
        <div className="flex flex-wrap gap-2">
          {COMPANY_LEGAL_LINKS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="border-[3px] border-black bg-white px-3 py-1.5 text-[13px] font-medium text-black shadow-[3px_3px_0_0_#000] hover:translate-x-0.5 hover:translate-y-0.5 hover:shadow-none"
            >
              {item.label}
            </Link>
          ))}
        </div>
        <p className="text-[12px] text-neutral-500">
          Name, avatar, and GitHub login are on <Link href="/profile" className="underline">Profile</Link>. Settings does not collect a second copy.
        </p>
      </SettingSection>
    </div>
  );
}

function UserPreferencesTab({
  user,
  onChangePreferences,
  saving,
}: {
  user: UserSettings;
  onChangePreferences: (next: UserSettings['preferences']) => void;
  saving: boolean;
}) {
  return (
    <div>
      <div className="mb-8">
        <h2 className="text-2xl font-bold tracking-tight text-black">Preferences</h2>
        <p className="mt-1 text-sm text-zinc-500">Applied immediately across the dashboard and stored with your account.</p>
      </div>

      <SettingSection title="Appearance">
        <SettingField label="Invert theme">
          <div className="flex items-center gap-3">
            <AppThemeToggle />
            <p className="text-[13px] text-neutral-600">Same control as the dashboard header. Inverts the workspace chrome.</p>
          </div>
        </SettingField>
        <SettingField label="Density">
          <select
            value={user.preferences.density}
            disabled={saving}
            onChange={(event) => onChangePreferences({
              ...user.preferences,
              density: event.target.value as UserSettings['preferences']['density'],
            })}
            className={FIELD}
          >
            <option value="comfortable">Comfortable</option>
            <option value="default">Default</option>
            <option value="compact">Compact</option>
          </select>
        </SettingField>
        <SettingField label="Font size">
          <select
            value={user.preferences.fontSize}
            disabled={saving}
            onChange={(event) => onChangePreferences({
              ...user.preferences,
              fontSize: event.target.value as UserSettings['preferences']['fontSize'],
            })}
            className={FIELD}
          >
            <option value="small">Small</option>
            <option value="default">Default</option>
            <option value="large">Large</option>
          </select>
        </SettingField>
        <SettingField label="Reduced motion">
          <EditableToggle
            active={user.preferences.reducedMotion}
            disabled={saving}
            onToggle={() => onChangePreferences({
              ...user.preferences,
              reducedMotion: !user.preferences.reducedMotion,
            })}
          />
        </SettingField>
      </SettingSection>

      <SettingSection title="Accessibility">
        <SettingField label="High contrast">
          <EditableToggle
            active={user.preferences.highContrast}
            disabled={saving}
            onToggle={() => onChangePreferences({
              ...user.preferences,
              highContrast: !user.preferences.highContrast,
            })}
          />
        </SettingField>
      </SettingSection>
    </div>
  );
}

function UserPrivacyTab({
  user,
  onChangePrivacy,
  onExport,
  exporting,
  saving,
}: {
  user: UserSettings;
  onChangePrivacy: (next: UserSettings['privacy']) => void;
  onExport: () => void;
  exporting: boolean;
  saving: boolean;
}) {
  return (
    <div>
      <div className="mb-8">
        <h2 className="text-2xl font-bold tracking-tight text-black">Privacy & data</h2>
        <p className="mt-1 text-sm text-zinc-500">Export what Deplai stores for you, or delete the account from Profile.</p>
      </div>

      <SettingSection title="Product metrics" description="Stored as a consent flag on your account. Deplai does not send data to a third-party analytics vendor.">
        <SettingField label="Usage telemetry">
          <EditableToggle
            active={user.privacy.usageTelemetry}
            disabled={saving}
            onToggle={() => onChangePrivacy({
              ...user.privacy,
              usageTelemetry: !user.privacy.usageTelemetry,
            })}
          />
        </SettingField>
      </SettingSection>

      <SettingSection title="Data controls">
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
          <button type="button" onClick={onExport} disabled={exporting} className={appBtnPaper}>
            {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            Export my data
          </button>
          <Link href="/profile" className={`${appBtnInk} w-full bg-rose-600 sm:ml-auto sm:w-auto`}>
            Delete account
          </Link>
        </div>
        <p className="text-[12px] text-neutral-500">
          Export downloads a JSON file with profile, credits, projects, and GitHub App installations. Account deletion lives on Profile so you confirm the phrase there after cancelling a paid plan.
        </p>
      </SettingSection>
    </div>
  );
}

function SessionTab({
  sessionUser,
  signingOut,
  onSignOut,
}: {
  sessionUser: AuthUser | null;
  signingOut: boolean;
  onSignOut: () => void;
}) {
  const login = sessionUser?.login || '';
  const name = sessionUser?.name || login || 'Signed in';
  const email = sessionUser?.email || '';

  return (
    <div>
      <div className="mb-8">
        <h2 className="text-2xl font-bold tracking-tight text-black">Sign-in</h2>
        <p className="mt-1 text-sm text-zinc-500">Deplai uses GitHub OAuth. There is one browser session cookie, not a device list.</p>
      </div>

      <SettingSection title="GitHub account">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4">
            {sessionUser?.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={sessionUser.avatarUrl} alt="" className="h-14 w-14 border-[3px] border-black object-cover" />
            ) : (
              <div className="flex h-14 w-14 items-center justify-center border-[3px] border-black bg-black text-lg font-bold text-white">
                {initialsFrom(name)}
              </div>
            )}
            <div>
              <p className="text-sm font-semibold text-black">{name}</p>
              {login ? (
                <a
                  href={`https://github.com/${login}`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-xs text-zinc-600 underline"
                >
                  @{login}
                </a>
              ) : null}
              {email ? <p className="text-xs text-zinc-500">{email}</p> : null}
            </div>
          </div>
          <button type="button" onClick={onSignOut} disabled={signingOut} className={appBtnInk}>
            {signingOut ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <LogOut className="h-3.5 w-3.5" />}
            Sign out
          </button>
        </div>
        <p className="text-[12px] text-neutral-500">
          The session cookie lasts 7 days. Signing out clears it on this browser. GitHub MFA and passkeys are managed on GitHub, not inside Deplai.
        </p>
      </SettingSection>
    </div>
  );
}

export default function SettingsApp() {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<TabKey>('contact');
  const [settings, setSettings] = useState<PublicSettings>(DEFAULT_SETTINGS);
  const [serverConfig, setServerConfig] = useState<ServerConfig>(DEFAULT_SERVER_CONFIG);
  const [canManageWorkspace, setCanManageWorkspace] = useState(false);
  const [sessionUser, setSessionUser] = useState<AuthUser | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [cleanupPhrase, setCleanupPhrase] = useState('');
  const [cleanupRunning, setCleanupRunning] = useState(false);
  const [cleanupResult, setCleanupResult] = useState('');

  const visibleNav = SETTINGS_NAV.filter((tab) => !tab.adminOnly || canManageWorkspace);
  const activeLabel = visibleNav.find((tab) => tab.id === activeTab)?.label ?? 'Settings';

  const applySettingsPayload = useCallback((payload: SettingsResponse) => {
    if (payload.settings) {
      setSettings(payload.settings);
      applyUserChrome(payload.settings.user.preferences);
      setProductTelemetryEnabled(payload.settings.user.privacy.usageTelemetry);
    }
    if (payload.serverConfig && Object.keys(payload.serverConfig).length > 0) {
      setServerConfig({ ...DEFAULT_SERVER_CONFIG, ...payload.serverConfig });
    }
    setCanManageWorkspace(Boolean(payload.access?.canManageWorkspace));
    setUpdatedAt(payload.updatedAt ?? null);
  }, []);

  const patchUser = useCallback(async (userPatch: Partial<UserSettings>) => {
    const response = await fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { user: userPatch } }),
    });
    const result = await response.json() as SettingsResponse;
    if (!response.ok) throw new Error(result.error || 'Failed to save settings');
    applySettingsPayload(result);
    return result;
  }, [applySettingsPayload]);

  const loadSettings = useCallback(async () => {
    const response = await fetch('/api/settings', { cache: 'no-store' });
    const payload = await response.json() as SettingsResponse;
    if (!response.ok) throw new Error(payload.error || 'Failed to load settings');
    applySettingsPayload(payload);
  }, [applySettingsPayload]);

  const loadSession = useCallback(async () => {
    const response = await fetch('/api/auth/session', { cache: 'no-store' }).catch(() => null);
    if (!response?.ok) return;
    const payload = await response.json().catch(() => ({})) as { isLoggedIn?: boolean; user?: AuthUser };
    setSessionUser(payload.isLoggedIn ? payload.user || null : null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const bootstrap = async () => {
      setLoading(true);
      setError('');
      try {
        await Promise.all([loadSettings(), loadSession()]);
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : 'Failed to load settings';
          setError(message);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, [loadSession, loadSettings]);

  useEffect(() => {
    if (activeTab === 'workspace' && !canManageWorkspace) {
      setActiveTab('contact');
    }
  }, [activeTab, canManageWorkspace]);

  const handleChangePreferences = useCallback(async (next: UserSettings['preferences']) => {
    setError('');
    setNotice('');
    applyUserChrome(next);
    setSettings((current) => ({
      ...current,
      user: { ...current.user, preferences: next },
    }));
    setSaving(true);
    try {
      await patchUser({ preferences: next });
      setNotice('Preferences saved.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save preferences');
    } finally {
      setSaving(false);
    }
  }, [patchUser]);

  const handleChangePrivacy = useCallback(async (next: UserSettings['privacy']) => {
    setError('');
    setNotice('');
    setProductTelemetryEnabled(next.usageTelemetry);
    setSettings((current) => ({
      ...current,
      user: { ...current.user, privacy: next },
    }));
    setSaving(true);
    try {
      await patchUser({ privacy: next });
      setNotice('Privacy preference saved.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save privacy preference');
    } finally {
      setSaving(false);
    }
  }, [patchUser]);

  const handleExport = useCallback(async () => {
    setExporting(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch('/api/settings/export', { cache: 'no-store' });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(payload.error || 'Export failed');
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'deplai-data-export.json';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setNotice('Export downloaded.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setExporting(false);
    }
  }, []);

  const handleSignOut = useCallback(async () => {
    setSigningOut(true);
    setError('');
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
      router.push(LOGIN_HREF);
    } catch (err) {
      setSigningOut(false);
      setError(err instanceof Error ? err.message : 'Sign out failed');
    }
  }, [router]);

  const handleCleanup = useCallback(async () => {
    setCleanupResult('');
    setError('');
    setCleanupRunning(true);
    try {
      const response = await fetch('/api/settings/cleanup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmation: cleanupPhrase }),
      });
      const payload = await response.json() as { error?: string; message?: string };
      if (!response.ok) throw new Error(payload.error || 'Failed to execute cleanup');
      setCleanupResult(payload.message || 'Cleanup completed.');
      setCleanupPhrase('');
    } catch (err) {
      setCleanupResult(err instanceof Error ? err.message : 'Failed to execute cleanup');
    } finally {
      setCleanupRunning(false);
    }
  }, [cleanupPhrase]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center py-20 text-zinc-400">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading settings...
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-16">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-zinc-500">Account</p>
          <h2 className="mt-2 font-display text-2xl font-semibold tracking-tight text-black">Settings</h2>
          <p className="mt-2 max-w-xl text-[13px] leading-relaxed text-zinc-500">
            How to reach us, appearance, privacy, and GitHub sign-in. Product pages stay in the left nav.
          </p>
          <p className="mt-1 text-[11px] text-zinc-600">Last saved: {formatTimestamp(updatedAt)}</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
        <span className="border-2 border-black px-2 py-0.5 text-black">Settings</span>
        <span className="text-neutral-400">/</span>
        <span className="font-medium text-black">{activeLabel}</span>
      </div>

      {error ? <div className="border-[3px] border-rose-600 bg-rose-50 px-4 py-2 text-sm text-rose-800">{error}</div> : null}
      {notice ? <div className="border-[3px] border-black bg-white px-4 py-2 text-sm text-black shadow-[4px_4px_0_0_#000]">{notice}</div> : null}

      <div className="app-paper p-4">
        <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-neutral-500">Open elsewhere</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {ELSEWHERE_LINKS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="border-[3px] border-black bg-white px-3 py-1.5 text-[13px] font-medium text-black shadow-[3px_3px_0_0_#000] hover:translate-x-0.5 hover:translate-y-0.5 hover:shadow-none"
            >
              {item.label}
            </Link>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <aside className="lg:col-span-3">
          <h4 className="mb-3 px-1 text-[10px] font-bold uppercase tracking-widest text-zinc-500">This page</h4>
          <div className="space-y-1">
            {visibleNav.map((tab) => {
              const active = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex w-full items-center justify-between border-[3px] px-3 py-2.5 text-left text-sm transition-colors ${active ? 'border-black bg-black text-white shadow-[3px_3px_0_0_#000]' : 'border-transparent text-neutral-600 hover:border-black hover:text-black'}`}
                >
                  <span>{tab.label}</span>
                  {active ? <span className="h-4 w-1 bg-white" /> : null}
                </button>
              );
            })}
          </div>
        </aside>

        <section className="lg:col-span-9">
          {activeTab === 'contact' ? <ContactInfoTab /> : null}
          {activeTab === 'preferences' ? (
            <UserPreferencesTab
              user={settings.user}
              onChangePreferences={(next) => void handleChangePreferences(next)}
              saving={saving}
            />
          ) : null}
          {activeTab === 'privacy' ? (
            <UserPrivacyTab
              user={settings.user}
              onChangePrivacy={(next) => void handleChangePrivacy(next)}
              onExport={() => void handleExport()}
              exporting={exporting}
              saving={saving}
            />
          ) : null}
          {activeTab === 'session' ? (
            <SessionTab
              sessionUser={sessionUser}
              signingOut={signingOut}
              onSignOut={() => void handleSignOut()}
            />
          ) : null}
          {activeTab === 'workspace' && canManageWorkspace ? (
            <div>
              <div className="mb-8">
                <h2 className="text-2xl font-bold tracking-tight text-black">Workspace</h2>
                <p className="mt-1 text-sm text-zinc-500">
                  Runtime status from the server environment. Secrets are not stored in Settings and cannot be edited here.
                </p>
              </div>
              <SettingSection title="Environment" description="Read-only. Values come from process environment, not the form.">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <EnvStatus label="GitHub App" ok={Boolean(serverConfig.githubAppConfigured)} />
                  <EnvStatus label="GitHub webhook secret" ok={Boolean(serverConfig.githubWebhookConfigured)} />
                  <EnvStatus label="Session secret" ok={Boolean(serverConfig.sessionSecretConfigured)} />
                  <EnvStatus label="Service key" ok={Boolean(serverConfig.serviceKeyConfigured)} />
                  <EnvStatus label="AWS runtime credentials" ok={Boolean(serverConfig.awsRuntimeConfigured)} />
                </div>
              </SettingSection>
              <SettingSection title="Danger zone" description="Calls the real cleanup endpoint. Type DESTROY ALL to continue.">
                <div className="border-[3px] border-rose-600 bg-rose-50 p-3 text-xs text-rose-900">
                  <p>Agentic layer cleanup currently: <strong>{serverConfig.cleanupEnabled ? 'enabled' : 'disabled'}</strong></p>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <input
                    value={cleanupPhrase}
                    onChange={(event) => setCleanupPhrase(event.target.value)}
                    placeholder="DESTROY ALL"
                    className="w-64 border-[3px] border-rose-600 bg-white px-3 py-2.5 font-mono text-sm text-black outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => void handleCleanup()}
                    disabled={cleanupRunning || cleanupPhrase.trim().toUpperCase() !== 'DESTROY ALL'}
                    className={`${appBtnInk} bg-[#B84A3E] disabled:opacity-50`}
                  >
                    {cleanupRunning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Database className="h-3.5 w-3.5" />}
                    Execute cleanup
                  </button>
                </div>
                {cleanupResult ? <div className="border-[3px] border-rose-600 bg-rose-50 px-3 py-2 text-sm text-rose-900">{cleanupResult}</div> : null}
              </SettingSection>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
