// Smoke tests for the Dexie repository running over fake-indexeddb under jsdom.

import { describe, it, expect, beforeEach } from 'vitest';
import { DexieRepository } from './dexieRepository';
import type { ExportBundle, Session, Subject } from '../types/models';

function makeSession(over: Partial<Session> = {}): Session {
  return {
    id: crypto.randomUUID(),
    userId: 'local',
    subjectId: null,
    startedAt: Date.now() - 60_000,
    endedAt: Date.now(),
    plannedDurationSec: 300,
    actualDurationSec: 300,
    outcome: 'completed',
    rampIndexAtStart: 0,
    wasOverride: false,
    ...over
  };
}

function makeSubject(over: Partial<Subject> = {}): Subject {
  return {
    id: crypto.randomUUID(),
    userId: 'local',
    name: 'APN 600',
    createdAt: Date.now(),
    archivedAt: null,
    ...over
  };
}

describe('DexieRepository', () => {
  let repo: DexieRepository;

  beforeEach(async () => {
    // fake-indexeddb is reset per test by deleting the db between runs.
    const indexedDB = globalThis.indexedDB;
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase('focus-stamina');
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
    repo = new DexieRepository();
  });

  it('returns default app state on first read', async () => {
    const state = await repo.getAppState();
    expect(state.userId).toBe('local');
    expect(state.currentStreak).toBe(0);
    expect(state.currentRampIndex).toBe(0);
    expect(state.activeTimer).toBeNull();
  });

  it('persists app state patches', async () => {
    await repo.setAppState({ currentStreak: 3, currentRampIndex: 2 });
    const state = await repo.getAppState();
    expect(state.currentStreak).toBe(3);
    expect(state.currentRampIndex).toBe(2);
  });

  it('adds and lists sessions', async () => {
    await repo.addSession(makeSession({ plannedDurationSec: 300 }));
    await repo.addSession(makeSession({ plannedDurationSec: 600 }));
    const sessions = await repo.listSessions();
    expect(sessions).toHaveLength(2);
  });

  it('lists sessions in a time range', async () => {
    const now = Date.now();
    await repo.addSession(makeSession({ startedAt: now - 1_000_000 }));
    await repo.addSession(makeSession({ startedAt: now - 100 }));
    const recent = await repo.listSessions({ since: now - 5_000 });
    expect(recent).toHaveLength(1);
  });

  it('adds, lists, archives subjects', async () => {
    const s1 = makeSubject({ name: 'A' });
    const s2 = makeSubject({ name: 'B' });
    await repo.addSubject(s1);
    await repo.addSubject(s2);
    let list = await repo.listSubjects();
    expect(list.map((x) => x.name)).toEqual(['A', 'B']);
    await repo.updateSubject(s1.id, { archivedAt: Date.now() });
    list = await repo.listSubjects();
    expect(list.map((x) => x.name)).toEqual(['B']);
    const all = await repo.listSubjects({ includeArchived: true });
    expect(all).toHaveLength(2);
  });

  it('exports and imports round-trip', async () => {
    const subj = makeSubject({ name: 'Curd Report' });
    await repo.addSubject(subj);
    await repo.addSession(makeSession({ subjectId: subj.id }));
    await repo.setAppState({ currentStreak: 5, currentRampIndex: 3 });

    const bundle = await repo.exportAll();
    expect(bundle.version).toBe(1);
    expect(bundle.subjects).toHaveLength(1);
    expect(bundle.sessions).toHaveLength(1);
    expect(bundle.appState.currentStreak).toBe(5);

    // Wipe and re-import.
    await repo.clearAllSessionsAndStreak();
    await repo.updateSubject(subj.id, { archivedAt: Date.now() });
    await repo.importAll(bundle);

    const sessions = await repo.listSessions();
    const subjects = await repo.listSubjects();
    const state = await repo.getAppState();
    expect(sessions).toHaveLength(1);
    expect(subjects).toHaveLength(1);
    expect(subjects[0].name).toBe('Curd Report');
    expect(subjects[0].archivedAt).toBeNull();
    expect(state.currentStreak).toBe(5);
  });

  it('rejects an import with the wrong version', async () => {
    const bad = { version: 2, exportedAt: 0, subjects: [], sessions: [], appState: {} } as unknown as ExportBundle;
    await expect(repo.importAll(bad)).rejects.toThrow(/version/i);
  });

  it('clearAllSessionsAndStreak wipes sessions and resets streak but keeps subjects', async () => {
    const subj = makeSubject();
    await repo.addSubject(subj);
    await repo.addSession(makeSession());
    await repo.setAppState({ currentStreak: 7, currentRampIndex: 5 });

    await repo.clearAllSessionsAndStreak();

    expect(await repo.listSessions()).toHaveLength(0);
    const state = await repo.getAppState();
    expect(state.currentStreak).toBe(0);
    expect(state.currentRampIndex).toBe(0);
    expect(await repo.listSubjects()).toHaveLength(1);
  });
});
