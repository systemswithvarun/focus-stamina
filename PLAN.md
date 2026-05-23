# Focus Stamina — Phase 1 Design Plan

**Status:** Draft for review. Do not build until approved.
**Author:** Engineering (Claude)
**Date:** 2026-05-22

---

## 0. TL;DR for the impatient

- **Stack:** Vite + React + TypeScript + Dexie (IndexedDB) + Cloudflare Pages. Installable PWA.
- **Why not Next.js + Supabase:** It's overkill for a single-user, client-side timer. Heavier cold load for zero benefit today. We isolate the data layer behind an interface so a Supabase backend can be added later without touching UI or timer code.
- **Why not pure Vite + Preact:** React's ecosystem (charts, date utils, etc.) saves us time. Bundle size is fine for our targets.
- **Background-resilient timer:** Timestamp deltas are the source of truth. A Web Worker drives UI ticks, an AudioContext schedules the chime at exact target time so it fires even when the tab is throttled, and IndexedDB persists active-timer state so a tab-close-and-reopen recovers gracefully.
- **Open questions:** 10 listed in Section 8. Some answers will change small details, none change the architecture.

---

## 1. Stack recommendation

### Evaluation matrix

| Criterion | Next.js + Supabase + Vercel | SvelteKit + CF D1 + CF Pages | Vite + React + IndexedDB + CF Pages **(recommended)** |
|---|---|---|---|
| Cold load (target <2s) | OK (~1.5–2s) | Excellent (~0.6–1s) | Excellent (~0.5–1s) |
| Free-tier generosity | Vercel hobby + Supabase free | Very generous | Very generous |
| Background timer reliability | Same browser APIs everywhere — **stack-agnostic** | Same | Same |
| Mobile PWA support | Works | Works | Works (Vite-PWA plugin is mature) |
| Ease of adding auth + multi-user later | Easiest (Supabase Auth drop-in) | Medium (Lucia/Auth.js) | Medium (add Supabase later behind the existing repo interface) |
| Build/deploy simplicity | Vercel UI is friendly | CF Pages is friendly | CF Pages is friendly |
| Familiarity for you | High | Low | Medium (React knowledge transfers from Next.js) |
| Overhead for a personal timer | High — SSR, RSC, framework you don't need | Low | Lowest |

### Decision: Vite + React + TypeScript + Dexie + Cloudflare Pages

**Why not Next.js even though you know it:**
This app has no SSR needs (no SEO — it's not public), no API routes (no backend today), and no server components. Next.js adds ~50–100KB of framework you don't use, slower cold load, and more deploy complexity for nothing. You're trading off familiarity for honest overhead. The React knowledge you already have transfers 1:1.

**Why not SvelteKit:**
It would be slightly faster and smaller. But the chart libraries you'll want (heatmap, line chart) are more mature in React, and the time you'd spend learning Svelte syntax outweighs the bundle-size win for a personal app. If this were a public commercial product where every 100ms mattered, I'd push harder on Svelte.

**Why IndexedDB (via Dexie) and not Supabase from day one:**
Network roundtrip per timer tick or pause is silly when the user is the only one who needs the data. IndexedDB is robust, survives reloads, restarts, and tab-closes. Dexie is a thin friendly wrapper over IndexedDB — small, well-maintained, no surprises.

**Why Cloudflare Pages over Vercel:**
Both have generous free tiers. CF Pages has slightly better cold-load characteristics for static SPAs and no "function invocations" billing surprise since we have no functions. Either works; we go CF Pages by default. If you'd rather stay on Vercel for ops familiarity, switching is one file change.

### The migration path to multi-user (when the time comes)

We will hide all data access behind an interface:

```typescript
interface Repository {
  getSessions(filters): Promise<Session[]>;
  addSession(s: Session): Promise<void>;
  getSubjects(): Promise<Subject[]>;
  // ...
}
```

Today there is one implementation: `DexieRepository`. Tomorrow we add `SupabaseRepository`, flip an env flag, and the UI doesn't change. The `userId` column already exists on every row (it's hardcoded `'local'` today). Auth gets wired into a `useAuth()` hook that supplies the real user id. **No schema rewrite. No row migration.** That is what "multi-user-ready" means in practice.

