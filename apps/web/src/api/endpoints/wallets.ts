import client from "../client";
import type { Asset, Wallet, LedgerEntry } from "@/types/api";

export function listAssets() {
  return client.get<{ ok: true; assets: Asset[] }>("/assets");
}

export function createWallet(assetId: string) {
  return client.post<{ ok: true; wallet: Wallet }>("/wallets", { assetId });
}

export function listWallets() {
  return client.get<{ ok: true; wallets: Wallet[] }>("/wallets");
}

export function getTransactions(
  walletId: string,
  params?: { cursor?: string; limit?: number },
) {
  return client.get<{ ok: true; entries: LedgerEntry[]; nextCursor: string | null }>(
    `/wallets/${walletId}/transactions`,
    { params },
  );
}
