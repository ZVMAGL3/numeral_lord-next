/** Return the draft key for an editor route, or null for every other screen. */
export function mapEditorDraftIdFromPath(path: string): string | null {
  const match = path.match(/^\/maps\/edit\/([^/]+)$/);
  if (!match) return null;
  try { return decodeURIComponent(match[1]!); }
  catch { return null; }
}

/** Remove only the draft belonging to the editor being cancelled or exited. */
export function clearMapEditorDraft(storage: Pick<Storage, "getItem" | "removeItem">, mapId: string, key: string): void {
  try {
    const saved = JSON.parse(storage.getItem(key) ?? "null") as { mapId?: unknown } | null;
    if (saved?.mapId === mapId) storage.removeItem(key);
  } catch {
    storage.removeItem(key);
  }
}
