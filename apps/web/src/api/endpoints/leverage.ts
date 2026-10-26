import client from "../client";
import type { LeverageInfo, UUID } from "@/types/api";

/** What the user's next order on `pairId` may use: model + cap, decided by the server. */
export function getLeverageInfo(pairId: UUID) {
  return client.get<LeverageInfo>("/leverage", { params: { pairId } });
}
