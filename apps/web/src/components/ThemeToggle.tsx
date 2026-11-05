import { Button, Icon } from "@openportrait/ui";
import { THEME_LABEL, useTheme, type ThemePref } from "../lib/theme.js";

const ICON = { system: "contrast", light: "sun", dark: "moon" } as const;

/** One-tap cycle: Match device, Light, Dark. Used in the sidebar and on sign-in. */
export function ThemeToggle({ className = "" }: { className?: string }) {
  const { pref, cycle } = useTheme();
  const label = `Appearance: ${THEME_LABEL[pref]}. Press to change.`;
  return (
    <Button variant="ghost" size="sm" className={`icon ${className}`} icon={ICON[pref]} aria-label={label} title={label} onClick={cycle} />
  );
}

/** The full three-way choice, for Settings. */
export function ThemePicker() {
  const { pref, set } = useTheme();
  const opts: ThemePref[] = ["system", "light", "dark"];
  return (
    <div className="theme-picker" role="radiogroup" aria-label="Appearance">
      {opts.map((o) => (
        <button key={o} type="button" role="radio" aria-checked={pref === o} className={`theme-opt t-${o}${pref === o ? " on" : ""}`} onClick={() => set(o)}>
          <span className="theme-swatch" aria-hidden="true" />
          <span className="theme-name"><Icon name={ICON[o]} />{THEME_LABEL[o]}</span>
        </button>
      ))}
    </div>
  );
}
