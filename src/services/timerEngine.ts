// Timer engine — pure logic.
//
// Design rule: timestamps are the source of truth. The display can be driven by
// intervals, but elapsed time always recomputes from Date.now() deltas. This is
// what survives backgrounded tabs, sleep/wake, and tab close + reopen.
//
// No React, no DOM, no AudioContext here. All side effects (audio, notifications,
// persistence) are wired up by the caller. This module is unit-testable in
// isolation by injecting a `now: number` argument into every function.

import {
  type ActiveTimer,
  type Session,
  BREAK_DEFAULT_MIN,
  BREAK_PHYSICAL_LIMIT_MIN,
  RAMP_LADDER_MIN
} from '../types/models';

// ---------------------------------------------------------------------------
// Status — what the UI renders.
// ---------------------------------------------------------------------------

export interface TimerStatus {
  phase: 'idle' | 'focus' | 'break';
  plannedSec: number;
  elapsedSec: number;
  remainingSec: number; // negative once the timer has run past planned
  isPaused: boolean;
  // True when the running break has elapsed >= 15 min total. UI uses this to
  // switch from countdown to a "step away from the screen" prompt.
  hasOverrunPhysicalLimit: boolean;
  // True when the *planned* break duration itself exceeds 15 min (user picked
  // a long custom break). UI shows the physical-break prompt immediately,
  // not after the 15-min mark.
  isLongBreak: boolean;
  isStopwatch: boolean;
}

export function computeElapsedMs(t: ActiveTimer, now: number): number {
  const base = now - t.startedAt;
  const inFlightPause = t.pausedAt !== null ? now - t.pausedAt : 0;
  return Math.max(0, base - t.pausedAccumMs - inFlightPause);
}

export function getStatus(active: ActiveTimer | null, now: number): TimerStatus {
  if (!active) {
    return {
      phase: 'idle',
      plannedSec: 0,
      elapsedSec: 0,
      remainingSec: 0,
      isPaused: false,
      hasOverrunPhysicalLimit: false,
      isLongBreak: false,
      isStopwatch: false
    };
  }
  const elapsedSec = Math.floor(computeElapsedMs(active, now) / 1000);
  const physicalLimitSec = BREAK_PHYSICAL_LIMIT_MIN * 60;
  const isStopwatch = active.phase === 'focus' && active.plannedDurationSec === 0;
  return {
    phase: active.phase,
    plannedSec: active.plannedDurationSec,
    elapsedSec,
    remainingSec: isStopwatch ? Infinity : active.plannedDurationSec - elapsedSec,
    isPaused: active.pausedAt !== null,
    hasOverrunPhysicalLimit:
      active.phase === 'break' && elapsedSec >= physicalLimitSec,
    isLongBreak:
      active.phase === 'break' && active.plannedDurationSec > physicalLimitSec,
    isStopwatch
  };
}

// ---------------------------------------------------------------------------
// Mutators — return a new ActiveTimer; never mutate the input.
// ---------------------------------------------------------------------------

export function createActiveTimer(opts: {
  phase: 'focus' | 'break';
  plannedDurationSec: number;
  subjectId: string | null;
  rampIndexAtStart: number;
  wasOverride: boolean;
  now: number;
}): ActiveTimer {
  return {
    phase: opts.phase,
    plannedDurationSec: opts.plannedDurationSec,
    startedAt: opts.now,
    pausedAt: null,
    pausedAccumMs: 0,
    subjectId: opts.subjectId,
    rampIndexAtStart: opts.rampIndexAtStart,
    wasOverride: opts.wasOverride
  };
}

export function pauseTimer(t: ActiveTimer, now: number): ActiveTimer {
  if (t.pausedAt !== null) return t; // already paused
  return { ...t, pausedAt: now };
}

export function resumeTimer(t: ActiveTimer, now: number): ActiveTimer {
  if (t.pausedAt === null) return t; // not paused
  const additionalPausedMs = Math.max(0, now - t.pausedAt);
  return { ...t, pausedAt: null, pausedAccumMs: t.pausedAccumMs + additionalPausedMs };
}

// Change the planned duration of an in-flight break (extend / shorten).
// Minimum one minute; no upper cap so custom long breaks are allowed.
// The UI shows a physical-break prompt (instead of a countdown) when the
// planned duration exceeds 15 min — see TimerStatus.isLongBreak.
// No-op on focus.
export function setBreakDurationSec(t: ActiveTimer, newDurationSec: number): ActiveTimer {
  if (t.phase !== 'break') return t;
  const clamped = Math.max(60, newDurationSec);
  return { ...t, plannedDurationSec: clamped };
}

// ---------------------------------------------------------------------------
// Finalization — turn an ActiveTimer into a Session row.
// ---------------------------------------------------------------------------

export function finalizeSession(opts: {
  active: ActiveTimer;
  outcome: 'completed' | 'aborted';
  now: number;
  userId: string;
  id?: string;
}): Session {
  const actualDurationSec = Math.floor(computeElapsedMs(opts.active, opts.now) / 1000);
  return {
    id: opts.id ?? crypto.randomUUID(),
    userId: opts.userId,
    // Session type mirrors the timer's phase: 'focus' or 'break'.
    type: opts.active.phase,
    subjectId: opts.active.subjectId,
    startedAt: opts.active.startedAt,
    endedAt: opts.now,
    plannedDurationSec: opts.active.plannedDurationSec,
    actualDurationSec:
      opts.outcome === 'completed' ? opts.active.plannedDurationSec : actualDurationSec,
    outcome: opts.outcome,
    rampIndexAtStart: opts.active.rampIndexAtStart,
    wasOverride: opts.active.wasOverride
  };
}

