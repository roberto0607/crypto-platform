import { useEffect, useRef } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import axios from "axios";
import { useAuthStore } from "@/stores/authStore";
import { useAppStore } from "@/stores/appStore";
import { useCompetitionStore } from "@/stores/competitionStore";
import { useNotificationStore } from "@/stores/notificationStore";
import { useThemeStore } from "@/stores/themeStore";
import { useThemeDetector } from "@/hooks/useThemeDetector";
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
import TradingPage from "@/pages/TradingPage";
import SettingsPage from "@/pages/SettingsPage";
import ArenaPage from "@/pages/ArenaPage";
import CyclePage from "@/pages/CyclePage";
import JournalPage from "@/pages/JournalPage";
import ProfilePage from "@/pages/ProfilePage";
import NotFoundPage from "@/pages/NotFoundPage";
import LandingPage from "@/pages/LandingPage";

// Admin
import AdminLayout from "@/pages/admin/AdminLayout";
import AdminUsersPage from "@/pages/admin/AdminUsersPage";
import AdminAssetsPage from "@/pages/admin/AdminAssetsPage";
import AdminWalletsPage from "@/pages/admin/AdminWalletsPage";
import AdminSystemPage from "@/pages/admin/AdminSystemPage";
import AdminRiskPage from "@/pages/admin/AdminRiskPage";
import AdminReconciliationPage from "@/pages/admin/AdminReconciliationPage";
import AdminIncidentsPage from "@/pages/admin/AdminIncidentsPage";
import AdminRepairPage from "@/pages/admin/AdminRepairPage";
import AdminJobsPage from "@/pages/admin/AdminJobsPage";
import AdminRetentionPage from "@/pages/admin/AdminRetentionPage";
import AdminBetaPage from "@/pages/admin/AdminBetaPage";
import AdminEventStreamPage from "@/pages/admin/AdminEventStreamPage";
import AdminOutboxPage from "@/pages/admin/AdminOutboxPage";

export default function App() {
  // ── Theme auto-detection (route + active match) ──
  useThemeDetector();
  const currentTheme = useThemeStore((s) => s.currentTheme);

  // Apply data-theme attribute to <html> for CSS variable switching
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", currentTheme);
  }, [currentTheme]);

  const initialized = useAppStore((s) => s.initialized);
  const serverOffline = useAppStore((s) => s.serverOffline);
  const setInitialized = useAppStore((s) => s.setInitialized);
  const setServerOffline = useAppStore((s) => s.setServerOffline);
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
      // 0. Health check — verify backend is reachable
      try {
        const apiBase = import.meta.env.VITE_API_BASE ?? "/api";
        await axios.get(`${apiBase}/health`, { timeout: 5000 });
        if (!cancelled) setServerOffline(false);
      } catch {
        if (!cancelled) {
          setServerOffline(true);
          setInitialized(true);
        }
        return;
      }

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

      // Fetch user's competitions and notifications if authenticated
      if (useAuthStore.getState().isAuthenticated) {
        useCompetitionStore.getState().fetchMyCompetitions().catch(() => {});
        useNotificationStore.getState().fetch().catch(() => {});
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
    useNotificationStore.getState().fetch().catch(() => {});
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

  if (serverOffline) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-gray-950 text-white font-mono gap-4">
        <div className="text-tradr-green text-2xl tracking-[6px]">TRADR</div>
        <div className="text-red-500 text-sm tracking-[3px]">SERVER OFFLINE</div>
        <div className="text-white/30 text-xs tracking-[1px] max-w-sm text-center leading-5">
          Cannot reach the backend API. Start your server and refresh.
        </div>
        <button
          onClick={() => window.location.reload()}
          className="mt-4 px-6 py-2 text-xs tracking-[2px] border border-tradr-green/30 text-tradr-green hover:bg-tradr-green/10 transition-colors"
        >
          RETRY
        </button>
      </div>
    );
  }

  return (
    <Routes>
      <Route path="/" element={isAuthenticated ? <Navigate to="/trade" replace /> : <LandingPage />} />

      {/* Public auth routes */}
      <Route element={<AuthLayout />}>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
      </Route>

      {/* Protected app routes */}
      <Route element={<ProtectedRoute />}>
        <Route element={<AppLayout />}>
          <Route path="/trade" element={<TradingPage />} />
          <Route path="/arena" element={<ArenaPage />} />
          <Route path="/cycle" element={<CyclePage />} />
          <Route path="/history" element={<JournalPage />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/settings" element={<SettingsPage />} />
          {/* Legacy redirects */}
          <Route path="/dashboard" element={<Navigate to="/trade" replace />} />
          <Route path="/portfolio" element={<Navigate to="/trade" replace />} />
          <Route path="/competitions" element={<Navigate to="/arena" replace />} />
          <Route path="/competitions/:id" element={<Navigate to="/arena" replace />} />
          <Route path="/journal" element={<Navigate to="/history" replace />} />
          <Route path="/replay" element={<Navigate to="/trade" replace />} />
          <Route path="/orders" element={<Navigate to="/trade" replace />} />
          <Route path="/positions" element={<Navigate to="/trade" replace />} />
          <Route path="/triggers" element={<Navigate to="/trade" replace />} />
        </Route>
      </Route>

      {/* Admin routes */}
      <Route element={<AdminRoute />}>
        <Route element={<AppLayout />}>
          <Route path="/admin" element={<AdminLayout />}>
            <Route index element={<Navigate to="/admin/users" replace />} />
            <Route path="users" element={<AdminUsersPage />} />
            <Route path="assets" element={<AdminAssetsPage />} />
            <Route path="wallets" element={<AdminWalletsPage />} />
            <Route path="system" element={<AdminSystemPage />} />
            <Route path="risk" element={<AdminRiskPage />} />
            <Route path="reconciliation" element={<AdminReconciliationPage />} />
            <Route path="incidents" element={<AdminIncidentsPage />} />
            <Route path="repair" element={<AdminRepairPage />} />
            <Route path="jobs" element={<AdminJobsPage />} />
            <Route path="retention" element={<AdminRetentionPage />} />
            <Route path="beta" element={<AdminBetaPage />} />
            <Route path="event-stream" element={<AdminEventStreamPage />} />
            <Route path="outbox" element={<AdminOutboxPage />} />
          </Route>
        </Route>
      </Route>

      {/* 404 catch-all */}
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
