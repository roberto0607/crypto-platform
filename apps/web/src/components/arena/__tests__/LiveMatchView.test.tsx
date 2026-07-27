import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// LiveMatchView pulls in the whole trade-page module graph (chart/canvas,
// order panel, end overlay). Stub the heavy children so the import stays
// light and jsdom-safe, same technique orderBookPanel.test.tsx uses for
// TradingPage. MatchChatPanel is stubbed too — its own behavior is covered
// by MatchChatPanel.test.tsx; here we only test LiveMatchView's unread/open
// bookkeeping, so the stub just surfaces the props it was called with.
vi.mock("@/components/trading/CandlestickChart", () => ({ CandlestickChart: () => null }));
vi.mock("@/components/trading/UnifiedOrderPanel", () => ({ UnifiedOrderPanel: () => null }));
vi.mock("../MatchEndOverlay", () => ({ MatchEndOverlay: () => null }));
vi.mock("../MatchChatPanel", () => ({
    MatchChatPanel: (props: { matchId: string; opponentName: string; isOpen: boolean; onClose: () => void }) => (
        <div
            data-testid="match-chat-panel-stub"
            data-match-id={props.matchId}
            data-opponent={props.opponentName}
            data-open={props.isOpen}
        />
    ),
}));

const getPositionsApi = vi.fn();
vi.mock("@/api/endpoints/analytics", () => ({
    getPositions: (params?: unknown) => getPositionsApi(params),
}));

const forfeitMatchApi = vi.fn();
const getActiveMatchApi = vi.fn();
const getMatchApi = vi.fn();
vi.mock("@/api/endpoints/matches", () => ({
    forfeitMatch: (id: string) => forfeitMatchApi(id),
    getActiveMatch: () => getActiveMatchApi(),
    getMatch: (id: string) => getMatchApi(id),
}));

import { useAppStore } from "@/stores/appStore";
import { useAuthStore } from "@/stores/authStore";
import { useTradingStore } from "@/stores/tradingStore";
import ToastProvider from "@/components/ToastProvider";
import { LiveMatchView } from "@/components/arena/LiveMatchView";
import type { Match } from "@/api/endpoints/matches";
import type { TradingPair, MessageReceivedEvent } from "@/types/api";

function makeMatch(overrides: Partial<Match> = {}): Match {
    return {
        id: "match-1",
        season_id: null,
        challenger_id: "me",
        opponent_id: "opp",
        status: "ACTIVE",
        duration_hours: 24,
        starting_capital: "50000",
        challenger_pnl_pct: "0",
        opponent_pnl_pct: "0",
        challenger_trades_count: 0,
        opponent_trades_count: 0,
        challenger_win_rate: null,
        opponent_win_rate: null,
        challenger_score: null,
        opponent_score: null,
        winner_id: null,
        forfeit_user_id: null,
        elo_delta: null,
        started_at: new Date().toISOString(),
        ends_at: new Date(Date.now() + 3_600_000).toISOString(),
        completed_at: null,
        created_at: new Date().toISOString(),
        challenger_name: "Me",
        challenger_elo: 1200,
        opponent_name: "Opp",
        opponent_elo: 1200,
        winner_elo_delta: null,
        loser_elo_delta: null,
        ...overrides,
    };
}

const pair: TradingPair = {
    id: "pair-1",
    symbol: "BTC/USD",
    base_asset_id: "base-1",
    quote_asset_id: "quote-1",
    is_active: true,
    fee_bps: 5,
    maker_fee_bps: 2,
    taker_fee_bps: 5,
    trading_enabled: true,
    created_at: new Date().toISOString(),
};

function dispatchMatchMessage(overrides: Partial<MessageReceivedEvent> = {}) {
    const detail: MessageReceivedEvent = {
        conversationId: "conv-1",
        conversationType: "match",
        messageId: "m-sse",
        senderId: "opp",
        senderName: "Opp",
        body: "gl",
        imageUrl: null,
        createdAt: new Date().toISOString(),
        ...overrides,
    };
    act(() => {
        window.dispatchEvent(new CustomEvent("sse:message.received", { detail }));
    });
}

function renderView(match: Match) {
    return render(
        <ToastProvider>
            <LiveMatchView match={match} onMatchEnd={vi.fn()} />
        </ToastProvider>,
    );
}

