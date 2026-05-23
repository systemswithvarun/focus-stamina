// Subjects screen — add, rename, archive, unarchive.

import { useState } from 'react';
import { useSubjects } from '../hooks/useSubjects';
import type { Subject } from '../types/models';
import './SubjectsScreen.css';

export function SubjectsScreen() {
  const { subjects, allSubjects, loading, addSubject, renameSubject, archiveSubject, unarchiveSubject } =
    useSubjects();
  const [newName, setNewName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');

  const archived = allSubjects.filter((s) => s.archivedAt !== null);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    await addSubject(newName);
    setNewName('');
  };

  const startEdit = (s: Subject) => {
    setEditingId(s.id);
    setEditingName(s.name);
  };
  const saveEdit = async () => {
    if (!editingId) return;
    await renameSubject(editingId, editingName);
    setEditingId(null);
  };

  return (
    <div className="subjects-screen">
      <h1>Subjects</h1>
      <p className="text-dim">
        Tag each focus session with what you were working on. Archive a subject to
        hide it from the picker while keeping its history.
      </p>

      <form className="add-row" onSubmit={handleAdd}>
        <input
          className="input"
          placeholder="Add a subject (e.g., APN 600)"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
        />
        <button className="btn btn-primary" type="submit" disabled={!newName.trim()}>
          Add
        </button>
      </form>

      {loading ? (
        <p className="text-faint">Loading…</p>
      ) : subjects.length === 0 && archived.length === 0 ? (
        <p className="text-faint">No subjects yet. Add one above.</p>
      ) : null}

      {subjects.length > 0 && (
        <section>
          <h2>Active</h2>
          <ul className="subject-list">
            {subjects.map((s) => (
              <li key={s.id} className="subject-row">
                {editingId === s.id ? (
                  <>
                    <input
                      autoFocus
                      className="input"
                      value={editingName}
                      onChange={(e) => setEditingName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void saveEdit();
                        if (e.key === 'Escape') setEditingId(null);
                      }}
                    />
                    <button className="btn btn-primary" onClick={() => void saveEdit()}>
                      Save
                    </button>
                    <button className="btn btn-ghost" onClick={() => setEditingId(null)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <span className="subject-name">{s.name}</span>
                    <button className="btn btn-ghost" onClick={() => startEdit(s)}>
                      Rename
                    </button>
                    <button className="btn btn-ghost" onClick={() => void archiveSubject(s.id)}>
                      Archive
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {archived.length > 0 && (
        <section>
          <h2>Archived</h2>
          <ul className="subject-list archived">
            {archived.map((s) => (
              <li key={s.id} className="subject-row">
                <span className="subject-name text-dim">{s.name}</span>
                <button className="btn btn-ghost" onClick={() => void unarchiveSubject(s.id)}>
                  Unarchive
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
