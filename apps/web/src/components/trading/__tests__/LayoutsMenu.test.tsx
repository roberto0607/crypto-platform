import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/api/endpoints/chartLayouts", () => ({
    listChartLayouts: vi.fn(),
    createChartLayout: vi.fn(),
    updateChartLayout: vi.fn(),
    deleteChartLayout: vi.fn(),
}));

import * as api from "@/api/endpoints/chartLayouts";
import type { SavedChartLayout } from "@/api/endpoints/chartLayouts";
import { LayoutsMenu } from "@/components/trading/LayoutsMenu";
import { useChartLayoutStore } from "@/stores/chartLayoutStore";
import { useTradingStore, DEFAULT_INDICATOR_CONFIG } from "@/stores/tradingStore";

const mocked = vi.mocked(api);
const ok = <T,>(data: T) => Promise.resolve({ data }) as never;

function saved(over: Partial<SavedChartLayout> = {}): SavedChartLayout {
    return {
        id: "33333333-3333-3333-3333-333333333333",
        name: "Night",
        config: { version: 1, indicators: { vwap: true } },
        is_default: false,
        created_at: "2026-11-02T00:00:00Z",
        updated_at: "2026-11-02T00:00:00Z",
        ...over,
    };
}

const dot = () => screen.queryByTestId("layout-modified-dot");
const triggerName = () => screen.getByTestId("layout-trigger-name").textContent;

beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    useTradingStore.setState({ indicatorConfig: { ...DEFAULT_INDICATOR_CONFIG } });
    useChartLayoutStore.getState().resetSession();
    useChartLayoutStore.setState({ layouts: [] });
    mocked.listChartLayouts.mockReturnValue(ok({ layouts: [] }));
});

