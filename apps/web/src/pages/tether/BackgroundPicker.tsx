import { useEffect, useId, useState } from "react";
import { HEX, parseBg } from "../../lib/tether.js";

/** Black, white or any colour: presets, a native colour picker, and a hex box that stay in sync. */
export function BackgroundPicker({ value, onChange }: { value: string; onChange: (hex: string) => void }) {
  const id = useId();
  const [text, setText] = useState(value.slice(1));
  useEffect(() => setText(value.slice(1)), [value]);
  const invalid = text !== "" && !HEX.test(text);
  const preset = value === "#000000" ? "black" : value === "#ffffff" ? "white" : "custom";

  return (
    <div className="bgpick">
      <div className="bgpick-presets" role="radiogroup" aria-label="Background">
        {([["black", "Black", "#000000"], ["white", "White", "#ffffff"]] as const).map(([key, label, hex]) => (
          <button key={key} type="button" role="radio" aria-checked={preset === key} className={preset === key ? "on" : ""} onClick={() => onChange(hex)}>
            <span className="chip-swatch" style={{ background: hex }} />
            {label}
          </button>
        ))}
        <label className={preset === "custom" ? "on" : ""} role="radio" aria-checked={preset === "custom"}>
          <input type="color" value={value} onChange={(e) => onChange(parseBg(e.target.value) ?? value)} aria-label="Pick a custom colour" />
          <span className="chip-swatch custom" style={preset === "custom" ? { background: value } : undefined} />
          Custom
        </label>
      </div>
      <div className="bgpick-hex">
        <label htmlFor={id}>Hex</label>
        <span className="hash" aria-hidden>#</span>
        <input
          id={id}
          value={text}
          maxLength={7}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={invalid || undefined}
          placeholder="1a1a1a"
          onChange={(e) => {
            const t = e.target.value.replace(/^#/, "");
            setText(t);
            const parsed = HEX.test(t) ? parseBg(t) : null;
            if (parsed) onChange(parsed);
          }}
          onBlur={() => setText(value.slice(1))}
        />
      </div>
      {invalid && <p className="bgpick-err">Enter six letters or numbers, like 1a1a1a.</p>}
    </div>
  );
}
