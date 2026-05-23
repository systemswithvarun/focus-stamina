// useActiveTimeTracker — accumulates total milliseconds the app tab is visible,
// keyed by local date. Mount once at the app root.
//
// Implementation notes:
// - Source of truth is Date.now() deltas, not interval ticks. The interval
//   exists only to flush the in-memory delta into IndexedDB so a crash or
//   surprise tab close loses at most ~30 seconds.
// - visibilitychange events handle backgrounded / foregrounded transitions.
// - beforeunload / pagehide flush best-effort on tab close (async write may
//   not complete; the 30-second periodic flush is the real safety net).
// - The repository's addActiveMs uses a transaction so concurrent flushes
//   don't lose increments.

import { useEffect, useMemo, useRef } from 'react';
import { getRepository } from '../services/dexieRepository';

function dateKey(d: Date): string {
  const y = d.getFullYear();
  const m = (d.getMonth() + 1).toString().padStart(2, '0');
  const dd = d.getDate().toString().padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

const FLUSH_INTERVAL_MS = 30_000;
const MIN_FLUSH_DELTA_MS = 250;

export function useActiveTimeTracker(): void {
  const repo = useMemo(() => getRepository(), []);
  const activeSinceRef = useRef<number | null>(null);

  useEffect(() => {
    const flush = async () => {
      if (activeSinceRef.current === null) return;
      const now = Date.now();
      const delta = now - activeSinceRef.current;
      // Move the baseline forward even if the delta was too small to write —
      // otherwise tiny intervals would never advance.
      activeSinceRef.current = now;
      if (delta < MIN_FLUSH_DELTA_MS) return;
      try {
        await repo.addActiveMs(dateKey(new Date(now)), delta);
      } catch {
        // Persist failure is non-fatal — next flush will try again.
      }
    };

    const start = () => {
      if (activeSinceRef.current === null) {
        activeSinceRef.current = Date.now();
      }
    };

    const stop = () => {
      void flush();
      activeSinceRef.current = null;
    };

    if (document.visibilityState === 'visible') start();

    const onVis = () => {
      if (document.visibilityState === 'visible') start();
      else stop();
    };
    document.addEventListener('visibilitychange', onVis);

    const onUnload = () => {
      // Best-effort. IndexedDB writes during unload are unreliable; the
      // periodic flush below keeps the loss window small.
      void flush();
    };
    window.addEventListener('beforeunload', onUnload);
    window.addEventListener('pagehide', onUnload);

    const id = setInterval(() => void flush(), FLUSH_INTERVAL_MS);

    return () => {
      void flush();
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('beforeunload', onUnload);
      window.removeEventListener('pagehide', onUnload);
    };
  }, [repo]);
}
