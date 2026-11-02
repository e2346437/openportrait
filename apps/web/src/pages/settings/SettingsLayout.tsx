import { NavLink, Outlet } from "react-router";
import { Icon, PageHeader } from "@openportrait/ui";
import { useSession } from "../../lib/session.js";
import { useLoad } from "../../lib/useLoad.js";

export function SettingsLayout() {
  const { me } = useSession();
  const owner = me?.user?.role === "owner";
  // Only owners can see extensions, and the tab only appears when one is installed.
  const ext = useLoad<{ extensions: unknown[] }>(owner ? "/extensions" : null);
  const hasExtensions = !!ext.data?.extensions.length;
  return (
    <>
      <PageHeader title="Settings" />
      <nav className="subnav" aria-label="Settings sections">
        <NavLink to="studio">
          <Icon name="building" /> Studio
        </NavLink>
        <NavLink to="galleries">
          <Icon name="image" /> Galleries
        </NavLink>
        <NavLink to="shoots">
          <Icon name="camera" /> Shoots &amp; folders
        </NavLink>
        {owner ? (
          <NavLink to="calendar">
            <Icon name="calendar" /> Google Calendar
          </NavLink>
        ) : null}
        <NavLink to="questionnaires">
          <Icon name="note" /> Questionnaires
        </NavLink>
        <NavLink to="prices">
          <Icon name="receipt" /> Prices
        </NavLink>
        {owner ? (
          <NavLink to="payments">
            <Icon name="receipt" /> Payments
          </NavLink>
        ) : null}
        {owner ? (
          <NavLink to="email">
            <Icon name="mail" /> Email
          </NavLink>
        ) : null}
        {owner ? (
          <NavLink to="camera-upload">
            <Icon name="camera" /> Camera upload
          </NavLink>
        ) : null}
        {owner ? (
          <NavLink to="internet">
            <Icon name="globe" /> Internet access
          </NavLink>
        ) : null}
        {owner ? (
          <NavLink to="ai">
            <Icon name="sparkle" /> Connect your AI
          </NavLink>
        ) : null}
        {owner ? (
          <NavLink to="automation">
            <Icon name="refresh" /> Automation
          </NavLink>
        ) : null}
        {owner && hasExtensions ? (
          <NavLink to="extensions">
            <Icon name="sparkle" /> Extensions
          </NavLink>
        ) : null}
        <NavLink to="account">
          <Icon name="user" /> Your account
        </NavLink>
      </nav>
      <Outlet />
    </>
  );
}
