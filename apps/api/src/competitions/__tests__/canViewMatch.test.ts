import { describe, it, expect } from "vitest";
import { canViewMatch } from "../matchService";

const CHALLENGER = "11111111-1111-1111-1111-111111111111";
const OPPONENT = "22222222-2222-2222-2222-222222222222";
const OUTSIDER = "33333333-3333-3333-3333-333333333333";

describe("canViewMatch", () => {
  it("grants participant to the challenger regardless of status", () => {
    for (const status of ["PENDING", "ACTIVE", "COMPLETED", "FORFEITED", "CANCELLED"] as const) {
      expect(canViewMatch({ challenger_id: CHALLENGER, opponent_id: OPPONENT, status }, CHALLENGER))
        .toBe("participant");
    }
  });

  it("grants participant to the opponent regardless of status", () => {
    expect(canViewMatch({ challenger_id: CHALLENGER, opponent_id: OPPONENT, status: "COMPLETED" }, OPPONENT))
      .toBe("participant");
  });

  it("grants a non-participant spectator access only while ACTIVE", () => {
    expect(canViewMatch({ challenger_id: CHALLENGER, opponent_id: OPPONENT, status: "ACTIVE" }, OUTSIDER))
      .toBe("spectator");
  });

  it("denies a non-participant for PENDING, COMPLETED, FORFEITED, CANCELLED", () => {
    for (const status of ["PENDING", "COMPLETED", "FORFEITED", "CANCELLED"] as const) {
      expect(canViewMatch({ challenger_id: CHALLENGER, opponent_id: OPPONENT, status }, OUTSIDER))
        .toBe("none");
    }
  });
});
