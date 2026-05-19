import { collection, deleteDoc, doc, getDocs, limit, orderBy, query, serverTimestamp, setDoc } from "firebase/firestore";
import { db } from "../firebase";
import type { ExtractedTask } from "./types";

export const getTasksCollection = (uid: string) => collection(db, "users", uid, "tasks");
export const getTaskDoc = (uid: string, taskKey: string) => doc(db, "users", uid, "tasks", taskKey);

export const upsertTask = async (uid: string, task: ExtractedTask) =>
  setDoc(
    getTaskDoc(uid, task.taskKey),
    {
      course: task.course,
      title: task.title,
      endAt: task.endAtRaw,
      endAtMs: task.endAtMs,
      taskUrl: task.taskUrl,
      courseId: task.courseId,
      taskId: task.taskId,
      source: task.source,
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );

export const loadTasksFromDb = async (uid: string, max = 120): Promise<ExtractedTask[]> => {
  const q = query(getTasksCollection(uid), orderBy("updatedAt", "desc"), limit(max));
  const snapshot = await getDocs(q);
  const now = Date.now();
  const toDelete: string[] = [];
  const items: ExtractedTask[] = snapshot.docs.map((row) => {
    const data = row.data();
    return {
      taskKey: row.id,
      course: data.course || "不明な教科",
      title: data.title || "無題課題",
      endAtRaw: data.endAt || "期限なし",
      endAtMs: data.endAtMs,
      taskUrl: data.taskUrl || null,
      courseId: data.courseId || null,
      taskId: data.taskId || null,
      source: data.source === "GoogleClassroom" ? "GoogleClassroom" : "WebClass_AutoSync",
      hidden: data.hidden,
      hiddenUntil: data.hiddenUntil,
      hiddenAt: data.hiddenAt,
    };
  });
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
    await Promise.all(toDelete.map((key) => deleteDoc(getTaskDoc(uid, key))));
  }
  return Array.from(new Map(visible.map((t) => [t.taskKey, t])).values());
};
