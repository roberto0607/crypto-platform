import client from "../client";
import type { ApiKey } from "@/types/api";

export function create(params: {
  label: string;
  scopes: ("read" | "trade" | "admin")[];
  expiresInDays?: number;
}) {
  return client.post<{ ok: true; apiKey: ApiKey; secret: string }>(
    "/api-keys",
    params,
  );
}

export function list() {
  return client.get<{ ok: true; apiKeys: ApiKey[] }>("/api-keys");
}

export function revoke(keyId: string) {
  return client.post<{ ok: true }>(`/api-keys/${keyId}/revoke`);
}
