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
        <NavLink to="galleries">
          <Icon name="image" /> Galleries
        </NavLink>
        {owner ? (
          <NavLink to="internet">
            <Icon name="globe" /> Internet access
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
