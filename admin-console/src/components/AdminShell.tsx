'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Activity,
  Building2,
  CreditCard,
  FolderKanban,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Receipt,
  RotateCcw,
  Shield,
  Users,
} from 'lucide-react';
import { cn } from '@/lib/utils';

const NAV = [
  { href: '/overview', label: 'Overview', icon: LayoutDashboard },
  { href: '/users', label: 'Users', icon: Users },
  { href: '/organizations', label: 'Organizations', icon: Building2 },
  { href: '/projects', label: 'Projects', icon: FolderKanban },
  { href: '/payments', label: 'Payments', icon: CreditCard },
  { href: '/refunds', label: 'Refunds', icon: RotateCcw },
  { href: '/api-keys', label: 'API Keys', icon: KeyRound },
  { href: '/provider-keys', label: 'Provider Keys', icon: Shield },
  { href: '/audit', label: 'Audit Log', icon: Activity },
  { href: '/security', label: 'Security Events', icon: Receipt },
  { href: '/settings', label: 'Settings', icon: Shield },
];

export function AdminShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    window.location.href = '/login';
  }

  return (
    <div className="min-h-screen grid lg:grid-cols-[260px_1fr]">
      <aside className="border-r border-border bg-surface p-4 flex flex-col gap-6">
        <div>
          <div className="text-xs uppercase tracking-[0.2em] text-muted">Deplai</div>
          <div className="font-[family-name:var(--font-display)] text-xl font-semibold">Owner Console</div>
          <div className="text-xs text-muted mt-1">Private control plane</div>
        </div>
        <nav className="flex flex-col gap-1">
          {NAV.map((item) => {
            const Icon = item.icon;
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors',
                  active ? 'bg-[rgba(255,122,26,0.12)] text-accent' : 'text-foreground hover:bg-surface-alt',
                )}
              >
                <Icon size={16} />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <button type="button" onClick={logout} className="btn btn-outline mt-auto">
          <LogOut size={16} />
          Sign out
        </button>
      </aside>
      <main className="p-6 lg:p-8">
        <div key={pathname} className="page-enter">
          {children}
        </div>
      </main>
    </div>
  );
}
