// Dexie / IndexedDB implementation of Repository.
// Browser-local persistence; survives reload, restart, and tab-close.

import Dexie, { type Table } from 'dexie';
import type { Repository } from './repository';
import {
  type AppState,
  type ExportBundle,
  type Session,
  type Subject,
  LOCAL_USER_ID
} from '../types/models';

class FocusStaminaDb extends Dexie {
  sessions!: Table<Session, string>;
  subjects!: Table<Subject, string>;
  appState!: Table<AppState, string>;

  constructor() {
    super('focus-stamina');
    this.version(1).stores({
      // [userId+startedAt] compound index for heatmap & recent queries.
      // [userId+subjectId] for per-subject rollups.
      sessions: 'id, userId, subjectId, startedAt, [userId+startedAt], [userId+subjectId]',
      subjects: 'id, userId, name, archivedAt, [userId+name]',
      appState: 'userId'
    });
  }
}

const DEFAULT_APP_STATE: AppState = {
  userId: LOCAL_USER_ID,
  currentStreak: 0,
  currentRampIndex: 0,
  streakAtCurrentRung: 0,
  activeSubjectId: null,
  theme: 'system',
  notificationPermission: 'default',
  soundEnabled: true,
  notificationsEnabled: true,
  tabFlashEnabled: true,
  activeTimer: null,
  pendingTransition: null,
  dailyActiveMs: {}
};

// Sessions written before the `type` field was added are treated as focus
// sessions. Apply this normalization on every read.
function normalizeSession(s: Session): Session {
  return { ...s, type: s.type ?? 'focus' };
}

export class DexieRepository implements Repository {
  private db: FocusStaminaDb;
  private userId: string;

  constructor(userId: string = LOCAL_USER_ID, db?: FocusStaminaDb) {
    this.db = db ?? new FocusStaminaDb();
    this.userId = userId;
  }

  async addSession(session: Session): Promise<void> {
    await this.db.sessions.put(session);
  }

  async listSessions(opts: { since?: number; until?: number; limit?: number } = {}): Promise<Session[]> {
    let coll = this.db.sessions
      .where('[userId+startedAt]')
      .between([this.userId, opts.since ?? Dexie.minKey], [this.userId, opts.until ?? Dexie.maxKey]);
    if (opts.limit !== undefined) {
      // .limit() on Dexie collections; sort newest-first by reverse.
      coll = coll.reverse();
      const rows = await coll.limit(opts.limit).toArray();
      return rows.map(normalizeSession);
    }
    const rows = await coll.toArray();
    return rows.map(normalizeSession);
  }

  async countSessions(): Promise<number> {
    return await this.db.sessions.where('userId').equals(this.userId).count();
  }

  async addSubject(subject: Subject): Promise<void> {
    await this.db.subjects.put(subject);
  }

  async updateSubject(id: string, patch: Partial<Pick<Subject, 'name' | 'archivedAt'>>): Promise<void> {
    await this.db.subjects.update(id, patch);
  }

  async listSubjects(opts: { includeArchived?: boolean } = {}): Promise<Subject[]> {
    const rows = await this.db.subjects.where('userId').equals(this.userId).toArray();
    const filtered = opts.includeArchived ? rows : rows.filter((s) => s.archivedAt === null);
    return filtered.sort((a, b) => a.name.localeCompare(b.name));
  }

  async getSubject(id: string): Promise<Subject | undefined> {
    return await this.db.subjects.get(id);
  }

  async getAppState(): Promise<AppState> {
    const existing = await this.db.appState.get(this.userId);
    if (existing) {
      // Backfill fields added after release so older rows still load cleanly.
      const merged = { ...DEFAULT_APP_STATE, ...existing, userId: this.userId };
      return merged;
    }
    const fresh = { ...DEFAULT_APP_STATE, userId: this.userId };
    await this.db.appState.put(fresh);
    return fresh;
  }

  async setAppState(patch: Partial<AppState>): Promise<AppState> {
    const current = await this.getAppState();
    const next = { ...current, ...patch, userId: this.userId };
    await this.db.appState.put(next);
    return next;
  }

  async exportAll(): Promise<ExportBundle> {
    const [subjects, sessions, appState] = await Promise.all([
      this.listSubjects({ includeArchived: true }),
      this.listSessions(),
      this.getAppState()
    ]);
    const { activeTimer: _activeTimer, ...rest } = appState;
    void _activeTimer;
    return {
      version: 1,
      exportedAt: Date.now(),
      subjects,
      sessions,
      appState: rest
    };
  }

  async importAll(bundle: ExportBundle): Promise<void> {
    if (bundle.version !== 1) {
      throw new Error(`Unsupported export version: ${bundle.version}`);
    }
    await this.db.transaction('rw', this.db.sessions, this.db.subjects, this.db.appState, async () => {
      await this.db.sessions.where('userId').equals(this.userId).delete();
      await this.db.subjects.where('userId').equals(this.userId).delete();
      await this.db.appState.delete(this.userId);
      if (bundle.subjects.length) await this.db.subjects.bulkPut(bundle.subjects);
      if (bundle.sessions.length) await this.db.sessions.bulkPut(bundle.sessions);
      await this.db.appState.put({ ...bundle.appState, userId: this.userId, activeTimer: null });
    });
  }

  async addActiveMs(dateKey: string, deltaMs: number): Promise<void> {
    if (deltaMs <= 0) return;
    // Use a Dexie transaction to make read-modify-write atomic so concurrent
    // tab-visibility flushes don't lose increments.
    await this.db.transaction('rw', this.db.appState, async () => {
      const existing = await this.db.appState.get(this.userId);
      const base = existing ?? { ...DEFAULT_APP_STATE, userId: this.userId };
      const dailyActiveMs = { ...(base.dailyActiveMs ?? {}) };
      dailyActiveMs[dateKey] = (dailyActiveMs[dateKey] ?? 0) + deltaMs;
      await this.db.appState.put({ ...base, dailyActiveMs });
    });
  }

  async clearAllSessionsAndStreak(): Promise<void> {
    await this.db.transaction('rw', this.db.sessions, this.db.appState, async () => {
      await this.db.sessions.where('userId').equals(this.userId).delete();
      await this.db.appState.update(this.userId, {
        currentStreak: 0,
        currentRampIndex: 0,
        activeTimer: null
      });
    });
  }
}

// Singleton instance used by the app at runtime.
let _repo: DexieRepository | null = null;
export function getRepository(): DexieRepository {
  if (!_repo) _repo = new DexieRepository();
  return _repo;
}
