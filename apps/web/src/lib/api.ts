/** Thin fetch wrapper for the staff API. Errors carry the server's plain-language message. */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public field?: string,
  ) {
    super(message);
  }
}

type Init = { method?: string; body?: unknown; signal?: AbortSignal };

export const api = <T>(path: string, init: Init = {}): Promise<T> => request<T>("/api/studio", path, init);
/** Pages clients use without signing in. */
export const publicApi = <T>(path: string, init: Init = {}): Promise<T> => request<T>("/api/public", path, init);

async function request<T>(base: string, path: string, init: Init): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: init.body === undefined ? undefined : { "content-type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      credentials: "same-origin",
      signal: init.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiError(0, "Can't reach OpenPortrait. Check your connection and try again.");
  }
  const data = (await res.json().catch(() => ({}))) as { message?: string; field?: string };
  if (!res.ok) throw new ApiError(res.status, data.message ?? `Request failed (${res.status}).`, data.field);
  return data as T;
}

export interface Me {
  user: { id: string; email: string; name: string; role: "owner" | "staff" | "assistant" } | null;
  studio: { name: string; timezone: string };
}

export interface InternetStatus {
  tunnel: {
    installed: boolean;
    configured: boolean;
    state: "not-installed" | "off" | "starting" | "connected" | "reconnecting" | "error";
    hostnames: string[];
    connections: number;
    lastError: string | null;
    since: number | null;
    tokenSource: "settings" | "template" | null;
  };
  publicUrl: string;
  publicUrlSource: "settings" | "template" | "tunnel" | null;
  trustCloudflare: boolean;
  lan: { addresses: string[]; port: number };
  platform: "unraid" | "docker";
}

export type AiLevel = "read" | "assist" | "full";
export interface AiConnection {
  id: string;
  label: string;
  kind: "token" | "oauth";
  level: AiLevel;
  areas: string[];
  tokenHint: string;
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  expired: boolean;
}
export interface AiStatus {
  enabled: boolean;
  paused: boolean;
  urls: { public: string | null; lan: string | null };
  online: boolean;
  areas: string[];
  toolCount: number;
  connections: AiConnection[];
  lastSeenAt: number | null;
}
export interface AiActivityItem {
  id: number;
  at: number;
  connection: string;
  action: string;
  ok: boolean;
}

export interface AiApproval {
  id: string;
  connection: string;
  tool: string;
  tier: "outward" | "money";
  summary: string;
  args: unknown;
  status: "pending" | "approved" | "declined" | "expired" | "failed";
  result: unknown;
  createdAt: number;
  decidedAt: number | null;
  expiresAt: number;
}
