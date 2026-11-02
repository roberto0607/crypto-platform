/**
 * The trade toolbar's Agent Activity toggle (phone: it replaces the floating
 * button, which covered whatever scrolled under the bottom-right corner).
 * It opens and closes the same panel. The panel's outside-click close must
 * ignore it: otherwise mousedown closes the panel and the click reopens it,
 * so the toolbar button could never close it.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentActivityPanel, AgentActivityToggle } from "@/components/AgentActivityPanel";
import { useAgentActivityStore } from "@/stores/agentActivityStore";

const panelHidden = () =>
  document.querySelector(".agent-activity-fab")!.nextElementSibling!.getAttribute("aria-hidden");

beforeEach(() => {
  useAgentActivityStore.setState({ panelOpen: false, newCount: 0 });
});

describe("AgentActivityToggle", () => {
  it("opens the panel, and a second click closes it", async () => {
    render(<><AgentActivityPanel /><AgentActivityToggle className="tr-tb-agent-btn" /></>);
    const user = userEvent.setup();
    const toggle = document.querySelector(".tr-tb-agent-btn") as HTMLElement;
    await user.click(toggle);
    expect(panelHidden()).toBe("false");
    await user.click(toggle);
    expect(panelHidden()).toBe("true");
  });

  it("a click anywhere else still closes the panel", async () => {
    render(<><AgentActivityPanel /><AgentActivityToggle /><p>elsewhere</p></>);
    const user = userEvent.setup();
    await user.click(screen.getAllByRole("button", { name: "Agent Activity" })[1]!);
    expect(panelHidden()).toBe("false");
    await user.click(screen.getByText("elsewhere"));
    expect(panelHidden()).toBe("true");
  });

  it("shows the unread count", () => {
    useAgentActivityStore.setState({ newCount: 3 });
    render(<AgentActivityToggle className="tr-tb-agent-btn" />);
    expect(document.querySelector(".tr-tb-agent-btn")!.textContent).toContain("3");
  });
});
