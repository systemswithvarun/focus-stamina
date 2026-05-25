// useTimer — the central orchestrator hook.
//
// Wires the pure timer engine to the side-effectful world: audio, notifications,
// IndexedDB persistence. The hook is intentionally fat — there is exactly one
// place where timer state mutation happens, which makes the data-flow easy to
// follow and audit. Splitting this into smaller hooks creates more surface area
// for inconsistency between them.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type ActiveTimer,
  type AppState,
  type Session,
  BREAK_DEFAULT_MIN,
  LOCAL_USER_ID,
  PENDING_TRANSITION_STALE_MS
} from '../types/models';
import {
  afterFocusAborted,
  afterFocusCompleted,
  createActiveTimer,
  finalizeSession,
  getStatus,
  manuallyAdvanceRamp,
  pauseTimer,
  planRecovery,
  resumeTimer,
  setBreakDurationSec,
  suggestedFocusDurationSec,
  type TimerStatus
} from '../services/timerEngine';
import { getRepository } from '../services/dexieRepository';
import {
  cancelScheduledChime,
  isAudioUnlocked,
  playTransitionAlert,
  scheduleChimeAt,
  unlockAudio
} from '../services/audioService';
import {
  notify,
  requestNotificationPermission
} from '../services/notificationService';

interface UseTimerValue {
  status: TimerStatus;
  appState: AppState | null;
  loading: boolean;
  // Actions
  startFocus: (durationSec: number, subjectId: string | null) => Promise<void>;
  startStopwatch: (subjectId: string | null) => Promise<void>;
  startBreak: (durationSec?: number) => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  abort: () => Promise<void>;
  completeNow: () => Promise<void>; // manual "I'm done" mid-session — completes successfully
  extendBreakBy: (newDurationSec: number) => Promise<void>;
  skipBreak: () => Promise<void>;
  setActiveSubject: (subjectId: string | null) => Promise<void>;
  // User chose to climb the ramp via the "ready to ramp up?" modal.
  advanceRamp: () => Promise<void>;
  // User dismissed the post-session "Start break?" / "Start focus?" modal.
  // For after-focus modals this counts as a skipped break (logged).
  dismissTransition: () => Promise<void>;
  // User stepped away from their workstation after a phase ended. Like
  // dismissTransition but does NOT log a skipped break — they were taking
  // a real break, not skipping one. Returns to idle focus screen.
  stepAwayFromTransition: () => Promise<void>;
  // Update user-facing settings (sound, notifications, tab flash).
  updateSettings: (patch: { soundEnabled?: boolean; notificationsEnabled?: boolean; tabFlashEnabled?: boolean }) => Promise<void>;
}

const BASE_TITLE = 'Focus Stamina';

function fmtPhaseTitle(phase: 'focus' | 'break', durationSec: number): string {
  const min = Math.round(durationSec / 60);
  return phase === 'focus' ? `Focus ${min} min` : `Break ${min} min`;
}

