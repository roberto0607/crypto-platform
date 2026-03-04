import client from "../client";
import type { SystemStatus, UserStatus } from "@/types/api";

export function getSystemStatus() {
  return client.get<SystemStatus>("/status/system");
}

export function getUserStatus() {
  return client.get<UserStatus>("/status/user");
}