describe("LayoutsMenu", () => {
    it("shows presets and an empty 'my layouts' list; no name, no dot", async () => {
        render(<LayoutsMenu />);
        await waitFor(() => expect(mocked.listChartLayouts).toHaveBeenCalled());
        expect(triggerName()).toBe("LAYOUT");
        expect(dot()).toBeNull();

        await userEvent.click(screen.getByRole("button", { name: "Chart layouts" }));
        for (const n of ["Swing", "Everything", "Clean"]) expect(screen.getByRole("menuitemradio", { name: n })).toBeInTheDocument();
        expect(screen.getByText("No saved layouts yet")).toBeInTheDocument();
        // No saved layout active → only "Save current as…".
        expect(screen.queryByText(/^Update/)).toBeNull();
        expect(screen.queryByText("Delete")).toBeNull();
    });

    it("applies a preset and shows the modified dot after a change", async () => {
        render(<LayoutsMenu />);
        await userEvent.click(screen.getByRole("button", { name: "Chart layouts" }));
        await userEvent.click(screen.getByRole("menuitemradio", { name: "Swing" }));

        expect(triggerName()).toBe("Swing");
        expect(useTradingStore.getState().indicatorConfig.vpvr).toBe(true);
        expect(dot()).toBeNull();

        act(() => useTradingStore.getState().toggleIndicator("macd"));
        expect(dot()).toBeInTheDocument();
        act(() => useTradingStore.getState().toggleIndicator("macd"));
        expect(dot()).toBeNull();
    });

    it("applies the default layout on load and labels it", async () => {
        mocked.listChartLayouts.mockReturnValue(ok({ layouts: [saved({ is_default: true })] }));
        render(<LayoutsMenu />);
        await waitFor(() => expect(triggerName()).toBe("Night"));
        expect(useTradingStore.getState().indicatorConfig.vwap).toBe(true);
        expect(dot()).toBeNull();
    });

    it("save dialog: names the current chart, optionally as default", async () => {
        mocked.createChartLayout.mockImplementation((b) => ok({ layout: saved({ name: b.name, config: b.config, is_default: !!b.isDefault }) }));
        act(() => useTradingStore.getState().toggleIndicator("rsi"));
        render(<LayoutsMenu />);
        await userEvent.click(screen.getByRole("button", { name: "Chart layouts" }));
        await userEvent.click(screen.getByText("Save current as…"));
        await userEvent.type(screen.getByLabelText("Layout name"), "My RSI");
        await userEvent.click(screen.getByLabelText("Set as default"));
        await userEvent.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => expect(triggerName()).toBe("My RSI"));
        const body = mocked.createChartLayout.mock.calls[0]![0];
        expect(body).toMatchObject({ name: "My RSI", isDefault: true });
        expect(body.config.indicators).toEqual({ rsi: true });
        expect(screen.queryByRole("menu")).toBeNull();
    });

    it("save dialog shows the server error and stays open", async () => {
        mocked.createChartLayout.mockImplementation(() =>
            Promise.reject({ response: { data: { message: "You already have a chart layout with this name." } } }) as never,
        );
        render(<LayoutsMenu />);
        await userEvent.click(screen.getByRole("button", { name: "Chart layouts" }));
        await userEvent.click(screen.getByText("Save current as…"));
        await userEvent.type(screen.getByLabelText("Layout name"), "Dup");
        await userEvent.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByRole("alert")).toHaveTextContent("already have a chart layout");
        expect(screen.getByLabelText("Layout name")).toBeInTheDocument();
    });

    it("update clears the dot; delete removes the layout", async () => {
        const l = saved();
        mocked.listChartLayouts.mockReturnValue(ok({ layouts: [l] }));
        mocked.updateChartLayout.mockImplementation((_id, p) => ok({ layout: { ...l, ...(p.config ? { config: p.config } : {}) } }));
        mocked.deleteChartLayout.mockReturnValue(ok(undefined));
        render(<LayoutsMenu />);
        await waitFor(() => expect(mocked.listChartLayouts).toHaveBeenCalled());

        await userEvent.click(screen.getByRole("button", { name: "Chart layouts" }));
        await waitFor(() => expect(screen.getByRole("menuitemradio", { name: "Night" })).toBeInTheDocument());
        await userEvent.click(screen.getByRole("menuitemradio", { name: "Night" }));
        act(() => useTradingStore.getState().toggleIndicator("atr"));
        expect(dot()).toBeInTheDocument();

        await userEvent.click(screen.getByRole("button", { name: "Chart layouts" }));
        await userEvent.click(screen.getByText("Update “Night”"));
        await waitFor(() => expect(dot()).toBeNull());
        expect(mocked.updateChartLayout.mock.calls[0]![1].config!.indicators).toEqual({ vwap: true, atr: true });

        await userEvent.click(screen.getByText("Delete"));
        await userEvent.click(screen.getByRole("button", { name: "Delete" }));
        await waitFor(() => expect(mocked.deleteChartLayout).toHaveBeenCalledWith(l.id));
        expect(triggerName()).toBe("LAYOUT");
        expect(screen.getByText("No saved layouts yet")).toBeInTheDocument();
    });

    it("rename and set-as-default go to the API", async () => {
        const l = saved();
        mocked.listChartLayouts.mockReturnValue(ok({ layouts: [l] }));
        mocked.updateChartLayout.mockImplementation((_id, p) =>
            ok({ layout: { ...l, ...(p.name ? { name: p.name } : {}), ...(p.isDefault !== undefined ? { is_default: p.isDefault } : {}) } }));
        render(<LayoutsMenu />);
        await userEvent.click(screen.getByRole("button", { name: "Chart layouts" }));
        await userEvent.click(await screen.findByRole("menuitemradio", { name: "Night" }));

        await userEvent.click(screen.getByRole("button", { name: "Chart layouts" }));
        await userEvent.click(screen.getByText("Rename"));
        const input = screen.getByLabelText("Layout name");
        await userEvent.clear(input);
        await userEvent.type(input, "Night v2");
        await userEvent.click(screen.getByRole("button", { name: "Rename" }));
        await waitFor(() => expect(triggerName()).toBe("Night v2"));
        expect(mocked.updateChartLayout).toHaveBeenCalledWith(l.id, { name: "Night v2" });

        await userEvent.click(screen.getByText("Set as default"));
        await waitFor(() => expect(mocked.updateChartLayout).toHaveBeenLastCalledWith(l.id, { isDefault: true }));
        expect(await screen.findByText("Unset default")).toBeInTheDocument();
    });
});
