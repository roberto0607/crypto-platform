import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuthStore } from "@/stores/authStore";
import Spinner from "@/components/Spinner";
import { loginUrlFor } from "@/lib/safeRedirect";

export default function ProtectedRoute() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const isInitializing = useAuthStore((s) => s.isInitializing);
  const location = useLocation();

  // Don't redirect while auth state is still being resolved
  if (isInitializing) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-950">
        <Spinner size="lg" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to={loginUrlFor(location)} replace />;
  }

  return <Outlet />;
}
