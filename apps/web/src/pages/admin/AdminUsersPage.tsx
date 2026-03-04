import { useState, useEffect } from "react";
import { format } from "date-fns";
import {
  listUsers,
  changeRole,
  setAccountStatus,
  setQuotas,
  unquarantineUser,
  type AdminUser,
} from "@/api/endpoints/admin";
import { normalizeApiError } from "@/lib/errors";
import { AxiosError } from "axios";
import Card from "@/components/Card";
import Button from "@/components/Button";
import Input from "@/components/Input";

import Spinner from "@/components/Spinner";
import ErrorBanner from "@/components/ErrorBanner";
import EmptyState from "@/components/EmptyState";

export default function AdminUsersPage() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  // Quotas form
  const [quotaUserId, setQuotaUserId] = useState<string | null>(null);
  const [quotaMaxPerMin, setQuotaMaxPerMin] = useState("");
  const [quotaMaxOpen, setQuotaMaxOpen] = useState("");
  const [quotaMaxDaily, setQuotaMaxDaily] = useState("");

  useEffect(() => {
    setLoading(true);
    listUsers()
      .then((res) => setUsers(res.data.users))
      .catch(() => setError("Failed to load users"))
      .finally(() => setLoading(false));
  }, []);

  async function handleRoleChange(userId: string, role: "USER" | "ADMIN") {
    setActionLoading(userId);
    try {
      await changeRole(userId, role);
      setUsers((prev) =>
        prev.map((u) => (u.id === userId ? { ...u, role } : u)),
      );
    } catch (err) {
      const { message } = normalizeApiError(err as AxiosError<never>);
      setError(message);
    } finally {
      setActionLoading(null);
    }
  }

  async function handleStatusChange(userId: string, status: string) {
    setActionLoading(userId);
    try {
      await setAccountStatus(userId, status);
      setUsers((prev) =>
        prev.map((u) =>
          u.id === userId ? { ...u, account_status: status } : u,
        ),
      );
    } catch (err) {
      const { message } = normalizeApiError(err as AxiosError<never>);
      setError(message);
    } finally {
      setActionLoading(null);
    }
  }

  async function handleSetQuotas(userId: string) {
    setActionLoading(userId);
    try {
      const quotas: Record<string, number> = {};
      if (quotaMaxPerMin) quotas.maxOrdersPerMin = parseInt(quotaMaxPerMin, 10);
      if (quotaMaxOpen) quotas.maxOpenOrders = parseInt(quotaMaxOpen, 10);
      if (quotaMaxDaily) quotas.maxDailyOrders = parseInt(quotaMaxDaily, 10);
      await setQuotas(userId, quotas);
      setQuotaUserId(null);
      setQuotaMaxPerMin("");
      setQuotaMaxOpen("");
      setQuotaMaxDaily("");
    } catch (err) {
      const { message } = normalizeApiError(err as AxiosError<never>);
      setError(message);
    } finally {
      setActionLoading(null);
    }
  }

  async function handleUnquarantine(userId: string) {
    setActionLoading(userId);
    try {
      await unquarantineUser(userId);
      setUsers((prev) =>
        prev.map((u) =>
          u.id === userId ? { ...u, account_status: "ACTIVE" } : u,
        ),
      );
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
    <div className="space-y-4">
      {error && (
        <ErrorBanner message={error} onDismiss={() => setError(null)} />
      )}

      <Card>
        {users.length === 0 ? (
          <EmptyState message="No users found" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 border-b border-gray-800">
                  <th className="pb-2 pr-3">Email</th>
                  <th className="pb-2 pr-3">Role</th>
                  <th className="pb-2 pr-3">Status</th>
                  <th className="pb-2 pr-3">Created</th>
                  <th className="pb-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr
                    key={user.id}
                    className="border-b border-gray-800/50"
                  >
                    <td className="py-2 pr-3">{user.email}</td>
                    <td className="py-2 pr-3">
                      <select
                        value={user.role}
                        onChange={(e) =>
                          handleRoleChange(
                            user.id,
                            e.target.value as "USER" | "ADMIN",
                          )
                        }
                        disabled={actionLoading === user.id}
                        className="rounded border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-gray-300"
                      >
                        <option value="USER">USER</option>
                        <option value="ADMIN">ADMIN</option>
                      </select>
                    </td>
                    <td className="py-2 pr-3">
                      <select
                        value={user.account_status ?? "ACTIVE"}
                        onChange={(e) =>
                          handleStatusChange(user.id, e.target.value)
                        }
                        disabled={actionLoading === user.id}
                        className="rounded border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-gray-300"
                      >
                        <option value="ACTIVE">ACTIVE</option>
                        <option value="SUSPENDED">SUSPENDED</option>
                        <option value="QUARANTINED">QUARANTINED</option>
                      </select>
                    </td>
                    <td className="py-2 pr-3 text-xs text-gray-500">
                      {format(new Date(user.created_at), "MMM d, yyyy")}
                    </td>
                    <td className="py-2 space-x-2">
                      <Button
                        variant="secondary"
                        className="text-xs px-2 py-1"
                        onClick={() =>
                          setQuotaUserId(
                            quotaUserId === user.id ? null : user.id,
                          )
                        }
                      >
                        Quotas
                      </Button>
                      {user.account_status === "QUARANTINED" && (
                        <Button
                          variant="danger"
                          className="text-xs px-2 py-1"
                          onClick={() => handleUnquarantine(user.id)}
                          loading={actionLoading === user.id}
                        >
                          Unquarantine
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Quotas inline form */}
      {quotaUserId && (
        <Card>
          <h3 className="text-sm font-medium text-gray-300 mb-3">
            Set Quotas for {users.find((u) => u.id === quotaUserId)?.email}
          </h3>
          <div className="grid grid-cols-3 gap-3 mb-3">
            <Input
              label="Max Orders/Min"
              type="number"
              value={quotaMaxPerMin}
              onChange={(e) => setQuotaMaxPerMin(e.target.value)}
            />
            <Input
              label="Max Open Orders"
              type="number"
              value={quotaMaxOpen}
              onChange={(e) => setQuotaMaxOpen(e.target.value)}
            />
            <Input
              label="Max Daily Orders"
              type="number"
              value={quotaMaxDaily}
              onChange={(e) => setQuotaMaxDaily(e.target.value)}
            />
          </div>
          <Button
            onClick={() => handleSetQuotas(quotaUserId)}
            loading={actionLoading === quotaUserId}
          >
            Save Quotas
          </Button>
        </Card>
      )}
    </div>
  );
}
