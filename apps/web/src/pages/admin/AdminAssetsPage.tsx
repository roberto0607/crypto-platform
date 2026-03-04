import { useState } from "react";
import {
  createAsset,
  createPair,
  setPrice,
  toggleTrading,
} from "@/api/endpoints/admin";
import { listAssets } from "@/api/endpoints/wallets";
import { listPairs } from "@/api/endpoints/trading";
import { useAppStore } from "@/stores/appStore";
import { normalizeApiError } from "@/lib/errors";
import { AxiosError } from "axios";
import Card from "@/components/Card";
import Button from "@/components/Button";
import Input from "@/components/Input";
import Badge from "@/components/Badge";
import ErrorBanner from "@/components/ErrorBanner";
import EmptyState from "@/components/EmptyState";

export default function AdminAssetsPage() {
  const assets = useAppStore((s) => s.assets);
  const pairs = useAppStore((s) => s.pairs);
  const setAssets = useAppStore((s) => s.setAssets);
  const setPairs = useAppStore((s) => s.setPairs);

  // Create asset form
  const [assetSymbol, setAssetSymbol] = useState("");
  const [assetName, setAssetName] = useState("");
  const [assetDecimals, setAssetDecimals] = useState("8");
  const [assetSubmitting, setAssetSubmitting] = useState(false);
  const [assetError, setAssetError] = useState<string | null>(null);

  // Create pair form
  const [pairBase, setPairBase] = useState("");
  const [pairQuote, setPairQuote] = useState("");
  const [pairSymbol, setPairSymbol] = useState("");
  const [pairFees, setPairFees] = useState("");
  const [pairSubmitting, setPairSubmitting] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);

  // Set price
  const [priceMap, setPriceMap] = useState<Record<string, string>>({});
  const [priceLoading, setPriceLoading] = useState<string | null>(null);

  // Toggle trading
  const [tradingLoading, setTradingLoading] = useState<string | null>(null);

  const [error, setError] = useState<string | null>(null);

  async function handleCreateAsset(e: React.FormEvent) {
    e.preventDefault();
    setAssetError(null);
    setAssetSubmitting(true);
    try {
      await createAsset({
        symbol: assetSymbol,
        name: assetName,
        decimals: parseInt(assetDecimals, 10),
      });
      const res = await listAssets();
      setAssets(res.data.assets);
      setAssetSymbol("");
      setAssetName("");
      setAssetDecimals("8");
    } catch (err) {
      const { message } = normalizeApiError(err as AxiosError<never>);
      setAssetError(message);
    } finally {
      setAssetSubmitting(false);
    }
  }

  async function handleCreatePair(e: React.FormEvent) {
    e.preventDefault();
    setPairError(null);
    setPairSubmitting(true);
    try {
      await createPair({
        baseAssetId: pairBase,
        quoteAssetId: pairQuote,
        symbol: pairSymbol,
        feeBps: pairFees ? parseInt(pairFees, 10) : undefined,
      });
      const res = await listPairs();
      setPairs(res.data.pairs);
      setPairBase("");
      setPairQuote("");
      setPairSymbol("");
      setPairFees("");
    } catch (err) {
      const { message } = normalizeApiError(err as AxiosError<never>);
      setPairError(message);
    } finally {
      setPairSubmitting(false);
    }
  }

  async function handleSetPrice(pairId: string) {
    const price = priceMap[pairId];
    if (!price) return;
    setPriceLoading(pairId);
    try {
      await setPrice(pairId, price);
      setPairs(
        pairs.map((p) =>
          p.id === pairId ? { ...p, last_price: price } : p,
        ),
      );
      setPriceMap((prev) => ({ ...prev, [pairId]: "" }));
    } catch (err) {
      const { message } = normalizeApiError(err as AxiosError<never>);
      setError(message);
    } finally {
      setPriceLoading(null);
    }
  }

  async function handleToggleTrading(pairId: string, enabled: boolean) {
    setTradingLoading(pairId);
    try {
      await toggleTrading(pairId, enabled);
      setPairs(
        pairs.map((p) =>
          p.id === pairId ? { ...p, trading_enabled: enabled } : p,
        ),
      );
    } catch (err) {
      const { message } = normalizeApiError(err as AxiosError<never>);
      setError(message);
    } finally {
      setTradingLoading(null);
    }
  }

  return (
    <div className="space-y-6">
      {error && (
        <ErrorBanner message={error} onDismiss={() => setError(null)} />
      )}

      {/* Create Asset */}
      <Card>
        <h2 className="text-sm font-medium text-gray-300 mb-3">
          Create Asset
        </h2>
        <form onSubmit={handleCreateAsset} className="space-y-3">
          <div className="grid grid-cols-3 gap-3">
            <Input
              label="Symbol"
              placeholder="BTC"
              value={assetSymbol}
              onChange={(e) => setAssetSymbol(e.target.value)}
            />
            <Input
              label="Name"
              placeholder="Bitcoin"
              value={assetName}
              onChange={(e) => setAssetName(e.target.value)}
            />
            <Input
              label="Decimals"
              type="number"
              value={assetDecimals}
              onChange={(e) => setAssetDecimals(e.target.value)}
            />
          </div>
          {assetError && <ErrorBanner message={assetError} onDismiss={() => setAssetError(null)} />}
          <Button type="submit" loading={assetSubmitting} disabled={!assetSymbol || !assetName}>
            Create Asset
          </Button>
        </form>
      </Card>

      {/* Asset List */}
      <Card>
        <h2 className="text-sm font-medium text-gray-300 mb-3">Assets</h2>
        {assets.length === 0 ? (
          <EmptyState message="No assets" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 border-b border-gray-800">
                  <th className="pb-2 pr-3">Symbol</th>
                  <th className="pb-2 pr-3">Name</th>
                  <th className="pb-2 pr-3">Decimals</th>
                  <th className="pb-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {assets.map((a) => (
                  <tr key={a.id} className="border-b border-gray-800/50">
                    <td className="py-2 pr-3 font-medium">{a.symbol}</td>
                    <td className="py-2 pr-3">{a.name}</td>
                    <td className="py-2 pr-3">{a.decimals}</td>
                    <td className="py-2">
                      <Badge color={a.is_active ? "green" : "red"}>
                        {a.is_active ? "Active" : "Inactive"}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Create Pair */}
      <Card>
        <h2 className="text-sm font-medium text-gray-300 mb-3">
          Create Pair
        </h2>
        <form onSubmit={handleCreatePair} className="space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-500">Base Asset</label>
              <select
                value={pairBase}
                onChange={(e) => setPairBase(e.target.value)}
                className="rounded border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100"
              >
                <option value="">Select...</option>
                {assets.map((a) => (
                  <option key={a.id} value={a.id}>{a.symbol}</option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-500">Quote Asset</label>
              <select
                value={pairQuote}
                onChange={(e) => setPairQuote(e.target.value)}
                className="rounded border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100"
              >
                <option value="">Select...</option>
                {assets.map((a) => (
                  <option key={a.id} value={a.id}>{a.symbol}</option>
                ))}
              </select>
            </div>
            <Input
              label="Symbol"
              placeholder="BTC/USD"
              value={pairSymbol}
              onChange={(e) => setPairSymbol(e.target.value)}
            />
            <Input
              label="Fee (bps)"
              type="number"
              placeholder="30"
              value={pairFees}
              onChange={(e) => setPairFees(e.target.value)}
            />
          </div>
          {pairError && <ErrorBanner message={pairError} onDismiss={() => setPairError(null)} />}
          <Button type="submit" loading={pairSubmitting} disabled={!pairBase || !pairQuote || !pairSymbol}>
            Create Pair
          </Button>
        </form>
      </Card>

      {/* Pairs List */}
      <Card>
        <h2 className="text-sm font-medium text-gray-300 mb-3">Pairs</h2>
        {pairs.length === 0 ? (
          <EmptyState message="No pairs" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 border-b border-gray-800">
                  <th className="pb-2 pr-3">Symbol</th>
                  <th className="pb-2 pr-3">Last Price</th>
                  <th className="pb-2 pr-3">Trading</th>
                  <th className="pb-2 pr-3">Set Price</th>
                  <th className="pb-2">Toggle</th>
                </tr>
              </thead>
              <tbody>
                {pairs.map((p) => (
                  <tr key={p.id} className="border-b border-gray-800/50">
                    <td className="py-2 pr-3 font-medium">{p.symbol}</td>
                    <td className="py-2 pr-3">{p.last_price ?? "—"}</td>
                    <td className="py-2 pr-3">
                      <Badge color={p.trading_enabled ? "green" : "red"}>
                        {p.trading_enabled ? "Enabled" : "Disabled"}
                      </Badge>
                    </td>
                    <td className="py-2 pr-3">
                      <div className="flex items-center gap-1">
                        <input
                          type="text"
                          placeholder="Price"
                          value={priceMap[p.id] ?? ""}
                          onChange={(e) =>
                            setPriceMap((prev) => ({
                              ...prev,
                              [p.id]: e.target.value,
                            }))
                          }
                          className="w-24 rounded border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-gray-100"
                        />
                        <Button
                          variant="secondary"
                          className="text-xs px-2 py-1"
                          onClick={() => handleSetPrice(p.id)}
                          loading={priceLoading === p.id}
                          disabled={!priceMap[p.id]}
                        >
                          Set
                        </Button>
                      </div>
                    </td>
                    <td className="py-2">
                      <Button
                        variant={p.trading_enabled ? "danger" : "primary"}
                        className="text-xs px-2 py-1"
                        onClick={() =>
                          handleToggleTrading(p.id, !p.trading_enabled)
                        }
                        loading={tradingLoading === p.id}
                      >
                        {p.trading_enabled ? "Disable" : "Enable"}
                      </Button>
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
