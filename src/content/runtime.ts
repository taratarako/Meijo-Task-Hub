export const extensionChrome = (globalThis as typeof globalThis & {
  chrome?: {
    runtime?: {
      sendMessage: (message: unknown, callback?: (response: unknown) => void) => void;
      lastError?: { message?: string };
    };
    storage?: {
      local?: {
        get: (keys: string[], callback: (items: Record<string, unknown>) => void) => void;
        set: (items: Record<string, unknown>, callback: () => void) => void;
      };
    };
  };
}).chrome;
