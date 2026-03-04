import { useState, useEffect } from "react";
import { format } from "date-fns";
import {
  listInvites,
  createInvite,
  disableInvite,
  type Invite,
} from "@/api/endpoints/admin";
import { normalizeApiError } from "@/lib/errors";
import { AxiosError } from "axios";
import Card from "@/components/Card";
import Button from "@/components/Button";
import Input from "@/components/Input";
import Badge from "@/components/Badge";
import Spinner from "@/components/Spinner";
import ErrorBanner from "@/components/ErrorBanner";
import EmptyState from "@/components/EmptyState";

export default function AdminBetaPage() {
  const [invites, setInvites] = useState<Invite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create form
  const [formCode, setFormCode] = useState("");
  const [formMaxUses, setFormMaxUses] = useState("10");
  const [formExpires, setFormExpires] = useState("");
  const [formSubmitting, setFormSubmitting] = useState(false);

  const [disableLoading, setDisableLoading] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    listInvites()
      .then((res) => setInvites(res.data.invites))
      .catch(() => setError("Failed to load invites"))
      .finally(() => setLoading(false));
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setFormSubmitting(true);
    setError(null);
    try {
      const res = await createInvite({
        code: formCode,
        maxUses: parseInt(formMaxUses, 10),
        expiresAt: formExpires
          ? new Date(formExpires).toISOString()
          : undefined,
      });
      setInvites((prev) => [res.data.invite, ...prev]);
      setFormCode("");
      setFormMaxUses("10");
      setFormExpires("");
    } catch (err) {
      const { message } = normalizeApiError(err as AxiosError<never>);
      setError(message);
    } finally {
      setFormSubmitting(false);
    }
  }

  async function handleDisable(id: string) {
    setDisableLoading(id);
    try {
      await disableInvite(id);
      setInvites((prev) =>
        prev.map((i) => (i.id === id ? { ...i, disabled: true } : i)),
      );
    } catch (err) {
      const { message } = normalizeApiError(err as AxiosError<never>);
      setError(message);
    } finally {
      setDisableLoading(null);
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

      {/* Create Invite */}
      <Card>
        <h2 className="text-sm font-medium text-gray-300 mb-3">
          Create Invite
        </h2>
        <form onSubmit={handleCreate} className="space-y-3">
          <div className="grid grid-cols-3 gap-3">
            <Input
              label="Code"
              placeholder="BETA2024"
              value={formCode}
              onChange={(e) => setFormCode(e.target.value)}
            />
            <Input
              label="Max Uses"
              type="number"
              min="1"
              value={formMaxUses}
              onChange={(e) => setFormMaxUses(e.target.value)}
            />
            <Input
              label="Expires At"
              type="datetime-local"
              value={formExpires}
              onChange={(e) => setFormExpires(e.target.value)}
            />
          </div>
          <Button
            type="submit"
            loading={formSubmitting}
            disabled={!formCode || !formMaxUses}
          >
            Create Invite
          </Button>
        </form>
      </Card>

      {/* Invites List */}
      <Card>
        <h2 className="text-sm font-medium text-gray-300 mb-3">Invites</h2>
        {invites.length === 0 ? (
          <EmptyState message="No invites" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 border-b border-gray-800">
                  <th className="pb-2 pr-3">Code</th>
                  <th className="pb-2 pr-3">Uses</th>
                  <th className="pb-2 pr-3">Status</th>
                  <th className="pb-2 pr-3">Expires</th>
                  <th className="pb-2 pr-3">Created</th>
                  <th className="pb-2">Action</th>
                </tr>
              </thead>
              <tbody>
                {invites.map((inv) => (
                  <tr key={inv.id} className="border-b border-gray-800/50">
                    <td className="py-2 pr-3 font-mono font-medium">
                      {inv.code}
                    </td>
                    <td className="py-2 pr-3">
                      {inv.use_count} / {inv.max_uses}
                    </td>
                    <td className="py-2 pr-3">
                      <Badge color={inv.disabled ? "red" : "green"}>
                        {inv.disabled ? "Disabled" : "Active"}
                      </Badge>
                    </td>
                    <td className="py-2 pr-3 text-xs text-gray-500">
                      {inv.expires_at
                        ? format(new Date(inv.expires_at), "MMM d, yyyy")
                        : "Never"}
                    </td>
                    <td className="py-2 pr-3 text-xs text-gray-500">
                      {format(new Date(inv.created_at), "MMM d, yyyy")}
                    </td>
                    <td className="py-2">
                      {!inv.disabled && (
                        <Button
                          variant="danger"
                          className="text-xs px-2 py-1"
                          onClick={() => handleDisable(inv.id)}
                          loading={disableLoading === inv.id}
                        >
                          Disable
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
    </div>
  );
}
