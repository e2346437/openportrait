import { NavLink, Outlet } from "react-router";
import { Icon, PageHeader } from "@openportrait/ui";
import { useSession } from "../../lib/session.js";

export function SettingsLayout() {
  const { me } = useSession();
  const owner = me?.user?.role === "owner";
  return (
    <>
      <PageHeader title="Settings" />
      <nav className="subnav" aria-label="Settings sections">
        <NavLink to="studio">
          <Icon name="building" /> Studio
        </NavLink>
        <NavLink to="shoots">
          <Icon name="camera" /> Shoots &amp; folders
        </NavLink>
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
        <NavLink to="account">
          <Icon name="user" /> Your account
        </NavLink>
      </nav>
      <Outlet />
    </>
  );
}
