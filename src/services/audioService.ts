// Audio service.
//
// Web Audio API. AudioContext must be unlocked by a user gesture — we unlock on
// the first Start click and keep the context alive for the life of the page.
//
// For the background-tab reliability story: we schedule the chime at an exact
// AudioContext clock time (not via setTimeout). AudioContext.currentTime keeps
// running accurately in backgrounded tabs across Chrome / Firefox / Safari,
// because real-time audio glitches are user-hostile so browsers don't throttle
// the audio thread.

let audioCtx: AudioContext | null = null;
let unlocked = false;

interface ScheduledChime {
  oscillator: OscillatorNode;
  gain: GainNode;
  cancelTimer: ReturnType<typeof setTimeout> | null;
}

let scheduled: ScheduledChime | null = null;

export function isAudioUnlocked(): boolean {
  return unlocked;
}

// Call this from within a user-gesture handler (e.g., the Start button onClick).
export async function unlockAudio(): Promise<void> {
  if (unlocked) return;
  const Ctor =
    (window.AudioContext as typeof AudioContext) ||
    ((window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext);
  if (!Ctor) throw new Error('Web Audio API not supported in this browser');
  audioCtx = new Ctor();
  if (audioCtx.state === 'suspended') {
    await audioCtx.resume();
  }
  // iOS Safari quirk: play a silent buffer to fully unlock.
  const buffer = audioCtx.createBuffer(1, 1, 22050);
  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(audioCtx.destination);
  source.start(0);
  unlocked = true;
}

// Play a clean chime right now.
export function playChime(opts: { frequencyHz?: number; durationMs?: number; volume?: number } = {}): void {
  if (!audioCtx) return;
  // If the context drifted to suspended (browser autosuspend), nudge it.
  if (audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  const freq = opts.frequencyHz ?? 660;
  const durationMs = opts.durationMs ?? 280;
  const volume = opts.volume ?? 0.5;
  const t = audioCtx.currentTime;
  buildChime(audioCtx, t, freq, durationMs, volume);
}

// Play a more attention-grabbing pattern for phase transitions: two chimes,
// the second a bit higher. Louder than the single chime so it cuts through
// other audio (music, video calls, etc.).
export function playTransitionAlert(): void {
  if (!audioCtx) return;
  if (audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  const t = audioCtx.currentTime;
  buildChime(audioCtx, t, 660, 220, 0.55);
  buildChime(audioCtx, t + 0.28, 880, 260, 0.55);
}

// Schedule the chime to fire at a specific epoch-ms time. Returns a cancel handle.
// If the target time is in the past, fires immediately.
export function scheduleChimeAt(opts: {
  targetEpochMs: number;
  frequencyHz?: number;
  durationMs?: number;
  volume?: number;
}): void {
  if (!audioCtx) return;
  cancelScheduledChime();
  const freq = opts.frequencyHz ?? 660;
  const durationMs = opts.durationMs ?? 280;
  const volume = opts.volume ?? 0.3;
  const offsetMs = opts.targetEpochMs - Date.now();
  const ctxTargetTime = audioCtx.currentTime + Math.max(0, offsetMs) / 1000;
  const { osc, gain } = buildChime(audioCtx, ctxTargetTime, freq, durationMs, volume);
  // We also set a setTimeout as a belt-and-suspenders fallback — if the page is
  // foregrounded and audioCtx is paused for any reason, we still chime.
  const cancelTimer = setTimeout(
    () => {
      if (!audioCtx) return;
      if (audioCtx.state === 'suspended') {
        // The scheduled oscillator probably didn't fire; play a fresh one now.
        playChime({ frequencyHz: freq, durationMs, volume });
      }
    },
    Math.max(0, offsetMs) + durationMs + 50
  );
  scheduled = { oscillator: osc, gain, cancelTimer };
}

export function cancelScheduledChime(): void {
  if (!scheduled) return;
  try {
    scheduled.oscillator.stop();
  } catch {
    // Already stopped — ignore.
  }
  if (scheduled.cancelTimer) clearTimeout(scheduled.cancelTimer);
  scheduled = null;
}

function buildChime(
  ctx: AudioContext,
  startTime: number,
  freq: number,
  durationMs: number,
  volume: number
): { osc: OscillatorNode; gain: GainNode } {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  osc.connect(gain);
  gain.connect(ctx.destination);
  const dur = durationMs / 1000;
  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(volume, startTime + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.001, startTime + dur);
  osc.start(startTime);
  osc.stop(startTime + dur + 0.05);
  return { osc, gain };
}
