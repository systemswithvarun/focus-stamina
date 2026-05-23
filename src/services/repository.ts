// Repository interface. The UI talks to this, not directly to Dexie.
// Today there is one implementation (Dexie / IndexedDB). When multi-user
// is added later, we add a SupabaseRepository that satisfies this same
// interface and swap it in — UI code does not change.

import type {
  AppState,
  ExportBundle,
  Session,
  Subject
} from '../types/models';

export interface Repository {
  // Sessions
  addSession(session: Session): Promise<void>;
  listSessions(opts?: { since?: number; until?: number; limit?: number }): Promise<Session[]>;
  countSessions(): Promise<number>;

  // Subjects
  addSubject(subject: Subject): Promise<void>;
  updateSubject(id: string, patch: Partial<Pick<Subject, 'name' | 'archivedAt'>>): Promise<void>;
  listSubjects(opts?: { includeArchived?: boolean }): Promise<Subject[]>;
  getSubject(id: string): Promise<Subject | undefined>;

  // App state (singleton per user)
  getAppState(): Promise<AppState>;
  setAppState(patch: Partial<AppState>): Promise<AppState>;

  // Active-time tracking
  addActiveMs(dateKey: string, deltaMs: number): Promise<void>;

  // Bulk
  exportAll(): Promise<ExportBundle>;
  importAll(bundle: ExportBundle): Promise<void>;
  clearAllSessionsAndStreak(): Promise<void>;
}
