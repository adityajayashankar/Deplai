'use client';

import { useEffect, useState } from 'react';
import { Contrast } from 'lucide-react';
import {
  applyDeplaiTheme,
  appFocusRing,
  readDeplaiTheme,
  subscribeDeplaiTheme,
  type DeplaiTheme,
} from '@/features/workspace/theme';

export function AppThemeToggle({ compact = false }: { compact?: boolean }) {
  const [theme, setTheme] = useState<DeplaiTheme>('default');
  const inverted = theme === 'inverted';

  useEffect(() => {
    const current = readDeplaiTheme();
    setTheme(current);
    applyDeplaiTheme(current);
    return subscribeDeplaiTheme(setTheme);
  }, []);

  return (
    <button
      type="button"
      aria-pressed={inverted}
      aria-label={inverted ? 'Switch to default theme' : 'Invert theme'}
      title={inverted ? 'Default theme' : 'Invert theme'}
      onClick={() => {
        const next: DeplaiTheme = inverted ? 'default' : 'inverted';
        setTheme(next);
        applyDeplaiTheme(next);
      }}
      className={`${compact ? 'h-8 w-8' : 'h-8 w-8'} inline-flex items-center justify-center border-[3px] border-black bg-white text-black shadow-[3px_3px_0_0_#000] transition-transform hover:translate-x-0.5 hover:translate-y-0.5 hover:shadow-none ${appFocusRing}`}
    >
      <Contrast className="h-4 w-4" strokeWidth={2.4} />
    </button>
  );
}

export function AppThemeToggleSlot() {
  return (
    <div className="pointer-events-none absolute right-4 top-2 z-[70] hidden sm:right-6 md:block">
      <div className="pointer-events-auto">
        <AppThemeToggle />
      </div>
    </div>
  );
}
