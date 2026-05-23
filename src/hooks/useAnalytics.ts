// useAnalytics — reads sessions + subjects + appState, computes the stats the
// analytics screen renders. Recomputes when the tab regains focus to catch
// updates from other screens.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { getRepository } from '../services/dexieRepository';
import type { AppState, Session, Subject } from '../types/models';

export interface AnalyticsData {
  // Totals
  totalFocusMin: number;
  totalBreakMin: number;
  totalCompletedFocusSessions: number;
  totalCompletedBreakSessions: number;
  skippedBreaksCount: number;
  peakFocusSessionMin: number;

  // Active time (app open + visible)
  activeMsToday: number;
  activeMsAllTime: number;
  // Focus minutes today, derived from sessions started today.
  focusMinToday: number;
  // Ratio: focus minutes / active minutes today (0–1). null when no active time yet.
  focusActiveRatioToday: number | null;

  // Charts
  heatmap: Map<string, number>; // YYYY-MM-DD -> focus minutes that day
  rampSeries: { idx: number; plannedMin: number; actualMin: number; date: number }[];
  hoursBySubject: { subjectName: string; hours: number }[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const TWELVE_WEEKS_DAYS = 84;

function dateKey(d: Date): string {
  const y = d.getFullYear();
  const m = (d.getMonth() + 1).toString().padStart(2, '0');
  const dd = d.getDate().toString().padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function isSameLocalDay(epochMs: number, ref: Date): boolean {
  const d = new Date(epochMs);
  return (
    d.getFullYear() === ref.getFullYear() &&
    d.getMonth() === ref.getMonth() &&
    d.getDate() === ref.getDate()
  );
}

function buildAnalytics(
  sessions: Session[],
  subjects: Subject[],
  appState: AppState
): AnalyticsData {
  const focusCompleted = sessions.filter((s) => s.type === 'focus' && s.outcome === 'completed');
  const breakCompleted = sessions.filter((s) => s.type === 'break' && s.outcome === 'completed');
  const breakSkipped = sessions.filter((s) => s.type === 'break' && s.outcome === 'aborted');

  const totalFocusMin = Math.round(
    focusCompleted.reduce((sum, s) => sum + s.actualDurationSec, 0) / 60
  );
  const totalBreakMin = Math.round(
    breakCompleted.reduce((sum, s) => sum + s.actualDurationSec, 0) / 60
  );

  const peakFocusSessionMin = focusCompleted.reduce(
    (max, s) => Math.max(max, Math.round(s.actualDurationSec / 60)),
    0
  );

  const today = new Date();
  const todayKey = dateKey(today);
  const activeMsToday = appState.dailyActiveMs?.[todayKey] ?? 0;
  const activeMsAllTime = Object.values(appState.dailyActiveMs ?? {}).reduce(
    (sum, ms) => sum + ms,
    0
  );
  const focusMinToday = Math.round(
    focusCompleted
      .filter((s) => isSameLocalDay(s.startedAt, today))
      .reduce((sum, s) => sum + s.actualDurationSec, 0) / 60
  );
  const focusActiveRatioToday =
    activeMsToday > 0 ? Math.min(1, (focusMinToday * 60 * 1000) / activeMsToday) : null;

  // Heatmap: focus minutes per day across the last 12 weeks.
  const heatmap = new Map<string, number>();
  const earliest = new Date(today.getTime() - TWELVE_WEEKS_DAYS * DAY_MS);
  earliest.setHours(0, 0, 0, 0);

  for (let d = new Date(earliest); d <= today; d = new Date(d.getTime() + DAY_MS)) {
    heatmap.set(dateKey(d), 0);
  }
  for (const s of focusCompleted) {
    const d = new Date(s.startedAt);
    if (d < earliest) continue;
    const k = dateKey(d);
    heatmap.set(k, (heatmap.get(k) ?? 0) + Math.round(s.actualDurationSec / 60));
  }

  // Last 30 completed focus sessions, chronological.
  const last30 = [...focusCompleted]
    .sort((a, b) => a.startedAt - b.startedAt)
    .slice(-30);
  const rampSeries = last30.map((s, idx) => ({
    idx: idx + 1,
    plannedMin: Math.round(s.plannedDurationSec / 60),
    actualMin: Math.round(s.actualDurationSec / 60),
    date: s.startedAt
  }));

  // Hours by subject — focus sessions only.
  const subjectMap = new Map<string | null, number>();
  for (const s of focusCompleted) {
    subjectMap.set(s.subjectId, (subjectMap.get(s.subjectId) ?? 0) + s.actualDurationSec / 3600);
  }
  const lookup = new Map(subjects.map((s) => [s.id, s.name]));
  const hoursBySubject = Array.from(subjectMap.entries())
    .map(([id, hours]) => ({
      subjectName: id === null ? 'Unassigned' : lookup.get(id) ?? '(removed)',
      hours: Math.round(hours * 10) / 10
    }))
    .sort((a, b) => b.hours - a.hours);

  return {
    totalFocusMin,
    totalBreakMin,
    totalCompletedFocusSessions: focusCompleted.length,
    totalCompletedBreakSessions: breakCompleted.length,
    skippedBreaksCount: breakSkipped.length,
    peakFocusSessionMin,
    activeMsToday,
    activeMsAllTime,
    focusMinToday,
    focusActiveRatioToday,
    heatmap,
    rampSeries,
    hoursBySubject
  };
}

export function useAnalytics() {
  const repo = useMemo(() => getRepository(), []);
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const [sessions, subjects, appState] = await Promise.all([
      repo.listSessions(),
      repo.listSubjects({ includeArchived: true }),
      repo.getAppState()
    ]);
    setData(buildAnalytics(sessions, subjects, appState));
    setLoading(false);
  }, [repo]);

  useEffect(() => {
    void refresh();
    const onVis = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [refresh]);

  return { data, loading, refresh };
}
