import client from "../client";
import type { SimulationConfig, SimQuote, UUID, OrderSide, DecimalString } from "@/types/api";

export function getConfig() {
  return client.get<{ ok: true; config: SimulationConfig }>("/sim/config");
}

export function updateConfig(config: Partial<SimulationConfig>) {
  return client.put<{ ok: true; config: SimulationConfig }>("/sim/config", config);
}

export function getQuote(params: {
  pairId: UUID;
  side: OrderSide;
  qty: DecimalString;
}) {
  return client.post<{ ok: true; quote: SimQuote }>("/sim/quote", params);
}