// ---------------------------------------------------------------------------
// Ramp / streak planner — pure functions over indices and durations.
// ---------------------------------------------------------------------------

// Return the next suggested focus duration in seconds for a given ramp index.
export function suggestedFocusDurationSec(rampIndex: number): number {
  const idx = Math.max(0, Math.min(rampIndex, RAMP_LADDER_MIN.length - 1));
  return RAMP_LADDER_MIN[idx] * 60;
}

// Given a completed focus duration in seconds, find the ramp index that
// matches that rung (i.e., the largest rung whose minutes <= completedMin).
export function rampIndexForCompletedDurationSec(completedDurationSec: number): number {
  const minutes = completedDurationSec / 60;
  let idx = 0;
  for (let i = 0; i < RAMP_LADDER_MIN.length; i++) {
    if (RAMP_LADDER_MIN[i] <= minutes) idx = i;
  }
  return idx;
}

// After a successful focus completion, compute the new streak counters.
// The ramp index does NOT auto-advance — the user must explicitly choose to
// climb a rung via the "ready to ramp up?" modal. This is a deliberate change:
// the original auto-advance felt too aggressive, pushing users to longer
// sessions before they had built real stamina at the current rung.
//
// `streakAtCurrentRung` increments when the user completes a focus session
// (including stopwatch or overrides) that meets or exceeds the currently-suggested duration.
export function afterFocusCompleted(opts: {
  currentStreak: number;
  streakAtCurrentRung: number;
  completedDurationSec: number;
  currentRampIndex: number;
  wasOverride: boolean;
}): { newStreak: number; newStreakAtCurrentRung: number } {
  const currentRungSec = suggestedFocusDurationSec(opts.currentRampIndex);
  // "Matched the rung" = completed at least the suggested duration.
  const matchedRung = opts.completedDurationSec >= currentRungSec;
  return {
    newStreak: opts.currentStreak + 1,
    newStreakAtCurrentRung: matchedRung
      ? opts.streakAtCurrentRung + 1
      : opts.streakAtCurrentRung
  };
}

// User explicitly chose to climb the ramp. Bump rampIndex by one and reset
// the at-rung counter. Capped at the top of the ladder.
export function manuallyAdvanceRamp(currentRampIndex: number): number {
  return Math.min(currentRampIndex + 1, RAMP_LADDER_MIN.length - 1);
}

// True when the user has earned a "ready to ramp up?" prompt right now.
// Fires at counts of 3, 6, 9, ... so the prompt nudges every third successful
// at-rung session if the user keeps choosing not to advance.
export function shouldPromptRampUp(streakAtCurrentRung: number, currentRampIndex: number): boolean {
  if (streakAtCurrentRung < 3) return false;
  if (currentRampIndex >= RAMP_LADDER_MIN.length - 1) return false; // already at top
  return streakAtCurrentRung % 3 === 0;
}

// After abort / skip / reset. Wipes both streaks and the ramp index.
export function afterFocusAborted(): {
  newStreak: number;
  newRampIndex: number;
  newStreakAtCurrentRung: number;
} {
  return { newStreak: 0, newRampIndex: 0, newStreakAtCurrentRung: 0 };
}

// ---------------------------------------------------------------------------
// Stale-timer recovery — what to do when the app loads with an activeTimer
// already in IndexedDB (tab was closed, laptop slept, etc.).
//
// Three buckets:
//   - elapsed < planned                : resume in flight
//   - planned <= elapsed < 2 * planned : auto-complete this phase, advance to
//                                        the next (focus -> break, break -> idle)
//   - elapsed >= 2 * planned           : auto-complete this phase, then idle
//                                        (don't silently cycle while user was away)
// ---------------------------------------------------------------------------

export type RecoveryAction =
  | { kind: 'idle' }
  | { kind: 'resume'; activeTimer: ActiveTimer }
  | {
      kind: 'auto-complete-advance';
      completedSession: Session;
      nextActiveTimer: ActiveTimer;
    }
  | {
      kind: 'auto-complete-idle';
      completedSession: Session;
    };

export function planRecovery(opts: {
  active: ActiveTimer | null;
  now: number;
  userId: string;
}): RecoveryAction {
  if (!opts.active) return { kind: 'idle' };

  const elapsedSec = Math.floor(computeElapsedMs(opts.active, opts.now) / 1000);
  const planned = opts.active.plannedDurationSec;

  // Still in flight — resume.
  if (elapsedSec < planned) {
    return { kind: 'resume', activeTimer: opts.active };
  }

  const completedSession = finalizeSession({
    active: opts.active,
    outcome: 'completed',
    now: opts.active.startedAt + planned * 1000 + opts.active.pausedAccumMs,
    userId: opts.userId
  });

  // Excessive — finalize but go idle. Don't auto-cycle while the user was away.
  if (elapsedSec >= planned * 2) {
    return { kind: 'auto-complete-idle', completedSession };
  }

  // Reasonable overrun — auto-advance to the next phase, starting fresh from now.
  if (opts.active.phase === 'focus') {
    const nextActiveTimer = createActiveTimer({
      phase: 'break',
      plannedDurationSec: BREAK_DEFAULT_MIN * 60,
      subjectId: opts.active.subjectId,
      rampIndexAtStart: opts.active.rampIndexAtStart,
      wasOverride: false,
      now: opts.now
    });
    return { kind: 'auto-complete-advance', completedSession, nextActiveTimer };
  }

  // Break ended while away — go idle, let the user start the next focus
  // intentionally rather than auto-starting work on a returning user.
  return { kind: 'auto-complete-idle', completedSession };
}
