import { useState } from "react";
import { creditWallet, debitWallet } from "@/api/endpoints/admin";
import { normalizeApiError } from "@/lib/errors";
import { AxiosError } from "axios";
import Card from "@/components/Card";
import Button from "@/components/Button";
import Input from "@/components/Input";
import ErrorBanner from "@/components/ErrorBanner";

export default function AdminWalletsPage() {
  const [walletId, setWalletId] = useState("");
  const [amount, setAmount] = useState("");
  const [action, setAction] = useState<"credit" | "debit">("credit");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  async function handleSubmit() {
    setError(null);
    setSuccess(null);
    setSubmitting(true);
    try {
      if (action === "credit") {
        await creditWallet(walletId, amount);
      } else {
        await debitWallet(walletId, amount);
      }
      setSuccess(
        `Successfully ${action === "credit" ? "credited" : "debited"} ${amount} to wallet ${walletId.slice(0, 8)}...`,
      );
      setAmount("");
      setConfirmOpen(false);
    } catch (err) {
      const { message } = normalizeApiError(err as AxiosError<never>);
      setError(message);
      setConfirmOpen(false);
    } finally {
      setSubmitting(false);
    }
  }

  function handleFormSubmit(e: React.FormEvent) {
    e.preventDefault();
    setConfirmOpen(true);
  }

  return (
    <div className="space-y-4">
      <Card>
        <h2 className="text-sm font-medium text-gray-300 mb-3">
          Wallet Operations
        </h2>
        <form onSubmit={handleFormSubmit} className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Input
              label="Wallet ID"
              placeholder="UUID"
              value={walletId}
              onChange={(e) => setWalletId(e.target.value)}
            />
            <Input
              label="Amount"
              placeholder="100.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-500">Action</label>
              <div className="flex rounded overflow-hidden border border-gray-700">
                <button
                  type="button"
                  onClick={() => setAction("credit")}
                  className={`flex-1 px-3 py-2 text-sm font-medium transition-colors ${
                    action === "credit"
                      ? "bg-green-600 text-white"
                      : "bg-gray-900 text-gray-400"
                  }`}
                >
                  Credit
                </button>
                <button
                  type="button"
                  onClick={() => setAction("debit")}
                  className={`flex-1 px-3 py-2 text-sm font-medium transition-colors ${
                    action === "debit"
                      ? "bg-red-600 text-white"
                      : "bg-gray-900 text-gray-400"
                  }`}
                >
                  Debit
                </button>
              </div>
            </div>
          </div>
          {error && (
            <ErrorBanner message={error} onDismiss={() => setError(null)} />
          )}
          {success && (
            <div className="text-sm text-green-400">{success}</div>
          )}
          <Button
            type="submit"
            variant={action === "debit" ? "danger" : "primary"}
            disabled={!walletId || !amount}
          >
            {action === "credit" ? "Credit Wallet" : "Debit Wallet"}
          </Button>
        </form>
      </Card>

      {/* Confirmation dialog */}
      {confirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-gray-900 border border-gray-700 rounded-lg p-6 max-w-sm w-full mx-4 space-y-4">
            <h3 className="text-lg font-semibold text-gray-100">
              Confirm {action === "credit" ? "Credit" : "Debit"}
            </h3>
            <p className="text-sm text-gray-300">
              Are you sure you want to {action}{" "}
              <span className="font-mono font-medium">{amount}</span> to wallet{" "}
              <span className="font-mono text-xs">{walletId.slice(0, 12)}...</span>?
            </p>
            <div className="flex gap-2 justify-end">
              <Button
                variant="secondary"
                onClick={() => setConfirmOpen(false)}
              >
                Cancel
              </Button>
              <Button
                variant={action === "debit" ? "danger" : "primary"}
                onClick={handleSubmit}
                loading={submitting}
              >
                Confirm
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
