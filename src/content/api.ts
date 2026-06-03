import type { ExtractedTask } from "./types";

type RefreshWaiter = (ok: boolean) => void;

type ApiError = Error & { status?: number };

type HideUpdate = {
  hidden: boolean;
  hiddenUntil: number | null;
  hiddenAt: number;
};

// Mock-only in-memory store. Resets on reload.
let mockDb: ExtractedTask[] = [
  {
    taskKey: "mock_webclass_001",
    course: "サンプル講義",
    title: "モック課題: 初期描画テスト",
    endAtRaw: "期限なし",
    endAtMs: null,
    taskUrl: null,
    courseId: "mock_course",
    taskId: "mock_task",
    source: "WebClass_AutoSync",
    hidden: false,
  },
];

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
      console.log("[Mock API] POST /auth/refresh (cookie)");
      // Placeholder for real refresh call.
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

const sortByDue = (a: ExtractedTask, b: ExtractedTask) => {
  if (a.endAtMs === null && b.endAtMs === null) return a.title.localeCompare(b.title, "ja");
  if (a.endAtMs === null) return 1;
  if (b.endAtMs === null) return -1;
  if (a.endAtMs !== b.endAtMs) return a.endAtMs - b.endAtMs;
  return a.title.localeCompare(b.title, "ja");
};

export const apiGetTasks = async (includeHidden = false): Promise<ExtractedTask[]> =>
  withRefreshLock(async () => {
    console.log(`[Mock API] GET /tasks?includeHidden=${includeHidden}`);
    const filtered = mockDb.filter((task) => includeHidden || !task.hidden);
    return [...filtered].sort(sortByDue);
  });

export const apiUpsertTasks = async (tasks: ExtractedTask[]): Promise<void> =>
  withRefreshLock(async () => {
    console.log("[Mock API] POST /tasks/upsert", tasks);
    tasks.forEach((incoming) => {
      const index = mockDb.findIndex((task) => task.taskKey === incoming.taskKey);
      if (index >= 0) {
        mockDb[index] = { ...mockDb[index], ...incoming };
      } else {
        mockDb.push({ ...incoming, hidden: incoming.hidden ?? false });
      }
    });
  });

export const apiHideTask = async (taskKey: string, update: HideUpdate): Promise<void> =>
  withRefreshLock(async () => {
    console.log("[Mock API] PATCH /tasks/hidden", { taskKey, update });
    const index = mockDb.findIndex((task) => task.taskKey === taskKey);
    if (index >= 0) {
      mockDb[index] = { ...mockDb[index], ...update };
    }
  });

export const apiDeleteTask = async (taskKey: string): Promise<void> =>
  withRefreshLock(async () => {
    console.log("[Mock API] DELETE /tasks", { taskKey });
    mockDb = mockDb.filter((task) => task.taskKey !== taskKey);
  });
