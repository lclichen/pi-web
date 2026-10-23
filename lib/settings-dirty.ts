// Dirty-state bridge between embedded config sections and the settings dialog
// shell. Sections with editable drafts register a predicate; the shell consults
// isAnySettingsDirty() before closing (Escape / backdrop / ×) so unsaved work
// can prompt instead of vanishing. Registration is per section id — a section
// remounting replaces its own predicate; a stale unregister is a no-op.

const checkers = new Map<string, () => boolean>();

export function registerSettingsDirty(section: string, check: () => boolean): () => void {
  checkers.set(section, check);
  return () => {
    // Only remove when this exact predicate still owns the slot.
    if (checkers.get(section) === check) checkers.delete(section);
  };
}

export function isAnySettingsDirty(): boolean {
  for (const check of checkers.values()) {
    if (check()) return true;
  }
  return false;
}
