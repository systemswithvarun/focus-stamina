// Timer engine tests. The engine is pure — every function takes `now` as an
// argument, so we control the clock here without monkey-patching anything.

import { describe, it, expect } from 'vitest';
import {
  afterFocusAborted,
  afterFocusCompleted,
  computeElapsedMs,
  createActiveTimer,
  finalizeSession,
  getStatus,
  manuallyAdvanceRamp,
  pauseTimer,
  planRecovery,
  rampIndexForCompletedDurationSec,
  resumeTimer,
  setBreakDurationSec,
  shouldPromptRampUp,
  suggestedFocusDurationSec
} from './timerEngine';
import { BREAK_DEFAULT_MIN, BREAK_PHYSICAL_LIMIT_MIN, RAMP_LADDER_MIN } from '../types/models';

const T0 = 1_700_000_000_000; // arbitrary fixed epoch ms for tests

function focus(opts: Partial<Parameters<typeof createActiveTimer>[0]> = {}) {
  return createActiveTimer({
    phase: 'focus',
    plannedDurationSec: 300,
    subjectId: null,
    rampIndexAtStart: 0,
    wasOverride: false,
    now: T0,
    ...opts
  });
}

describe('computeElapsedMs', () => {
  it('returns ms since start when not paused', () => {
    const t = focus();
    expect(computeElapsedMs(t, T0 + 60_000)).toBe(60_000);
  });

  it('excludes time spent paused', () => {
    let t = focus();
    t = pauseTimer(t, T0 + 30_000); // pause at 30s
    // 30s later, while still paused — elapsed should still be 30s
    expect(computeElapsedMs(t, T0 + 60_000)).toBe(30_000);
    t = resumeTimer(t, T0 + 60_000); // resume after 30s of being paused
    // 30s after resume — elapsed should be 60s (30s before pause + 30s after)
    expect(computeElapsedMs(t, T0 + 90_000)).toBe(60_000);
  });

  it('never returns negative', () => {
    const t = focus();
    // Defensive: if a clock skew makes "now" earlier than startedAt, return 0.
    expect(computeElapsedMs(t, T0 - 1000)).toBe(0);
  });
});

describe('getStatus', () => {
  it('reports idle when there is no active timer', () => {
    const s = getStatus(null, T0);
    expect(s.phase).toBe('idle');
    expect(s.plannedSec).toBe(0);
    expect(s.elapsedSec).toBe(0);
  });

  it('reports remaining time correctly', () => {
    const t = focus({ plannedDurationSec: 300 });
    const s = getStatus(t, T0 + 60_000);
    expect(s.elapsedSec).toBe(60);
    expect(s.remainingSec).toBe(240);
  });

  it('flags break overrun once past the physical-break limit', () => {
    const brk = createActiveTimer({
      phase: 'break',
      plannedDurationSec: BREAK_DEFAULT_MIN * 60,
      subjectId: null,
      rampIndexAtStart: 0,
      wasOverride: false,
      now: T0
    });
    const beforeLimit = getStatus(brk, T0 + (BREAK_PHYSICAL_LIMIT_MIN - 1) * 60_000);
    expect(beforeLimit.hasOverrunPhysicalLimit).toBe(false);
    const atLimit = getStatus(brk, T0 + BREAK_PHYSICAL_LIMIT_MIN * 60_000);
    expect(atLimit.hasOverrunPhysicalLimit).toBe(true);
  });

  it('does not flag overrun for focus phase', () => {
    const t = focus({ plannedDurationSec: 60 });
    const s = getStatus(t, T0 + 999_999_999);
    expect(s.hasOverrunPhysicalLimit).toBe(false);
  });

  it('isLongBreak true when planned break duration > 15 min, immediately', () => {
    const longBrk = createActiveTimer({
      phase: 'break',
      plannedDurationSec: 25 * 60,
      subjectId: null,
      rampIndexAtStart: 0,
      wasOverride: false,
      now: T0
    });
    const s = getStatus(longBrk, T0); // elapsed = 0
    expect(s.isLongBreak).toBe(true);
  });

  it('isLongBreak false for a 15-min break and for focus', () => {
    const brk = createActiveTimer({
      phase: 'break',
      plannedDurationSec: 15 * 60,
      subjectId: null,
      rampIndexAtStart: 0,
      wasOverride: false,
      now: T0
    });
    expect(getStatus(brk, T0).isLongBreak).toBe(false);
    expect(getStatus(focus({ plannedDurationSec: 60 * 60 }), T0).isLongBreak).toBe(false);
  });
});

