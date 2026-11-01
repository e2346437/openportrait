/**
 * A thin client for the parts of Google Calendar that OpenPortrait uses, behind an interface so the
 * sync engine can be tested against a fake. Uses the photographer's own OAuth client (SPEC section 6).
 */

export const GOOGLE_SCOPE = "https://www.googleapis.com/auth/calendar";

export interface GoogleCalendarInfo {
  id: string;
  name: string;
  primary: boolean;
  /** "owner" or "writer" can be written to; "reader" and "freeBusyReader" are read only. */
  accessRole: string;
}

export interface GoogleEvent {
  id: string;
  etag?: string;
  status?: "confirmed" | "tentative" | "cancelled";
  summary?: string;
  description?: string;
  location?: string;
  /** "transparent" means shown as free. */
  transparency?: "opaque" | "transparent";
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
}

export interface ListEventsResult {
  events: GoogleEvent[];
  nextSyncToken: string | null;
}

export interface GoogleApi {
  listCalendars(): Promise<GoogleCalendarInfo[]>;
  createCalendar(name: string, timeZone: string): Promise<GoogleCalendarInfo>;
  /** Without a syncToken this reads events from `timeMin` on; with one it returns only what changed. Throws SyncTokenExpired when Google no longer honours it. */
  listEvents(calendarId: string, opts: { syncToken?: string | null; timeMin?: string; timeMax?: string }): Promise<ListEventsResult>;
  insertEvent(calendarId: string, event: Omit<GoogleEvent, "id" | "etag">): Promise<GoogleEvent>;
  patchEvent(calendarId: string, eventId: string, event: Omit<GoogleEvent, "id" | "etag">): Promise<GoogleEvent>;
  /** Deleting an event that is already gone is not an error. */
  deleteEvent(calendarId: string, eventId: string): Promise<void>;
}

export class SyncTokenExpired extends Error {
  constructor() {
    super("Google asked for a full re-read of this calendar.");
  }
}

/** Google refused the saved sign-in (revoked, or expired because the OAuth app is still in Testing). */
export class GoogleAuthError extends Error {}

export class GoogleApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type Fetch = typeof fetch;

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

