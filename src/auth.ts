import { apiError, json, send, SyncError, type Http } from "./http";

/*
 * Sign-in with Grimoire, the studio's identity service (each studio runs its own). The plugin is Grimoire's public client
 * "tome-obsidian": authorization code with PKCE in the system browser, landing on Grimoire's
 * /obsidian/callback page, which hands the code back through an obsidian://tome-sync link (or
 * as text to paste). The refresh token stays on this device; each call to Tome uses a 5-minute
 * Tome token from Grimoire's desktop API, so Tome sees the person with their own role, and
 * Grimoire decides who may sync: removing someone there ends their sync everywhere.
 */

export const CLIENT_ID = "tome-obsidian";
const SCOPES = "openid email profile grimoire offline_access";
/** Ask for a new access token this long before the old one runs out. */
const EARLY_MS = 60_000;

export interface Session {
  /** Grimoire's address, like https://app.example-studio.com */
  server: string;
  tokenEndpoint: string;
  revocationEndpoint: string | null;
  refreshToken: string;
  user: { name: string; email: string };
}

/** A sign-in in progress, saved because a phone may close Obsidian while the browser is open. */
export interface Pending {
  server: string;
  tokenEndpoint: string;
  revocationEndpoint: string | null;
  state: string;
  verifier: string;
  nonce: string;
  redirect: string;
  at: number;
}

export interface SessionStore {
  load(): Session | null;
  save(s: Session | null): void;
  loadPending(): Pending | null;
  savePending(p: Pending | null): void;
}

/** https only, except on this machine (development). */
export function normalizeServer(input: string): string {
  const t = input.trim().replace(/\/+$/, "");
  let u: URL;
  try {
    u = new URL(t.includes("://") ? t : `https://${t}`);
  } catch {
    throw new SyncError("other", "That doesn't look like a web address");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (!(u.protocol === "https:" || (u.protocol === "http:" && local))) throw new SyncError("other", "Use an https:// address");
  if (u.username || u.password || u.search) throw new SyncError("other", "Use just the Grimoire address, like https://grimoire.example.com");
  return u.origin;
}

const b64url = (bytes: Uint8Array) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const random = (n: number) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const utf8b64url = (s: string) => b64url(new TextEncoder().encode(s));

function jwtPayload(jwt: string): Record<string, unknown> | null {
  try {
    const p = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(p), (c) => c.charCodeAt(0))));
  } catch {
    return null;
  }
}

const form = (o: Record<string, string>) => new URLSearchParams(o).toString();

export class Grimoire {
  private access: { token: string; exp: number } | null = null;
  private tome: { token: string; url: string; exp: number } | null = null;
  private refreshing: Promise<string> | null = null;

  constructor(
    private http: Http,
    private store: SessionStore,
  ) {}

  get session() {
    return this.store.load();
  }

  /** Step 1: the address to open in the browser. `vaultName` routes the obsidian:// link back to this vault. */
  async begin(serverInput: string, vaultName: string): Promise<string> {
    const server = normalizeServer(serverInput);
    const issuer = `${server}/oidc`;
    const res = await send(this.http, { url: `${issuer}/.well-known/openid-configuration` });
    const disco = res.status === 200 ? json(res) : null;
    if (!disco?.issuer) throw new SyncError("other", `${server} doesn't look like Grimoire`);
    if (String(disco.issuer).replace(/\/$/, "") !== issuer) throw new SyncError("other", `Grimoire calls itself ${disco.issuer}; use that address instead`);
    const verifier = random(32);
    const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
    const p: Pending = {
      server,
      tokenEndpoint: disco.token_endpoint,
      revocationEndpoint: disco.revocation_endpoint ?? null,
      state: `${random(18)}.${utf8b64url(vaultName)}`,
      verifier,
      nonce: random(18),
      redirect: `${server}/obsidian/callback`,
      at: Date.now(),
    };
    this.store.savePending(p);
    const url = new URL(disco.authorization_endpoint);
    for (const [k, v] of Object.entries({ response_type: "code", client_id: CLIENT_ID, redirect_uri: p.redirect, scope: SCOPES, state: p.state, nonce: p.nonce, code_challenge: challenge, code_challenge_method: "S256" })) url.searchParams.set(k, v);
    return url.toString();
  }

