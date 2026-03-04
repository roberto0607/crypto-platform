import client from "../client";
import type {
  LoginResponse,
  RegisterResponse,
  RefreshResponse,
  MeResponse,
} from "@/types/api";

export function register(
  email: string,
  password: string,
  inviteCode?: string,
) {
  return client.post<RegisterResponse>("/auth/register", {
    email,
    password,
    ...(inviteCode ? { inviteCode } : {}),
  });
}

export function login(email: string, password: string) {
  return client.post<LoginResponse>("/auth/login", { email, password });
}

export function refresh() {
  return client.post<RefreshResponse>("/auth/refresh");
}

export function me() {
  return client.get<MeResponse>("/auth/me");
}

export function logout() {
  return client.post<{ ok: true }>("/auth/logout");
}
