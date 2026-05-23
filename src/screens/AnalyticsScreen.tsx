// Analytics screen — totals, streak, peak, heatmap, charts.

import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts';
import { useAnalytics } from '../hooks/useAnalytics';
import { useEffect, useState, useMemo } from 'react';
import { getRepository } from '../services/dexieRepository';
import { Heatmap } from '../components/Heatmap';
import './AnalyticsScreen.css';

export function AnalyticsScreen() {
  const { data, loading } = useAnalytics();
  const repo = useMemo(() => getRepository(), []);
  const [streak, setStreak] = useState(0);

  useEffect(() => {
    void repo.getAppState().then((s) => setStreak(s.currentStreak));
  }, [repo]);

  if (loading || !data) {
    return (
      <div className="analytics-screen">
        <p className="text-faint">Loading analytics…</p>
      </div>
    );
  }

  const fmtHM = (mins: number) => `${Math.floor(mins / 60)}h ${mins % 60}m`;
  const fmtHMfromMs = (ms: number) => fmtHM(Math.round(ms / 60_000));
  const ratioPct =
    data.focusActiveRatioToday === null ? null : Math.round(data.focusActiveRatioToday * 100);

  return (
    <div className="analytics-screen">
      <h1>Analytics</h1>

      <section className="today-section">
        <h2>Today</h2>
        <div className="stat-grid">
          <Stat label="Active in app" value={fmtHMfromMs(data.activeMsToday)} />
          <Stat label="Focus today" value={fmtHM(data.focusMinToday)} />
          <Stat
            label="Focus / active"
            value={ratioPct === null ? '—' : `${ratioPct}%`}
            accent
          />
        </div>
      </section>

      <section>
        <h2>All time</h2>
        <div className="stat-grid">
          <Stat label="Total focus" value={fmtHM(data.totalFocusMin)} />
          <Stat label="Focus sessions" value={data.totalCompletedFocusSessions.toString()} />
          <Stat label="Current streak" value={streak.toString()} accent />
          <Stat
            label="Peak focus"
            value={data.peakFocusSessionMin ? `${data.peakFocusSessionMin} min` : '—'}
          />
          <Stat label="Total break" value={fmtHM(data.totalBreakMin)} />
          <Stat
            label="Breaks skipped"
            value={data.skippedBreaksCount.toString()}
          />
          <Stat label="Active in app" value={fmtHMfromMs(data.activeMsAllTime)} />
        </div>
      </section>

      <section>
        <h2>Last 12 weeks</h2>
        <p className="text-faint section-hint">Each square is one day. Darker = more focus minutes.</p>
        <div className="heatmap-wrap">
          <Heatmap data={data.heatmap} />
        </div>
      </section>

      <section>
        <h2>Last 30 sessions</h2>
        <p className="text-faint section-hint">Planned and actual session length over time. Watch the ramp.</p>
        {data.rampSeries.length === 0 ? (
          <p className="text-faint">No completed sessions yet.</p>
        ) : (
          <div className="chart-wrap">
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={data.rampSeries} margin={{ top: 10, right: 10, bottom: 0, left: -10 }}>
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="idx" stroke="var(--text-faint)" fontSize={11} />
                <YAxis stroke="var(--text-faint)" fontSize={11} unit="m" />
                <Tooltip
                  contentStyle={{
                    background: 'var(--bg-elev)',
                    border: '1px solid var(--border)',
                    borderRadius: '8px',
                    fontSize: '13px'
                  }}
                  formatter={(v: number, name: string) => [`${v} min`, name === 'plannedMin' ? 'Planned' : 'Actual']}
                  labelFormatter={(idx) => `Session ${idx}`}
                />
                <Line
                  type="monotone"
                  dataKey="plannedMin"
                  stroke="var(--accent)"
                  strokeWidth={2}
                  dot={{ r: 3 }}
                />
                <Line
                  type="monotone"
                  dataKey="actualMin"
                  stroke="var(--good)"
                  strokeWidth={1.5}
                  strokeDasharray="4 4"
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </section>

      <section>
        <h2>By subject</h2>
        {data.hoursBySubject.length === 0 ? (
          <p className="text-faint">No completed sessions yet.</p>
        ) : (
          <div className="chart-wrap">
            <ResponsiveContainer width="100%" height={Math.max(140, data.hoursBySubject.length * 36 + 40)}>
              <BarChart
                data={data.hoursBySubject}
                layout="vertical"
                margin={{ top: 6, right: 30, bottom: 6, left: 0 }}
              >
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" stroke="var(--text-faint)" fontSize={11} unit="h" />
                <YAxis type="category" dataKey="subjectName" stroke="var(--text-faint)" fontSize={12} width={110} />
                <Tooltip
                  contentStyle={{
                    background: 'var(--bg-elev)',
                    border: '1px solid var(--border)',
                    borderRadius: '8px',
                    fontSize: '13px'
                  }}
                  formatter={(v: number) => [`${v} h`, 'Total']}
                />
                <Bar dataKey="hours" fill="var(--accent)" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`stat-card ${accent ? 'accent' : ''}`}>
      <div className="stat-value mono">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}
