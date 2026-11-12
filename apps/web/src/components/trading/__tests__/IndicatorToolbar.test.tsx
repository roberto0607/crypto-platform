import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IndicatorToolbar } from "@/components/trading/IndicatorToolbar";
import { useTradingStore, DEFAULT_INDICATOR_CONFIG } from "@/stores/tradingStore";
import { useIndicatorSettingsStore } from "@/stores/indicatorSettingsStore";
import { DEFAULT_INDICATOR_SETTINGS } from "@/lib/chartLayouts/layoutConfig";

const settings = () => useIndicatorSettingsStore.getState();

beforeEach(() => {
    localStorage.clear();
    useTradingStore.setState({ indicatorConfig: { ...DEFAULT_INDICATOR_CONFIG } });
    useIndicatorSettingsStore.setState({ ...DEFAULT_INDICATOR_SETTINGS });
});

async function openAndSearch(q: string) {
    const user = userEvent.setup();
    render(<IndicatorToolbar />);
    await user.click(screen.getByRole("button", { name: "Indicators" }));
    const box = screen.getByPlaceholderText("Search indicators...");
    await user.clear(box);
    if (q) await user.type(box, q);
    return user;
}

describe("search aliases", () => {
    for (const q of ["moving average", "Moving", "sma", "ema", "MA"]) {
        it(`"${q}" finds Moving Averages`, async () => {
            await openAndSearch(q);
            expect(screen.getByText("Moving Averages")).toBeTruthy();
        });
    }

    it("the old fixed EMA rows are gone", async () => {
        await openAndSearch("ema");
        expect(screen.queryByText("EMA 20")).toBeNull();
        expect(screen.queryByText("EMA 200")).toBeNull();
    });

    it("an unrelated query still says nothing found", async () => {
        await openAndSearch("zzz");
        expect(screen.getByText("No indicators found")).toBeTruthy();
    });
});

describe("moving average editor", () => {
    it("adds lines, edits type/length/color, removes one", async () => {
        const user = await openAndSearch("moving");
        await user.click(screen.getByRole("button", { name: "Add moving average" }));
        await user.click(screen.getByRole("button", { name: "Add moving average" }));
        expect(settings().movingAverages.map((m) => `${m.type} ${m.length}`)).toEqual(["EMA 20", "EMA 50"]);

        const row = within(screen.getByTestId("ma-row-ma1"));
        await user.selectOptions(row.getByLabelText("Type"), "SMA");
        const len = row.getByLabelText("Length");
        await user.clear(len);
        await user.type(len, "200");
        fireEvent.input(row.getByLabelText("Color"), { target: { value: "#22c55e" } });
        expect(settings().movingAverages[0]).toEqual({ id: "ma1", type: "SMA", length: 200, color: "#22c55e" });

        await user.click(within(screen.getByTestId("ma-row-ma2")).getByRole("button", { name: "Remove" }));
        expect(settings().movingAverages.map((m) => m.id)).toEqual(["ma1"]);
    });

    it("a line's timeframe: 1D adds the timeframe to its label and offers LIVE; Chart removes both", async () => {
        const user = await openAndSearch("higher timeframe");
        await user.click(screen.getByRole("button", { name: "Add moving average" }));
        const row = within(screen.getByTestId("ma-row-ma1"));
        expect(row.queryByLabelText("Show forming value")).toBeNull();
        await user.selectOptions(row.getByLabelText("Timeframe"), "1d");
        expect(settings().movingAverages[0]).toMatchObject({ timeframe: "1d" });
        await user.click(row.getByLabelText("Show forming value"));
        expect(settings().movingAverages[0]).toMatchObject({ timeframe: "1d", forming: true });
        await user.selectOptions(row.getByLabelText("Timeframe"), "chart");
        expect(settings().movingAverages[0]).toEqual({ id: "ma1", type: "EMA", length: 20, color: "#3b82f6" });
    });

    it("cross pickers name the timeframe", async () => {
        const user = await openAndSearch("moving");
        await user.click(screen.getByRole("button", { name: "Add moving average" }));
        await user.click(screen.getByRole("button", { name: "Add moving average" }));
        await user.selectOptions(within(screen.getByTestId("ma-row-ma2")).getByLabelText("Timeframe"), "1w");
        expect(within(screen.getByLabelText("Cross fast line")).getByRole("option", { name: "EMA 50 (1W)" })).toBeTruthy();
    });

    it("an empty or out-of-range length never reaches the chart", async () => {
        const user = await openAndSearch("sma");
        await user.click(screen.getByRole("button", { name: "Add moving average" }));
        const len = within(screen.getByTestId("ma-row-ma1")).getByLabelText("Length");
        await user.clear(len);
        expect(settings().movingAverages[0]!.length).toBe(20);
        await user.type(len, "0");
        expect(settings().movingAverages[0]!.length).toBe(20);
        await user.clear(len);
        await user.type(len, "9999");
        expect(settings().movingAverages[0]!.length).toBe(500);
    });

    it("cross markers on any two lines", async () => {
        const user = await openAndSearch("moving");
        for (let i = 0; i < 3; i++) await user.click(screen.getByRole("button", { name: "Add moving average" }));
        expect(screen.getByLabelText("Cross slow line")).toHaveProperty("disabled", true);

        await user.selectOptions(screen.getByLabelText("Cross fast line"), "ma1");
        // Slow defaults to the longest other line.
        expect(settings().maCross).toEqual({ fast: "ma1", slow: "ma3" });
        await user.selectOptions(screen.getByLabelText("Cross slow line"), "ma2");
        expect(settings().maCross).toEqual({ fast: "ma1", slow: "ma2" });
        await user.selectOptions(screen.getByLabelText("Cross fast line"), "");
        expect(settings().maCross).toBeNull();
    });

    it("counts each line in the active badge", async () => {
        useIndicatorSettingsStore.setState({
            movingAverages: [
                { id: "a", type: "EMA", length: 20, color: "#3b82f6" },
                { id: "b", type: "SMA", length: 50, color: "#f59e0b" },
            ],
        });
        useTradingStore.setState({ indicatorConfig: { ...DEFAULT_INDICATOR_CONFIG, rsi: true } });
        render(<IndicatorToolbar />);
        expect(screen.getByRole("button", { name: "Indicators" }).textContent).toContain("3");
    });
});

