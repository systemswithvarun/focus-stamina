// useSubjects — list / add / rename / archive subjects.
//
// Subjects are user-managed tags. Archiving is soft-delete so historical
// sessions can still display the subject name.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { LOCAL_USER_ID, type Subject } from '../types/models';
import { getRepository } from '../services/dexieRepository';

export function useSubjects() {
  const repo = useMemo(() => getRepository(), []);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [allSubjects, setAllSubjects] = useState<Subject[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const [active, all] = await Promise.all([
      repo.listSubjects(),
      repo.listSubjects({ includeArchived: true })
    ]);
    setSubjects(active);
    setAllSubjects(all);
    setLoading(false);
  }, [repo]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const addSubject = useCallback(
    async (name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      const subject: Subject = {
        id: crypto.randomUUID(),
        userId: LOCAL_USER_ID,
        name: trimmed,
        createdAt: Date.now(),
        archivedAt: null
      };
      await repo.addSubject(subject);
      await refresh();
    },
    [repo, refresh]
  );

  const renameSubject = useCallback(
    async (id: string, name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      await repo.updateSubject(id, { name: trimmed });
      await refresh();
    },
    [repo, refresh]
  );

  const archiveSubject = useCallback(
    async (id: string) => {
      await repo.updateSubject(id, { archivedAt: Date.now() });
      await refresh();
    },
    [repo, refresh]
  );

  const unarchiveSubject = useCallback(
    async (id: string) => {
      await repo.updateSubject(id, { archivedAt: null });
      await refresh();
    },
    [repo, refresh]
  );

  return {
    subjects,        // active (non-archived) — for the picker
    allSubjects,     // includes archived — for history lookup
    loading,
    addSubject,
    renameSubject,
    archiveSubject,
    unarchiveSubject,
    refresh
  };
}

// Lookup helper for rendering session subject names when only the id is known.
export function subjectNameById(list: Subject[], id: string | null): string {
  if (!id) return 'Unassigned';
  return list.find((s) => s.id === id)?.name ?? 'Unassigned';
}
