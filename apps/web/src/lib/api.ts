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

export async function api<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/studio${path}`, {
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
  studio: { name: string };
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
