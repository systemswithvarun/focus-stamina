// Settings — theme, export, import, clear all.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTheme, type ThemeChoice } from '../hooks/useTheme';
import { getRepository } from '../services/dexieRepository';
import type { ExportBundle } from '../types/models';
import './SettingsScreen.css';

export function SettingsScreen() {
  const { choice, setChoice } = useTheme();
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
        <h2>Notifications</h2>
        <p className="text-dim setting-help">
          Permission status: <span className={`perm-${notifPerm}`}>{notifPerm}</span>.
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
          Focus Stamina is a progressive-ramp pomodoro timer. Sessions start at 5 min and
          ramp up to 45 min as you build consecutive streaks. Built for personal use; data
          lives only in this browser. iOS: install to home screen for notifications to work.
        </p>
      </section>
    </div>
  );
}
