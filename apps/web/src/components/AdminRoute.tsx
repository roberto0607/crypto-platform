import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuthStore } from "@/stores/authStore";
import { loginUrlFor } from "@/lib/safeRedirect";

export default function AdminRoute() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const isAdmin = useAuthStore((s) => s.isAdmin);
  const location = useLocation();

  if (!isAuthenticated) {
    return <Navigate to={loginUrlFor(location)} replace />;
  }

  if (!isAdmin) return <Navigate to="/trade" replace />;

  return <Outlet />;
}