describe('pause / resume', () => {
  it('pause is idempotent', () => {
    const t = focus();
    const p1 = pauseTimer(t, T0 + 10_000);
    const p2 = pauseTimer(p1, T0 + 20_000); // second pause should be no-op
    expect(p2.pausedAt).toBe(T0 + 10_000);
  });

  it('resume on a non-paused timer is a no-op', () => {
    const t = focus();
    const r = resumeTimer(t, T0 + 10_000);
    expect(r).toEqual(t);
  });
});

describe('setBreakDurationSec', () => {
  function brk(plannedDurationSec = 300) {
    return createActiveTimer({
      phase: 'break',
      plannedDurationSec,
      subjectId: null,
      rampIndexAtStart: 0,
      wasOverride: false,
      now: T0
    });
  }

  it('updates the planned duration for a break', () => {
    const t = brk(300);
    const updated = setBreakDurationSec(t, 600);
    expect(updated.plannedDurationSec).toBe(600);
  });

  it('allows long custom breaks (no upper cap); UI shows physical-break prompt instead', () => {
    const t = brk();
    const updated = setBreakDurationSec(t, 60 * 60); // request 1 hour
    expect(updated.plannedDurationSec).toBe(60 * 60);
  });

  it('enforces a 60-second minimum on break duration', () => {
    const t = brk();
    const updated = setBreakDurationSec(t, 5); // five seconds
    expect(updated.plannedDurationSec).toBe(60);
  });

  it('is a no-op on focus', () => {
    const t = focus({ plannedDurationSec: 300 });
    const updated = setBreakDurationSec(t, 999);
    expect(updated.plannedDurationSec).toBe(300);
  });
});

describe('finalizeSession', () => {
  it('records actualDurationSec = plannedDurationSec on completion', () => {
    const t = focus({ plannedDurationSec: 600 });
    const session = finalizeSession({
      active: t,
      outcome: 'completed',
      now: T0 + 600_000,
      userId: 'local'
    });
    expect(session.actualDurationSec).toBe(600);
    expect(session.outcome).toBe('completed');
  });

  it('records actualDurationSec = elapsed on abort', () => {
    const t = focus({ plannedDurationSec: 600 });
    const session = finalizeSession({
      active: t,
      outcome: 'aborted',
      now: T0 + 120_000, // aborted after 2 min
      userId: 'local'
    });
    expect(session.actualDurationSec).toBe(120);
    expect(session.outcome).toBe('aborted');
  });
});

