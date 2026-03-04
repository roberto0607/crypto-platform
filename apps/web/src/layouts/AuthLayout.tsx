import { Outlet } from "react-router-dom";
import SystemBanner from "@/components/SystemBanner";

export default function AuthLayout() {
  return (
    <div className="min-h-screen flex flex-col bg-gray-950">
      <SystemBanner />
      <div className="flex-1 flex items-center justify-center p-4">
        <div className="w-full max-w-md">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
