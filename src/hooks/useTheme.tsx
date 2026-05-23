// Theme provider — system / light / dark.
// Persists choice in localStorage so it survives reloads.
// Listens to system theme changes when in 'system' mode.

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export type ThemeChoice = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

interface ThemeContextValue {
  choice: ThemeChoice;
  resolved: ResolvedTheme;
  setChoice: (choice: ThemeChoice) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);
const STORAGE_KEY = 'focus-stamina:theme';

function getSystemTheme(): ResolvedTheme {
  if (typeof window === 'undefined') return 'dark';
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function resolve(choice: ThemeChoice): ResolvedTheme {
  if (choice === 'system') return getSystemTheme();
  return choice;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [choice, setChoiceState] = useState<ThemeChoice>(() => {
    if (typeof window === 'undefined') return 'system';
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
    return 'system';
  });

  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolve(choice));

  useEffect(() => {
    setResolved(resolve(choice));
    if (typeof window !== 'undefined') window.localStorage.setItem(STORAGE_KEY, choice);
  }, [choice]);

  useEffect(() => {
    if (choice !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const handler = () => setResolved(getSystemTheme());
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [choice]);

  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
  }, [resolved]);

  return (
    <ThemeContext.Provider value={{ choice, resolved, setChoice: setChoiceState }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>');
  return ctx;
}
