import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { Button, Icon, Mark, type IconName } from "@openportrait/ui";
import { useApprovalSummary } from "./lib/useApprovals.js";
import { useSession } from "./lib/session.js";
import { useExtensionPages } from "./lib/extensionPages.js";

interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  soon?: boolean;
  end?: boolean;
}

const groups: Array<{ label?: string; items: NavItem[] }> = [
  { items: [{ to: "/studio", label: "Home", icon: "home", end: true }] },
  {
    label: "Clients & bookings",
    items: [
      { to: "/studio/leads", label: "Leads", icon: "lead" },
      { to: "/studio/shoots", label: "Shoots", icon: "camera" },
      { to: "/studio/calendar", label: "Calendar", icon: "calendar" },
      { to: "/studio/booking", label: "Booking", icon: "clock" },
      { to: "/studio/clients", label: "Clients", icon: "users" },
      { to: "/studio/orders", label: "Orders", icon: "receipt" },
      { to: "/studio/contracts", label: "Contracts", icon: "note" },
    ],
  },
  {
    label: "Photos",
    items: [
      { to: "/studio/galleries", label: "Galleries", icon: "image" },
      { to: "/studio/incoming", label: "Incoming", icon: "inbox" },
      { to: "/studio/tether", label: "Tethering", icon: "lan" },
    ],
  },
  { label: "Studio", items: [{ to: "/studio/settings", label: "Settings", icon: "gear" }] },
];

/** Icons an extension page may ask for. Anything else gets a generic one. */
const NAV_ICONS: Record<string, true> = Object.fromEntries(["receipt", "pin", "note", "tag", "calendar", "camera", "folder", "image", "users", "clock", "globe", "building", "key", "sparkle", "heart", "send", "mail", "phone", "grid", "gear", "home", "inbox", "lan", "cloud", "shield", "lead", "palette", "crosshair"].map((n) => [n, true]));

const approvalsItem: NavItem = { to: "/studio/approvals", label: "Approvals", icon: "shield" };

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : "")).toUpperCase() || "?";
}

export function Shell() {
  const { me, signOut } = useSession();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => setOpen(false), [location.pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const approvals = useApprovalSummary(me?.user?.role === "owner");
  const showApprovals = approvals.enabled || approvals.pending > 0;
  const { pages: extPages } = useExtensionPages();
  const extGroups = [...new Set(extPages.map((p) => p.page.group ?? "More"))].map((label) => ({
    label,
    items: extPages.filter((p) => (p.page.group ?? "More") === label).map((p): NavItem => ({ to: `/studio/x/${p.extension}/${p.page.slug}`, label: p.page.title, icon: (p.page.icon && p.page.icon in NAV_ICONS ? p.page.icon : "grid") as IconName })),
  }));
  const base = groups.map((g) => (g.label === "Studio" && showApprovals ? { ...g, items: [approvalsItem, ...g.items] } : g));
  // Extension pages sit just above the Studio group (Settings).
  const allGroups = [...base.slice(0, -1), ...extGroups, ...base.slice(-1)];
  // A login limited to its own shoots only sees the Shoots page.
  const scoped = !!me?.user?.scoped;
  const navGroups = scoped ? [{ items: [{ to: "/studio/shoots", label: "My shoots", icon: "camera" as IconName }] }] : allGroups;
  useEffect(() => {
    if (scoped && location.pathname === "/studio") navigate("/studio/shoots", { replace: true });
  }, [scoped, location.pathname, navigate]);

  const studioName = me?.studio.name || "Your studio";
  const user = me?.user;

  const brand = (
    <NavLink to="/studio" className="brand" aria-label={`${studioName} home`}>
      <Mark />
      <span className="brand-text">
        OpenPortrait
        <small>{studioName}</small>
      </span>
    </NavLink>
  );

  return (
    <div className={`shell${open ? " nav-open" : ""}`}>
      <header className="topbar">
        <Button variant="ghost" className="icon" icon="menu" aria-label="Open menu" aria-expanded={open} aria-controls="sidebar" onClick={() => setOpen(true)} />
        {brand}
      </header>
      <div className="scrim" onClick={() => setOpen(false)} aria-hidden="true" />
      <aside className="sidebar" id="sidebar" aria-label="Main">
        {brand}
        <nav className="nav">
          {navGroups.map((g, i) => (
            <div key={g.label ?? i} className="nav">
              {g.label ? <div className="nav-label">{g.label}</div> : null}
              {g.items.map((item) => (
                <NavLink key={item.to} to={item.to} end={item.end}>
                  <Icon name={item.icon} />
                  {item.label}
                  {item.soon ? <span className="soon">Soon</span> : null}
                  {item === approvalsItem && approvals.pending > 0 ? <span className="count-badge" aria-label={`${approvals.pending} waiting`}>{approvals.pending}</span> : null}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        {user ? (
          <div className="sidebar-foot">
            <span className="avatar" aria-hidden="true">
              {initials(user.name)}
            </span>
            <span className="who">
              <b>{user.name}</b>
              <span>{user.role === "owner" ? "Owner" : user.role === "staff" ? "Staff" : "Assistant"}</span>
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="icon"
              icon="logout"
              aria-label="Sign out"
              title="Sign out"
              onClick={async () => {
                await signOut();
                navigate("/studio/login", { replace: true });
              }}
            />
          </div>
        ) : null}
      </aside>
      <main className="main" id="main">
        <div className="main-in">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
