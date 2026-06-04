import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { NavIcon } from "@/components/NavIcon";

const KNOWN_KEYS = [
  "trade",
  "arena",
  "replay",
  "cycle",
  "history",
  "profile",
  "settings",
  "admin",
];

describe("NavIcon", () => {
  it.each(KNOWN_KEYS)("renders an <svg> for known key '%s'", (key) => {
    const { container } = render(<NavIcon name={key} />);
    expect(container.querySelector("svg")).toBeInTheDocument();
  });

  it("renders nothing for an unknown key", () => {
    const { container } = render(<NavIcon name="nope" />);
    expect(container.querySelector("svg")).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });
});
