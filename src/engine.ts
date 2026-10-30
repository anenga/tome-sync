import { SyncError } from "./http";
import { mergeText } from "./merge";
import { conflictName, hidden, isNote, portable, syncable } from "./paths";
import { plan, type Action, type LocalFile, type RemoteFile, type State } from "./plan";
import type { Tome } from "./tome";

/*
 * Two-way sync between this Obsidian vault and a Tome vault, one cycle at a time:
 *
 *  - changed here only   → upload, conditional on the revision last seen (Tome refuses it if
 *                          someone changed the file meanwhile, and the file is merged instead);
 *  - changed in Tome only → download (after checking it wasn't just edited here);
 *  - changed on both     → notes merge line by line against the last synced copy; when the same
 *                          lines changed, Tome's version stays at the path and this device's is
 *                          kept next to it as "Note (conflict, <device>, <date>).md";
 *  - deleted here        → moved to Tome's trash (only if nobody changed it there);
 *  - deleted in Tome     → moved to this vault's .trash folder (Obsidian's own trash);
 *  - renamed here        → a move in Tome.
 *
 * Hidden files and folders (.obsidian, .trash, …), file types Tome doesn't keep, names other
 * computers can't hold and files over Tome's size limit stay here and are listed. A cycle that
 * would delete more than 50 files, or a fifth of the vault, waits for the person to confirm.
 * With view access the copy is read-only: Tome's changes come down, local edits stay local.
 */

const MASS_DELETE_FILES = 50;
const MASS_DELETE_SHARE = 0.2;
/** Below this many synced files the share rule doesn't apply (deleting 3 of 5 notes is normal). */
const MASS_DELETE_MIN = 10;

/** This vault's files, as the plugin sees them (Obsidian's vault API, or a folder in tests). */
export interface LocalFs {
  /** Every file outside hidden folders, with its size and modification time (ms). */
  list(): Promise<{ path: string; size: number; mtime: number }[]>;
  read(path: string): Promise<Uint8Array | null>;
  /** Creates or replaces the file, and the folders above it. */
  write(path: string, data: Uint8Array): Promise<void>;
  stat(path: string): Promise<{ size: number; mtime: number } | null>;
  exists(path: string): Promise<boolean>;
  /** Moves a file into the vault's .trash folder. */
  trash(path: string): Promise<void>;
}

/** Where the plugin keeps the sync state and the last synced copy of each note (for merging). */
export interface StateStore {
  load(): Promise<State>;
  save(s: State): Promise<void>;
  readBase(hash: string): Promise<Uint8Array | null>;
  writeBase(hash: string, data: Uint8Array): Promise<void>;
  /** Deletes the base copies no entry points at any more. */
  pruneBases(keep: Set<string>): Promise<void>;
}

export interface Activity {
  at: string;
  kind: "uploaded" | "downloaded" | "merged" | "conflict" | "deleted_remote" | "deleted_local" | "moved" | "error";
  path: string;
  detail?: string;
}

export interface Report {
  uploaded: number;
  downloaded: number;
  merged: number;
  conflicts: string[];
  deletedRemote: number;
  deletedLocal: number;
  moved: number;
  /** Read-only vault: local changes that stayed local. */
  keptLocal: number;
  /** Files that don't sync, with the reason (hidden files aren't listed). */
  skipped: [string, string][];
  errors: [string, string][];
  activity: Activity[];
  readOnly: boolean;
  files: number;
}

export type Cycle = { outcome: "done"; report: Report } | { outcome: "needsConfirmation"; local: number; remote: number; of: number };

export interface EngineOptions {
  /** Names this device in conflict copies. */
  device: string;
  /** Two Tome files differing only in letter case can't both live here (Windows, macOS, phones). */
  caseInsensitive: boolean;
  now?: () => Date;
}

export async function sha256Hex(data: Uint8Array) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", data.slice().buffer));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const utf8 = (b: Uint8Array | null) => new TextDecoder().decode(b ?? new Uint8Array());

export class Engine {
  constructor(
    private tome: Tome,
    private local: LocalFs,
    private store: StateStore,
    private opts: EngineOptions,
  ) {}

