// Settings — theme, alerts, export, import, clear all.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTheme, type ThemeChoice } from '../hooks/useTheme';
import { useTimer } from '../hooks/useTimer';
import { getRepository } from '../services/dexieRepository';
import type { ExportBundle } from '../types/models';
import './SettingsScreen.css';

export function SettingsScreen() {
  const { choice, setChoice } = useTheme();
  const { appState, updateSettings } = useTimer();
  const repo = useMemo(() => getRepository(), []);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [importMessage, setImportMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [notifPerm, setNotifPerm] = useState<NotificationPermission>(
    typeof Notification !== 'undefined' ? Notification.permission : 'default'
  );

  useEffect(() => {
    const id = setInterval(() => {
      if (typeof Notification !== 'undefined') setNotifPerm(Notification.permission);
    }, 1000);
    return () => clearInterval(id);
  }, []);

  const handleExport = async () => {
    const bundle = await repo.exportAll();
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `focus-stamina-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const handleImportPick = () => fileInputRef.current?.click();

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    setImportMessage(null);
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-import of same file
    if (!file) return;
    if (!confirm('Importing will overwrite your current data. Continue?')) return;
    try {
      const text = await file.text();
      const bundle = JSON.parse(text) as ExportBundle;
      await repo.importAll(bundle);
      setImportMessage({ kind: 'ok', text: 'Import successful. Reload to see changes.' });
    } catch (err) {
      setImportMessage({
        kind: 'err',
        text: err instanceof Error ? err.message : 'Import failed.'
      });
    }
  };

  const handleClearAll = async () => {
    if (!confirm('This will erase all sessions and reset your streak. Subjects are kept. Continue?')) {
      return;
    }
    await repo.clearAllSessionsAndStreak();
    location.reload();
  };

  const soundEnabled = appState?.soundEnabled ?? true;
  const notificationsEnabled = appState?.notificationsEnabled ?? true;
  const tabFlashEnabled = appState?.tabFlashEnabled ?? true;

  return (
    <div className="settings-screen">
      <h1>Settings</h1>

      <section>
        <h2>Appearance</h2>
        <div className="theme-row">
          {(['system', 'light', 'dark'] as ThemeChoice[]).map((c) => (
            <button
              key={c}
              className={`btn theme-btn ${choice === c ? 'is-selected' : ''}`}
              onClick={() => setChoice(c)}
            >
              {c}
            </button>
          ))}
        </div>
      </section>

      <section>
        <h2>Alerts</h2>
        <div className="toggle-group">
          <label className="toggle-row" htmlFor="toggle-sound">
            <div className="toggle-info">
              <span className="toggle-label">Sound chimes</span>
              <span className="toggle-desc text-dim">Play an audible alert when a phase ends</span>
            </div>
            <div className="toggle-switch-wrap">
              <input
                id="toggle-sound"
                type="checkbox"
                className="toggle-input"
                checked={soundEnabled}
                onChange={(e) => void updateSettings({ soundEnabled: e.target.checked })}
              />
              <div className="toggle-track" />
            </div>
          </label>

          <label className="toggle-row" htmlFor="toggle-notif">
            <div className="toggle-info">
              <span className="toggle-label">Desktop notifications</span>
              <span className="toggle-desc text-dim">
                Show a system notification when a phase ends
                {notifPerm === 'denied' && ' (blocked in browser settings)'}
              </span>
            </div>
            <div className="toggle-switch-wrap">
              <input
                id="toggle-notif"
                type="checkbox"
                className="toggle-input"
                checked={notificationsEnabled}
                onChange={(e) => void updateSettings({ notificationsEnabled: e.target.checked })}
              />
              <div className="toggle-track" />
            </div>
          </label>

          <label className="toggle-row" htmlFor="toggle-flash">
            <div className="toggle-info">
              <span className="toggle-label">Tab title flash</span>
              <span className="toggle-desc text-dim">Flash the browser tab title when a phase ends</span>
            </div>
            <div className="toggle-switch-wrap">
              <input
                id="toggle-flash"
                type="checkbox"
                className="toggle-input"
                checked={tabFlashEnabled}
                onChange={(e) => void updateSettings({ tabFlashEnabled: e.target.checked })}
              />
              <div className="toggle-track" />
            </div>
          </label>
        </div>

        <p className="text-dim setting-help" style={{ marginTop: 'var(--space-3)', marginBottom: 0 }}>
          Browser notification permission: <span className={`perm-${notifPerm}`}>{notifPerm}</span>.
          {notifPerm === 'denied' && ' Enable notifications in your browser settings to get phase-change alerts.'}
          {notifPerm === 'default' && ' Permission will be requested the first time you press Start.'}
        </p>
      </section>

      <section>
        <h2>Your data</h2>
        <p className="text-dim setting-help">
          Everything is stored locally in your browser. Export to back up; import to restore on another browser.
        </p>
        <div className="data-actions">
          <button className="btn" onClick={() => void handleExport()}>Export JSON</button>
          <button className="btn" onClick={handleImportPick}>Import JSON</button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json"
            style={{ display: 'none' }}
            onChange={handleImportFile}
          />
          <button className="btn btn-danger" onClick={() => void handleClearAll()}>Clear all data</button>
        </div>
        {importMessage && (
          <p className={`import-msg ${importMessage.kind}`}>{importMessage.text}</p>
        )}
      </section>

      <section>
        <h2>About</h2>
        <p className="text-dim setting-help">
          Focus Stamina is a progressive stamina-building pomodoro timer. Sessions start at 5 min and
          ramp up to 45 min as you build consecutive streaks. Built for personal use; data
          lives only in this browser. iOS: install to home screen for notifications to work.
        </p>
      </section>
    </div>
  );
}
