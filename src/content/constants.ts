export const DATE_TOKEN_REGEX = /(\d{4})\/(\d{1,2})\/(\d{1,2})(?:[^\d]+(\d{1,2}):(\d{2}))?/g;
export const PANEL_ID = "meijo-task-hub-panel";
export const AUTO_SYNC_COOLDOWN_MS = 60 * 60 * 1000;
export const LAST_AUTO_SYNC_AT_KEY = "mth-last-auto-sync-at";
export const TASK_INCLUDE_KEYWORDS = ["課題", "提出", "レポート", "演習", "小テスト", "テスト", "quiz", "assignment"];
export const TASK_EXCLUDE_KEYWORDS = ["お知らせ", "連絡", "資料", "教材", "案内", "出席", "時間割", "成績", "アンケート", "掲示"];
