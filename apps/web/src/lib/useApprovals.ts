import { useEffect, useState } from "react";
import { api } from "./api.js";

/** Whether to show the Approvals item in the sidebar, and how many requests are waiting. Owners only. */
export function useApprovalSummary(active: boolean, pollMs = 20_000) {
  const [s, setS] = useState({ enabled: false, pending: 0 });
  useEffect(() => {
    if (!active) return;
    let stop = false;
    const load = () => api<{ enabled: boolean; pending: number }>("/ai/approvals/summary").then((r) => !stop && setS(r), () => undefined);
    void load();
    const t = window.setInterval(() => document.visibilityState === "visible" && void load(), pollMs);
    return () => {
      stop = true;
      window.clearInterval(t);
    };
  }, [active, pollMs]);
  return s;
}
