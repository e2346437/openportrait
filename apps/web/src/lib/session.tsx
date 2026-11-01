import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, type Me } from "./api.js";

interface SessionState {
  loading: boolean;
  needsSetup: boolean;
  me: Me | null;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [me, setMe] = useState<Me | null>(null);

  const refresh = useCallback(async () => {
    const [setup, who] = await Promise.all([api<{ needsSetup: boolean }>("/setup"), api<Me>("/auth/me")]);
    setNeedsSetup(setup.needsSetup);
    setMe(who);
    setLoading(false);
  }, []);

  const signOut = useCallback(async () => {
    await api("/auth/logout", { method: "POST" });
    setMe((m) => (m ? { ...m, user: null } : m));
  }, []);

  useEffect(() => {
    refresh().catch(() => setLoading(false));
  }, [refresh]);

  return <SessionContext.Provider value={{ loading, needsSetup, me, refresh, signOut }}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession outside SessionProvider");
  return ctx;
}