  /** One sync cycle with the Tome vault `vault` (its slug). `allowDeletes`: the person confirmed a large deletion. */
  async sync(vault: string, allowDeletes = false): Promise<Cycle> {
    const listing = await this.tome.listing(vault);
    const readOnly = !listing.canWrite;
    const ctx = new Run(this.tome, this.local, this.store, this.opts, vault, await this.store.load(), readOnly, new Set(listing.folders));
    for (const f of listing.files) {
      if (!portable(f.path)) {
        ctx.report.skipped.push([f.path, "This name can't be used on every computer"]);
        continue;
      }
      ctx.remote.set(f.path, { tag: f.tag, size: f.size });
    }
    if (this.opts.caseInsensitive) {
      const seen = new Set<string>();
      for (const p of [...ctx.remote.keys()]) {
        if (seen.has(p.toLowerCase())) {
          ctx.remote.delete(p);
          ctx.report.skipped.push([p, "Another file in Tome has the same name in different letter case"]);
        } else seen.add(p.toLowerCase());
      }
    }
    const local = await ctx.scan(listing.maxFileBytes);
    const synced = Object.keys(ctx.state.files).length;
    // A vault that suddenly looks empty is more likely a problem than an emptied vault.
    if (local.size === 0 && synced >= 3 && !allowDeletes) return { outcome: "needsConfirmation", local: 0, remote: synced, of: synced };
    const actions = plan(ctx.state, local, ctx.remote, readOnly);
    const dl = actions.filter((a) => a.kind === "deleteLocal").length;
    const dr = actions.filter((a) => a.kind === "deleteRemote").length;
    if (!allowDeletes && (dl + dr > MASS_DELETE_FILES || (synced >= MASS_DELETE_MIN && dl + dr > synced * MASS_DELETE_SHARE))) return { outcome: "needsConfirmation", local: dl, remote: dr, of: synced };
    try {
      for (const a of actions) {
        try {
          await ctx.run(a);
        } catch (e) {
          // Signed out or offline: stop here; what's done is saved and the rest is retried next time.
          if (e instanceof SyncError && (e.kind === "signedOut" || e.kind === "network")) throw e;
          const msg = e instanceof Error ? e.message : String(e);
          ctx.log("error", a.path, msg);
          ctx.report.errors.push([a.path, msg]);
        }
      }
    } finally {
      await ctx.finish();
    }
    return { outcome: "done", report: ctx.report };
  }
}

/** One cycle's working state. */
class Run {
  report: Report;
  remote = new Map<string, RemoteFile>();

  constructor(
    private tome: Tome,
    private fs: LocalFs,
    private store: StateStore,
    private opts: EngineOptions,
    private vault: string,
    public state: State,
    readOnly: boolean,
    private folders: Set<string>,
  ) {
    this.report = { uploaded: 0, downloaded: 0, merged: 0, conflicts: [], deletedRemote: 0, deletedLocal: 0, moved: 0, keptLocal: 0, skipped: [], errors: [], activity: [], readOnly, files: 0 };
  }

  log(kind: Activity["kind"], path: string, detail?: string) {
    this.report.activity.push({ at: new Date().toISOString(), kind, path, ...(detail ? { detail } : {}) });
  }

  /** Every syncable file here, hashed (reusing the last hash when size and mtime match). */
  async scan(max: number) {
    const out = new Map<string, LocalFile>();
    for (const f of await this.fs.list()) {
      if (hidden(f.path)) continue;
      if (!syncable(f.path)) {
        this.report.skipped.push([f.path, "Tome doesn't keep this kind of file"]);
        continue;
      }
      if (!portable(f.path)) {
        this.report.skipped.push([f.path, "The name has characters Windows can't use"]);
        continue;
      }
      if (f.size > max) {
        this.report.skipped.push([f.path, `Larger than Tome's ${Math.round(max / 1048576)} MB limit`]);
        continue;
      }
      const s = this.state.files[f.path];
      let hash = s && s.size === f.size && s.mtime === f.mtime ? s.hash : null;
      if (!hash) {
        const data = await this.fs.read(f.path);
        if (!data) continue;
        hash = await sha256Hex(data);
      }
      out.set(f.path, { hash, size: f.size, mtime: f.mtime });
    }
    return out;
  }

  async run(a: Action) {
    switch (a.kind) {
      case "upload":
        return this.upload(a.path, a.base);
      case "download":
        return this.download(a.path, a.known);
      case "merge":
        return this.merge(a.path);
      case "deleteRemote":
        return this.deleteRemote(a.path, a.rev);
      case "deleteLocal":
        return this.deleteLocal(a.path);
      case "moveRemote":
        return this.moveRemote(a.from, a.path);
      case "forget":
        delete this.state.files[a.path];
        return;
      case "keepLocal":
        this.report.keptLocal++;
        return;
    }
  }

  async finish() {
    await this.store.save(this.state);
    this.report.files = Object.keys(this.state.files).length;
    await this.store.pruneBases(new Set(Object.values(this.state.files).map((e) => e.hash)));
  }

  /** Records that both sides now hold `data` at Tome revision `rev`. */
  private async record(path: string, data: Uint8Array, rev: string, tag: string | null) {
    const hash = await sha256Hex(data);
    const st = (await this.fs.stat(path)) ?? { size: data.length, mtime: 0 };
    if (isNote(path)) await this.store.writeBase(hash, data);
    this.state.files[path] = { hash, rev, tag, size: st.size, mtime: st.mtime };
  }

  private remoteTag = (path: string) => this.remote.get(path)?.tag ?? null;

  private async upload(path: string, base: string | null): Promise<void> {
    const data = await this.fs.read(path);
    if (!data) return;
    const r = await this.tome.put(this.vault, path, data, base);
    // Someone changed (or created) it in Tome meanwhile.
    if ("conflict" in r) return this.merge(path);
    // The list's tag is from before this write: leave it unknown so the next cycle checks the
    // revision (cheap: 304) and learns the new tag.
    await this.record(path, data, r.rev, null);
    this.report.uploaded++;
    this.log("uploaded", path);
  }

