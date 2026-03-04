import { useEffect, useRef } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { useAuthStore } from "@/stores/authStore";
import { useAppStore } from "@/stores/appStore";
import { getSystemStatus, getUserStatus } from "@/api/endpoints/status";
import { getStatus as getRiskStatus } from "@/api/endpoints/risk";
import { listPairs } from "@/api/endpoints/trading";
import { listAssets, listWallets } from "@/api/endpoints/wallets";
import AuthLayout from "@/layouts/AuthLayout";
import AppLayout from "@/layouts/AppLayout";
import ProtectedRoute from "@/components/ProtectedRoute";
import AdminRoute from "@/components/AdminRoute";
import Spinner from "@/components/Spinner";
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
  const initialized = useAppStore((s) => s.initialized);
  const setInitialized = useAppStore((s) => s.setInitialized);
  const setSystemStatus = useAppStore((s) => s.setSystemStatus);
  const setUserStatus = useAppStore((s) => s.setUserStatus);
  const setRiskStatus = useAppStore((s) => s.setRiskStatus);
  const setPairs = useAppStore((s) => s.setPairs);
  const setAssets = useAppStore((s) => s.setAssets);
  const setWallets = useAppStore((s) => s.setWallets);

  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const initLoadedData = useRef(false);

  useEffect(() => {
    let cancelled = false;

    async function init() {
      // 1. Fetch system status (public, always)
      try {
        const sysRes = await getSystemStatus();
        if (!cancelled) setSystemStatus(sysRes.data);
      } catch {
        // Non-fatal — banner just won't show
      }

      // 2. Attempt silent auth refresh
      await useAuthStore.getState().initialize();
      if (cancelled) return;

      // 3. If authenticated, fetch user data in parallel
      if (useAuthStore.getState().isAuthenticated) {
        initLoadedData.current = true;
        const results = await Promise.allSettled([
          getUserStatus(),
          getRiskStatus(),
          listPairs(),
          listAssets(),
          listWallets(),
        ]);

        if (!cancelled) {
          const [userRes, riskRes, pairsRes, assetsRes, walletsRes] = results;
          if (userRes.status === "fulfilled") setUserStatus(userRes.value.data);
          if (riskRes.status === "fulfilled") setRiskStatus(riskRes.value.data.risk);
          if (pairsRes.status === "fulfilled") setPairs(pairsRes.value.data.pairs);
          if (assetsRes.status === "fulfilled") setAssets(assetsRes.value.data.assets);
          if (walletsRes.status === "fulfilled") setWallets(walletsRes.value.data.wallets);
        }
      }

      if (!cancelled) setInitialized(true);
    }

    init();
    return () => {
      cancelled = true;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-load user data after fresh login (init effect doesn't re-run)
  useEffect(() => {
    if (!initialized || !isAuthenticated || initLoadedData.current) return;

    let cancelled = false;

    async function loadUserData() {
      const results = await Promise.allSettled([
        getUserStatus(),
        getRiskStatus(),
        listPairs(),
        listAssets(),
        listWallets(),
      ]);

      if (!cancelled) {
        const [userRes, riskRes, pairsRes, assetsRes, walletsRes] = results;
        if (userRes.status === "fulfilled") setUserStatus(userRes.value.data);
        if (riskRes.status === "fulfilled") setRiskStatus(riskRes.value.data.risk);
        if (pairsRes.status === "fulfilled") setPairs(pairsRes.value.data.pairs);
        if (assetsRes.status === "fulfilled") setAssets(assetsRes.value.data.assets);
        if (walletsRes.status === "fulfilled") setWallets(walletsRes.value.data.wallets);
      }
    }

    loadUserData();
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, initialized]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!initialized) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-950">
        <Spinner size="lg" />
      </div>
    );
  }

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
