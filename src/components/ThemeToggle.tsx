import { useTheme, type Theme } from '@/hooks/useTheme';

const LABELS: Record<Theme, string> = { system: 'System theme', dark: 'Dark theme', light: 'Light theme' };

function Icon({ theme }: { theme: Theme }) {
  const common = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
  if (theme === 'dark') {
    return (
      <svg {...common}>
        <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
      </svg>
    );
  }
  if (theme === 'light') {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <rect x="2" y="4" width="20" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}

/** Cycles system → dark → light. */
export default function ThemeToggle({ className }: { className?: string }) {
  const { theme, cycle } = useTheme();
  return (
    <button type="button" className={`btn btn--icon theme-toggle${className ? ` ${className}` : ''}`} onClick={cycle} title={`${LABELS[theme]} (click to change)`} aria-label={`${LABELS[theme]}, click to change`}>
      <Icon theme={theme} />
    </button>
  );
}