describe('ramp / streak planner', () => {
  it('suggestedFocusDurationSec returns RAMP_LADDER values in seconds', () => {
    expect(suggestedFocusDurationSec(0)).toBe(5 * 60);
    expect(suggestedFocusDurationSec(7)).toBe(45 * 60);
  });

  it('suggestedFocusDurationSec clamps at the top of the ladder', () => {
    expect(suggestedFocusDurationSec(99)).toBe(45 * 60);
    expect(suggestedFocusDurationSec(-1)).toBe(5 * 60);
  });

  it('rampIndexForCompletedDurationSec maps minutes to the right rung', () => {
    expect(rampIndexForCompletedDurationSec(5 * 60)).toBe(0);
    expect(rampIndexForCompletedDurationSec(10 * 60)).toBe(1);
    expect(rampIndexForCompletedDurationSec(45 * 60)).toBe(RAMP_LADDER_MIN.length - 1);
    expect(rampIndexForCompletedDurationSec(38 * 60)).toBe(5); // 30 min rung
  });

  it('afterFocusCompleted increments at-rung streak when no override and rung matched', () => {
    // Rung 0 = 5 min. User completes 5 min, no override. At-rung streak goes 0 -> 1.
    const r = afterFocusCompleted({
      currentStreak: 2,
      streakAtCurrentRung: 0,
      completedDurationSec: 5 * 60,
      currentRampIndex: 0,
      wasOverride: false
    });
    expect(r.newStreak).toBe(3);
    expect(r.newStreakAtCurrentRung).toBe(1);
  });

  it('afterFocusCompleted does NOT increment at-rung streak when wasOverride=true', () => {
    // Rung 0 (5 min). User overrode to 10 and completed.
    const r = afterFocusCompleted({
      currentStreak: 4,
      streakAtCurrentRung: 2,
      completedDurationSec: 10 * 60,
      currentRampIndex: 0,
      wasOverride: true
    });
    expect(r.newStreak).toBe(5);
    expect(r.newStreakAtCurrentRung).toBe(2); // unchanged
  });

  it('afterFocusCompleted does NOT advance the ramp index automatically', () => {
    const r = afterFocusCompleted({
      currentStreak: 0,
      streakAtCurrentRung: 0,
      completedDurationSec: 5 * 60,
      currentRampIndex: 0,
      wasOverride: false
    });
    // No rampIndex in the return shape — engine cannot auto-advance the ramp.
    expect((r as { newRampIndex?: number }).newRampIndex).toBeUndefined();
  });

  it('manuallyAdvanceRamp bumps by one and caps at the top of the ladder', () => {
    expect(manuallyAdvanceRamp(0)).toBe(1);
    expect(manuallyAdvanceRamp(6)).toBe(7);
    expect(manuallyAdvanceRamp(7)).toBe(7); // already at top
  });

  it('shouldPromptRampUp triggers at multiples of 3 below the top rung', () => {
    expect(shouldPromptRampUp(0, 0)).toBe(false);
    expect(shouldPromptRampUp(2, 0)).toBe(false);
    expect(shouldPromptRampUp(3, 0)).toBe(true);
    expect(shouldPromptRampUp(4, 0)).toBe(false);
    expect(shouldPromptRampUp(6, 0)).toBe(true);
    expect(shouldPromptRampUp(9, 0)).toBe(true);
  });

  it('shouldPromptRampUp returns false at top of ramp', () => {
    expect(shouldPromptRampUp(3, RAMP_LADDER_MIN.length - 1)).toBe(false);
    expect(shouldPromptRampUp(9, RAMP_LADDER_MIN.length - 1)).toBe(false);
  });

  it('afterFocusAborted resets streak, at-rung streak, and ramp index', () => {
    const r = afterFocusAborted();
    expect(r.newStreak).toBe(0);
    expect(r.newRampIndex).toBe(0);
    expect(r.newStreakAtCurrentRung).toBe(0);
  });
});

describe('planRecovery', () => {
  it('returns idle when there is no active timer', () => {
    const action = planRecovery({ active: null, now: T0, userId: 'local' });
    expect(action.kind).toBe('idle');
  });

  it('resumes when elapsed < planned', () => {
    const t = focus({ plannedDurationSec: 300 });
    const action = planRecovery({ active: t, now: T0 + 60_000, userId: 'local' });
    expect(action.kind).toBe('resume');
    if (action.kind === 'resume') {
      expect(action.activeTimer).toEqual(t);
    }
  });

  it('auto-completes focus and advances to a break when planned <= elapsed < 2 * planned', () => {
    const t = focus({ plannedDurationSec: 300 });
    // Reopen 7 minutes later — planned was 5 min, elapsed is 7 min => < 2x
    const action = planRecovery({ active: t, now: T0 + 7 * 60_000, userId: 'local' });
    expect(action.kind).toBe('auto-complete-advance');
    if (action.kind === 'auto-complete-advance') {
      expect(action.completedSession.outcome).toBe('completed');
      expect(action.completedSession.actualDurationSec).toBe(300);
      expect(action.nextActiveTimer.phase).toBe('break');
      expect(action.nextActiveTimer.plannedDurationSec).toBe(BREAK_DEFAULT_MIN * 60);
      expect(action.nextActiveTimer.startedAt).toBe(T0 + 7 * 60_000);
    }
  });

  it('auto-completes and goes idle when elapsed >= 2 * planned', () => {
    const t = focus({ plannedDurationSec: 300 });
    // Reopen 20 minutes later — planned was 5 min, 4x over.
    const action = planRecovery({ active: t, now: T0 + 20 * 60_000, userId: 'local' });
    expect(action.kind).toBe('auto-complete-idle');
    if (action.kind === 'auto-complete-idle') {
      expect(action.completedSession.outcome).toBe('completed');
    }
  });

  it('auto-completes break and goes idle when break elapsed > planned (does not auto-start focus)', () => {
    const brk = createActiveTimer({
      phase: 'break',
      plannedDurationSec: BREAK_DEFAULT_MIN * 60,
      subjectId: null,
      rampIndexAtStart: 0,
      wasOverride: false,
      now: T0
    });
    const action = planRecovery({
      active: brk,
      now: T0 + 7 * 60_000, // break overran by a couple minutes
      userId: 'local'
    });
    expect(action.kind).toBe('auto-complete-idle');
  });
});
