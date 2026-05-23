# Focus Stamina

A progressive-ramp pomodoro timer for building "focus stamina" — the user's term
for treating sustained attention as a trainable capacity. Sessions start at 5 min
and ramp up to 45 min as you build consecutive streaks. Non-judgmental: a missed
session resets the streak with no penalty language.

This is a personal-use web app today. The architecture is multi-user ready so an
auth + cloud-sync layer can be added later without rewriting the existing data
model.

## What it does

- **Progressive ramp:** 5 → 10 → 15 → 20 → 25 → 30 → 40 → 45 min focus sessions.
  After three at-rung completions a prompt asks if you're ready to climb a rung.
  Ramping is always user-controlled — never automatic.
- **Flexible breaks:** Default 5 min, extend with 5 / 10 / 15 / Custom during the
  break. A custom break longer than 15 min flips the screen to a "step away from
  your desk" prompt instead of a countdown.
- **Custom durations:** Any focus or break duration via the Custom button on
  either screen.
- **Subjects:** Tag each session with what you were working on. Add / rename /
  archive subjects on the Subjects screen.
- **Background-resilient timer:** Source of truth is `Date.now()` deltas, not
  interval ticks. AudioContext schedules the chime at the exact target time, so
  it fires audibly even when the tab is backgrounded. Closing the tab mid-session
  and reopening is handled: within 2× the planned duration the session is
  credited and the next phase starts; beyond that the session is credited and we
  go idle so you decide what's next.
- **Audible chime + system notifications** on every phase transition.
- **Analytics:** total hours, streak, peak session, 12-week heatmap,
  by-subject bar chart, last-30-sessions ramp progression.
- **Local-first data:** Everything lives in IndexedDB in your browser. Export
  JSON to back up, import JSON to restore. No accounts, no server, no
  per-user setup.
- **Installable PWA:** Pin to taskbar / dock / home screen.
- **Dark mode** with manual override and system detection.

## How to run it locally

Prerequisites: Node 18+ and npm.

```powershell
npm install
npm run dev
```

Then open <http://localhost:5173>.

Other scripts:

```powershell
npm test          # run unit tests once
npm run test:watch # tests in watch mode
npm run typecheck  # TypeScript check without emitting
npm run build      # production build into dist/
npm run preview    # serve the production build locally
```

## How to deploy (Cloudflare Pages — free)

The app is a static SPA, so any static host works. Cloudflare Pages is
recommended because the free tier is generous and there's no cold-start latency.

### One-time setup

1. Sign up at <https://dash.cloudflare.com> (free).
2. Create a new Pages project: **Workers & Pages** → **Create application** →
   **Pages** → **Connect to Git** (or **Upload assets** if you don't want a
   GitHub repo yet — see "Deploy without a repo" below).
3. If connecting to Git, push this folder to a GitHub repo first:
   ```powershell
   git init
   git add .
   git commit -m "Initial commit"
   git remote add origin https://github.com/<you>/focus-stamina.git
   git push -u origin main
   ```
4. In the Cloudflare Pages setup, set:
   - **Build command:** `npm run build`
   - **Build output directory:** `dist`
   - **Environment variables:** none needed
5. Hit Deploy. You get a `*.pages.dev` URL — share it with the small test
   group. Anyone with the URL can use the app and their data lives in their own
   browser.

### Deploy without a repo

If you'd rather not use GitHub, you can drag-and-drop the `dist/` folder into
the Cloudflare Pages dashboard:

```powershell
npm run build
```

Then in the dashboard: **Create application** → **Pages** → **Upload assets** →
drop the `dist/` folder.

### Updating after the first deploy

If you used Git: every `git push` to `main` triggers a new deploy automatically.

If you used drag-and-drop: rebuild (`npm run build`) and re-upload the new
`dist/` folder under the same project.

## Where the data lives

Everything is in your browser's IndexedDB under the origin
`https://<your-deploy>.pages.dev`. There is no server-side database. Each tester
who opens the URL gets their own independent data store.

Caveats:
- Clearing browser data wipes the app data.
- Using the app on laptop + phone keeps two separate datasets. Use Settings →
  Export / Import to move data between browsers manually.

## Export / Import

Settings → **Export JSON** downloads a `focus-stamina-YYYY-MM-DD.json` file
containing all sessions, subjects, and your streak / ramp state.

Settings → **Import JSON** prompts for confirmation, then wipes and restores
from the file. Active timer state is not imported (avoiding a stale "session in
progress" from another machine).

## Reset

Settings → **Clear all data** wipes sessions, streak, and ramp index. Subjects
are preserved.

## Adding multi-user later (architecture note)

All data access goes through `Repository` (see `src/services/repository.ts`).
Today there's exactly one implementation, `DexieRepository`, backed by
IndexedDB. To go multi-user:

1. Write a `SupabaseRepository` (or any backend) that satisfies the same
   `Repository` interface.
2. Wire `getRepository()` in `src/services/dexieRepository.ts` to choose between
   the two based on auth state.
3. Replace the hardcoded `LOCAL_USER_ID` in `src/types/models.ts` with the real
   user id from the auth session.

The `userId` column already exists on every Session, Subject, and AppState row.
No schema migration is needed. UI code does not change.

## File layout

```
src/
  components/      Reusable UI bits (AppShell, Heatmap)
  hooks/           React hooks (useTimer, useSubjects, useAnalytics, useTheme)
  screens/         Top-level screens (Timer, Analytics, Subjects, Settings)
  services/        Pure modules: timerEngine, audioService, notificationService,
                   repository (interface), dexieRepository (IndexedDB impl)
  types/           Shared TypeScript types and constants
  test/            Vitest setup (fake-indexeddb under jsdom)
```

The timer engine in `src/services/timerEngine.ts` is intentionally side-effect
free and unit-tested under `timerEngine.test.ts`. The data layer is similarly
tested under `dexieRepository.test.ts`. UI is verified manually.

## Known limitations

- **iOS Safari notifications** only work in an installed PWA (iOS 16.4+). On
  iPhone, install the app to the home screen first via Share → Add to Home Screen.
- **Closed-browser chime is not possible** without native code or a push-server
  backend. A backgrounded tab is fine; a fully quit browser is not.
- **No automatic sync between devices.** Export / Import bridges them manually.

## Tech stack

- **Vite + React + TypeScript** — fast dev loop, small bundle.
- **Dexie** (IndexedDB wrapper) — local-first data.
- **React Router** — flat routing for four screens.
- **Recharts** — analytics charts.
- **vite-plugin-pwa** — installable, auto-updating service worker.
- **Vitest + jsdom + fake-indexeddb** — fast unit testing.
