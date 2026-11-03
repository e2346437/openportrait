import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { Icon, PageHeader } from "@openportrait/ui";
import { useSession } from "../../lib/session.js";
import { useLoad } from "../../lib/useLoad.js";

type IconName = Parameters<typeof Icon>[0]["name"];
interface Item {
  to: string;
  label: string;
  icon: IconName;
  ownerOnly?: boolean;
}
interface Group {
  title: string;
  items: Item[];
}

/** Every settings section, in the order and grouping the menu shows. */
function groups(hasExtensions: boolean): Group[] {
  return [
    {
      title: "Studio",
      items: [
        { to: "studio", label: "Studio details", icon: "building" },
        { to: "galleries", label: "Galleries", icon: "image" },
        { to: "shoots", label: "Shoots & folders", icon: "camera" },
      ],
    },
    {
      title: "Work",
      items: [
        { to: "questionnaires", label: "Questionnaires", icon: "note" },
        { to: "contracts", label: "Contracts", icon: "note", ownerOnly: true },
      ],
    },
    {
      title: "Money",
      items: [
        { to: "prices", label: "Prices", icon: "receipt" },
        { to: "tax", label: "Sales tax", icon: "receipt" },
        { to: "payments", label: "Payments", icon: "receipt", ownerOnly: true },
      ],
    },
    {
      title: "Connections",
      items: [
        { to: "email", label: "Email", icon: "mail", ownerOnly: true },
        { to: "calendar", label: "Google Calendar", icon: "calendar", ownerOnly: true },
        { to: "camera-upload", label: "Camera upload", icon: "camera", ownerOnly: true },
        { to: "internet", label: "Internet access", icon: "globe", ownerOnly: true },
        { to: "ai", label: "Connect your AI", icon: "sparkle", ownerOnly: true },
      ],
    },
    {
      title: "System",
      items: [
        { to: "automation", label: "Automation", icon: "refresh", ownerOnly: true },
        ...(hasExtensions ? [{ to: "extensions", label: "Extensions", icon: "sparkle" as IconName, ownerOnly: true }] : []),
        { to: "import", label: "Import and export", icon: "inbox", ownerOnly: true },
        { to: "backups", label: "Backups", icon: "shield", ownerOnly: true },
        { to: "logs", label: "Logs", icon: "info", ownerOnly: true },
        { to: "account", label: "Your account", icon: "user" },
      ],
    },
  ];
}

export function SettingsLayout() {
  const { me } = useSession();
  const owner = me?.user?.role === "owner";
  // Only owners can see extensions, and the entry only appears when one is installed.
  const ext = useLoad<{ extensions: unknown[] }>(owner ? "/extensions" : null);
  const hasExtensions = !!ext.data?.extensions.length;
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const visible = groups(hasExtensions)
    .map((g) => ({ ...g, items: g.items.filter((i) => owner || !i.ownerOnly) }))
    .filter((g) => g.items.length > 0);
  const current = pathname.split("/").filter(Boolean).pop() ?? "studio";

  return (
    <>
      <PageHeader title="Settings" />
      <div className="settings-shell">
        {/* Phones and small tablets: a labelled picker that lists every section at once. */}
        <label className="settings-picker">
          <span>Section</span>
          <select className="input" value={current} onChange={(e) => navigate(e.target.value)} aria-label="Settings section">
            {visible.map((g) => (
              <optgroup key={g.title} label={g.title}>
                {g.items.map((i) => (
                  <option key={i.to} value={i.to}>
                    {i.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <nav className="settings-nav" aria-label="Settings sections">
          {visible.map((g) => (
            <div key={g.title} className="settings-group">
              <div className="nav-label">{g.title}</div>
              {g.items.map((i) => (
                <NavLink key={i.to} to={i.to}>
                  <Icon name={i.icon} /> {i.label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="settings-content">
          <Outlet />
        </div>
      </div>
    </>
  );
}
