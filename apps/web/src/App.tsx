import { Routes, Route, Navigate } from "react-router-dom";
import AuthLayout from "@/layouts/AuthLayout";
import AppLayout from "@/layouts/AppLayout";
import ProtectedRoute from "@/components/ProtectedRoute";
import AdminRoute from "@/components/AdminRoute";
import LoginPage from "@/pages/LoginPage";
import RegisterPage from "@/pages/RegisterPage";
import DashboardPage from "@/pages/DashboardPage";
import TradingPage from "@/pages/TradingPage";
import OrderHistoryPage from "@/pages/OrderHistoryPage";
import WalletsPage from "@/pages/WalletsPage";
import PositionsPage from "@/pages/PositionsPage";
import TriggersPage from "@/pages/TriggersPage";
import BotPage from "@/pages/BotPage";
import ReplayPage from "@/pages/ReplayPage";
import PortfolioPage from "@/pages/PortfolioPage";
import SettingsPage from "@/pages/SettingsPage";
import AdminPage from "@/pages/AdminPage";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/dashboard" replace />} />

      {/* Public auth routes */}
      <Route element={<AuthLayout />}>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
      </Route>

      {/* Protected app routes */}
      <Route element={<ProtectedRoute />}>
        <Route element={<AppLayout />}>
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/trade" element={<TradingPage />} />
          <Route path="/orders" element={<OrderHistoryPage />} />
          <Route path="/wallets" element={<WalletsPage />} />
          <Route path="/positions" element={<PositionsPage />} />
          <Route path="/triggers" element={<TriggersPage />} />
          <Route path="/bot" element={<BotPage />} />
          <Route path="/replay" element={<ReplayPage />} />
          <Route path="/portfolio" element={<PortfolioPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
      </Route>

      {/* Admin routes */}
      <Route element={<AdminRoute />}>
        <Route element={<AppLayout />}>
          <Route path="/admin/*" element={<AdminPage />} />
        </Route>
      </Route>
    </Routes>
  );
}
