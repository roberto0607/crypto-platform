import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IndicatorToolbar } from "@/components/trading/IndicatorToolbar";
import { useTradingStore, DEFAULT_INDICATOR_CONFIG } from "@/stores/tradingStore";
import { useIndicatorSettingsStore } from "@/stores/indicatorSettingsStore";

const settings = () => useIndicatorSettingsStore.getState();

beforeEach(() => {
    localStorage.clear();
    useTradingStore.setState({ indicatorConfig: { ...DEFAULT_INDICATOR_CONFIG } });
    useIndicatorSettingsStore.setState({ movingAverages: [], maCross: null });
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
