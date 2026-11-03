import { useEffect, type ReactNode } from "react";
import { useSearchParams } from "react-router";

/** The frame around pages clients see: calm, one column, the studio's name, nothing from the back office. */
export function PublicShell({ studio, children, narrow }: { studio?: string; children: ReactNode; narrow?: boolean }) {
  const [params] = useSearchParams();
  const embed = params.get("embed") === "1";
  // Clients see the studio's name in the browser tab, not the product's.
  useEffect(() => {
    if (studio) document.title = studio;
  }, [studio]);
  return (
    <div className={`pub${embed ? " embed" : ""}`}>
      <main className={`pub-card${narrow ? " narrow" : ""}`}>
        {studio && !embed ? <p className="pub-studio">{studio}</p> : null}
        {children}
      </main>
      {embed ? null : (
        <footer className="pub-foot">
          <a href="https://openportrait.app" target="_blank" rel="noreferrer noopener">
            Powered by OpenPortrait
          </a>
        </footer>
      )}
    </div>
  );
}

export function PublicMessage({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <PublicShell narrow>
      <h1 className="pub-title">{title}</h1>
      {children ? <p className="pub-lead">{children}</p> : null}
    </PublicShell>
  );
}
