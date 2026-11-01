import type { ReactNode } from "react";
import { Mark } from "@openportrait/ui";

export function AuthLayout({ headline, body, children }: { headline: string; body?: string; children: ReactNode }) {
  return (
    <div className="auth">
      <aside className="auth-art">
        <span className="brand">
          <Mark />
          OpenPortrait
        </span>
        <div>
          <h1>{headline}</h1>
          <p>{body ?? "Your clients, bookings, and galleries, on your own server."}</p>
        </div>
      </aside>
      <main className="auth-main">
        <div className="auth-card">{children}</div>
      </main>
    </div>
  );
}