export function authUrl(client: OAuthClient, redirectUri: string, state: string): string {
  const q = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: `${GOOGLE_SCOPE} openid email`,
    access_type: "offline",
    // Forces Google to hand back a refresh token even if the studio connected before.
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

async function tokenRequest(body: Record<string, string>, f: Fetch): Promise<{ access_token: string; expires_in: number; refresh_token?: string; id_token?: string }> {
  const res = await f("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
  const json = (await res.json().catch(() => ({}))) as { error?: string; error_description?: string; access_token?: string; expires_in?: number; refresh_token?: string; id_token?: string };
  if (!res.ok || !json.access_token) {
    if (json.error === "invalid_grant" || json.error === "invalid_client" || json.error === "unauthorized_client") throw new GoogleAuthError(describeAuthError(json.error, json.error_description));
    throw new GoogleApiError(json.error_description || json.error || `Google returned ${res.status}.`, res.status);
  }
  return { access_token: json.access_token, expires_in: json.expires_in ?? 3600, refresh_token: json.refresh_token, id_token: json.id_token };
}

function describeAuthError(code: string, detail?: string): string {
  if (code === "invalid_grant") return "Google no longer accepts the saved sign-in. Reconnect Google Calendar. (If this keeps happening every week, set the OAuth app's publishing status to \"In production\" in Google Cloud.)";
  if (code === "invalid_client") return "Google doesn't recognize the client ID or secret. Check them in Settings > Google Calendar.";
  return detail || "Google refused the sign-in.";
}

export async function exchangeCode(client: OAuthClient, redirectUri: string, code: string, f: Fetch = fetch): Promise<{ refreshToken: string; email: string | null }> {
  const t = await tokenRequest({ code, client_id: client.clientId, client_secret: client.clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code" }, f);
  if (!t.refresh_token) throw new GoogleApiError("Google didn't send a refresh token. Remove OpenPortrait from your Google account's third-party access and connect again.", 400);
  let email: string | null = null;
  if (t.id_token) {
    try {
      email = (JSON.parse(Buffer.from(t.id_token.split(".")[1] ?? "", "base64url").toString("utf8")) as { email?: string }).email ?? null;
    } catch {
      /* the address is only a label */
    }
  }
  return { refreshToken: t.refresh_token, email };
}

export function createGoogleApi(client: OAuthClient, refreshToken: string, f: Fetch = fetch): GoogleApi {
  let access: { token: string; expires: number } | null = null;
  const BASE = "https://www.googleapis.com/calendar/v3";

  async function token(): Promise<string> {
    if (access && access.expires > Date.now() + 60_000) return access.token;
    const t = await tokenRequest({ refresh_token: refreshToken, client_id: client.clientId, client_secret: client.clientSecret, grant_type: "refresh_token" }, f);
    access = { token: t.access_token, expires: Date.now() + t.expires_in * 1000 };
    return access.token;
  }

  async function call<T>(method: string, path: string, opts: { query?: Record<string, string>; body?: unknown; allow?: number[] } = {}): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const url = `${BASE}${path}${opts.query ? `?${new URLSearchParams(opts.query)}` : ""}`;
      const res = await f(url, { method, headers: { authorization: `Bearer ${await token()}`, ...(opts.body ? { "content-type": "application/json" } : {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
      if (res.ok) return (res.status === 204 ? {} : await res.json()) as T;
      if (opts.allow?.includes(res.status)) return {} as T;
      if (res.status === 410) throw new SyncTokenExpired();
      if (res.status === 401 && attempt === 0) {
        access = null;
        continue;
      }
      if ((res.status === 429 || res.status === 403 || res.status >= 500) && attempt < 3) {
        const body = (await res.clone().json().catch(() => ({}))) as { error?: { errors?: Array<{ reason?: string }> } };
        const rate = res.status !== 403 || body.error?.errors?.some((e) => /rateLimit|userRateLimit/i.test(e.reason ?? ""));
        if (rate) {
          await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
          continue;
        }
      }
      const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      if (res.status === 401) throw new GoogleAuthError(describeAuthError("invalid_grant"));
      throw new GoogleApiError(err.error?.message ?? `Google returned ${res.status}.`, res.status);
    }
  }

  return {
    async listCalendars() {
      const out: GoogleCalendarInfo[] = [];
      let pageToken: string | undefined;
      do {
        const r = await call<{ items?: Array<{ id: string; summary?: string; summaryOverride?: string; primary?: boolean; accessRole: string }>; nextPageToken?: string }>("GET", "/users/me/calendarList", { query: { maxResults: "250", ...(pageToken ? { pageToken } : {}) } });
        for (const c of r.items ?? []) out.push({ id: c.id, name: c.summaryOverride || c.summary || c.id, primary: !!c.primary, accessRole: c.accessRole });
        pageToken = r.nextPageToken;
      } while (pageToken);
      return out;
    },
    async createCalendar(name, timeZone) {
      const c = await call<{ id: string; summary: string }>("POST", "/calendars", { body: { summary: name, timeZone } });
      return { id: c.id, name: c.summary, primary: false, accessRole: "owner" };
    },
    async listEvents(calendarId, { syncToken, timeMin, timeMax }) {
      const events: GoogleEvent[] = [];
      let pageToken: string | undefined;
      let nextSyncToken: string | null = null;
      do {
        const query: Record<string, string> = { maxResults: "250", singleEvents: "true", showDeleted: "true" };
        if (syncToken) query.syncToken = syncToken;
        else {
          if (timeMin) query.timeMin = timeMin;
          if (timeMax) query.timeMax = timeMax;
        }
        if (pageToken) query.pageToken = pageToken;
        const r = await call<{ items?: GoogleEvent[]; nextPageToken?: string; nextSyncToken?: string }>("GET", `/calendars/${encodeURIComponent(calendarId)}/events`, { query });
        events.push(...(r.items ?? []));
        pageToken = r.nextPageToken;
        nextSyncToken = r.nextSyncToken ?? nextSyncToken;
      } while (pageToken);
      return { events, nextSyncToken };
    },
    insertEvent: (calendarId, event) => call<GoogleEvent>("POST", `/calendars/${encodeURIComponent(calendarId)}/events`, { body: event }),
    patchEvent: (calendarId, eventId, event) => call<GoogleEvent>("PATCH", `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, { body: event }),
    async deleteEvent(calendarId, eventId) {
      await call("DELETE", `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, { allow: [404, 410] });
    },
  };
}
