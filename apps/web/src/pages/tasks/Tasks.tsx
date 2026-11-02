import { useState } from "react";
import { PageHeader } from "@openportrait/ui";
import { TaskList } from "../../components/TaskList.js";

/** Everything left to do across the studio's shoots, soonest due first. */
export function TasksPage() {
  const [status, setStatus] = useState<"open" | "done">("open");
  return (
    <>
      <PageHeader title="Tasks" description="What's left to do on your shoots, soonest due first. Add tasks on a shoot, or give each shoot type a starter checklist in Settings." />
      <div className="toolbar">
        <div className="tabs" role="tablist" aria-label="Show">
          {([["open", "To do"], ["done", "Done"]] as const).map(([k, label]) => (
            <button key={k} role="tab" aria-selected={status === k} className={status === k ? "on" : ""} onClick={() => setStatus(k)}>{label}</button>
          ))}
        </div>
      </div>
      <TaskList key={status} status={status} />
    </>
  );
}