describe("ADX, UT Bot, key levels, swings", () => {
    const cases: Array<[string, string]> = [
        ["adx", "ADX / DMI"],
        ["trend strength", "ADX / DMI"],
        ["DMI", "ADX / DMI"],
        ["ut bot", "UT Bot"],
        ["trailing stop", "UT Bot"],
        ["weekly high", "Key Levels (PDH/PDL/PWH/PWL)"],
        ["pwl", "Key Levels (PDH/PDL/PWH/PWL)"],
        ["previous day", "Key Levels (PDH/PDL/PWH/PWL)"],
        ["swing", "Swing Highs/Lows"],
        ["pivot", "Swing Highs/Lows"],
    ];
    for (const [q, label] of cases) {
        it(`"${q}" finds ${label}`, async () => {
            await openAndSearch(q);
            expect(screen.getByText(label)).toBeTruthy();
        });
    }

    it("all three are off by default", () => {
        const c = useTradingStore.getState().indicatorConfig;
        expect([c.adx, c.utBot, c.swings]).toEqual([false, false, false]);
    });

    it("ADX settings show once it's on and edit the store", async () => {
        const user = await openAndSearch("adx");
        expect(screen.queryByLabelText("ADX DI length")).toBeNull();
        await user.click(screen.getByText("ADX / DMI"));
        expect(useTradingStore.getState().indicatorConfig.adx).toBe(true);

        const threshold = screen.getByLabelText("ADX threshold");
        await user.clear(threshold);
        await user.type(threshold, "20");
        const di = screen.getByLabelText("ADX DI length");
        await user.clear(di);
        await user.type(di, "10");
        expect(settings().adx).toEqual({ diLength: 10, adxSmoothing: 14, threshold: 20 });
    });

    it("UT Bot settings: key value (0.1 steps) and ATR period", async () => {
        useTradingStore.setState({ indicatorConfig: { ...DEFAULT_INDICATOR_CONFIG, utBot: true } });
        const user = await openAndSearch("ut bot");
        const key = screen.getByLabelText("UT Bot key value");
        await user.clear(key);
        await user.type(key, "2.5");
        const atr = screen.getByLabelText("UT Bot ATR period");
        await user.clear(atr);
        await user.type(atr, "14");
        expect(settings().utBot).toEqual({ keyValue: 2.5, atrPeriod: 14 });
    });
});
