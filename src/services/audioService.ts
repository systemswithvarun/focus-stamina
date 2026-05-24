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
  oscillators: OscillatorNode[];
  gains: GainNode[];
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

// Play a single clean chime right now.
export function playChime(opts: { frequencyHz?: number; durationMs?: number; volume?: number } = {}): void {
  if (!audioCtx) return;
  // If the context drifted to suspended (browser autosuspend), nudge it.
  if (audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  const freq = opts.frequencyHz ?? 660;
  const durationMs = opts.durationMs ?? 400;
  const volume = opts.volume ?? 0.7;
  const t = audioCtx.currentTime;
  buildChime(audioCtx, t, freq, durationMs, volume);
}

// Play a loud, attention-grabbing pattern for phase transitions.
// Repeating ascending 3-chime pattern (ding-ding-DING × 2) over ~3 seconds.
// Loud enough to cut through music, video calls, and other background audio.
export function playTransitionAlert(): void {
  if (!audioCtx) return;
  if (audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  const t = audioCtx.currentTime;
  // Ascending pitches: E5 → G5 → B5 (a major triad — pleasant but attention-grabbing).
  const pattern: [number, number][] = [
    [660,  0.80],  // E5 — first ding
    [784,  0.85],  // G5 — second ding (slightly louder)
    [988,  0.90],  // B5 — third DING (loudest, highest)
  ];
  const chimeSpacing = 0.32;  // seconds between chimes within a group
  const groupGap = 0.55;      // seconds gap between the two groups
  const chimeDur = 400;        // ms per chime

  // Play the pattern twice.
  for (let rep = 0; rep < 2; rep++) {
    const groupStart = rep * (pattern.length * chimeSpacing + groupGap);
    for (let i = 0; i < pattern.length; i++) {
      const [freq, vol] = pattern[i];
      buildChime(audioCtx, t + groupStart + i * chimeSpacing, freq, chimeDur, vol);
    }
  }
}

// Schedule the transition alert to fire at a specific epoch-ms time.
// Returns nothing; call cancelScheduledChime() to abort.
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
  const durationMs = opts.durationMs ?? 400;
  const volume = opts.volume ?? 0.7;
  const offsetMs = opts.targetEpochMs - Date.now();
  const ctxTargetTime = audioCtx.currentTime + Math.max(0, offsetMs) / 1000;
  const { oscillators, gains } = buildChime(audioCtx, ctxTargetTime, freq, durationMs, volume);
  // We also set a setTimeout as a belt-and-suspenders fallback — if the page is
  // foregrounded and audioCtx is paused for any reason, we still fire the full
  // transition alert (not just a single quiet chime).
  const cancelTimer = setTimeout(
    () => {
      if (!audioCtx) return;
      if (audioCtx.state === 'suspended') {
        // The scheduled oscillator probably didn't fire; play the full alert now.
        playTransitionAlert();
      }
    },
    Math.max(0, offsetMs) + durationMs + 50
  );
  scheduled = { oscillators, gains, cancelTimer };
}

export function cancelScheduledChime(): void {
  if (!scheduled) return;
  for (const osc of scheduled.oscillators) {
    try {
      osc.stop();
    } catch {
      // Already stopped — ignore.
    }
  }
  if (scheduled.cancelTimer) clearTimeout(scheduled.cancelTimer);
  scheduled = null;
}

// Build a single rich chime using multi-oscillator synthesis.
// Returns all created oscillators/gains so they can be tracked and cancelled.
function buildChime(
  ctx: AudioContext,
  startTime: number,
  freq: number,
  durationMs: number,
  volume: number
): { oscillators: OscillatorNode[]; gains: GainNode[] } {
  const dur = durationMs / 1000;
  const oscillators: OscillatorNode[] = [];
  const gains: GainNode[] = [];

  // Lowpass filter to prevent harsh digital artifacts.
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = freq * 2.5;
  filter.Q.value = 1;
  filter.connect(ctx.destination);

  // Layer 1: primary sine wave (clean fundamental tone).
  {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    osc.connect(gain);
    gain.connect(filter);
    gain.gain.setValueAtTime(0, startTime);
    gain.gain.linearRampToValueAtTime(volume, startTime + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.001, startTime + dur);
    osc.start(startTime);
    osc.stop(startTime + dur + 0.05);
    oscillators.push(osc);
    gains.push(gain);
  }

  // Layer 2: quiet triangle wave for warmth/body.
  {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    osc.connect(gain);
    gain.connect(filter);
    const triVol = volume * 0.35;
    gain.gain.setValueAtTime(0, startTime);
    gain.gain.linearRampToValueAtTime(triVol, startTime + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.001, startTime + dur);
    osc.start(startTime);
    osc.stop(startTime + dur + 0.05);
    oscillators.push(osc);
    gains.push(gain);
  }

  // Layer 3: quiet sine at the octave (freq × 2) for a bright bell-like ring.
  {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq * 2;
    osc.connect(gain);
    gain.connect(filter);
    const octVol = volume * 0.2;
    gain.gain.setValueAtTime(0, startTime);
    gain.gain.linearRampToValueAtTime(octVol, startTime + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.001, startTime + dur * 0.7);
    osc.start(startTime);
    osc.stop(startTime + dur + 0.05);
    oscillators.push(osc);
    gains.push(gain);
  }

  return { oscillators, gains };
}
