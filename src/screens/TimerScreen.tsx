// Timer screen — the main view.
//
// Three states drive layout:
//   - idle:  pick a subject, presets + custom focus duration, big Start button.
//            A "ready to ramp up?" modal can fire on Start when the user has
//            completed 3 (or 6, 9, ...) at-rung sessions without advancing.
//   - focus: big countdown, pause/resume, abort, manual complete.
//   - break: countdown + extend buttons (5/10/15/custom) for normal breaks;
//            "step away" physical-break UI when the planned break > 15 min
//            (custom long break) OR when elapsed >= 15 min.

import { useState } from 'react';
import { useTimer } from '../hooks/useTimer';
import { useSubjects } from '../hooks/useSubjects';
import {
  shouldPromptRampUp,
  suggestedFocusDurationSec
} from '../services/timerEngine';
import {
  BREAK_DEFAULT_MIN,
  BREAK_PHYSICAL_LIMIT_MIN,
  BREAK_PRESET_MINUTES,
  PRESET_MINUTES,
  RAMP_LADDER_MIN
} from '../types/models';
import './TimerScreen.css';

const CUSTOM_FOCUS_MIN_MAX = 240; // sanity cap: 4 hours
const CUSTOM_BREAK_MIN_MAX = 120; // sanity cap: 2 hours

