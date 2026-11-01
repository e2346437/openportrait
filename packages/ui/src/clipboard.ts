/**
 * Copies text to the clipboard. `navigator.clipboard` only exists in secure contexts
 * (https or localhost), so pages opened over plain http on a LAN address need a fallback
 * that selects a hidden textarea and uses the legacy copy command.
 * Resolves true when the text reached the clipboard.
 */
export async function copyText(text: string): Promise<boolean> {
  if (typeof window !== "undefined" && window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied or no focus: fall through to the legacy path.
    }
  }
  return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
  if (typeof document === "undefined") return false;
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  // Keep it on screen but invisible so focus and selection work on iOS and Safari.
  area.style.position = "fixed";
  area.style.top = "0";
  area.style.left = "0";
  area.style.opacity = "0";
  area.style.fontSize = "16px";
  document.body.appendChild(area);
  const active = document.activeElement as HTMLElement | null;
  area.select();
  area.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.body.removeChild(area);
  active?.focus?.();
  return ok;
}

/** Selects the text of an element so the user can press Ctrl+C or Cmd+C themselves. */
export function selectElementText(el: Element | null): void {
  if (!el || typeof window === "undefined") return;
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}