  /** Step 2: the code came back (obsidian:// link, or pasted as "code~state"). */
  async finish(code: string, state: string) {
    const p = this.store.loadPending();
    if (!p || p.state !== state) throw new SyncError("other", "This sign-in code isn't from this vault's latest sign-in. Press Sign in again.");
    if (Date.now() - p.at > 15 * 60_000) throw new SyncError("other", "That sign-in took too long. Press Sign in again.");
    const res = await send(this.http, {
      url: p.tokenEndpoint,
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({ grant_type: "authorization_code", code, redirect_uri: p.redirect, client_id: CLIENT_ID, code_verifier: p.verifier }),
    });
    const tok = json(res);
    if (res.status !== 200) throw new SyncError("signedOut", `Grimoire refused the sign-in: ${tok.error_description ?? tok.error ?? `HTTP ${res.status}`}`);
    if (!tok.access_token || !tok.refresh_token || !tok.id_token) throw new SyncError("other", "Grimoire didn't return the tokens the plugin needs");
    const claims = jwtPayload(tok.id_token);
    if (claims?.nonce !== p.nonce) throw new SyncError("signedOut", "Sign-in response didn't match this request");
    this.store.savePending(null);
    this.access = { token: tok.access_token, exp: Date.now() + (tok.expires_in ?? 3600) * 1000 };
    this.tome = null;
    const session: Session = {
      server: p.server,
      tokenEndpoint: p.tokenEndpoint,
      revocationEndpoint: p.revocationEndpoint,
      refreshToken: tok.refresh_token,
      user: { name: String(claims?.name ?? claims?.email ?? ""), email: String(claims?.email ?? "") },
    };
    this.store.save(session);
    return session.user;
  }

  /** Accepts "code~state" as shown on Grimoire's page (whitespace around it is fine). */
  finishPasted(text: string) {
    const [code, state] = text.trim().split("~");
    if (!code || !state) throw new SyncError("other", "That isn't a sign-in code. Copy the whole code from the Grimoire page.");
    return this.finish(code, state);
  }

  async signOut() {
    const s = this.store.load();
    this.store.save(null);
    this.access = null;
    this.tome = null;
    if (s?.revocationEndpoint) {
      await send(this.http, {
        url: s.revocationEndpoint,
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form({ token: s.refreshToken, token_type_hint: "refresh_token", client_id: CLIENT_ID }),
      }).catch(() => {});
    }
  }

  private ended(): never {
    this.store.save(null);
    this.access = null;
    this.tome = null;
    throw new SyncError("signedOut", "Your Grimoire sign-in ended. Sign in again.");
  }

  /** A valid Grimoire access token, refreshed when needed (one refresh at a time: refresh tokens rotate). */
  private async accessToken(force = false): Promise<string> {
    if (!force && this.access && this.access.exp - EARLY_MS > Date.now()) return this.access.token;
    this.refreshing ??= (async () => {
      const s = this.store.load();
      if (!s) throw new SyncError("signedOut", "Sign in with Grimoire first");
      const res = await send(this.http, {
        url: s.tokenEndpoint,
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form({ grant_type: "refresh_token", refresh_token: s.refreshToken, client_id: CLIENT_ID }),
      });
      const tok = json(res);
      if (res.status === 400 || res.status === 401) this.ended();
      if (res.status !== 200 || !tok.access_token) throw new SyncError("network", `Grimoire answered HTTP ${res.status}`);
      // Saved before anything else: the old refresh token no longer works.
      if (tok.refresh_token) this.store.save({ ...s, refreshToken: tok.refresh_token });
      this.access = { token: tok.access_token, exp: Date.now() + (tok.expires_in ?? 3600) * 1000 };
      return tok.access_token as string;
    })().finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  /** Grimoire's desktop API (`path` under /api/v1/desktop). */
  async desktop(method: string, path: string, body?: unknown) {
    const s = this.store.load();
    if (!s) throw new SyncError("signedOut", "Sign in with Grimoire first");
    for (let attempt = 0; ; attempt++) {
      const token = await this.accessToken(attempt > 0);
      const res = await send(this.http, {
        url: `${s.server}/api/v1/desktop${path}`,
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.status === 401 && attempt === 0) continue;
      if (res.status === 401) this.ended();
      if (res.status >= 400) throw apiError(res, "Grimoire refused the request");
      return json(res);
    }
  }

  /** A short-lived token for Tome's API and Tome's address, cached until shortly before it expires. */
  async tomeToken(force = false) {
    if (!force && this.tome && this.tome.exp - 30_000 > Date.now()) return this.tome;
    let v;
    try {
      v = await this.desktop("POST", "/token", { app: "tome" });
    } catch (e) {
      if (e instanceof SyncError && (e.status === 403 || e.status === 404)) throw new SyncError("api", "Your Grimoire account doesn't have Tome. Ask your Grimoire admin to give you access.", e.status, e.code);
      throw e;
    }
    if (!v.token || !v.url) throw new SyncError("other", "Grimoire didn't return a Tome token");
    this.tome = { token: v.token, url: String(v.url).replace(/\/$/, ""), exp: Date.now() + (v.expiresIn ?? 300) * 1000 };
    return this.tome;
  }
}