export function useTimer(): UseTimerValue {
  const repo = useMemo(() => getRepository(), []);
  const [appState, setAppState] = useState<AppState | null>(null);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => Date.now());

  // We need a ref for any handler that fires after a long delay (visibility, completion)
  // so it always reads the latest active timer, not a stale closure.
  const activeRef = useRef<ActiveTimer | null>(null);
  activeRef.current = appState?.activeTimer ?? null;

  // ---- Bootstrap: load app state and run recovery ----------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let state = await repo.getAppState();

      // Drop stale pendingTransition. If the user stepped away after a phase
      // ended and only just opened the tab again, force them back to the
      // idle focus screen instead of trapping them in the modal.
      if (
        state.pendingTransition &&
        Date.now() - state.pendingTransition.completedAt > PENDING_TRANSITION_STALE_MS
      ) {
        state = await repo.setAppState({ pendingTransition: null });
      }

      const action = planRecovery({
        active: state.activeTimer,
        now: Date.now(),
        userId: LOCAL_USER_ID
      });
      if (cancelled) return;

      if (action.kind === 'idle') {
        setAppState(state);
        setLoading(false);
        return;
      }
      if (action.kind === 'resume') {
        setAppState(state);
        setLoading(false);
        scheduleNextChime(action.activeTimer);
        return;
      }
      if (action.kind === 'auto-complete-advance' || action.kind === 'auto-complete-idle') {
        // Both branches now behave the same way: finalize the elapsed session,
        // do NOT auto-start the next phase. Instead set a pendingTransition so
        // the UI can prompt the user when they return. The user said the auto-
        // start was the wrong behavior — recovery should be just as deliberate
        // as a normal completion.
        await repo.addSession(action.completedSession);
        const patch: Partial<AppState> = { activeTimer: null };
        if (state.activeTimer?.phase === 'focus') {
          const advanced = afterFocusCompleted({
            currentStreak: state.currentStreak,
            streakAtCurrentRung: state.streakAtCurrentRung,
            completedDurationSec: action.completedSession.actualDurationSec,
            currentRampIndex: state.currentRampIndex,
            wasOverride: action.completedSession.wasOverride
          });
          patch.currentStreak = advanced.newStreak;
          patch.streakAtCurrentRung = advanced.newStreakAtCurrentRung;
          patch.pendingTransition = {
            kind: 'after-focus',
            completedAt: Date.now(),
            completedDurationSec: action.completedSession.actualDurationSec,
            subjectId: state.activeTimer.subjectId
          };
        } else if (state.activeTimer?.phase === 'break') {
          patch.pendingTransition = {
            kind: 'after-break',
            completedAt: Date.now(),
            completedDurationSec: action.completedSession.actualDurationSec,
            subjectId: state.activeTimer.subjectId
          };
        }
        const next = await repo.setAppState(patch);
        setAppState(next);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Tick loop for the displayed countdown -------------------------------
  // Source of truth is Date.now() deltas; this just refreshes the displayed value.
  useEffect(() => {
    const active = appState?.activeTimer;
    if (!active || active.pausedAt !== null) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [appState?.activeTimer]);

  // ---- Visibility recovery -------------------------------------------------
  // When the tab returns to foreground (or the laptop wakes), recompute and
  // catch up any phase transitions we slept through. Also drop a stale
  // pendingTransition so the user isn't trapped in the modal on return.
  useEffect(() => {
    async function onVisibilityChange() {
      if (document.visibilityState !== 'visible') return;
      setNow(Date.now());
      const state = await repo.getAppState();
      if (
        state.pendingTransition &&
        Date.now() - state.pendingTransition.completedAt > PENDING_TRANSITION_STALE_MS
      ) {
        const cleared = await repo.setAppState({ pendingTransition: null });
        setAppState(cleared);
      }
      void checkAndAdvanceIfElapsed();
    }
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Tick-driven completion check ---------------------------------------
  // Every render where the active timer's elapsed has reached planned, we
  // finalize. This catches both normal tick completions and a returned-from-
  // background catch-up.
  useEffect(() => {
    if (!appState?.activeTimer) return;
    if (appState.activeTimer.plannedDurationSec === 0) return;
    const s = getStatus(appState.activeTimer, now);
    if (s.remainingSec <= 0) {
      void checkAndAdvanceIfElapsed();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now, appState?.activeTimer]);

  // ---- Helpers --------------------------------------------------------------

  // Ref for settings so async callbacks always read the latest values.
  const settingsRef = useRef({ soundEnabled: true, notificationsEnabled: true, tabFlashEnabled: true });
  settingsRef.current = {
    soundEnabled: appState?.soundEnabled ?? true,
    notificationsEnabled: appState?.notificationsEnabled ?? true,
    tabFlashEnabled: appState?.tabFlashEnabled ?? true
  };

  const scheduleNextChime = useCallback((active: ActiveTimer) => {
    cancelScheduledChime();
    if (!isAudioUnlocked()) return;
    if (!settingsRef.current.soundEnabled) return;
    if (active.plannedDurationSec === 0) return;
    const targetEpochMs = active.startedAt + active.plannedDurationSec * 1000 + active.pausedAccumMs;
    scheduleChimeAt({ targetEpochMs });
  }, []);

  // Atomically transition out of the current phase. Called when the elapsed
  // time has reached the planned duration. Idempotent — uses activeRef to
  // skip if already transitioned.
  const checkAndAdvanceIfElapsed = useCallback(async () => {
    const active = activeRef.current;
    if (!active) return;
    const status = getStatus(active, Date.now());
    if (status.remainingSec > 0) return;

    const completedAt = active.startedAt + active.plannedDurationSec * 1000 + active.pausedAccumMs;
    const session = finalizeSession({
      active,
      outcome: 'completed',
      now: completedAt,
      userId: LOCAL_USER_ID
    });
    await repo.addSession(session);

    // Cancel any pre-scheduled chime (it may already have fired audibly while
    // the tab was backgrounded — that's fine, we play another one now to
    // guarantee the alert lands when the user is actually present).
    cancelScheduledChime();
    if (settingsRef.current.soundEnabled) {
      playTransitionAlert();
    }

    if (active.phase === 'focus') {
      // Focus complete: bump streak counters. Ramp index is NOT auto-bumped —
      // the user advances explicitly via the modal.
      //
      // We do NOT auto-start the break here. We set a pendingTransition flag
      // so the UI can show "Focus done — start break?" and the user decides.
      const current = await repo.getAppState();
      const advanced = afterFocusCompleted({
        currentStreak: current.currentStreak,
        streakAtCurrentRung: current.streakAtCurrentRung,
        completedDurationSec: session.actualDurationSec,
        currentRampIndex: current.currentRampIndex,
        wasOverride: session.wasOverride
      });
      const next = await repo.setAppState({
        currentStreak: advanced.newStreak,
        streakAtCurrentRung: advanced.newStreakAtCurrentRung,
        activeTimer: null,
        pendingTransition: {
          kind: 'after-focus',
          completedAt: Date.now(),
          completedDurationSec: session.actualDurationSec,
          subjectId: active.subjectId
        }
      });
      setAppState(next);
      activeRef.current = null;

      if (settingsRef.current.notificationsEnabled) {
        notify(
          'Focus session complete',
          `Ready for a break? Open Focus Stamina to start it.`
        );
      }
    } else {
      // Break completed → idle, with a pending after-break transition so the
      // UI can show "Break done — start next focus?" instead of just sitting idle.
      const next = await repo.setAppState({
        activeTimer: null,
        pendingTransition: {
          kind: 'after-break',
          completedAt: Date.now(),
          completedDurationSec: session.actualDurationSec,
          subjectId: active.subjectId
        }
      });
      setAppState(next);
      activeRef.current = null;
      if (settingsRef.current.notificationsEnabled) {
        notify(
          'Break over',
          `Ready for ${Math.round(suggestedFocusDurationSec(next.currentRampIndex) / 60)} min focus? Open Focus Stamina to start.`
        );
      }
    }
  }, [repo]);

  // ---- Actions --------------------------------------------------------------

  const ensureUnlocked = useCallback(async () => {
    // Unlock audio + request notification permission. Safe to call repeatedly.
    if (!isAudioUnlocked()) {
      try {
        await unlockAudio();
      } catch {
        // No audio support — chime won't play, but timer still works.
      }
    }
    await requestNotificationPermission();
    const perm = typeof Notification !== 'undefined' ? Notification.permission : 'denied';
    if (appState && appState.notificationPermission !== perm) {
      const next = await repo.setAppState({ notificationPermission: perm });
      setAppState(next);
    }
  }, [appState, repo]);

  const startFocus = useCallback(
    async (durationSec: number, subjectId: string | null) => {
      await ensureUnlocked();
      const current = await repo.getAppState();
      const active = createActiveTimer({
        phase: 'focus',
        plannedDurationSec: durationSec,
        subjectId,
        rampIndexAtStart: current.currentRampIndex,
        wasOverride: false,
        now: Date.now()
      });
      const next = await repo.setAppState({
        activeTimer: active,
        activeSubjectId: subjectId,
        pendingTransition: null
      });
      setAppState(next);
      activeRef.current = active;
      scheduleNextChime(active);
    },
    [repo, ensureUnlocked, scheduleNextChime]
  );

  const startStopwatch = useCallback(
    async (subjectId: string | null) => {
      await ensureUnlocked();
      const current = await repo.getAppState();
      const active = createActiveTimer({
        phase: 'focus',
        plannedDurationSec: 0,
        subjectId,
        rampIndexAtStart: current.currentRampIndex,
        wasOverride: false,
        now: Date.now()
      });
      const next = await repo.setAppState({
        activeTimer: active,
        activeSubjectId: subjectId,
        pendingTransition: null
      });
      setAppState(next);
      activeRef.current = active;
    },
    [repo, ensureUnlocked]
  );

  const startBreak = useCallback(
    async (durationSec: number = BREAK_DEFAULT_MIN * 60) => {
      await ensureUnlocked();
      const current = await repo.getAppState();
      const active = createActiveTimer({
        phase: 'break',
        plannedDurationSec: durationSec,
        subjectId: current.activeSubjectId,
        rampIndexAtStart: current.currentRampIndex,
        wasOverride: false,
        now: Date.now()
      });
      const next = await repo.setAppState({
        activeTimer: active,
        pendingTransition: null
      });
      setAppState(next);
      activeRef.current = active;
      scheduleNextChime(active);
    },
    [repo, ensureUnlocked, scheduleNextChime]
  );

  // User dismissed the post-session modal. If they dismissed an after-focus
  // modal (i.e., skipped the break), log a zero-duration aborted break session
  // so the analytics screen can count it as a skipped break.
  const dismissTransition = useCallback(async () => {
    const current = await repo.getAppState();
    const pending = current.pendingTransition;
    if (pending && pending.kind === 'after-focus') {
      const now = Date.now();
      const skipped: Session = {
        id: crypto.randomUUID(),
        userId: LOCAL_USER_ID,
        type: 'break',
        subjectId: pending.subjectId,
        startedAt: now,
        endedAt: now,
        plannedDurationSec: BREAK_DEFAULT_MIN * 60,
        actualDurationSec: 0,
        outcome: 'aborted',
        rampIndexAtStart: 0,
        wasOverride: false
      };
      await repo.addSession(skipped);
    }
    const next = await repo.setAppState({ pendingTransition: null });
    setAppState(next);
  }, [repo]);

  // User stepped away from the workstation after a phase ended. Clears the
  // modal without logging a skipped break. Treat like the user took a real
  // break: silent return to idle focus screen.
  const stepAwayFromTransition = useCallback(async () => {
    const next = await repo.setAppState({ pendingTransition: null });
    setAppState(next);
  }, [repo]);

  const pause = useCallback(async () => {
    const active = activeRef.current;
    if (!active || active.pausedAt !== null) return;
    const paused = pauseTimer(active, Date.now());
    const next = await repo.setAppState({ activeTimer: paused });
    setAppState(next);
    activeRef.current = paused;
    cancelScheduledChime();
  }, [repo]);

  const resume = useCallback(async () => {
    const active = activeRef.current;
    if (!active || active.pausedAt === null) return;
    const resumed = resumeTimer(active, Date.now());
    const next = await repo.setAppState({ activeTimer: resumed });
    setAppState(next);
    activeRef.current = resumed;
    scheduleNextChime(resumed);
  }, [repo, scheduleNextChime]);

  const abort = useCallback(async () => {
    const active = activeRef.current;
    if (!active) return;
    cancelScheduledChime();

    // Record the aborted session.
    const session = finalizeSession({
      active,
      outcome: 'aborted',
      now: Date.now(),
      userId: LOCAL_USER_ID
    });
    await repo.addSession(session);

    // Aborting a focus resets streak + ramp. Aborting a break just clears the timer.
    const patch: Partial<AppState> = { activeTimer: null };
    if (active.phase === 'focus') {
      const r = afterFocusAborted();
      patch.currentStreak = r.newStreak;
      patch.currentRampIndex = r.newRampIndex;
      patch.streakAtCurrentRung = r.newStreakAtCurrentRung;
    }
    const next = await repo.setAppState(patch);
    setAppState(next);
    activeRef.current = null;
  }, [repo]);

  // Manual "I'm done" — only meaningful during a focus.
  // Marks the session completed with the actual elapsed time (or planned, whichever is more).
  const completeNow = useCallback(async () => {
    const active = activeRef.current;
    if (!active || active.phase !== 'focus') return;
    cancelScheduledChime();
    if (settingsRef.current.soundEnabled) {
      playTransitionAlert();
    }

    const elapsedSec = Math.floor((Date.now() - active.startedAt - active.pausedAccumMs) / 1000);
    const session: Session = {
      id: crypto.randomUUID(),
      userId: LOCAL_USER_ID,
      type: 'focus',
      subjectId: active.subjectId,
      startedAt: active.startedAt,
      endedAt: Date.now(),
      plannedDurationSec: active.plannedDurationSec,
      actualDurationSec: Math.max(elapsedSec, 60), // give credit for at least a minute
      outcome: 'completed',
      rampIndexAtStart: active.rampIndexAtStart,
      wasOverride: active.wasOverride
    };
    await repo.addSession(session);

    const current = await repo.getAppState();
    const advanced = afterFocusCompleted({
      currentStreak: current.currentStreak,
      streakAtCurrentRung: current.streakAtCurrentRung,
      completedDurationSec: session.actualDurationSec,
      currentRampIndex: current.currentRampIndex,
      wasOverride: session.wasOverride
    });
    // No auto-start of break here either — set pendingTransition and let the
    // modal ask the user.
    const next = await repo.setAppState({
      currentStreak: advanced.newStreak,
      streakAtCurrentRung: advanced.newStreakAtCurrentRung,
      activeTimer: null,
      pendingTransition: {
        kind: 'after-focus',
        completedAt: Date.now(),
        completedDurationSec: session.actualDurationSec,
        subjectId: active.subjectId
      }
    });
    setAppState(next);
    activeRef.current = null;
    if (settingsRef.current.notificationsEnabled) {
      notify('Focus session complete', 'Ready for a break? Open Focus Stamina to start it.');
    }
  }, [repo]);

  // User explicitly chose to climb the ramp via the "ready to ramp up?" modal.
  // Bumps rampIndex by one and resets streakAtCurrentRung so the next prompt
  // fires after three more at-rung completions at the new level.
  const advanceRamp = useCallback(async () => {
    const current = await repo.getAppState();
    const newRampIndex = manuallyAdvanceRamp(current.currentRampIndex);
    const next = await repo.setAppState({
      currentRampIndex: newRampIndex,
      streakAtCurrentRung: 0
    });
    setAppState(next);
  }, [repo]);

  const extendBreakBy = useCallback(
    async (newDurationSec: number) => {
      const active = activeRef.current;
      if (!active || active.phase !== 'break') return;
      const updated = setBreakDurationSec(active, newDurationSec);
      const next = await repo.setAppState({ activeTimer: updated });
      setAppState(next);
      activeRef.current = updated;
      scheduleNextChime(updated);
    },
    [repo, scheduleNextChime]
  );

  const skipBreak = useCallback(async () => {
    const active = activeRef.current;
    if (!active || active.phase !== 'break') return;
    cancelScheduledChime();
    // Record the partial break as an aborted break session so the analytics
    // screen can count skipped breaks and tally break time.
    const session = finalizeSession({
      active,
      outcome: 'aborted',
      now: Date.now(),
      userId: LOCAL_USER_ID
    });
    await repo.addSession(session);
    const next = await repo.setAppState({ activeTimer: null });
    setAppState(next);
    activeRef.current = null;
  }, [repo]);

  const setActiveSubject = useCallback(
    async (subjectId: string | null) => {
      const next = await repo.setAppState({ activeSubjectId: subjectId });
      setAppState(next);
    },
    [repo]
  );

  const updateSettings = useCallback(
    async (patch: { soundEnabled?: boolean; notificationsEnabled?: boolean; tabFlashEnabled?: boolean }) => {
      const next = await repo.setAppState(patch);
      setAppState(next);
    },
    [repo]
  );

  // ---- Tab title: live countdown while a timer is active --------------------
  useEffect(() => {
    const active = appState?.activeTimer;
    if (!active || active.pausedAt !== null) {
      // Reset title when idle or paused (unless a pending transition flash is active).
      if (!appState?.pendingTransition) {
        document.title = BASE_TITLE;
      }
      return;
    }
    function tick() {
      const s = getStatus(active!, Date.now());
      if (s.isStopwatch) {
        const mm = Math.floor(s.elapsedSec / 60).toString().padStart(2, '0');
        const ss = (s.elapsedSec % 60).toString().padStart(2, '0');
        document.title = `(${mm}:${ss}) Stopwatch | ${BASE_TITLE}`;
      } else {
        const remaining = Math.max(0, s.remainingSec);
        const mm = Math.floor(remaining / 60).toString().padStart(2, '0');
        const ss = (remaining % 60).toString().padStart(2, '0');
        const phase = active!.phase === 'focus' ? 'Focus' : 'Break';
        document.title = `(${mm}:${ss}) ${phase} | ${BASE_TITLE}`;
      }
    }
    tick(); // set immediately
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [appState?.activeTimer, appState?.pendingTransition]);

  // ---- Tab title flash when a phase completes (pending transition) -----------
  useEffect(() => {
    const pending = appState?.pendingTransition;
    if (!pending) return;
    if (!(appState?.tabFlashEnabled ?? true)) {
      // Flashing disabled — just set a static completion title.
      document.title = pending.kind === 'after-focus'
        ? `✓ Focus Done | ${BASE_TITLE}`
        : `✓ Break Done | ${BASE_TITLE}`;
      return () => { document.title = BASE_TITLE; };
    }
    const labels = pending.kind === 'after-focus'
      ? ['🔴 Focus Done!', BASE_TITLE]
      : ['🟢 Break Done!', BASE_TITLE];
    let idx = 0;
    document.title = labels[0];
    const id = setInterval(() => {
      idx = 1 - idx;
      document.title = labels[idx];
    }, 1000);
    return () => {
      clearInterval(id);
      document.title = BASE_TITLE;
    };
  }, [appState?.pendingTransition, appState?.tabFlashEnabled]);

  void fmtPhaseTitle; // referenced by future toast logic; keep import quiet

  const status = useMemo(
    () => getStatus(appState?.activeTimer ?? null, now),
    [appState?.activeTimer, now]
  );

  return {
    status,
    appState,
    loading,
    startFocus,
    startStopwatch,
    startBreak,
    pause,
    resume,
    abort,
    advanceRamp,
    dismissTransition,
    stepAwayFromTransition,
    completeNow,
    extendBreakBy,
    skipBreak,
    setActiveSubject,
    updateSettings
  };
}
