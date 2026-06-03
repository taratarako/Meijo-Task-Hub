import { extensionChrome } from "./runtime";

type AuthTokenResponse = {
  ok: boolean;
  token?: string;
  message?: string;
};

let activeUid: string | null = null;
let signInPromise: Promise<string | null> | null = null;

const tokenToUid = (token: string): string => `google_${token.slice(0, 12)}`;

const requestAuthToken = (interactive: boolean): Promise<string> =>
  new Promise((resolve, reject) => {
    if (!extensionChrome?.runtime?.sendMessage) {
      reject(new Error("chrome.runtime が利用できません"));
      return;
    }
    extensionChrome.runtime.sendMessage(
      { type: "mth-get-auth-token", interactive },
      (response) => {
        const res = response as AuthTokenResponse | undefined;
        if (res?.ok && res.token) {
          resolve(res.token);
          return;
        }
        reject(new Error(res?.message || "認証トークン取得に失敗しました"));
      },
    );
  });

export const ensureSignedIn = async (interactive: boolean): Promise<string | null> => {
  if (activeUid) return activeUid;
  if (signInPromise) return signInPromise;
  signInPromise = (async () => {
    try {
      const token = await requestAuthToken(interactive);
      activeUid = tokenToUid(token);
      return activeUid;
    } catch (error) {
      console.error("❌ 認証に失敗:", error);
      return null;
    } finally {
      signInPromise = null;
    }
  })();
  return signInPromise;
};