---

## 2. Data model

### Tables (Dexie today, Postgres tomorrow — identical shape)

```typescript
// Session: one row per focus session attempt
type Session = {
  id: string;                  // UUID
  userId: string;              // 'local' today; real user id later
  subjectId: string | null;    // FK to Subject.id
  startedAt: number;           // epoch ms
  endedAt: number;             // epoch ms (when this session actually ended)
  plannedDurationSec: number;  // what we asked for
  actualDurationSec: number;   // what we got (may differ if aborted)
  outcome: 'completed' | 'aborted';
  rampIndexAtStart: number;    // 0..7 index into ramp ladder
  wasOverride: boolean;        // true if user picked a preset different from suggested
};

// Subject: a user-managed tag
type Subject = {
  id: string;                  // UUID
  userId: string;
  name: string;
  createdAt: number;
  archivedAt: number | null;   // soft-delete; preserves historical session labels
};

// AppState: singleton, one row keyed by userId
type AppState = {
  userId: string;
  currentStreak: number;       // consecutive completed focus sessions
  currentRampIndex: number;    // 0..7
  activeSubjectId: string | null;
  theme: 'system' | 'light' | 'dark';
  notificationPermission: 'granted' | 'denied' | 'default';

  // Active timer state — present only when a session is in flight.
  // Persisted so a tab-close-and-reopen can recover.
  activeTimer: {
    phase: 'focus' | 'break';
    plannedDurationSec: number;
    startedAt: number;          // epoch ms
    pausedAt: number | null;    // epoch ms if currently paused
    pausedAccumMs: number;      // total ms spent paused so far
    subjectId: string | null;
    rampIndexAtStart: number;
    wasOverride: boolean;
  } | null;
};
```

### Indexes (Dexie)
- `sessions`: primary `id`, indexes on `[userId+startedAt]`, `[userId+subjectId]`
- `subjects`: primary `id`, index on `[userId+name]`
- `appState`: primary `userId`

### Ramp ladder
Stored as a constant in code, not in the DB: `[5, 10, 15, 20, 25, 30, 40, 45]` minutes. If we ever want it user-configurable, we add it to `AppState`. Out of scope today.

### Export JSON shape

```json
{
  "version": 1,
  "exportedAt": 1716400000000,
  "subjects": [/* Subject[] */],
  "sessions": [/* Session[] */],
  "appState": { /* AppState minus activeTimer */ }
}
```

Import: parse, validate `version === 1`, confirm overwrite, wipe tables, insert rows. Active timer state is **not** imported — you don't want a stale active-timer from another machine.

---

## 3. Background-resilient timer architecture

This is the highest-risk part of the build. The prototype's failure mode (15 min of work → 1 min credited) was a fatal flaw. We solve it with three independent layers; any one of them is sufficient to keep accurate state. All three together make it bulletproof.

### Core principle: timestamps are truth, intervals are display

**Never use `setInterval` ticks to count elapsed time.** Interval frequency is unreliable in backgrounded tabs. Instead:

```
elapsedMs = Date.now() - startedAt - pausedAccumMs
```

The interval exists only to refresh the displayed countdown. If the interval throttles to 1Hz or stops entirely, the math when it next fires is still correct because `Date.now()` is always honest.

### Layer 1 — Web Worker tick loop

A dedicated Web Worker runs its own `setInterval(tick, 1000)`. Web Workers in Chrome/Firefox/Safari are throttled less aggressively than the main thread when the tab is backgrounded (typically still throttled to 1Hz, but kept alive and not paused entirely as foreground setIntervals sometimes are). The worker posts an `elapsedMs` message to the main thread; the main thread renders.

**Why a worker and not a main-thread interval:** the main thread's setInterval can be paused completely in some browsers when the tab is fully hidden for several minutes (especially on mobile). Web Workers fare better.

### Layer 2 — AudioContext-scheduled chime

This is the critical piece. Even if the worker is throttled to 1Hz, the chime needs to fire at the *exact* target time so the user hears it from another tab.

