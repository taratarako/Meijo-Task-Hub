import { extensionChrome } from "./runtime";

export const readStorageNumber = async (key: string): Promise<number | null> => {
  const storageLocal = extensionChrome?.storage?.local;
  if (storageLocal) {
    const value = await new Promise<number | null>((resolve) => {
      storageLocal.get([key], (items) => {
        const raw = items[key];
        resolve(typeof raw === "number" ? raw : null);
      });
    });
    if (value !== null) return value;
  }
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

export const writeStorageNumber = async (key: string, value: number): Promise<void> => {
  const storageLocal = extensionChrome?.storage?.local;
  if (storageLocal) {
    await new Promise<void>((resolve) => {
      storageLocal.set({ [key]: value }, () => resolve());
    });
    return;
  }
  try {
    localStorage.setItem(key, String(value));
  } catch {
    void 0;
  }
};