export function TimerScreen() {
  const {
    status,
    appState,
    loading,
    startFocus,
    startBreak,
    pause,
    resume,
    abort,
    advanceRamp,
    dismissTransition,
    completeNow,
    extendBreakBy,
    skipBreak,
    setActiveSubject
  } = useTimer();
  const { subjects } = useSubjects();

  // Idle-state UI: which mode is the user starting from idle? Focus or break.
  // Each mode has its own preset selection + custom-input state.
  const [idleMode, setIdleMode] = useState<'focus' | 'break'>('focus');

  // Focus preset state.
  const [selectedPresetMin, setSelectedPresetMin] = useState<number | null>(null);
  const [customMode, setCustomMode] = useState(false);
  const [customMinText, setCustomMinText] = useState('');

  // Break preset state (from idle).
  const [idleBreakMin, setIdleBreakMin] = useState<number>(BREAK_DEFAULT_MIN);
  const [idleBreakCustomMode, setIdleBreakCustomMode] = useState(false);
  const [idleBreakCustomText, setIdleBreakCustomText] = useState('');

  // Custom-break state during a running break (extend control).
  const [customBreakMode, setCustomBreakMode] = useState(false);
  const [customBreakText, setCustomBreakText] = useState('');

  // Ramp-up modal state.
  const [modal, setModal] = useState<null | { suggestedMin: number; nextRungMin: number }>(null);

  if (loading || !appState) {
    return (
      <div className="timer-screen">
        <div className="timer-loading">…</div>
      </div>
    );
  }

  const suggestedMin = Math.round(suggestedFocusDurationSec(appState.currentRampIndex) / 60);

  // Resolve "what duration is the user about to start?"
  let chosenMin: number;
  let chosenIsCustom = false;
  if (customMode) {
    const parsed = parseInt(customMinText, 10);
    chosenMin = Number.isFinite(parsed) && parsed > 0 ? parsed : suggestedMin;
    chosenIsCustom = true;
  } else if (selectedPresetMin !== null) {
    chosenMin = selectedPresetMin;
  } else {
    chosenMin = suggestedMin;
  }
  const isOverride = chosenIsCustom || chosenMin !== suggestedMin;

  const handlePickPreset = (m: number) => {
    setCustomMode(false);
    setSelectedPresetMin(m);
  };

  const handleEnterCustom = () => {
    setCustomMode(true);
    setSelectedPresetMin(null);
    if (!customMinText) setCustomMinText(String(suggestedMin));
  };

  const handleStartFocus = async () => {
    // Validate custom input.
    let runDurationMin = chosenMin;
    if (customMode) {
      const parsed = parseInt(customMinText, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) return;
      runDurationMin = Math.min(parsed, CUSTOM_FOCUS_MIN_MAX);
    }

    // Ramp-up modal: only when starting at the suggested duration with no
    // override (custom counts as override). User has earned the prompt if their
    // at-rung streak hits 3, 6, 9, ...
    if (
      !isOverride &&
      runDurationMin === suggestedMin &&
      shouldPromptRampUp(appState.streakAtCurrentRung, appState.currentRampIndex)
    ) {
      const nextIdx = Math.min(appState.currentRampIndex + 1, RAMP_LADDER_MIN.length - 1);
      setModal({
        suggestedMin,
        nextRungMin: RAMP_LADDER_MIN[nextIdx]
      });
      return;
    }

    await startFocus(runDurationMin * 60, appState.activeSubjectId, isOverride);
    setSelectedPresetMin(null);
    setCustomMode(false);
    setCustomMinText('');
  };

  // Modal actions.
  const handleModalRampUp = async () => {
    if (!modal) return;
    await advanceRamp();
    // After the ramp advances, start at the new (higher) rung's duration.
    await startFocus(modal.nextRungMin * 60, appState.activeSubjectId, false);
    setSelectedPresetMin(null);
    setCustomMode(false);
    setCustomMinText('');
    setModal(null);
  };
  const handleModalStay = async () => {
    if (!modal) return;
    // User declined to advance; start at the current rung's duration as planned.
    await startFocus(modal.suggestedMin * 60, appState.activeSubjectId, false);
    setSelectedPresetMin(null);
    setModal(null);
  };
  const handleModalCancel = () => setModal(null);

  const handleSubjectChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value;
    void setActiveSubject(value === '' ? null : value);
  };

  // Custom break submit (during break state).
  const handleSubmitCustomBreak = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parseInt(customBreakText, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return;
    const clamped = Math.min(parsed, CUSTOM_BREAK_MIN_MAX);
    void extendBreakBy(clamped * 60);
    setCustomBreakMode(false);
    setCustomBreakText('');
  };

  // Resolve break duration from idle break state.
  const idleBreakChosenMin = idleBreakCustomMode
    ? (() => {
        const p = parseInt(idleBreakCustomText, 10);
        return Number.isFinite(p) && p > 0 ? p : BREAK_DEFAULT_MIN;
      })()
    : idleBreakMin;

  const handleStartIdleBreak = async () => {
    let runMin = idleBreakChosenMin;
    if (idleBreakCustomMode) {
      const p = parseInt(idleBreakCustomText, 10);
      if (!Number.isFinite(p) || p <= 0) return;
      runMin = Math.min(p, CUSTOM_BREAK_MIN_MAX);
    }
    await startBreak(runMin * 60);
    // Reset idle break UI for the next time we come back to idle.
    setIdleBreakMin(BREAK_DEFAULT_MIN);
    setIdleBreakCustomMode(false);
    setIdleBreakCustomText('');
  };

  // -------------------------------------------------------- IDLE state --
  if (status.phase === 'idle') {
    const atTop = appState.currentRampIndex >= RAMP_LADDER_MIN.length - 1;
    const nextLabel = atTop && appState.currentStreak > 0
      ? 'top of the ramp'
      : appState.currentStreak === 0
      ? 'start at 5 min'
      : `next up: ${suggestedMin} min`;

    const headerMin = idleMode === 'focus' ? chosenMin : idleBreakChosenMin;

    return (
      <div className="timer-screen">
        <div className="ramp-status">
          <span className="text-dim">{nextLabel}</span>
          {appState.currentStreak > 0 && (
            <span className="streak-badge">streak {appState.currentStreak}</span>
          )}
          {appState.streakAtCurrentRung > 0 && !atTop && (
            <span className="streak-badge subtle">
              {appState.streakAtCurrentRung} at this rung
            </span>
          )}
        </div>

        <div className="mode-tabs" role="tablist" aria-label="Pick session type">
          <button
            role="tab"
            aria-selected={idleMode === 'focus'}
            className={`mode-tab ${idleMode === 'focus' ? 'is-active' : ''}`}
            onClick={() => setIdleMode('focus')}
          >
            Focus
          </button>
          <button
            role="tab"
            aria-selected={idleMode === 'break'}
            className={`mode-tab break ${idleMode === 'break' ? 'is-active' : ''}`}
            onClick={() => setIdleMode('break')}
          >
            Break
          </button>
        </div>

        <div className={`big-countdown idle ${idleMode === 'break' ? 'break' : ''}`}>
          <span className="mono">{headerMin}</span>
          <span className="big-countdown-unit">min</span>
        </div>

        {idleMode === 'focus' && (
          <>
            <div className="subject-row">
              <label htmlFor="subject-pick" className="text-dim">Subject</label>
              <select
                id="subject-pick"
                value={appState.activeSubjectId ?? ''}
                onChange={handleSubjectChange}
              >
                <option value="">Unassigned</option>
                {subjects.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>

            <div className="preset-row">
              {PRESET_MINUTES.map((m) => (
                <button
                  key={m}
                  className={`preset ${!customMode && chosenMin === m ? 'is-selected' : ''} ${m === suggestedMin ? 'is-suggested' : ''}`}
                  onClick={() => handlePickPreset(m)}
                >
                  {m}
                </button>
              ))}
              <button
                className={`preset custom ${customMode ? 'is-selected' : ''}`}
                onClick={handleEnterCustom}
              >
                Custom
              </button>
            </div>

            {customMode && (
              <div className="custom-input-row">
                <label htmlFor="custom-focus" className="text-dim">
                  Custom minutes
                </label>
                <input
                  id="custom-focus"
                  type="number"
                  min={1}
                  max={CUSTOM_FOCUS_MIN_MAX}
                  inputMode="numeric"
                  value={customMinText}
                  onChange={(e) => setCustomMinText(e.target.value)}
                  autoFocus
                />
              </div>
            )}

            <button
              className="btn btn-primary start-btn"
              onClick={() => void handleStartFocus()}
              disabled={customMode && (!customMinText || parseInt(customMinText, 10) <= 0)}
            >
              Start {chosenMin}-min focus
            </button>
          </>
        )}

        {idleMode === 'break' && (
          <>
            <div className="preset-row break-preset-row">
              {BREAK_PRESET_MINUTES.map((m) => (
                <button
                  key={m}
                  className={`preset break ${!idleBreakCustomMode && idleBreakMin === m ? 'is-selected' : ''}`}
                  onClick={() => {
                    setIdleBreakCustomMode(false);
                    setIdleBreakMin(m);
                  }}
                >
                  {m}
                </button>
              ))}
              <button
                className={`preset custom break ${idleBreakCustomMode ? 'is-selected' : ''}`}
                onClick={() => {
                  setIdleBreakCustomMode(true);
                  if (!idleBreakCustomText) setIdleBreakCustomText(String(idleBreakMin));
                }}
              >
                Custom
              </button>
            </div>

            {idleBreakCustomMode && (
              <div className="custom-input-row">
                <label htmlFor="custom-break-idle" className="text-dim">
                  Custom minutes
                </label>
                <input
                  id="custom-break-idle"
                  type="number"
                  min={1}
                  max={CUSTOM_BREAK_MIN_MAX}
                  inputMode="numeric"
                  value={idleBreakCustomText}
                  onChange={(e) => setIdleBreakCustomText(e.target.value)}
                  autoFocus
                />
              </div>
            )}

            <button
              className="btn btn-primary start-btn break"
              onClick={() => void handleStartIdleBreak()}
              disabled={
                idleBreakCustomMode &&
                (!idleBreakCustomText || parseInt(idleBreakCustomText, 10) <= 0)
              }
            >
              Start {idleBreakChosenMin}-min break
            </button>

            {idleBreakChosenMin > BREAK_PHYSICAL_LIMIT_MIN && (
              <p className="text-faint override-note">
                Break longer than {BREAK_PHYSICAL_LIMIT_MIN} min — the screen will tell
                you to step away from your desk instead of showing a countdown.
              </p>
            )}
          </>
        )}

        {idleMode === 'focus' && isOverride && (
          <p className="text-faint override-note">
            {chosenIsCustom
              ? `Custom duration. Streak counts; doesn't earn ramp progress.`
              : `Overriding the ${suggestedMin}-min suggestion. Streak counts; doesn't earn ramp progress.`}
          </p>
        )}

        {modal && (
          <RampUpModal
            currentMin={modal.suggestedMin}
            nextMin={modal.nextRungMin}
            atRungCount={appState.streakAtCurrentRung}
            onRampUp={() => void handleModalRampUp()}
            onStay={() => void handleModalStay()}
            onCancel={handleModalCancel}
          />
        )}

        {appState.pendingTransition && (
          <TransitionModal
            transition={appState.pendingTransition}
            suggestedNextFocusMin={suggestedMin}
            onStartBreak={async () => {
              await startBreak(BREAK_DEFAULT_MIN * 60);
            }}
            onStartFocus={async () => {
              await startFocus(suggestedMin * 60, appState.activeSubjectId, false);
            }}
            onDismiss={() => void dismissTransition()}
          />
        )}
      </div>
    );
  }

  // -------------------------------------------------------- FOCUS state --
  if (status.phase === 'focus') {
    return (
      <div className="timer-screen">
        <div className="phase-label">FOCUS</div>
        <CountdownDisplay
          remainingSec={Math.max(0, status.remainingSec)}
          plannedSec={status.plannedSec}
        />
        <div className="subject-tag text-dim">
          {currentSubjectName(subjects, appState.activeSubjectId)}
        </div>
        <div className="action-row">
          {status.isPaused ? (
            <button className="btn btn-primary" onClick={() => void resume()}>Resume</button>
          ) : (
            <button className="btn" onClick={() => void pause()}>Pause</button>
          )}
          <button className="btn" onClick={() => void completeNow()}>
            I'm done
          </button>
          <button className="btn btn-danger" onClick={() => void abort()}>Reset</button>
        </div>
        <p className="text-faint hint">
          Tab can be backgrounded — the chime will pull you back.
        </p>
      </div>
    );
  }

  // -------------------------------------------------------- BREAK state --
  const elapsedMin = Math.floor(status.elapsedSec / 60);
  const plannedMin = Math.round(status.plannedSec / 60);
  // Long-break UI fires when EITHER the planned break is already > 15 min
  // (the user picked a long custom break and we honor it) OR the running break
  // has elapsed past the 15-min mark (regular break that overran).
  const showPhysicalBreak = status.isLongBreak || status.hasOverrunPhysicalLimit;

  return (
    <div className="timer-screen">
      <div className="phase-label phase-break">BREAK</div>
      {showPhysicalBreak ? (
        <div className="physical-break-prompt">
          <div className="physical-break-icon">🚶</div>
          {status.isLongBreak ? (
            <>
              <h2>Take a longer break away from your desk.</h2>
              <p className="text-dim">
                You picked a {plannedMin}-min break. That's long enough that staring at
                this screen would defeat the purpose. Stand up, walk around, get some
                water — let your eyes look at something more than 6 feet away.
              </p>
            </>
          ) : (
            <>
              <h2>Step away from the screen.</h2>
              <p className="text-dim">
                You've been on break for {elapsedMin} min. That's long enough to count as
                a real break — stand up, walk somewhere, look at something further than
                6 feet away.
              </p>
            </>
          )}
          <p className="text-dim">When you're ready to come back, hit the button below.</p>
          <button className="btn btn-primary big" onClick={() => void skipBreak()}>
            Ready to focus
          </button>
        </div>
      ) : (
        <>
          <CountdownDisplay
            remainingSec={Math.max(0, status.remainingSec)}
            plannedSec={status.plannedSec}
          />
          <div className="break-extend-row">
            <span className="text-dim">Set break to</span>
            {[5, 10, 15].map((m) => (
              <button
                key={m}
                className={`preset small ${status.plannedSec === m * 60 ? 'is-selected' : ''}`}
                onClick={() => void extendBreakBy(m * 60)}
              >
                {m}
              </button>
            ))}
            <button
              className={`preset small custom ${customBreakMode ? 'is-selected' : ''}`}
              onClick={() => setCustomBreakMode((v) => !v)}
            >
              Custom
            </button>
          </div>
          {customBreakMode && (
            <form className="custom-input-row" onSubmit={handleSubmitCustomBreak}>
              <label htmlFor="custom-break" className="text-dim">Custom minutes</label>
              <input
                id="custom-break"
                type="number"
                min={1}
                max={CUSTOM_BREAK_MIN_MAX}
                inputMode="numeric"
                value={customBreakText}
                onChange={(e) => setCustomBreakText(e.target.value)}
                autoFocus
              />
              <button className="btn btn-primary" type="submit">
                Set
              </button>
              <p className="text-faint custom-break-warn">
                Picking more than 15 min switches to a "step away from your desk" view.
              </p>
            </form>
          )}
          <div className="action-row">
            {status.isPaused ? (
              <button className="btn btn-primary" onClick={() => void resume()}>Resume</button>
            ) : (
              <button className="btn" onClick={() => void pause()}>Pause</button>
            )}
            <button className="btn btn-ghost" onClick={() => void skipBreak()}>Skip break</button>
          </div>
          <p className="text-faint hint">
            Past {BREAK_PHYSICAL_LIMIT_MIN} min the app will tell you to step away.
          </p>
        </>
      )}
    </div>
  );
}

