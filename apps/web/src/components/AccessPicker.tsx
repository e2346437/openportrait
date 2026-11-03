import { Icon } from "@openportrait/ui";
import type { AiLevel } from "../lib/api.js";

export const LEVELS: Array<{ id: AiLevel; title: string; text: string }> = [
  { id: "read", title: "Look only", text: "Can read and search. Can't change anything." },
  { id: "assist", title: "Assist", text: "Can also add notes, tasks and drafts. Anything that reaches a client waits for your OK." },
  { id: "full", title: "Full", text: "Same as Assist for now. Sending and payments will always ask you first." },
];

export const AREA_LABELS: Record<string, string> = {
  studio: "Studio info",
  contacts: "Contacts",
  leads: "Leads",
  shoots: "Shoots",
  calendar: "Calendar",
  quotes: "Quotes",
  orders: "Orders",
  contracts: "Contracts",
  galleries: "Galleries",
  email: "Email",
};
/** Areas that have tools today. The rest light up as those parts of OpenPortrait are built. */
export const LIVE_AREAS = new Set(["studio", "contacts", "leads", "shoots", "calendar", "quotes", "orders", "contracts"]);


/** The "what can it do" and "which parts of the studio" choices, shared by token creation and the sign-in consent screen. */
export function AccessPicker({ level, onLevel, areas, onAreas, allAreas, areaError }: { level: AiLevel; onLevel: (l: AiLevel) => void; areas: string[]; onAreas: (a: string[]) => void; allAreas: string[]; areaError?: string }) {
  return (
    <>
      <fieldset className="choice-set">
        <legend>What can it do?</legend>
        <div className="choice-grid">
          {LEVELS.map((l) => (
            <label key={l.id} className={`choice ${level === l.id ? "on" : ""}`}>
              <input type="radio" name="level" checked={level === l.id} onChange={() => onLevel(l.id)} />
              <b>{l.title}</b>
              <span>{l.text}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="choice-set">
        <legend>Which parts of the studio?</legend>
        <div className="area-grid">
          {allAreas.map((a) => {
            const live = LIVE_AREAS.has(a);
            return (
              <label key={a} className={`area ${live ? "" : "soon"}`}>
                <input type="checkbox" checked={areas.includes(a)} onChange={(e) => onAreas(e.target.checked ? [...areas, a] : areas.filter((x) => x !== a))} />
                <span>{AREA_LABELS[a] ?? a}</span>
                {live ? null : <small>Soon</small>}
              </label>
            );
          })}
        </div>
        {areaError ? (
          <span className="error-text">
            <Icon name="alert" width={16} height={16} />
            {areaError}
          </span>
        ) : null}
      </fieldset>
    </>
  );
}
