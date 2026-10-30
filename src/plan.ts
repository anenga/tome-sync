/*
 * The pure decision of a sync cycle: for every path, compare this vault, Tome's list, and what
 * both looked like after the last successful sync (the state). The same rules as the desktop
 * app (desktop/src-tauri/src/core/sync.rs), so a note behaves the same wherever it's synced.
 */

/** What a file looked like on both sides after it last synced. */
export interface Entry {
  /** sha256 of the content both sides had. */
  hash: string;
  /** Tome's revision of that content (for conditional writes). */
  rev: string;
  /** Tome's change tag from its list, when known. */
  tag: string | null;
  /** This vault's size and mtime then, so unchanged files aren't re-read. */
  size: number;
  mtime: number;
}

export interface State {
  files: Record<string, Entry>;
}

export interface LocalFile {
  hash: string;
  size: number;
  mtime: number;
}

export interface RemoteFile {
  tag: string | null;
  size: number;
}

export type Action =
  /** base: the revision last seen; null creates (and fails if the file exists). */
  | { kind: "upload"; path: string; base: string | null }
  /** known: a revision it may still be at (then nothing needs downloading). */
  | { kind: "download"; path: string; known: string | null }
  /** Changed on both sides, or new on both: compare, merge or keep both. */
  | { kind: "merge"; path: string }
  | { kind: "deleteRemote"; path: string; rev: string }
  | { kind: "deleteLocal"; path: string }
  | { kind: "moveRemote"; path: string; from: string }
  /** Gone on both sides. */
  | { kind: "forget"; path: string }
  /** Read-only vault: a local change that won't be uploaded. */
  | { kind: "keepLocal"; path: string };

export function plan(state: State, local: Map<string, LocalFile>, remote: Map<string, RemoteFile>, readOnly: boolean): Action[] {
  const paths = [...new Set([...Object.keys(state.files), ...local.keys(), ...remote.keys()])].sort();
  const out: Action[] = [];
  for (const path of paths) {
    const s = state.files[path];
    const l = local.get(path);
    const r = remote.get(path);
    const upload = (base: string | null): Action => (readOnly ? { kind: "keepLocal", path } : { kind: "upload", path, base });
    if (!s) {
      if (l && !r) out.push(upload(null));
      else if (!l && r) out.push({ kind: "download", path, known: null });
      else if (l && r) out.push({ kind: "merge", path });
      continue;
    }
    const localChanged = !!l && l.hash !== s.hash;
    // A tag that moved, or one this device doesn't know yet (right after its own upload).
    const remoteMoved = !!r && (s.tag === null || r.tag === null || r.tag !== s.tag);
    // Known to have changed. Uploads and deletions are revision-checked by Tome anyway, so an
    // unknown tag doesn't stop them: Tome refuses if the file really changed.
    const remoteChanged = !!r && s.tag !== null && r.tag !== null && r.tag !== s.tag;
    if (l && r) {
      if (!localChanged && !remoteMoved) continue;
      if (!localChanged) out.push({ kind: "download", path, known: s.rev });
      else if (!remoteChanged) out.push(upload(s.rev));
      else out.push({ kind: "merge", path });
    } else if (!l && r) {
      // Deleted here but changed in Tome (or nothing may be deleted): bring it back.
      out.push(readOnly || remoteChanged ? { kind: "download", path, known: null } : { kind: "deleteRemote", path, rev: s.rev });
    } else if (l && !r) {
      // Deleted in Tome, edited here: the edit wins, as a new file.
      out.push(localChanged ? upload(null) : { kind: "deleteLocal", path });
    } else {
      out.push({ kind: "forget", path });
    }
  }
  return readOnly ? out : detectRenames(state, local, out);
}

/** A local deletion plus a new local file with the same content is a rename. */
function detectRenames(state: State, local: Map<string, LocalFile>, actions: Action[]): Action[] {
  const deleted = new Map<string, number>();
  actions.forEach((a, i) => {
    if (a.kind !== "deleteRemote") return;
    const h = state.files[a.path]?.hash;
    // Several deletions with one content: leave them alone (not obviously a rename).
    if (h) deleted.set(h, deleted.has(h) ? -1 : i);
  });
  const drop = new Set<number>();
  actions.forEach((a, i) => {
    if (a.kind !== "upload" || a.base !== null || state.files[a.path]) return;
    const h = local.get(a.path)?.hash;
    const j = h ? deleted.get(h) : undefined;
    if (h && j !== undefined && j >= 0) {
      actions[j] = { kind: "moveRemote", from: actions[j].path, path: a.path };
      deleted.delete(h);
      drop.add(i);
    }
  });
  return actions.filter((_, i) => !drop.has(i));
}
