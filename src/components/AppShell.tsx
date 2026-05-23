// App shell — top brand bar + bottom nav (mobile) / side nav (desktop).
// Single navigation component, responsive via CSS.

import { Link, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useActiveTimeTracker } from '../hooks/useActiveTimeTracker';
import './AppShell.css';

const NAV_ITEMS = [
  { path: '/', label: 'Timer', icon: TimerIcon },
  { path: '/analytics', label: 'Stats', icon: StatsIcon },
  { path: '/subjects', label: 'Subjects', icon: SubjectsIcon },
  { path: '/settings', label: 'Settings', icon: SettingsIcon }
];

export function AppShell({ children }: { children: ReactNode }) {
  const location = useLocation();
  // Track total app-visible time per day. Mounted once here at the shell.
  useActiveTimeTracker();
  return (
    <div className="app-shell">
      <header className="app-header">
        <Link to="/" className="brand">
          <span className="brand-mark">●</span>
          <span className="brand-name">Focus Stamina</span>
        </Link>
      </header>
      <main className="app-main">{children}</main>
      <nav className="app-nav">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const active = location.pathname === item.path;
          return (
            <Link
              key={item.path}
              to={item.path}
              className={`nav-item ${active ? 'is-active' : ''}`}
            >
              <Icon />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

function TimerIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="13" r="8" />
      <path d="M12 9v4l3 2" />
      <path d="M10 2h4" />
    </svg>
  );
}
function StatsIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 21h18" />
      <rect x="5" y="13" width="3" height="6" rx="1" />
      <rect x="10.5" y="9" width="3" height="10" rx="1" />
      <rect x="16" y="5" width="3" height="14" rx="1" />
    </svg>
  );
}
function SubjectsIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7h16M4 12h16M4 17h10" />
    </svg>
  );
}
function SettingsIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
