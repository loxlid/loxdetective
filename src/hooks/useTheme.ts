import { useCallback, useEffect } from 'react';
import { useSettings, type SettingsState } from '@/lib/settings/store';

export type Theme = SettingsState['theme'];
export const THEMES: Theme[] = ['system', 'dark', 'light'];

/** Write the theme to `<html data-theme>`; an empty value lets the OS preference decide (see global.css). */
export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = theme === 'system' ? '' : theme;
}

export function nextTheme(theme: Theme): Theme {
  return THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
}

/** Theme preference from settings, applied to the document while mounted. */
export function useTheme(): { theme: Theme; setTheme: (t: Theme) => void; cycle: () => void } {
  const theme = useSettings((s) => s.theme);
  const set = useSettings((s) => s.set);
  useEffect(() => applyTheme(theme), [theme]);
  const setTheme = useCallback((t: Theme) => set({ theme: t }), [set]);
  const cycle = useCallback(() => set({ theme: nextTheme(theme) }), [set, theme]);
  return { theme, setTheme, cycle };
}
