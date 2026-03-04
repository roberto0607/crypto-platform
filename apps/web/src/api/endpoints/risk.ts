import client from "../client";
import type { RiskStatus } from "@/types/api";

export function getStatus() {
  return client.get<{ ok: true; risk: RiskStatus }>("/risk/status");
}