`AudioContext.currentTime` is a high-precision clock that **keeps running accurately even when the tab is backgrounded.** Scheduled audio events fire on the audio thread, which the browser does not throttle (because real-time audio glitches are user-hostile).

So on session start:
```typescript
const targetCtxTime = audioCtx.currentTime + plannedDurationSec;
// schedule the chime oscillator to start at targetCtxTime
// it WILL fire, audibly, even if the tab is hidden
```

The chime firing is the moment the user is yanked back. Even if the UI is frozen behind a backgrounded tab, the chime plays on time.

### Layer 3 — IndexedDB persistence + visibilitychange recovery

`activeTimer` state is written to IndexedDB on start, on pause, on resume. On every app load and on every `visibilitychange` → visible event, we:

1. Read `activeTimer` from IndexedDB.
2. Compute `elapsed = Date.now() - startedAt - pausedAccumMs`.
3. If `elapsed >= plannedDurationSec * 1000` → the session is over. Finalize it, advance to the next phase (see "Tab-close recovery" below).
4. If still in flight → set in-memory state and let the worker resume ticking.

### What happens if the tab is closed mid-session and reopened later?

**Recommended behavior:**

| Time elapsed since session start | Behavior on reopen |
|---|---|
| Less than `plannedDurationSec` | Resume the session in-flight. Chime is rescheduled. |
| `plannedDurationSec` to `2 × plannedDurationSec` | Mark session completed (the user was almost certainly working — non-punitive). Auto-advance to break. Show a banner: "Focus session completed while you were away — break starting." |
| More than `2 × plannedDurationSec` | Mark session completed but **do not** auto-start the next focus phase. Show: "Welcome back. Your last focus session (25 min) completed at 3:42pm. Ready for a break or starting fresh?" |

**Justification:** the user's actual behavior — closing the tab and coming back — almost always means they kept working. Crediting the session matches reality and stays non-punitive. Capping the auto-advance to one phase transition prevents weird states like "you returned 6 hours later and we've already mentally cycled through 4 sessions of nothing."

This needs your confirmation — see Open Question 2.

### Browser quirk inventory (what we'll test)

| Browser | Backgrounded-tab throttling | Notes |
|---|---|---|
| Chrome desktop | setInterval → 1Hz after 5 min; AudioContext unaffected | We rely on AudioContext-scheduled chime. |
| Firefox desktop | Similar to Chrome | Same approach. |
| Safari desktop | More aggressive throttling | AudioContext still reliable. |
| Safari iOS | Aggressive throttling + Notifications only work in installed PWA mode (iOS 16.4+) | Document the "install to home screen" requirement for iOS. |
| Chrome Android | Throttling + battery saver may pause workers | AudioContext + visibilitychange recovery handles it. |
| Laptop sleep/wake | All timing pauses during sleep | On wake → visibilitychange fires → recovery layer kicks in. The math (`Date.now() - startedAt`) handles sleep correctly. |

### Service Worker vs Web Worker — clarification

- **Web Worker:** background script while the page is open. Dies when the tab is closed. **We use this** for the tick loop.
- **Service Worker:** event-driven script that survives page closes. Cannot run long-running intervals. Could be used to trigger a push notification if the page is fully closed, but standard Web Notifications fired from a closed page require server-side push infrastructure we don't want to build today. **We use the SW only for PWA caching, not timing.**

If you ever wanted "chime even when the browser is completely closed," that requires a native app or push-server infrastructure. Out of scope. Keeping the tab open (even backgrounded) is fine and is the user's normal pattern.

---

## 4. Audio + notification unlock strategy

### AudioContext unlock

Browsers block audio until a user gesture. We unlock on the first Start click and keep the context alive for the life of the page.

```typescript
let audioCtx: AudioContext | null = null;

async function unlockAudio(): Promise<void> {
  if (audioCtx) return;
  audioCtx = new AudioContext();
  if (audioCtx.state === 'suspended') {
    await audioCtx.resume();
  }
  // iOS Safari quirk: play a silent buffer to fully unlock.
  const buffer = audioCtx.createBuffer(1, 1, 22050);
  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(audioCtx.destination);
  source.start(0);
}
```

