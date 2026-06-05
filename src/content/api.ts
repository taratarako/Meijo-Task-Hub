import type { ExtractedTask } from "./types";
import { extensionChrome } from "./runtime";

const API_BASE = "https://9tect2wfh8.execute-api.ap-northeast-1.amazonaws.com/default/meijo-task-hub-api";

type RefreshWaiter = (ok: boolean) => void;
type ApiError = Error & { status?: number };
type HideUpdate = {
  hidden: boolean;
  hiddenUntil: number | null;
  hiddenAt: number;
};

type BgApiRequest = {
  type: "mth-api-request";
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
};

type BgApiResponse = {
  ok: boolean;
  status: number;
  body: string;
};

type FakeResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

let accessToken: string | null = null;
let isRefreshing = false;
let refreshQueue: RefreshWaiter[] = [];

const isAuthError = (error: unknown): error is ApiError =>
  typeof error === "object" && error !== null && (error as ApiError).status === 401;

const awaitRefresh = () =>
  new Promise<void>((resolve, reject) => {
    refreshQueue.push((ok) => {
      if (ok) resolve();
      else reject(new Error("Session expired"));
    });
  });

const notifyRefresh = (ok: boolean) => {
  refreshQueue.forEach((cb) => cb(ok));
  refreshQueue = [];
};

const sendToBackground = (msg: BgApiRequest): Promise<BgApiResponse> =>
  new Promise((resolve, reject) => {
    if (!extensionChrome?.runtime?.sendMessage) {
      reject(new Error("chrome.runtime が利用できません"));
      return;
    }
    extensionChrome.runtime.sendMessage(msg, (response) => {
      const err = extensionChrome?.runtime?.lastError;
      if (err) {
        reject(new Error(err.message || "通信エラー"));
        return;
      }
      resolve(response as BgApiResponse);
    });
  });

const apiFetch = async (path: string, options: RequestInit = {}): Promise<FakeResponse> => {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };
  if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;

  const res = await sendToBackground({
    type: "mth-api-request",
    url: `${API_BASE}${path}`,
    method: (options.method as string) || "GET",
    headers,
    body: (options.body as string) ?? null,
  });

  if (res.status === 401) {
    const err: ApiError = new Error("Unauthorized");
    err.status = 401;
    throw err;
  }

  return {
    ok: res.ok,
    status: res.status,
    json: () => Promise.resolve(JSON.parse(res.body) as unknown),
  };
};

const withRefreshLock = async <T>(apiCall: () => Promise<T>): Promise<T> => {
  try {
    return await apiCall();
  } catch (error) {
    if (!isAuthError(error)) throw error;
    if (isRefreshing) {
      await awaitRefresh();
      return apiCall();
    }
    isRefreshing = true;
    try {
      notifyRefresh(true);
      return await apiCall();
    } catch (refreshError) {
      notifyRefresh(false);
      throw refreshError;
    } finally {
      isRefreshing = false;
    }
  }
};

export const apiLogin = async (googleToken: string): Promise<string> => {
  const res = await sendToBackground({
    type: "mth-api-request",
    url: `${API_BASE}/auth/login`,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ googleToken }),
  });
  if (!res.ok) throw new Error("ログインに失敗しました");
  const data = JSON.parse(res.body) as { ok: boolean; accessToken: string; userId: string };
  accessToken = data.accessToken;
  return data.userId;
};

export const apiGetTasks = async (includeHidden = false): Promise<ExtractedTask[]> =>
  withRefreshLock(async () => {
    const res = await apiFetch(`/tasks?includeHidden=${includeHidden}`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(`getTasks失敗 (HTTP ${res.status}): ${body.error ?? "不明"}`);
    }
    const data = await res.json() as { ok: boolean; tasks: ExtractedTask[] };
    return data.tasks ?? [];
  });

export const apiUpsertTasks = async (tasks: ExtractedTask[]): Promise<void> =>
  withRefreshLock(async () => {
    const res = await apiFetch("/tasks/upsert", {
      method: "POST",
      body: JSON.stringify({ tasks, clientUpdatedAt: Date.now() }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(`upsert失敗 (HTTP ${res.status}): ${body.error ?? "不明"}`);
    }
  });

export const apiHideTask = async (taskKey: string, update: HideUpdate): Promise<void> =>
  withRefreshLock(async () => {
    const res = await apiFetch("/tasks/hidden", {
      method: "PATCH",
      body: JSON.stringify({ taskKey, ...update }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(`hideTask失敗 (HTTP ${res.status}): ${body.error ?? "不明"}`);
    }
  });

export const apiDeleteTask = async (taskKey: string): Promise<void> =>
  withRefreshLock(async () => {
    await apiFetch("/tasks", {
      method: "DELETE",
      body: JSON.stringify({ taskKey }),
    });
  });
