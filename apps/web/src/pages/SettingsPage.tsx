import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { format } from "date-fns";
import { useAuthStore } from "@/stores/authStore";
import { useAppStore } from "@/stores/appStore";
import {
  list as listApiKeys,
  create as createApiKey,
  revoke as revokeApiKey,
} from "@/api/endpoints/apiKeys";
import type { ApiKey } from "@/types/api";
import { updateDisplayName } from "@/api/endpoints/profile";
import { normalizeApiError } from "@/lib/errors";
import { AxiosError } from "axios";
import Card from "@/components/Card";
import Button from "@/components/Button";
import Input from "@/components/Input";
import Badge from "@/components/Badge";
import Spinner from "@/components/Spinner";
import ErrorBanner from "@/components/ErrorBanner";
import EmptyState from "@/components/EmptyState";

const SCOPES = ["read", "trade", "admin"] as const;

export default function SettingsPage() {
  const user = useAuthStore((s) => s.user);
  const userStatus = useAppStore((s) => s.userStatus);

  // Display name
  const [displayName, setDisplayName] = useState(user?.displayName ?? "");
  const [dnSaving, setDnSaving] = useState(false);
  const [dnStatus, setDnStatus] = useState<"idle" | "success" | "error">("idle");

  // API Keys
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [keysLoading, setKeysLoading] = useState(true);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);

  // Create key form
  const [formLabel, setFormLabel] = useState("");
  const [formScopes, setFormScopes] = useState<Set<(typeof SCOPES)[number]>>(
    new Set(["read"]),
  );
  const [formExpiresDays, setFormExpiresDays] = useState("");
  const [formSubmitting, setFormSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Show raw key modal
  const [rawKey, setRawKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Load API keys
  useEffect(() => {
    let cancelled = false;
    setKeysLoading(true);
    listApiKeys()
      .then((res) => {
        if (!cancelled) setApiKeys(res.data.apiKeys ?? []);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setKeysLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function toggleScope(scope: (typeof SCOPES)[number]) {
    setFormScopes((prev) => {
      const next = new Set(prev);
      if (next.has(scope)) {
        next.delete(scope);
      } else {
        next.add(scope);
      }
      return next;
    });
  }

  async function handleCreateKey(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    setFormSubmitting(true);
    try {
      const res = await createApiKey({
        label: formLabel,
        scopes: Array.from(formScopes),
        expiresInDays: formExpiresDays ? parseInt(formExpiresDays, 10) : undefined,
      });
      setApiKeys((prev) => [res.data.apiKey, ...prev]);
      setRawKey(res.data.secret);
      setFormLabel("");
      setFormScopes(new Set(["read"]));
      setFormExpiresDays("");
    } catch (err) {
      const { message } = normalizeApiError(err as AxiosError<never>);
      setFormError(message);
    } finally {
      setFormSubmitting(false);
    }
  }

  async function handleRevoke(keyId: string) {
    if (confirmRevoke !== keyId) {
      setConfirmRevoke(keyId);
      return;
    }
    setRevoking(keyId);
    setConfirmRevoke(null);
    try {
      await revokeApiKey(keyId);
      setApiKeys((prev) =>
        prev.map((k) => (k.id === keyId ? { ...k, revoked: true } : k)),
      );
    } catch {
      // Non-fatal
    } finally {
      setRevoking(null);
    }
  }

  async function handleSaveDisplayName() {
    setDnSaving(true);
    setDnStatus("idle");
    try {
      await updateDisplayName(displayName);
      setDnStatus("success");
    } catch {
      setDnStatus("error");
    } finally {
      setDnSaving(false);
    }
  }

  async function copyToClipboard() {
    if (!rawKey) return;
    await navigator.clipboard.writeText(rawKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Settings</h1>

      {/* Section 1: Profile */}
      <Card>
        <h2 className="text-sm font-medium text-gray-300 mb-3">Profile</h2>
        {user && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <p className="text-xs text-gray-500">Email</p>
              <p className="text-sm text-gray-100">{user.email}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">User ID</p>
              <p className="text-sm text-gray-400 font-mono text-xs">
                {user.id}
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Role</p>
              <Badge color={user.role === "ADMIN" ? "yellow" : "gray"}>
                {user.role}
              </Badge>
            </div>
          </div>
        )}
      </Card>

      {/* Section 1b: Display Name */}
      <Card>
        <h2 className="text-sm font-medium text-gray-300 mb-1">Display Name</h2>
        <p className="text-gray-500 text-xs mb-3">
          This name appears on leaderboards. 3-30 chars, letters/numbers/underscores only.
        </p>
        <div className="flex gap-3 items-center">
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="your_display_name"
            className="bg-gray-800 text-white text-sm rounded px-3 py-2 border border-gray-700 focus:outline-none focus:border-blue-500 w-64"
            maxLength={30}
          />
          <Button
            onClick={handleSaveDisplayName}
            disabled={dnSaving || displayName.length < 3}
            loading={dnSaving}
          >
            Save
          </Button>
          {dnStatus === "success" && (
            <span className="text-green-400 text-sm">Saved!</span>
          )}
          {dnStatus === "error" && (
            <span className="text-red-400 text-sm">Failed to save</span>
          )}
        </div>
      </Card>

      {/* Section 2: API Keys */}
      <Card>
        <h2 className="text-sm font-medium text-gray-300 mb-3">API Keys</h2>

        {/* Create key form */}
        <form onSubmit={handleCreateKey} className="space-y-3 mb-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Input
              label="Label"
              placeholder="My trading bot"
              value={formLabel}
              onChange={(e) => setFormLabel(e.target.value)}
            />
            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-500">Scopes</label>
              <div className="flex gap-2 items-center h-[38px]">
                {SCOPES.map((scope) => (
                  <label
                    key={scope}
                    className="flex items-center gap-1.5 text-sm text-gray-300 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={formScopes.has(scope)}
                      onChange={() => toggleScope(scope)}
                      className="rounded border-gray-600 bg-gray-800 text-blue-500 focus:ring-blue-500"
                    />
                    {scope}
                  </label>
                ))}
              </div>
            </div>
            <Input
              label="Expires in (days)"
              type="number"
              placeholder="Optional"
              min="1"
              value={formExpiresDays}
              onChange={(e) => setFormExpiresDays(e.target.value)}
            />
          </div>
          {formError && (
            <ErrorBanner
              message={formError}
              onDismiss={() => setFormError(null)}
            />
          )}
          <Button
            type="submit"
            loading={formSubmitting}
            disabled={!formLabel.trim() || formScopes.size === 0}
          >
            Create API Key
          </Button>
        </form>

        {/* Keys table */}
        {keysLoading ? (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        ) : apiKeys.length === 0 ? (
          <EmptyState message="No API keys created yet" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 border-b border-gray-800">
                  <th className="pb-2 pr-3">Label</th>
                  <th className="pb-2 pr-3">Scopes</th>
                  <th className="pb-2 pr-3">Last Used</th>
                  <th className="pb-2 pr-3">Expires</th>
                  <th className="pb-2 pr-3">Status</th>
                  <th className="pb-2">Action</th>
                </tr>
              </thead>
              <tbody>
                {apiKeys.map((key) => (
                  <tr
                    key={key.id}
                    className="border-b border-gray-800/50"
                  >
                    <td className="py-2 pr-3 font-medium">{key.label}</td>
                    <td className="py-2 pr-3">
                      <div className="flex gap-1">
                        {key.scopes.map((s) => (
                          <Badge key={s} color="gray">
                            {s}
                          </Badge>
                        ))}
                      </div>
                    </td>
                    <td className="py-2 pr-3 text-xs text-gray-500">
                      {key.lastUsedAt
                        ? format(new Date(key.lastUsedAt), "MMM d HH:mm")
                        : "Never"}
                    </td>
                    <td className="py-2 pr-3 text-xs text-gray-500">
                      {key.expiresAt
                        ? format(new Date(key.expiresAt), "MMM d, yyyy")
                        : "Never"}
                    </td>
                    <td className="py-2 pr-3">
                      <Badge color={key.revoked ? "red" : "green"}>
                        {key.revoked ? "Revoked" : "Active"}
                      </Badge>
                    </td>
                    <td className="py-2">
                      {!key.revoked && (
                        <Button
                          variant="danger"
                          onClick={() => handleRevoke(key.id)}
                          loading={revoking === key.id}
                          className="text-xs px-2 py-1"
                        >
                          {confirmRevoke === key.id ? "Confirm?" : "Revoke"}
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

      {/* Section 3: Trading Quotas */}
      {userStatus?.quotas && (
        <Card>
          <h2 className="text-sm font-medium text-gray-300 mb-3">
            Trading Quotas
          </h2>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <p className="text-xs text-gray-500">Max Orders / Min</p>
              <p className="text-lg font-semibold text-gray-100">
                {userStatus.quotas.maxOrdersPerMin}
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Max Open Orders</p>
              <p className="text-lg font-semibold text-gray-100">
                {userStatus.quotas.maxOpenOrders}
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Max Daily Orders</p>
              <p className="text-lg font-semibold text-gray-100">
                {userStatus.quotas.maxDailyOrders}
              </p>
            </div>
          </div>
        </Card>
      )}

      {/* Section 4: Bot Management */}
      <Card>
        <h2 className="text-sm font-medium text-gray-300 mb-2">Bot Management</h2>
        <p className="text-xs text-gray-500 mb-2">Configure and manage your trading bot strategies.</p>
        <Link to="/bot" className="text-sm text-blue-400 hover:text-blue-300">
          Open Bot Manager &rarr;
        </Link>
      </Card>

      {/* Raw Key Modal */}
      {rawKey && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-gray-900 border border-gray-700 rounded-lg p-6 max-w-lg w-full mx-4 space-y-4">
            <h3 className="text-lg font-semibold text-gray-100">
              API Key Created
            </h3>
            <div className="rounded border border-yellow-800 bg-yellow-900/20 px-3 py-2 text-sm text-yellow-300">
              Copy this key now. It will not be shown again.
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded bg-gray-800 px-3 py-2 text-sm text-gray-100 font-mono break-all">
                {rawKey}
              </code>
              <Button variant="secondary" onClick={copyToClipboard}>
                {copied ? "Copied!" : "Copy"}
              </Button>
            </div>
            <div className="flex justify-end">
              <Button
                onClick={() => {
                  setRawKey(null);
                  setCopied(false);
                }}
              >
                Done
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