Once unlocked, it stays unlocked until the page reloads. If the user reloads, the next Start click re-unlocks. We surface no UI for this — it just works.

### The chime itself

A clean sine tone with a soft envelope, roughly 660 Hz, 250ms total. Not jarring.

```typescript
function playChime(): void {
  if (!audioCtx) return;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.frequency.value = 660;
  osc.type = 'sine';
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  const t = audioCtx.currentTime;
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(0.3, t + 0.01);  // 10ms attack
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.25);  // 250ms decay
  osc.start(t);
  osc.stop(t + 0.3);
}
```

For background-reliability, we schedule the chime *at the exact target time* using AudioContext's clock rather than waiting for a setTimeout to fire and then calling playChime:

```typescript
function scheduleChimeAt(targetEpochMs: number): void {
  if (!audioCtx) return;
  const offsetSec = (targetEpochMs - Date.now()) / 1000;
  const targetCtxTime = audioCtx.currentTime + offsetSec;
  // build oscillator + gain, then:
  osc.start(targetCtxTime);
  osc.stop(targetCtxTime + 0.3);
}
```

If the user pauses or aborts, we cancel the scheduled chime (stop the oscillator) and reschedule on resume.

### Notification permission

Requested on the first Start click — same gesture as the audio unlock, so we only ask once.

```typescript
async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!('Notification' in window)) return 'denied';
  if (Notification.permission !== 'default') return Notification.permission;
  return await Notification.requestPermission();
}
```

Firing a notification:
```typescript
function notify(title: string, body: string): void {
  if (Notification.permission !== 'granted') return;
  new Notification(title, { body, icon: '/icon-192.png' });
}
```

If permission was denied, we show a small banner on the Timer screen: "Notifications are off. Click here for instructions to enable in your browser settings." Non-blocking — the chime still works.

### iOS limitation to surface to the user
On iOS Safari, Web Notifications only work when the app is installed as a PWA (Add to Home Screen) on iOS 16.4+. If you use this on iPhone, we'll instruct you to install it first. On laptop this is irrelevant.

---

## 5. PWA decision: **Yes, build as installable PWA**

### What it buys
- You can pin it to the Windows taskbar, Mac dock, or iPhone home screen and launch like a native app.
- iOS notifications work (installed PWAs only).
- Service Worker caches the app shell so repeat loads are sub-second even on slow networks.
- Offline-first feels right for a local-IndexedDB app.

### What it costs
- ~30 lines of manifest.json
- vite-plugin-pwa handles the rest (~5 lines of config)
- One ongoing concern: SW updates can be sticky if not configured. We'll use `registerType: 'autoUpdate'` so a new SW activates on next reload. We'll also surface a small "new version available — reload" toast if a SW update is detected mid-session, never auto-reloading mid-session.

### What we will NOT do with the SW
We won't use Service Worker for timing or chime — the SW dies on tab close and event-driven SWs can't be relied on for "fire X at time T." Timing stays in the page, with AudioContext for the chime.

---

## 6. Routes / screens

Single-page app. Four screens, client-side routing.

| Route | Screen | Purpose |
|---|---|---|
| `/` | Timer | Default landing. Active timer, subject picker, preset buttons, ramp status, start/pause/abort. |
| `/analytics` | Analytics | Total hours, current streak, peak session, heatmap, hours-by-subject bar, last-30 ramp line. |
| `/subjects` | Subjects | Add, rename, archive subjects. |
| `/settings` | Settings | Theme toggle, export JSON, import JSON, clear all data. |

Navigation: a bottom nav bar on mobile (380px target), a top nav on desktop. Same component, responsive.

We'll use `react-router-dom` (lightweight, ~10KB) for routing. Or we could roll our own with `useState` since we have 4 screens. Probably react-router — saves time and the bundle hit is trivial. Confirm with Open Question 1 if you want me to skip the dep.

---

## 7. Component breakdown

Kept flat. No over-decomposition.

