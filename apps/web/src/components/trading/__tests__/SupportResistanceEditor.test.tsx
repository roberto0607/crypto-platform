import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SupportResistanceEditor } from "@/components/trading/SupportResistanceEditor";
import { useChartLayoutStore } from "@/stores/chartLayoutStore";
import { useIndicatorSettingsStore } from "@/stores/indicatorSettingsStore";
import { DEFAULT_INDICATOR_SETTINGS } from "@/lib/chartLayouts/layoutConfig";

const pivots = () => useIndicatorSettingsStore.getState().supportResistancePivots;

beforeEach(() => {
    localStorage.clear();
    useIndicatorSettingsStore.setState({ ...DEFAULT_INDICATOR_SETTINGS });
    useChartLayoutStore.setState({ timeframe: "1w" });
});

describe("S/R pivot length in the settings panel", () => {
    it("Auto shows the timeframe's length and the confirmation delay it gives", () => {
        render(<SupportResistanceEditor />);
        expect(screen.getByLabelText("S/R pivot length auto")).toBeChecked();
        expect(screen.getByTestId("sr-pivot-auto").textContent).toBe("3 / 3");
        expect(screen.queryByLabelText("S/R pivot bars left")).toBeNull();
        expect(screen.getByText("confirms after 3w")).toBeInTheDocument();
        act(() => useChartLayoutStore.setState({ timeframe: "1h" }));
        expect(screen.getByTestId("sr-pivot-auto").textContent).toBe("8 / 8");
    });

    it("turning Auto off sets this timeframe by hand (starting from the Auto value); edits stay on it", async () => {
        const user = userEvent.setup();
        render(<SupportResistanceEditor />);
        await user.click(screen.getByLabelText("S/R pivot length auto"));
        expect(pivots()).toEqual({ "1w": { left: 3, right: 3 } });
        const left = screen.getByLabelText("S/R pivot bars left");
        await user.clear(left);
        await user.type(left, "6");
        expect(pivots()).toEqual({ "1w": { left: 6, right: 3 } });
        expect(screen.getByText("confirms after 3w")).toBeInTheDocument();
        // Another timeframe is still on Auto.
        act(() => useChartLayoutStore.setState({ timeframe: "4h" }));
        expect(screen.getByLabelText("S/R pivot length auto")).toBeChecked();
        expect(screen.getByTestId("sr-pivot-auto").textContent).toBe("10 / 10");
    });

    it("turning Auto back on forgets that timeframe's hand-set value", async () => {
        useIndicatorSettingsStore.getState().setSupportResistancePivot("1w", { left: 6, right: 4 });
        const user = userEvent.setup();
        render(<SupportResistanceEditor />);
        expect(screen.getByLabelText("S/R pivot length auto")).not.toBeChecked();
        expect(screen.getByLabelText("S/R pivot bars right")).toHaveValue(4);
        await user.click(screen.getByLabelText("S/R pivot length auto"));
        expect(pivots()).toEqual({});
    });
});
