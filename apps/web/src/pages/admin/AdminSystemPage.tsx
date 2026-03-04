import { useState, useEffect } from "react";
import { format } from "date-fns";
import {
  setTradingGlobal,
  setReadOnly,
  getMigrationStatus,
  getBackups,
  restoreDrill,
  type MigrationInfo,
  type BackupInfo,
} from "@/api/endpoints/admin";
import { useAppStore } from "@/stores/appStore";
import { normalizeApiError } from "@/lib/errors";
import { AxiosError } from "axios";
import Card from "@/components/Card";
import Button from "@/components/Button";
import Badge from "@/components/Badge";
import Spinner from "@/components/Spinner";
import ErrorBanner from "@/components/ErrorBanner";
import EmptyState from "@/components/EmptyState";

export default function AdminSystemPage() {
  const systemStatus = useAppStore((s) => s.systemStatus);

  const [migrations, setMigrations] = useState<MigrationInfo[]>([]);
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<string | null>(null);
  const [restoreResult, setRestoreResult] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    setLoading(true);
    Promise.allSettled([getMigrationStatus(), getBackups()]).then(
      ([migRes, backupRes]) => {
        if (migRes.status === "fulfilled")
          setMigrations(migRes.value.data.migrations);
        if (backupRes.status === "fulfilled")
          setBackups(backupRes.value.data.backups);
        setLoading(false);
      },
    );
  }, []);

  async function handleToggle(action: string) {
    if (confirmAction !== action) {
      setConfirmAction(action);
      return;
    }
    setConfirmAction(null);
    setActionLoading(action);
    setError(null);
    try {
      if (action === "trading") {
        await setTradingGlobal(!systemStatus?.tradingEnabledGlobal);
      } else if (action === "readonly") {
        await setReadOnly(!systemStatus?.readOnlyMode);
      }
    } catch (err) {
      const { message } = normalizeApiError(err as AxiosError<never>);
      setError(message);
    } finally {
      setActionLoading(null);
    }
  }

  async function handleRestoreDrill() {
    if (confirmAction !== "restore") {
      setConfirmAction("restore");
      return;
    }
    setConfirmAction(null);
    setActionLoading("restore");
    setError(null);
    try {
      const res = await restoreDrill();
      setRestoreResult(res.data.result);
    } catch (err) {
      const { message } = normalizeApiError(err as AxiosError<never>);
      setError(message);
    } finally {
      setActionLoading(null);
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {error && (
        <ErrorBanner message={error} onDismiss={() => setError(null)} />
      )}

      {/* System Controls */}
      <Card>
        <h2 className="text-sm font-medium text-gray-300 mb-3">
          System Controls
        </h2>
        <div className="flex flex-wrap gap-4">
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-400">Trading Global:</span>
            <Badge
              color={systemStatus?.tradingEnabledGlobal ? "green" : "red"}
            >
              {systemStatus?.tradingEnabledGlobal ? "Enabled" : "Disabled"}
            </Badge>
            <Button
              variant={
                confirmAction === "trading"
                  ? "danger"
                  : systemStatus?.tradingEnabledGlobal
                    ? "danger"
                    : "primary"
              }
              className="text-xs px-2 py-1"
              onClick={() => handleToggle("trading")}
              loading={actionLoading === "trading"}
            >
              {confirmAction === "trading"
                ? "Confirm?"
                : systemStatus?.tradingEnabledGlobal
                  ? "Disable"
                  : "Enable"}
            </Button>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-400">Read-Only:</span>
            <Badge color={systemStatus?.readOnlyMode ? "red" : "green"}>
              {systemStatus?.readOnlyMode ? "Active" : "Off"}
            </Badge>
            <Button
              variant={
                confirmAction === "readonly"
                  ? "danger"
                  : systemStatus?.readOnlyMode
                    ? "primary"
                    : "danger"
              }
              className="text-xs px-2 py-1"
              onClick={() => handleToggle("readonly")}
              loading={actionLoading === "readonly"}
            >
              {confirmAction === "readonly"
                ? "Confirm?"
                : systemStatus?.readOnlyMode
                  ? "Disable"
                  : "Enable"}
            </Button>
          </div>
        </div>
      </Card>

      {/* Migrations */}
      <Card>
        <h2 className="text-sm font-medium text-gray-300 mb-3">Migrations</h2>
        {migrations.length === 0 ? (
          <EmptyState message="No migrations" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 border-b border-gray-800">
                  <th className="pb-2 pr-3">Name</th>
                  <th className="pb-2">Applied</th>
                </tr>
              </thead>
              <tbody>
                {migrations.map((m) => (
                  <tr key={m.name} className="border-b border-gray-800/50">
                    <td className="py-2 pr-3 font-mono text-xs">
                      {m.name}
                    </td>
                    <td className="py-2 text-xs text-gray-500">
                      {format(new Date(m.applied_at), "MMM d, yyyy HH:mm")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Backups */}
      <Card>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-medium text-gray-300">Backups</h2>
          <Button
            variant={confirmAction === "restore" ? "danger" : "secondary"}
            onClick={handleRestoreDrill}
            loading={actionLoading === "restore"}
          >
            {confirmAction === "restore"
              ? "Confirm Restore Drill?"
              : "Run Restore Drill"}
          </Button>
        </div>
        {backups.length === 0 ? (
          <EmptyState message="No backups" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 border-b border-gray-800">
                  <th className="pb-2 pr-3">Name</th>
                  <th className="pb-2 pr-3">Size</th>
                  <th className="pb-2">Created</th>
                </tr>
              </thead>
              <tbody>
                {backups.map((b) => (
                  <tr key={b.name} className="border-b border-gray-800/50">
                    <td className="py-2 pr-3 font-mono text-xs">
                      {b.name}
                    </td>
                    <td className="py-2 pr-3 text-xs text-gray-400">
                      {(b.size / 1024 / 1024).toFixed(1)} MB
                    </td>
                    <td className="py-2 text-xs text-gray-500">
                      {format(new Date(b.created_at), "MMM d, yyyy HH:mm")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {restoreResult && (
          <pre className="mt-3 text-xs text-gray-300 bg-gray-800 rounded p-3 overflow-x-auto">
            {JSON.stringify(restoreResult, null, 2)}
          </pre>
        )}
      </Card>
    </div>
  );
}
