/*
 * The little the sync needs from HTTP, so the same code runs inside Obsidian (requestUrl, which
 * isn't bound by CORS and works on phones) and in Node for the tests (fetch).
 */

export interface HttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
}

export interface HttpResponse {
  status: number;
  /** Lower-case names. */
  headers: Record<string, string>;
  body: ArrayBuffer;
}

/** Throws only when the server can't be reached; any HTTP status is an answer. */
export type Http = (req: HttpRequest) => Promise<HttpResponse>;

export type ErrorKind = "network" | "signedOut" | "api" | "other";

export class SyncError extends Error {
  constructor(
    public kind: ErrorKind,
    message: string,
    public status = 0,
    public code = "",
    public details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const text = (res: HttpResponse) => new TextDecoder().decode(res.body);

export function json<T = any>(res: HttpResponse): T {
  try {
    return JSON.parse(text(res)) as T;
  } catch {
    return {} as T;
  }
}

/** The error an app's or Grimoire's API answered with ({ error: { code, message, details } }). */
export function apiError(res: HttpResponse, fallback = "The server refused the request"): SyncError {
  const v = json(res);
  const e = v?.error;
  const message = typeof e === "object" && e ? e.message : (v?.error_description ?? (typeof e === "string" ? e : null));
  return new SyncError("api", message || `${fallback} (HTTP ${res.status})`, res.status, typeof e === "object" && e ? (e.code ?? "") : (e ?? ""), typeof e === "object" && e ? (e.details ?? {}) : {});
}

export async function send(http: Http, req: HttpRequest): Promise<HttpResponse> {
  try {
    return await http(req);
  } catch (e) {
    throw new SyncError("network", `Couldn't reach ${new URL(req.url).host}. Check your connection.`, 0, "", { cause: String(e) });
  }
}
