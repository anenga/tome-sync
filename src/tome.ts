import type { Grimoire } from "./auth";
import { apiError, json, send, SyncError, type HttpRequest, type HttpResponse, type Http } from "./http";

/** Tome's API (/api/v1), called as the signed-in person with a token from Grimoire. */

export interface VaultInfo {
  id: string;
  slug: string;
  name: string;
  role: "owner" | "admin" | "editor" | "viewer";
}

export interface Listing {
  vault: { id: string; slug: string; name: string };
  canWrite: boolean;
  maxFileBytes: number;
  files: { path: string; size: number; mtime: number; tag: string | null }[];
  folders: string[];
}

export type Fetched = { kind: "bytes"; data: Uint8Array; rev: string } | { kind: "unchanged" } | { kind: "gone" };

const enc = encodeURIComponent;

export class Tome {
  constructor(
    private http: Http,
    private grimoire: Grimoire,
  ) {}

  /** Retries once with a fresh token on 401. */
  async send(method: string, path: string, init: Omit<HttpRequest, "url" | "method"> = {}): Promise<HttpResponse> {
    for (let attempt = 0; ; attempt++) {
      const t = await this.grimoire.tomeToken(attempt > 0);
      const res = await send(this.http, { ...init, method, url: `${t.url}/api/v1${path}`, headers: { ...init.headers, authorization: `Bearer ${t.token}` } });
      if (res.status === 401 && attempt === 0) continue;
      if (res.status === 401) throw new SyncError("signedOut", "Tome didn't accept the sign-in. Sign in again.", 401);
      // Tome only knows people who have opened it once in the browser (that creates their account).
      if (res.status === 403 && /no access to Tome/i.test(apiError(res).message)) throw new SyncError("api", `Open ${t.url} once in your browser and sign in, then sync again. Tome sets up your account the first time.`, 403, "forbidden");
      return res;
    }
  }

  async json<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.send(method, path, body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (res.status >= 400) throw apiError(res, "Tome refused the request");
    return json<T>(res);
  }

  async url() {
    return (await this.grimoire.tomeToken()).url;
  }

  vaults = async () => (await this.json<{ vaults: VaultInfo[] }>("GET", "/vaults")).vaults;

  listing = (vault: string) => this.json<Listing>("GET", `/vaults/${enc(vault)}/sync`);

  /** Tome's bytes and revision. `known`: answers "unchanged" if it's still at that revision. */
  async fetch(vault: string, path: string, known: string | null): Promise<Fetched> {
    const res = await this.send("GET", `/vaults/${enc(vault)}/raw?path=${enc(path)}`, known ? { headers: { "if-none-match": `"${known}"` } } : {});
    if (res.status === 304) return { kind: "unchanged" };
    if (res.status === 404) return { kind: "gone" };
    if (res.status >= 400) throw apiError(res, "Tome refused the download");
    return { kind: "bytes", data: new Uint8Array(res.body), rev: (res.headers["etag"] ?? "").replace(/^W\//, "").replace(/"/g, "") };
  }

  /** Conditional write: { conflict } when Tome has another revision than `base` (or the file exists and base is null). */
  async put(vault: string, path: string, data: Uint8Array, base: string | null): Promise<{ rev: string } | { conflict: string | null }> {
    const q = `/vaults/${enc(vault)}/sync/file?path=${enc(path)}${base ? `&baseRev=${enc(base)}` : ""}`;
    const res = await this.send("PUT", q, { headers: { "content-type": "application/octet-stream" }, body: data.slice().buffer });
    if (res.status === 409) return { conflict: (json(res)?.error?.details?.currentRev as string | undefined) ?? null };
    if (res.status >= 400) throw apiError(res, "Tome refused the upload");
    return { rev: String(json(res).rev ?? "") };
  }

  /** Moves a file to Tome's trash if it's still at `rev`. false: it changed meanwhile. */
  async remove(vault: string, path: string, rev: string): Promise<boolean> {
    const res = await this.send("DELETE", `/vaults/${enc(vault)}/sync/file?path=${enc(path)}&baseRev=${enc(rev)}`);
    if (res.status === 409) return false;
    if (res.status >= 400) throw apiError(res, "Tome refused the deletion");
    return true;
  }

  move = (vault: string, from: string, to: string) => this.json("POST", `/vaults/${enc(vault)}/move`, { from, to, updateLinks: false });

  mkdir = (vault: string, parent: string, name: string) => this.json("POST", `/vaults/${enc(vault)}/folders`, { parent, name });
}
