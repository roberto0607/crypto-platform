/**
 * AVAILABLE must follow the server's balances without a reload (QA F4):
 * wallet.updated patches the store, and an SSE reconnect re-fetches every
 * wallet because events sent while disconnected are lost.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import type { SSEHandlers } from "@/api/sse";

const captured: { handlers: SSEHandlers | null } = { handlers: null };

vi.mock("@/api/sse", () => ({
  connectSSE: (_token: string, handlers: SSEHandlers) => {
    captured.handlers = handlers;
    return () => {};
  },
  disconnectSSE: () => {},
  forceReconnectSSE: () => {},
}));

const listWallets = vi.fn();
vi.mock("@/api/endpoints/wallets", () => ({ listWallets: () => listWallets() }));

import { useSSE } from "@/hooks/useSSE";
import { useAuthStore } from "@/stores/authStore";
import { useAppStore } from "@/stores/appStore";
import type { Wallet } from "@/types/api";

const usd = (balance: string, reserved = "0"): Wallet =>
  ({ id: "w-usd", user_id: "u1", asset_id: "a-usd", balance, reserved, created_at: "", updated_at: "" }) as Wallet;

beforeEach(() => {
  captured.handlers = null;
  listWallets.mockReset();
  useAuthStore.setState({ isAuthenticated: true, accessToken: "t" } as never);
  useAppStore.setState({ wallets: [usd("100000")] });
});

describe("useSSE wallet sync", () => {
  it("re-fetches wallets on reconnect", async () => {
    listWallets.mockResolvedValue({ data: { ok: true, wallets: [usd("99949.26")] } });
    renderHook(() => useSSE());

    captured.handlers!.onReconnected!();
    await vi.waitFor(() => expect(useAppStore.getState().wallets[0]!.balance).toBe("99949.26"));
    expect(listWallets).toHaveBeenCalledTimes(1);
  });

  it("patches the wallet from wallet.updated", () => {
    renderHook(() => useSSE());

    captured.handlers!.onWalletUpdated!({
      type: "wallet.updated",
      ts: 0,
      data: { walletId: "w-usd", assetId: "a-usd", balance: "99949.26", reserved: "10", entryType: "TRADE" },
    } as never);
    expect(useAppStore.getState().wallets[0]).toMatchObject({ balance: "99949.26", reserved: "10" });
  });

  it("keeps the last balances when the re-fetch fails", async () => {
    listWallets.mockRejectedValue(new Error("network"));
    renderHook(() => useSSE());

    captured.handlers!.onReconnected!();
    await vi.waitFor(() => expect(listWallets).toHaveBeenCalled());
    expect(useAppStore.getState().wallets[0]!.balance).toBe("100000");
  });
});