beforeEach(() => {
    getPositionsApi.mockReset().mockResolvedValue({ data: { positions: [] } });
    forfeitMatchApi.mockReset();
    getActiveMatchApi.mockReset().mockResolvedValue({ data: { match: null } });
    getMatchApi.mockReset();
    useAuthStore.setState({ user: { id: "me", email: "me@test.com", role: "USER" } as any });
    useAppStore.setState({ pairs: [pair], wallets: [] });
    useTradingStore.setState({ selectedPairId: "pair-1" } as any);
});

describe("LiveMatchView — Match Chat unread tracking", () => {
    it("does not mount MatchChatPanel until chat is opened for the first time", () => {
        renderView(makeMatch());
        expect(screen.queryByTestId("match-chat-panel-stub")).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: /CHAT/ })).toBeInTheDocument();
    });

    it("bumps the unread badge on an incoming match message while chat is closed", () => {
        renderView(makeMatch());
        dispatchMatchMessage();
        expect(screen.getByText("1")).toBeInTheDocument();

        dispatchMatchMessage({ messageId: "m-sse-2" });
        expect(screen.getByText("2")).toBeInTheDocument();
    });

    it("ignores dm-conversationType pushes for the unread badge", () => {
        renderView(makeMatch());
        dispatchMatchMessage({ conversationType: "dm" });
        expect(screen.queryByText("1")).not.toBeInTheDocument();
    });

    it("mounts MatchChatPanel with isOpen=true and clears unread on first open", async () => {
        renderView(makeMatch());
        dispatchMatchMessage();
        expect(screen.getByText("1")).toBeInTheDocument();

        await userEvent.click(screen.getByRole("button", { name: /CHAT/ }));

        const stub = screen.getByTestId("match-chat-panel-stub");
        expect(stub).toHaveAttribute("data-open", "true");
        expect(stub).toHaveAttribute("data-match-id", "match-1");
        expect(stub).toHaveAttribute("data-opponent", "Opp");
        expect(screen.queryByText("1")).not.toBeInTheDocument();
    });

    it("keeps MatchChatPanel mounted (isOpen=false) after closing, and re-bumps unread while closed", async () => {
        renderView(makeMatch());
        await userEvent.click(screen.getByRole("button", { name: /CHAT/ })); // open
        await userEvent.click(screen.getByRole("button", { name: /CHAT/ })); // close

        const stub = screen.getByTestId("match-chat-panel-stub");
        expect(stub).toHaveAttribute("data-open", "false");

        dispatchMatchMessage();
        expect(screen.getByText("1")).toBeInTheDocument();
    });

    // match.id can only change internally (setMatch from syncMatchState/SSE),
    // never via a prop swap — LiveMatchView's `match` is local state seeded
    // ONCE from the initialMatch prop (React ignores a changed useState
    // initial value on re-render), so a bare rerender with a different
    // `match` prop would not exercise the reset effect at all. Drive it
    // through the real mechanism instead: the "sse:reconnected" handler
    // calls syncMatchState(), which calls setMatch(data.match) with
    // whatever getActiveMatch() resolves to.
    it("resets chat open/unread/everOpened state when the mounted match's id changes", async () => {
        renderView(makeMatch({ id: "match-1" }));
        await userEvent.click(screen.getByRole("button", { name: /CHAT/ })); // open -> chatEverOpened=true
        await userEvent.click(screen.getByRole("button", { name: /CHAT/ })); // close
        dispatchMatchMessage();
        expect(screen.getByText("1")).toBeInTheDocument();

        getActiveMatchApi.mockResolvedValueOnce({
            data: { match: makeMatch({ id: "match-2", opponent_name: "NewOpp" }) },
        });
        await act(async () => {
            window.dispatchEvent(new CustomEvent("sse:reconnected"));
            await Promise.resolve();
        });

        // New match: panel un-mounts (chatEverOpened reset) and badge is gone.
        expect(screen.queryByTestId("match-chat-panel-stub")).not.toBeInTheDocument();
        expect(screen.queryByText("1")).not.toBeInTheDocument();

        // A push against the new match starts a fresh unread count from 0 -> 1, not 1 -> 2.
        dispatchMatchMessage();
        expect(screen.getByText("1")).toBeInTheDocument();
    });
});
