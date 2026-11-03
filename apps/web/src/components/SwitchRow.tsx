import { Switch } from "@openportrait/ui";

/** A switch with its label shown next to it. Clicking the text toggles it too. */
export function SwitchRow({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; disabled?: boolean }) {
  return (
    <div className="switch-row">
      <Switch checked={checked} onChange={onChange} label={label} disabled={disabled} />
      <button type="button" className="switch-text" tabIndex={-1} onClick={() => !disabled && onChange(!checked)}>
        <b>{label}</b>
        {hint ? <small>{hint}</small> : null}
      </button>
    </div>
  );
}
