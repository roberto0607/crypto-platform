import axios, { AxiosError, InternalAxiosRequestConfig } from "axios";

interface RetryableConfig extends InternalAxiosRequestConfig {
  _isRetry?: boolean;
}

const client = axios.create({
  baseURL: import.meta.env.VITE_API_BASE ?? "/api",
  withCredentials: true,
});

// ── Token access (lazily bound to avoid circular imports) ───
let getToken: () => string | null = () => null;
let setToken: (token: string) => void = () => {};
let clearAuth: () => void = () => {};

// ── Competition context ──────────────────────────────────────
let activeCompetitionId: string | null = null;

export function setActiveCompetitionId(id: string | null): void {
  activeCompetitionId = id;
}

export function getActiveCompetitionId(): string | null {
  return activeCompetitionId;
}

export function bindAuthStore(fns: {
  getToken: () => string | null;
  setToken: (token: string) => void;
  clearAuth: () => void;
}) {
  getToken = fns.getToken;
  setToken = fns.setToken;
  clearAuth = fns.clearAuth;
}

// ── Request interceptor: attach Bearer token ────────────────
client.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const token = getToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }

  // Competition scoping
  if (activeCompetitionId) {
    config.headers["X-Competition-Id"] = activeCompetitionId;
  } else {
    delete config.headers["X-Competition-Id"];
  }

  return config;
});

// ── Response interceptor: 401 → refresh → retry ────────────
let isRefreshing = false;
let pendingQueue: Array<{
  resolve: (token: string) => void;
  reject: (err: unknown) => void;
}> = [];

function processQueue(error: unknown, token: string | null) {
  for (const p of pendingQueue) {
    if (token) {
      p.resolve(token);
    } else {
      p.reject(error);
    }
  }
  pendingQueue = [];
}

client.interceptors.response.use(undefined, async (error: AxiosError) => {
  const original = error.config;
  if (!original || error.response?.status !== 401) {
    return Promise.reject(error);
  }

  // Don't retry the refresh call itself
  if ((original as RetryableConfig)._isRetry) {
    clearAuth();
    window.location.href = "/login";
    return Promise.reject(error);
  }

  if (isRefreshing) {
    // Queue concurrent 401s while a refresh is in flight
    return new Promise<string>((resolve, reject) => {
      pendingQueue.push({ resolve, reject });
    }).then((token) => {
      original.headers.Authorization = `Bearer ${token}`;
      return client(original);
    });
  }

  isRefreshing = true;
  (original as RetryableConfig)._isRetry = true;

  try {
    const res = await axios.post<{ ok: true; accessToken: string }>(
      `${client.defaults.baseURL}/auth/refresh`,
      {},
      { withCredentials: true },
    );
    const newToken = res.data.accessToken;
    setToken(newToken);
    processQueue(null, newToken);
    original.headers.Authorization = `Bearer ${newToken}`;
    return client(original);
  } catch (refreshError) {
    processQueue(refreshError, null);
    clearAuth();
    window.location.href = "/login";
    return Promise.reject(refreshError);
  } finally {
    isRefreshing = false;
  }
});

export default client;
