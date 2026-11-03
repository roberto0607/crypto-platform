import client from "../client";
import type { ChartLayoutConfig } from "@/lib/chartLayouts/catalog";

export interface SavedChartLayout {
  id: string;
  name: string;
  /** As stored. May name indicators this build no longer has — read it with resolveConfig. */
  config: ChartLayoutConfig;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export function listChartLayouts() {
  return client.get<{ layouts: SavedChartLayout[] }>("/v1/chart-layouts");
}

export function createChartLayout(body: { name: string; config: ChartLayoutConfig; isDefault?: boolean }) {
  return client.post<{ layout: SavedChartLayout }>("/v1/chart-layouts", body);
}

export function updateChartLayout(
  id: string,
  patch: { name?: string; config?: ChartLayoutConfig; isDefault?: boolean },
) {
  return client.patch<{ layout: SavedChartLayout }>(`/v1/chart-layouts/${id}`, patch);
}

export function deleteChartLayout(id: string) {
  return client.delete(`/v1/chart-layouts/${id}`);
}
