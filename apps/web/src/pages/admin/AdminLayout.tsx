import { NavLink, Outlet } from "react-router-dom";

const ADMIN_NAV = [
  { to: "/admin/users", label: "Users" },
  { to: "/admin/assets", label: "Assets" },
  { to: "/admin/wallets", label: "Wallets" },
  { to: "/admin/system", label: "System" },
  { to: "/admin/risk", label: "Risk" },
  { to: "/admin/reconciliation", label: "Recon" },
  { to: "/admin/incidents", label: "Incidents" },
  { to: "/admin/repair", label: "Repair" },
  { to: "/admin/jobs", label: "Jobs" },
  { to: "/admin/retention", label: "Retention" },
  { to: "/admin/beta", label: "Beta" },
  { to: "/admin/event-stream", label: "Events" },
  { to: "/admin/outbox", label: "Outbox" },
];

export default function AdminLayout() {
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Admin Panel</h1>
      <nav className="flex flex-wrap gap-1 border-b border-gray-800 pb-2">
        {ADMIN_NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              `px-3 py-1.5 rounded text-sm transition-colors ${
                isActive
                  ? "bg-gray-800 text-white font-medium"
                  : "text-gray-400 hover:text-gray-200 hover:bg-gray-800/50"
              }`
            }
          >
            {item.label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </div>
  );
}
