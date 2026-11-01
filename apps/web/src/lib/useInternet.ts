import { useCallback, useEffect, useState } from "react";
import { api, type InternetStatus } from "./api.js";

/** Loads tunnel status and keeps it fresh while the page is open. */
export function useInternet(pollMs = 4000) {
  const [status, setStatus] = useState<InternetStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await api<InternetStatus>("/internet"));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load status.");
    }
  }, []);

  useEffect(() => {
    void load();
    if (!pollMs) return;
    const t = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, pollMs);
    return () => window.clearInterval(t);
  }, [load, pollMs]);

  return { status, setStatus, error, reload: load };
}

export function tunnelSummary(s: InternetStatus | null): { tone: "ok" | "warn" | "bad" | "neutral" | "info"; label: string } {
  if (!s) return { tone: "neutral", label: "Checking…" };
  const t = s.tunnel;
  if (!t.installed) return { tone: "warn", label: "Tunnel not available" };
  if (!t.configured) return { tone: "neutral", label: "Not connected" };
  if (t.state === "connected") return { tone: "ok", label: "Online" };
  if (t.state === "starting") return { tone: "info", label: "Connecting…" };
  if (t.state === "reconnecting") return { tone: "warn", label: "Reconnecting…" };
  return { tone: "bad", label: "Tunnel problem" };
}
