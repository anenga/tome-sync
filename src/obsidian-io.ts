import { normalizePath, requestUrl, TFile, TFolder, type App } from "obsidian";
import type { Pending, Session, SessionStore } from "./auth";
import type { LocalFs, StateStore } from "./engine";
import type { Http } from "./http";
import type { State } from "./plan";

/* The plugin's ties to Obsidian: HTTP, the vault's files, and where it keeps its own state. */

/** requestUrl isn't bound by CORS and works the same on desktop and phones. */
export const obsidianHttp: Http = async (req) => {
  const res = await requestUrl({ url: req.url, method: req.method ?? "GET", headers: req.headers, body: req.body, throw: false });
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(res.headers ?? {})) headers[k.toLowerCase()] = String(v);
  return { status: res.status, headers, body: res.arrayBuffer };
};

const buf = (d: Uint8Array) => d.slice().buffer;

/**
 * The vault through Obsidian's own API, so the editor, links and search see every change at
 * once (on phones there's no file watcher to catch writes made behind Obsidian's back).
 */
export class ObsidianFs implements LocalFs {
  constructor(private app: App) {}

  async list() {
    return this.app.vault.getFiles().map((f) => ({ path: f.path, size: f.stat.size, mtime: f.stat.mtime }));
  }

  private file(path: string) {
    const f = this.app.vault.getAbstractFileByPath(normalizePath(path));
    return f instanceof TFile ? f : null;
  }

  async read(path: string) {
    const f = this.file(path);
    return f ? new Uint8Array(await this.app.vault.readBinary(f)) : null;
  }

  async write(path: string, data: Uint8Array) {
    const p = normalizePath(path);
    const f = this.file(p);
    if (f) return this.app.vault.modifyBinary(f, buf(data));
    const dir = p.split("/").slice(0, -1).join("/");
    if (dir && !(this.app.vault.getAbstractFileByPath(dir) instanceof TFolder)) await this.app.vault.createFolder(dir).catch(() => {});
    await this.app.vault.createBinary(p, buf(data));
  }

  async stat(path: string) {
    const f = this.file(path);
    return f ? { size: f.stat.size, mtime: f.stat.mtime } : null;
  }

  async exists(path: string) {
    return !!this.app.vault.getAbstractFileByPath(normalizePath(path)) || (await this.app.vault.adapter.exists(normalizePath(path)));
  }

  async trash(path: string) {
    const f = this.file(path);
    // false: the vault's own .trash folder, not the computer's (phones have none).
    if (f) await this.app.vault.trash(f, false);
  }
}

/**
 * Sync state in the plugin's folder (.obsidian/plugins/tome-sync/sync/), which is hidden, so it
 * never syncs itself. One state per Tome vault, so switching vaults starts clean.
 */
export class PluginStateStore implements StateStore {
  constructor(
    private app: App,
    private dir: string,
  ) {}

  private get a() {
    return this.app.vault.adapter;
  }

  private async ensure(dir: string) {
    if (!(await this.a.exists(dir))) await this.a.mkdir(dir);
  }

  async load(): Promise<State> {
    try {
      const v = JSON.parse(await this.a.read(`${this.dir}/state.json`));
      return v && typeof v.files === "object" ? v : { files: {} };
    } catch {
      return { files: {} };
    }
  }

  async save(s: State) {
    await this.ensure(this.dir);
    await this.a.write(`${this.dir}/state.json.tmp`, JSON.stringify(s));
    if (await this.a.exists(`${this.dir}/state.json`)) await this.a.remove(`${this.dir}/state.json`);
    await this.a.rename(`${this.dir}/state.json.tmp`, `${this.dir}/state.json`);
  }

  async readBase(hash: string) {
    try {
      return new Uint8Array(await this.a.readBinary(`${this.dir}/base/${hash}`));
    } catch {
      return null;
    }
  }

  async writeBase(hash: string, data: Uint8Array) {
    await this.ensure(this.dir);
    await this.ensure(`${this.dir}/base`);
    await this.a.writeBinary(`${this.dir}/base/${hash}`, buf(data));
  }

  async pruneBases(keep: Set<string>) {
    if (!(await this.a.exists(`${this.dir}/base`))) return;
    for (const f of (await this.a.list(`${this.dir}/base`)).files) {
      const name = f.split("/").pop()!;
      if (!keep.has(name)) await this.a.remove(f).catch(() => {});
    }
  }

  /** Forgets everything (the person picked another vault or signed out): files on both sides stay. */
  async clear() {
    if (await this.a.exists(this.dir)) await this.a.rmdir(this.dir, true);
  }
}

/**
 * The Grimoire sign-in, kept on this device only: Obsidian's secret storage where there is one
 * (1.11.4 and later), otherwise this vault's local storage. Never in a file inside the vault,
 * so copying or backing up the vault doesn't copy the sign-in.
 */
export class DeviceSessionStore implements SessionStore {
  /** Secret storage is shared by every vault on the device; each vault keeps its own sign-in. */
  private suffix: string;

  constructor(private app: App) {
    let h = 0x811c9dc5;
    for (const c of app.vault.getName()) h = Math.imul(h ^ c.codePointAt(0)!, 0x01000193) >>> 0;
    this.suffix = h.toString(16);
  }

  private get secrets() {
    return (this.app as App & { secretStorage?: { getSecret(id: string): string | null; setSecret(id: string, v: string): void } }).secretStorage;
  }

  private get(key: string) {
    try {
      const raw = this.secrets ? this.secrets.getSecret(key) : this.app.loadLocalStorage(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  private set(key: string, v: unknown) {
    const raw = v === null ? "" : JSON.stringify(v);
    if (this.secrets) this.secrets.setSecret(key, raw);
    else this.app.saveLocalStorage(key, raw || null);
  }

  load = (): Session | null => this.get(`tome-sync-session-${this.suffix}`);
  save = (s: Session | null) => this.set(`tome-sync-session-${this.suffix}`, s);
  loadPending = (): Pending | null => this.get(`tome-sync-pending-${this.suffix}`);
  savePending = (p: Pending | null) => this.set(`tome-sync-pending-${this.suffix}`, p);
}
