import { describe, it, expect } from "vitest";
import { render, screen, act } from "@testing-library/react";
import ToastProvider from "@/components/ToastProvider";

const canceled = (reason: string) => act(() => {
  window.dispatchEvent(new CustomEvent("sse:trigger.canceled", { detail: { reason, triggerId: "t1234567", pairId: "p1" } }));
});

describe("trigger.canceled toasts", () => {
  it("a TP/SL replaced by the user's own new one says nothing", () => {
    render(<ToastProvider><div /></ToastProvider>);
    canceled("replaced");
    expect(screen.queryByText(/canceled/i)).toBeNull();
  });

  it("other reasons still do", () => {
    render(<ToastProvider><div /></ToastProvider>);
    canceled("no_position");
    expect(screen.getByText(/no order placed/i)).toBeTruthy();
  });
});
