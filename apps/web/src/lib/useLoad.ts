import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.js";

/**
 * Loads a GET endpoint and reloads when the path changes. Keeps the previous data on screen while
 * reloading, so searching and filtering don't flash the page empty.
 */
export function useLoad<T>(path: string | null, opts: { api?: typeof api } = {}) {
  const fetcher = opts.api ?? api;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    if (path === null) return;
    const mine = ++seq.current;
    setLoading(true);
    try {
      const next = await fetcher<T>(path);
      if (mine !== seq.current) return;
      setData(next);
      setError(null);
    } catch (err) {
      if (mine !== seq.current) return;
      setError(err instanceof Error ? err.message : "Couldn't load this.");
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [path, fetcher]);

  useEffect(() => {
    void load();
    return () => {
      seq.current++;
    };
  }, [load]);

  return { data, setData, error, loading, reload: load };
}

/** Delays a fast-changing value (like a search box) so each keystroke doesn't hit the server. */
export function useDebounced<T>(value: T, ms = 220): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}
