export const appFocusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/35 focus-visible:ring-offset-2 focus-visible:ring-offset-white';

export const appPaper =
  'app-paper bg-white text-black border-[3px] border-black shadow-[6px_6px_0_0_#000] rounded-none';

export const secPaper = appPaper;

export const appBtnInk =
  'inline-flex items-center justify-center gap-2 border-[3px] border-black bg-black px-4 py-2 text-[13px] font-bold text-white shadow-[4px_4px_0_0_#000] transition-transform hover:translate-x-0.5 hover:translate-y-0.5 hover:shadow-none disabled:cursor-not-allowed disabled:opacity-50';

export const appBtnPaper =
  'inline-flex items-center justify-center gap-2 border-[3px] border-black bg-white px-4 py-2 text-[13px] font-bold text-black shadow-[4px_4px_0_0_#000] transition-transform hover:translate-x-0.5 hover:translate-y-0.5 hover:shadow-none disabled:cursor-not-allowed disabled:opacity-50';

export const appInput =
  'w-full rounded-none border-[3px] border-black bg-white px-3 py-2.5 text-[13px] text-black placeholder:text-neutral-500 outline-none disabled:opacity-50';

export const DEPLAI_THEME_STORAGE_KEY = 'deplai-theme';
export const DEPLAI_THEME_EVENT = 'deplai-theme-change';

export type DeplaiTheme = 'default' | 'inverted';

export function readDeplaiTheme(): DeplaiTheme {
  try {
    return window.localStorage.getItem(DEPLAI_THEME_STORAGE_KEY) === 'inverted' ? 'inverted' : 'default';
  } catch {
    return 'default';
  }
}

export function applyDeplaiTheme(theme: DeplaiTheme) {
  if (typeof document === 'undefined') return;
  if (theme === 'inverted') {
    document.documentElement.setAttribute('data-deplai-theme', 'inverted');
  } else {
    document.documentElement.removeAttribute('data-deplai-theme');
  }
  try {
    window.localStorage.setItem(DEPLAI_THEME_STORAGE_KEY, theme);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event(DEPLAI_THEME_EVENT));
}

export function subscribeDeplaiTheme(onChange: (theme: DeplaiTheme) => void) {
  const handler = () => onChange(readDeplaiTheme());
  window.addEventListener('storage', handler);
  window.addEventListener(DEPLAI_THEME_EVENT, handler);
  return () => {
    window.removeEventListener('storage', handler);
    window.removeEventListener(DEPLAI_THEME_EVENT, handler);
  };
}

export const DEPLAI_CHROME_STORAGE_KEY = 'deplai-user-chrome';
export const DEPLAI_TELEMETRY_STORAGE_KEY = 'deplai-telemetry';

export type UserChromePrefs = {
  density: 'comfortable' | 'default' | 'compact';
  fontSize: 'small' | 'default' | 'large';
  reducedMotion: boolean;
  highContrast: boolean;
};

const DEFAULT_USER_CHROME: UserChromePrefs = {
  density: 'default',
  fontSize: 'default',
  reducedMotion: false,
  highContrast: false,
};

function asChromeDensity(value: unknown): UserChromePrefs['density'] {
  return value === 'comfortable' || value === 'compact' ? value : 'default';
}

function asChromeFontSize(value: unknown): UserChromePrefs['fontSize'] {
  return value === 'small' || value === 'large' ? value : 'default';
}

export function readUserChrome(): UserChromePrefs {
  try {
    const raw = window.localStorage.getItem(DEPLAI_CHROME_STORAGE_KEY);
    if (!raw) return DEFAULT_USER_CHROME;
    const parsed = JSON.parse(raw) as Partial<UserChromePrefs>;
    return {
      density: asChromeDensity(parsed.density),
      fontSize: asChromeFontSize(parsed.fontSize),
      reducedMotion: Boolean(parsed.reducedMotion),
      highContrast: Boolean(parsed.highContrast),
    };
  } catch {
    return DEFAULT_USER_CHROME;
  }
}

export function applyUserChrome(prefs: Partial<UserChromePrefs>) {
  if (typeof document === 'undefined') return;
  const current = readUserChrome();
  const next: UserChromePrefs = {
    density: asChromeDensity(prefs.density ?? current.density),
    fontSize: asChromeFontSize(prefs.fontSize ?? current.fontSize),
    reducedMotion: typeof prefs.reducedMotion === 'boolean' ? prefs.reducedMotion : current.reducedMotion,
    highContrast: typeof prefs.highContrast === 'boolean' ? prefs.highContrast : current.highContrast,
  };
  const root = document.documentElement;
  if (next.density === 'default') root.removeAttribute('data-density');
  else root.setAttribute('data-density', next.density);
  if (next.fontSize === 'default') root.removeAttribute('data-font-size');
  else root.setAttribute('data-font-size', next.fontSize);
  if (next.reducedMotion) root.setAttribute('data-reduced-motion', '1');
  else root.removeAttribute('data-reduced-motion');
  if (next.highContrast) root.setAttribute('data-high-contrast', '1');
  else root.removeAttribute('data-high-contrast');
  try {
    window.localStorage.setItem(DEPLAI_CHROME_STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}

export function isProductTelemetryEnabled() {
  try {
    return window.localStorage.getItem(DEPLAI_TELEMETRY_STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

export function setProductTelemetryEnabled(enabled: boolean) {
  try {
    window.localStorage.setItem(DEPLAI_TELEMETRY_STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    /* ignore */
  }
}