### Top-level
- `App.tsx` — root: theme provider, router, repository provider (DI for testing).

### Screens
- `TimerScreen.tsx` — orchestrates the timer view.
- `AnalyticsScreen.tsx` — orchestrates the stats view.
- `SubjectsScreen.tsx` — list + CRUD for subjects.
- `SettingsScreen.tsx` — theme, export, import, clear.

### Reusable UI bits
- `TimerDisplay.tsx` — the big countdown number + phase label.
- `PresetButtons.tsx` — the 5/10/15/20/25/30/40/45 row.
- `SubjectPicker.tsx` — dropdown bound to active subject.
- `Heatmap.tsx` — 12-week heatmap, one cell per day.
- `RampLineChart.tsx` — last 30 sessions, line chart of plannedDuration.
- `SubjectBarChart.tsx` — hours per subject.

### Hooks
- `useTimer()` — wraps timerEngine, exposes `{ phase, elapsedMs, plannedMs, start, pause, resume, abort }`.
- `useAudio()` — `{ unlock, playChime, scheduleChimeAt, cancelScheduled }`.
- `useNotifications()` — `{ permission, request, notify }`.
- `useTheme()` — system/light/dark.
- `useRepository()` — DI access to the data layer.

### Services (non-React modules — testable in isolation)
- `timerEngine.ts` — the heart. Pure timestamp math, phase transitions, ramp progression. Zero React, zero browser APIs beyond `Date.now()`. **Heavily unit-tested.**
- `audioService.ts` — Web Audio. Smoke-tested manually.
- `notificationService.ts` — Notifications API. Smoke-tested manually.
- `repository.ts` — interface definition.
- `dexieRepository.ts` — IndexedDB implementation.
- `timerWorker.ts` — the Web Worker tick loop. Just posts `Date.now()` and elapsed every second.

