import { useState } from "react";
import { ApiError } from "./api.js";

/** Submit state + per-field server errors for a form. */
export function useSubmit<T>(fn: () => Promise<T>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const submit = async (): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ApiError && err.field) setFieldErrors({ [err.field]: err.message });
      else setError(err instanceof Error ? err.message : "Something went wrong.");
      return undefined;
    } finally {
      setBusy(false);
    }
  };

  return { busy, error, fieldErrors, submit, setFieldErrors };
}