// -------------------------------------------------------------- helpers --

function currentSubjectName(subjects: { id: string; name: string }[], id: string | null): string {
  if (!id) return 'Unassigned';
  return subjects.find((s) => s.id === id)?.name ?? 'Unassigned';
}

function CountdownDisplay({
  remainingSec,
  plannedSec
}: {
  remainingSec: number;
  plannedSec: number;
}) {
  const mm = Math.floor(remainingSec / 60).toString().padStart(2, '0');
  const ss = (remainingSec % 60).toString().padStart(2, '0');
  const progress = plannedSec > 0 ? 1 - remainingSec / plannedSec : 0;
  const circumference = 2 * Math.PI * 110;
  return (
    <div className="big-countdown">
      <svg className="progress-ring" width="260" height="260" viewBox="0 0 260 260">
        <circle cx="130" cy="130" r="110" className="ring-track" fill="none" strokeWidth="6" />
        <circle
          cx="130"
          cy="130"
          r="110"
          className="ring-fill"
          fill="none"
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - progress)}
          transform="rotate(-90 130 130)"
        />
      </svg>
      <div className="countdown-text">
        <span className="mono countdown-mm">{mm}</span>
        <span className="mono countdown-sep">:</span>
        <span className="mono countdown-ss">{ss}</span>
      </div>
    </div>
  );
}