  private async download(path: string, known: string | null): Promise<void> {
    const tag = this.remoteTag(path);
    const f = await this.tome.fetch(this.vault, path, known);
    if (f.kind === "unchanged") {
      const e = this.state.files[path];
      if (e) e.tag = tag;
      return;
    }
    if (f.kind === "gone") return;
    const hash = await sha256Hex(f.data);
    const current = await this.fs.read(path);
    if (current) {
      const h = await sha256Hex(current);
      if (h === hash) return this.record(path, f.data, f.rev, tag);
      // Edited here since the scan: merge instead of overwriting.
      if (this.state.files[path]?.hash !== h) return this.merge(path);
    }
    await this.fs.write(path, f.data);
    await this.record(path, f.data, f.rev, tag);
    this.report.downloaded++;
    this.log("downloaded", path);
  }

  private async merge(path: string): Promise<void> {
    const tag = this.remoteTag(path);
    const local = await this.fs.read(path);
    if (!local) return this.download(path, null);
    const f = await this.tome.fetch(this.vault, path, null);
    if (f.kind !== "bytes") {
      if (this.report.readOnly) {
        this.report.keptLocal++;
        return;
      }
      return this.upload(path, null);
    }
    const { data: remote, rev } = f;
    if (same(local, remote)) return this.record(path, local, rev, tag);
    const entry = this.state.files[path];
    const base = entry ? await this.store.readBase(entry.hash) : null;
    // Without a base (new on both sides) only identical text merges; that's handled above.
    if (isNote(path) && !this.report.readOnly && base) {
      const merged = mergeText(utf8(base), utf8(local), utf8(remote));
      if (merged !== null) {
        const bytes = new TextEncoder().encode(merged);
        let newRev = rev;
        if (!same(bytes, remote)) {
          const r = await this.tome.put(this.vault, path, bytes, rev);
          if ("conflict" in r) throw new Error("It changed in Tome again while merging; it will be merged on the next sync");
          newRev = r.rev;
        }
        if (!same(bytes, local)) await this.fs.write(path, bytes);
        await this.record(path, bytes, newRev, same(bytes, remote) ? tag : null);
        this.report.merged++;
        this.log("merged", path);
        return;
      }
    }
    // Keep both: Tome's version at the path, this device's next to it.
    const taken = new Set<string>();
    let copy = "";
    for (;;) {
      copy = conflictName(path, this.opts.device, (this.opts.now ?? (() => new Date()))(), (c) => taken.has(c) || this.remote.has(c));
      if (!(await this.fs.exists(copy))) break;
      taken.add(copy);
    }
    await this.fs.write(copy, local);
    await this.fs.write(path, remote);
    await this.record(path, remote, rev, tag);
    if (!this.report.readOnly) {
      const r = await this.tome.put(this.vault, copy, local, null);
      if ("rev" in r) await this.record(copy, local, r.rev, null);
    }
    this.report.conflicts.push(copy);
    this.log("conflict", path, `Changed here and in Tome; this device's version is in "${copy}"`);
  }

  private async deleteRemote(path: string, rev: string): Promise<void> {
    // Changed in Tome after this device deleted it: bring the new version back.
    if (!(await this.tome.remove(this.vault, path, rev))) return this.download(path, null);
    delete this.state.files[path];
    this.report.deletedRemote++;
    this.log("deleted_remote", path, "Moved to Tome's trash");
  }

  /** A file Tome deleted goes to this vault's .trash folder. */
  private async deleteLocal(path: string) {
    if (await this.fs.exists(path)) await this.fs.trash(path);
    delete this.state.files[path];
    this.report.deletedLocal++;
    this.log("deleted_local", path, "Deleted in Tome; moved to this vault's .trash folder");
  }

  /** Creates the folders above `path` in Tome that don't exist yet (a move needs them). */
  private async ensureFolders(path: string) {
    let parent = "";
    for (const seg of path.split("/").slice(0, -1)) {
      const here = parent ? `${parent}/${seg}` : seg;
      if (!this.folders.has(here)) {
        try {
          await this.tome.mkdir(this.vault, parent, seg);
        } catch (e) {
          if (!(e instanceof SyncError && e.status === 409)) throw e;
        }
        this.folders.add(here);
      }
      parent = here;
    }
  }

  private async moveRemote(from: string, to: string): Promise<void> {
    await this.ensureFolders(to);
    try {
      // Obsidian already updated links in this vault; those edits sync as ordinary changes.
      await this.tome.move(this.vault, from, to);
    } catch (e) {
      // Couldn't move (the old file changed or the name is taken): upload and delete instead.
      if (e instanceof SyncError && (e.status === 404 || e.status === 409)) {
        await this.upload(to, null);
        const old = this.state.files[from];
        if (old) await this.deleteRemote(from, old.rev);
        return;
      }
      throw e;
    }
    const data = await this.fs.read(to);
    if (!data) return;
    const old = this.state.files[from];
    delete this.state.files[from];
    // Same bytes, so the same content revision; checked again next cycle.
    await this.record(to, data, old?.rev ?? "", null);
    this.report.moved++;
    this.log("moved", to, `Renamed from ${from}`);
  }
}
