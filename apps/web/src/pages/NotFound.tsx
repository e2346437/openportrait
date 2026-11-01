import { Link } from "react-router";
import { EmptyState, Panel } from "@openportrait/ui";

export function NotFoundPage({ standalone }: { standalone?: boolean }) {
  const body = (
    <Panel>
      <EmptyState
        icon="alert"
        title="Nothing here"
        action={
          <Link className="btn primary" to="/studio">
            Go home
          </Link>
        }
      >
        The page you were looking for doesn't exist or has moved.
      </EmptyState>
    </Panel>
  );
  return standalone ? <div className="auth-main" style={{ minHeight: "100vh" }}><div className="auth-card">{body}</div></div> : body;
}