function TransitionModal({
  transition,
  suggestedNextFocusMin,
  onStartBreak,
  onStartFocus,
  onDismiss
}: {
  transition: { kind: 'after-focus' | 'after-break'; completedDurationSec: number };
  suggestedNextFocusMin: number;
  onStartBreak: () => Promise<void>;
  onStartFocus: () => Promise<void>;
  onDismiss: () => void;
}) {
  const completedMin = Math.round(transition.completedDurationSec / 60);
  const isAfterFocus = transition.kind === 'after-focus';

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal-card transition-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-eyebrow good">
          {isAfterFocus ? '✓ Focus complete' : '✓ Break over'}
        </div>
        {isAfterFocus ? (
          <>
            <h2>Nice — {completedMin} min done.</h2>
            <p className="text-dim">
              Ready for a {BREAK_DEFAULT_MIN}-min break? You can extend it during the
              break if you need more.
            </p>
            <div className="modal-actions">
              <button
                className="btn btn-primary big"
                onClick={() => void onStartBreak()}
              >
                Start {BREAK_DEFAULT_MIN}-min break
              </button>
              <button className="btn big" onClick={onDismiss}>
                Skip break
              </button>
            </div>
          </>
        ) : (
          <>
            <h2>Break done.</h2>
            <p className="text-dim">
              Ready for the next focus session? Suggested length: {suggestedNextFocusMin} min.
            </p>
            <div className="modal-actions">
              <button
                className="btn btn-primary big"
                onClick={() => void onStartFocus()}
              >
                Start {suggestedNextFocusMin}-min focus
              </button>
              <button className="btn big" onClick={onDismiss}>
                Not now
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function RampUpModal({
  currentMin,
  nextMin,
  atRungCount,
  onRampUp,
  onStay,
  onCancel
}: {
  currentMin: number;
  nextMin: number;
  atRungCount: number;
  onRampUp: () => void;
  onStay: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onCancel}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-eyebrow text-dim">Ready to ramp up?</div>
        <h2>You've done {atRungCount} sessions at {currentMin} min.</h2>
        <p className="text-dim">
          Try a {nextMin}-min session instead? You can always come back to {currentMin} min later.
          Your streak stays intact either way.
        </p>
        <div className="modal-actions">
          <button className="btn btn-primary big" onClick={onRampUp}>
            Yes — try {nextMin} min
          </button>
          <button className="btn big" onClick={onStay}>
            Stay at {currentMin} min
          </button>
        </div>
        <button className="btn btn-ghost modal-cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
