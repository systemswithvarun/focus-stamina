// Domain types. These match the shape we will write to a real database later.
// `userId` is hardcoded to 'local' today; tomorrow it becomes the authenticated user id.

export type Phase = 'idle' | 'focus' | 'break';

export type SessionOutcome = 'completed' | 'aborted';

// 'focus' = a work session. 'break' = a rest session. Recording breaks
// alongside focus lets us compute total time, ratio, and skipped-break count.
export type SessionType = 'focus' | 'break';

export interface Session {
  id: string;
  userId: string;
  // 'focus' or 'break'. Optional in the type for backward compatibility with
  // older rows; the repository normalizes missing values to 'focus' on read.
  type?: SessionType;
  subjectId: string | null;
  startedAt: number;
  endedAt: number;
  plannedDurationSec: number;
  actualDurationSec: number;
  outcome: SessionOutcome;
  // Only meaningful for focus sessions.
  rampIndexAtStart: number;
  wasOverride: boolean;
}

export interface Subject {
  id: string;
  userId: string;
  name: string;
  createdAt: number;
  archivedAt: number | null;
}

export interface ActiveTimer {
  phase: 'focus' | 'break';
  plannedDurationSec: number;
  startedAt: number;
  pausedAt: number | null;
  pausedAccumMs: number;
  subjectId: string | null;
  rampIndexAtStart: number;
  wasOverride: boolean;
}

// Pending phase transition — set when a session completes, waiting on the user
// to decide what to do next. Drives the post-session modal that asks
// "Start break?" or "Start next focus?" instead of auto-advancing.
export interface PendingTransition {
  kind: 'after-focus' | 'after-break';
  completedAt: number;
  // Duration of the session we just finished, for "you just did X min" copy.
  completedDurationSec: number;
  // For after-focus: the subjectId carried over so a Start-break inherits it.
  subjectId: string | null;
}

export interface AppState {
  userId: string;
  // Total consecutive successful completions across all rungs.
  currentStreak: number;
  // Which rung of the ramp the user is at (the suggested focus duration).
  currentRampIndex: number;
  // Count of consecutive successful completions AT the current rung's suggested
  // duration with no override. Drives the "ready to ramp up?" modal: when this
  // hits a multiple of 3, the next Start press shows the modal. Override
  // completions do not increment this counter — only completing the actual
  // suggested duration counts.
  streakAtCurrentRung: number;
  activeSubjectId: string | null;
  theme: 'system' | 'light' | 'dark';
  notificationPermission: 'granted' | 'denied' | 'default';
  activeTimer: ActiveTimer | null;
  // A phase just completed and the app is waiting for the user to decide what
  // to do next (start break? start focus? skip?). Cleared when the user acts
  // or explicitly dismisses.
  pendingTransition: PendingTransition | null;
  // Map of YYYY-MM-DD (local) -> total milliseconds the app tab has been
  // visible that day. Drives the "active time" and "focus / active ratio"
  // stats on the analytics screen.
  dailyActiveMs: Record<string, number>;
}

// The ramp ladder. Each value is the focus session length in minutes.
// Index into this array tracks how far up the ladder the user has climbed.
export const RAMP_LADDER_MIN: readonly number[] = [5, 10, 15, 20, 25, 30, 40, 45] as const;

// Preset buttons shown on the timer screen for focus. Matches the ramp ladder.
export const PRESET_MINUTES: readonly number[] = [5, 10, 15, 20, 25, 30, 40, 45] as const;

// Break preset buttons (idle-screen manual break + during-break extend).
export const BREAK_PRESET_MINUTES: readonly number[] = [5, 10, 15] as const;

// Break boundaries (in minutes).
export const BREAK_DEFAULT_MIN = 5;
export const BREAK_MAX_MIN = 15;
// If a break has been running this long total, we stop auto-advancing
// and instead prompt the user to step away from the screen.
export const BREAK_PHYSICAL_LIMIT_MIN = 15;

export const LOCAL_USER_ID = 'local';

// Export bundle shape — what the user downloads / uploads.
export interface ExportBundle {
  version: 1;
  exportedAt: number;
  subjects: Subject[];
  sessions: Session[];
  appState: Omit<AppState, 'activeTimer'>;
}
