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

// ── Refresh mutex — singleton promise so only ONE refresh runs at a time ──
let refreshPromise: Promise<string | null> | null = null;

export function refreshAccessToken(): Promise<string | null> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = axios
    .post<{ ok: true; accessToken: string }>(
      `${client.defaults.baseURL}/auth/refresh`,
      {},
      { withCredentials: true },
    )
    .then((res) => {
      const token = res.data.accessToken;
      setToken(token);
      return token;
    })
    .catch(() => null)
    .finally(() => {
      refreshPromise = null;
    });
  return refreshPromise;
}

// ── Response interceptor: 401 → refresh → retry ────────────
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
    return Promise.reject(error);
  }

  // If a refresh is already in flight (from init or another 401), queue this request
  if (refreshPromise) {
    return refreshPromise.then((token) => {
      if (!token) {
        clearAuth();
        return Promise.reject(error);
      }
      original.headers.Authorization = `Bearer ${token}`;
      return client(original);
    });
  }

  (original as RetryableConfig)._isRetry = true;

  const token = await refreshAccessToken();
  if (token) {
    processQueue(null, token);
    original.headers.Authorization = `Bearer ${token}`;
    return client(original);
  } else {
    processQueue(error, null);
    clearAuth();
    return Promise.reject(error);
  }
});

export default client;
