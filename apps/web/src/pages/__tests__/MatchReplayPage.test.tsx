/**
 * Post-match replay page. Prod (Bertito vs berto, Nov 9, a 15-minute match):
 * the header showed each result with its own precision, unlike every other
 * match view, and the P&L lines need a point per fill, which lightweight-charts
 * only takes at distinct, ascending whole seconds.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const series = vi.hoisted(() => ({ lines: [] as { setData: ReturnType<typeof vi.fn> }[] }));
vi.mock("lightweight-charts", () => {
    const mkSeries = () => {
        const s = { setData: vi.fn(), createPriceLine: vi.fn() };
        series.lines.push(s);
        return s;
    };
    return {
        createChart: () => ({
            addSeries: mkSeries,
            applyOptions: vi.fn(),
            remove: vi.fn(),
            timeScale: () => ({ setVisibleRange: vi.fn() }),
        }),
        createSeriesMarkers: () => ({ setMarkers: vi.fn() }),
        CandlestickSeries: {},
        LineSeries: {},
        LineStyle: { Dashed: 2 },
    };
});
const api = vi.hoisted(() => ({ getMatchReplay: vi.fn() }));
vi.mock("@/api/endpoints/matchReplay", () => api);

import MatchReplayPage, { toLineData } from "@/pages/MatchReplayPage";
import { formatMatchPnlPair } from "@/lib/matchPnl";

const S = Date.parse("2026-11-09T20:00:00Z");
const point = (ts: number, pnlPct: number) => ({ ts, pnlPct, equity: 0, realizedPnl: 0, unrealizedPnl: 0 });

beforeEach(() => {
    series.lines.length = 0;
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} disconnect() {} };
});

describe("toLineData", () => {
    it("one point per whole second, the last value in that second, ascending", () => {
        expect(toLineData([point(S, 0), point(S + 200, -0.01), point(S + 700, -0.02), point(S + 1500, -0.03)])).toEqual([
            { time: S / 1000, value: -0.02 },
            { time: S / 1000 + 1, value: -0.03 },
        ]);
    });
});

describe("MatchReplayPage header", () => {
    it("shows both players' results at one precision, like the other match views", async () => {
        // -$20.52 vs -$9.78 on $50,000: -0.04104% vs -0.01956%.
        const chal = "c", opp = "o";
        const clock = [S, S + 60_000, S + 15 * 60_000];
        api.getMatchReplay.mockResolvedValue({
            data: {
                ok: true, source: "fills", candleTimeframe: "1m",
                match: {
                    id: "m1", startedAt: S, endedAt: S + 15 * 60_000, startingCapital: 50000,
                    challenger: { id: chal, name: "Bertito", finalPnlPct: -0.04104 },
                    opponent: { id: opp, name: "berto", finalPnlPct: -0.01956 },
                },
                candles: { "BTC/USD": [{ ts: S, o: 1, h: 1, l: 1, c: 1 }] },
                positions: [],
                curves: {
                    [chal]: clock.map((ts, i) => point(ts, [0, -0.001, -0.04104][i]!)),
                    [opp]: clock.map((ts, i) => point(ts, [0, -0.0005, -0.01956][i]!)),
                },
            },
        });
        render(
            <MemoryRouter initialEntries={["/matches/m1/replay"]}>
                <Routes><Route path="/matches/:id/replay" element={<MatchReplayPage />} /></Routes>
            </MemoryRouter>,
        );
        await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

        const [chalFinal, oppFinal] = formatMatchPnlPair(-0.04104, -0.01956, 50000);
        expect(screen.getByText(`final ${chalFinal}`)).toBeTruthy();
        expect(screen.getByText(`final ${oppFinal}`)).toBeTruthy();
        // At the start of the replay both read zero, at the same precision.
        expect(screen.getAllByText(formatMatchPnlPair(0, 0, 50000)[0])).toHaveLength(2);
    });
});
