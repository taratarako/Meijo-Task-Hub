import type { ExtractedTask } from "./types";
import { apiDeleteTask, apiGetTasks, apiHideTask, apiUpsertTasks } from "./api";

export const upsertTask = async (_uid: string, task: ExtractedTask) => {
  await apiUpsertTasks([task]);
};

export const loadTasksFromDb = async (_uid: string, max = 120): Promise<ExtractedTask[]> => {
  const tasks = await apiGetTasks(true);
  const now = Date.now();
  const toDelete: string[] = [];
  const items = tasks.slice(0, max);
  const visible = items.filter((task) => {
    if (typeof task.endAtMs === "number" && task.endAtMs < now) {
      toDelete.push(task.taskKey);
      return false;
    }
    if (task.hidden) {
      if (typeof task.hiddenUntil === "number" && task.hiddenUntil <= now) {
        toDelete.push(task.taskKey);
      }
      return false;
    }
    return true;
  });
  if (toDelete.length > 0) {
    await Promise.all(toDelete.map((key) => apiDeleteTask(key)));
  }
  return Array.from(new Map(visible.map((task) => [task.taskKey, task])).values());
};

export const hideTask = async (
  _uid: string,
  taskKey: string,
  hidden: boolean,
  hiddenUntil: number | null,
  hiddenAt: number,
) => {
  await apiHideTask(taskKey, { hidden, hiddenUntil, hiddenAt });
};

export const deleteTask = async (_uid: string, taskKey: string) => {
  await apiDeleteTask(taskKey);
};