### Chart library
**Recommendation: `recharts`** — well-maintained, React-native, ~50KB gzipped. Good enough for our three charts. Alternative: roll our own SVG for the heatmap (it's trivial) and use recharts for the line and bar. We'll start with recharts for all three; if the heatmap looks off we'll write SVG by hand.

---

## 8. Open questions for you

Please answer the ones you have opinions on. For any you don't have an opinion on, I'll pick the default I've indicated and call it out.

**1. Routing library — react-router (~10KB) or hand-rolled `useState` switch?**
- (a) Use react-router. **(my default)**
- (b) Hand-rolled. Save the dep.
- (c) Whatever, your call.

**2. Tab-close-and-reopen behavior — confirm the recovery rules in Section 3?**
- (a) Yes, the three-bucket rule (resume / auto-complete-and-advance / auto-complete-but-pause) is right. **(my default)**
- (b) Always require manual confirm — never auto-complete on return.
- (c) Always auto-complete and auto-advance regardless of how long.

**3. Heatmap intensity — what does the color saturation represent?**
- (a) Total focus minutes that day. **(my default)**
- (b) Number of completed sessions that day.
- (c) Peak session length that day.

**4. Subject required, or optional per session?**
- (a) Required — you must pick a subject before Start. Forces intentionality.
- (b) Optional — "unassigned" is allowed. **(my default — less friction)**
- (c) Optional but warn on Start: "No subject selected, continue?"

**5. Ramp ladder cap at 45 min — what happens after a session at 45?**
- (a) Cap. Next suggestion stays 45. **(my default — 45 min is already very long, no reason to push higher)**
- (b) Continue: 50, 55, 60.
- (c) Other (specify).

**6. Streak definition — does the streak break across days?**
- (a) Streak counts consecutive successful sessions ever, regardless of date. Only an abort/skip breaks it. **(my default — non-punitive matches your brief)**
- (b) Streak resets if you don't complete at least one session per calendar day.
- (c) Streak resets after a 24-hour gap from the last completed session.

**7. Pause mid-session — allowed?**
- (a) Yes, with a Pause button. Paused time doesn't count toward elapsed. **(my default — you need a bathroom break)**
- (b) No pause. Only abort and restart.
- (c) Pause allowed but limited (e.g., max 2 min, then auto-abort).

**8. Override + ramp progression — concretely, what happens after an override completes?**
> Example: ramp suggests 20 min. You override to 30 min. You complete the 30.
- (a) Next suggested session = the next rung *after the rung you actually completed*. Since you completed 30, next = 40 min. **(my default — the brief says "ramp resumes from where the user actually completed")**
- (b) Next suggested session = the next rung after the *originally suggested* rung (20 → 25). Override is treated as a one-time bonus that doesn't change the ladder.
- (c) Override doesn't affect the ramp at all — next suggested stays 20.

**9. Subject removal — archive or hard delete?**
- (a) Archive: subject hidden from the picker but historical sessions still show its name. **(my default — preserves history)**
- (b) Hard delete: subject gone, historical sessions become "unassigned."
- (c) User chooses at remove time (modal: "Archive or delete?").

**10. Export/import scope — what's included?**
- (a) Sessions + subjects + appState (streak, ramp index, theme). Full restore. **(my default)**
- (b) Sessions + subjects only. Streak/ramp recompute on import.
- (c) Sessions only.

---

## 9. Honest tradeoffs and limitations to flag

A few things I want to surface explicitly so they're not surprises later:

1. **iOS Safari + notifications.** Notifications only work on iOS when the app is installed as a PWA (16.4+). If you use this on iPhone occasionally, you'll need to "Add to Home Screen" once. Documented but worth noting up front.

2. **Closed-browser chime is out of scope.** If you fully quit the browser, the chime cannot fire — that requires native or server push. Backgrounded tab is fine. "Browser open, our tab open but in the background" is the supported pattern.

3. **Worker throttling on mobile is unpredictable.** Aggressive Android battery savers and iOS low-power mode can throttle workers harder than expected. The AudioContext-scheduled chime is our backup; the visibilitychange-on-return recovery is the last line of defense. We'll explicitly test mobile-backgrounded behavior in Phase 2 and document what we find.

4. **No accounts means no sync.** If you use the app on laptop and phone, the data lives in each browser separately. Export/import bridges them manually. Auto-sync requires the multi-user / Supabase layer. Out of scope today; in scope for the v2 layer.

5. **Real timeline estimate.** Honest read on Phase 2 build effort, assuming I'm doing the work in-session under your direction:
   - Scaffold + data layer + repository: ~half a session
   - Timer engine (with tests): ~one full session — this is the highest-care work
   - Audio + notification layer: ~half a session
   - UI screens (Timer + Analytics + Subjects + Settings): ~one to one-and-a-half sessions
   - PWA setup + deploy: ~half a session
   - Cross-browser testing + bug fixes: ~half a session (likely more if mobile quirks surface)
   - **Total: 4–5 focused work sessions.** Not 4–5 hours; 4–5 sit-down sessions of an hour or two each. Could compress, but the timer engine and the cross-browser testing are where corners cost real bugs later.

---

## 10. What I'm NOT doing

Per your operating rules — listing things I considered and rejected as out-of-scope:

- ❌ Authentication / user accounts (Phase 1 explicitly excludes; multi-user is a later layer)
- ❌ Cloud sync across devices (depends on auth)
- ❌ Push notifications when browser is closed (would need server)
- ❌ Customizable ramp ladder UI (the constant in code is fine for personal use)
- ❌ Customizable chime sounds (one good chime is fine; no settings bloat)
- ❌ Pomodoro-style "long break every 4 sessions" (you didn't ask for this; the ramp is the structure)
- ❌ Task lists, todos, integrations with calendars, etc. (out of brief)
- ❌ Test suite covering UI components exhaustively (we'll test timer engine + data layer; smoke-test the UI manually, which is the right ROI for a personal tool)

If any of these belong in scope, flag them now and I'll fold them in before we move to Phase 2.

---

## Sign-off

**To approve:** answer the 10 open questions (even if just "all defaults"), confirm the stack pick, and say "approved" or "build it." I'll then produce the Phase 2 implementation plan (TDD-style, bite-sized tasks) and we'll start scaffolding.

**To revise:** tell me what to change. Architecture changes are cheap right now; expensive later.
