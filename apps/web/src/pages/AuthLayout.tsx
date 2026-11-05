import { useState, type ReactNode } from "react";
import { Mark } from "@openportrait/ui";
import { ThemeToggle } from "../components/ThemeToggle.js";

/**
 * The split screen behind sign-in, setup and consent. The art panel shows the studio's own sign-in photo when one
 * is set (Settings > Studio), darkened so the headline stays readable; otherwise the brand's lens.
 */
export function AuthLayout({
  headline,
  body,
  photo,
  credit,
  children,
}: {
  headline: string;
  body?: string;
  photo?: string | null;
  credit?: string;
  children: ReactNode;
}) {
  const [loaded, setLoaded] = useState(false);
  return (
    <div className="auth">
      <aside className={`auth-art${photo ? " has-photo" : ""}`}>
        {photo ? <img className={`auth-photo${loaded ? " in" : ""}`} src={photo} alt="" onLoad={() => setLoaded(true)} /> : null}
        <span className="brand">
          <Mark />
          OpenPortrait
        </span>
        <div className="auth-copy">
          <h1>{headline}</h1>
          <p>{body ?? "Your clients, bookings, and galleries, on your own server."}</p>
          {photo && credit ? <small className="auth-credit">{credit}</small> : null}
        </div>
      </aside>
      <main className="auth-main">
        <ThemeToggle className="auth-theme" />
        <div className="auth-card">{children}</div>
      </main>
    </div>
  );
}
