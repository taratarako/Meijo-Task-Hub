import { db } from "./firebase";
import { collection, deleteDoc, doc, getDocs, limit, orderBy, query, serverTimestamp, setDoc } from "firebase/firestore";

type ExtractedTask = {
  taskKey: string;
  course: string;
  title: string;
  endAtRaw: string;
  endAtMs: number | null;
  taskUrl: string | null;
  courseId: string | null;
  taskId: string | null;
  source: "WebClass_AutoSync" | "GoogleClassroom";
  hidden?: boolean;
  hiddenUntil?: number | null;
  hiddenAt?: number | null;
};

const DATE_TOKEN_REGEX = /(\d{4})\/(\d{1,2})\/(\d{1,2})(?:[^\d]+(\d{1,2}):(\d{2}))?/g;
const PANEL_ID = "meijo-task-hub-panel";
const AUTO_SYNC_COOLDOWN_MS = 60 * 60 * 1000;
const LAST_AUTO_SYNC_AT_KEY = "mth-last-auto-sync-at";
const TASK_INCLUDE_KEYWORDS = ["課題", "提出", "レポート", "演習", "小テスト", "テスト", "quiz", "assignment"];
const TASK_EXCLUDE_KEYWORDS = ["お知らせ", "連絡", "資料", "教材", "案内", "出席", "時間割", "成績", "アンケート", "掲示"];

let syncing = false;
let lastTasks: ExtractedTask[] = [];
let routeWatcherStarted = false;
let lastObservedHref = location.href;
let wasOnTimetablePage = false;

const extensionChrome = (globalThis as typeof globalThis & {
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

const readStorageNumber = async (key: string): Promise<number | null> => {
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

const writeStorageNumber = async (key: string, value: number): Promise<void> => {
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
    // no-op
    void 0;
  }
};

const formatRemainLabel = (ms: number): string => {
  const remainMinutes = Math.max(1, Math.ceil(ms / (60 * 1000)));
  return `${remainMinutes}分後に自動同期可能`;
};

const isTargetTimetablePage = (): boolean => {
  if (!location.href.includes("/webclass/")) return false;

  const path = location.pathname.toLowerCase();
  const search = location.search.toLowerCase();
  const href = location.href.toLowerCase();

  // 典型的な時間割URL
  if (path.includes("/main/timetable")) return true;
  if (search.includes("timetable")) return true;
  if (href.includes("/main/timetable")) return true;

  // 時間割見出し/パンくずのDOM判定
  const headingText =
    document.querySelector("h1")?.textContent ||
    document.querySelector("h2")?.textContent ||
    document.querySelector(".cl-pageTitle")?.textContent ||
    "";
  if (headingText.includes("時間割")) return true;

  const breadcrumbText = document.querySelector(".breadcrumb")?.textContent || "";
  if (breadcrumbText.includes("時間割")) return true;

  // URLが取りづらい環境向け: 科目リンクが複数あれば時間割トップ相当とみなす。
  const courseLinkCount = document.querySelectorAll("a[href*='course.php']").length;
  if (courseLinkCount >= 3) return true;

  return false;
};

const normalizeKey = (value: string): string =>
  value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[\\/\s]+/g, "_")
    .replace(/_+/g, "_")
    .trim();

// 先頭の5桁授業コードを抽出（存在すればキーに利用）
const extractCourseCode = (value: string): string | null => {
  if (!value) return null;
  const m = value.match(/\b(\d{5})\b/);
  return m ? m[1] : null;
};

const normalizeSpaces = (s: string) => s.replace(/\u3000/g, " ").replace(/\s+/g, " ").trim();

// タイトルやキー用に不要な注釈（締切が近い・期限切れ・矢印など）を除去
const sanitizeForKey = (value: string): string => {
  if (!value) return value;
  let v = normalizeSpaces(value);

  const noisePatterns = [
    "締切が近い課題があります",
    "締切が近い",
    "提出期限が近い",
    "締切間近",
    "期限切れ",
    "期限切れです",
  ];
  for (const p of noisePatterns) {
    const re = new RegExp(`[（(\\[]?\\s*${p}\\s*[）)\\]]?\\.?`, "gi");
    v = v.replace(re, "");
  }

  v = v.replace(/^[»»>\-\u2022\s]+/, "");
  v = v.replace(/\s+/g, " ").trim();
  return v;
};

const parseDatePartsToMs = (parts: RegExpMatchArray): number | null => {
  const [, y, m, d, hh = "23", mm = "59"] = parts;
  const asDate = new Date(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), 0, 0);
  if (Number.isNaN(asDate.getTime())) return null;
  return asDate.getTime();
};

const extractDueInfo = (text: string): { raw: string; ms: number | null } => {
  const normalized = text.replace(/\s+/g, " ");
  const matches = Array.from(normalized.matchAll(DATE_TOKEN_REGEX));
  if (matches.length === 0) return { raw: "期限なし", ms: null };

  const withMs = matches
    .map((m) => ({ match: m, ms: parseDatePartsToMs(m) }))
    .filter((item) => item.ms !== null) as Array<{ match: RegExpMatchArray; ms: number }>;

  if (withMs.length === 0) return { raw: matches[matches.length - 1][0], ms: null };

  const dueHintLabels = ["締切", "提出期限", "期限", "終了", "〆切"];
  const hintIndex = dueHintLabels
    .map((label) => normalized.lastIndexOf(label))
    .filter((index) => index >= 0)
    .sort((a, b) => b - a)[0];

  if (hintIndex !== undefined) {
    const afterHint = withMs.filter((item) => (item.match.index ?? 0) >= hintIndex);
    if (afterHint.length > 0) {
      const latestAfterHint = afterHint.reduce((prev, cur) => (cur.ms > prev.ms ? cur : prev));
      return { raw: latestAfterHint.match[0], ms: latestAfterHint.ms };
    }
  }

  const latest = withMs.reduce((prev, cur) => (cur.ms > prev.ms ? cur : prev));
  return { raw: latest.match[0], ms: latest.ms };
};

const extractQueryParam = (url: string, key: string): string | null => {
  try {
    const parsed = new URL(url, location.origin);
    return parsed.searchParams.get(key);
  } catch {
    return null;
  }
};

const resolveTitle = (element: Element): string => {
  const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();
  const stripNewPrefix = (value: string): string => value.replace(/^new\s*/i, "").replace(/^【?new】?\s*/i, "").trim();
  const isNoise = (value: string): boolean => {
    if (!value) return true;
    const v = value.trim();
    if (/^(new|詳細|利用回数|教材|タイムライン|お知らせ|試験|利用可能期間|期限|締切)$/i.test(v)) return true;
    if (/^(\d+|\d+件)$/i.test(v)) return true;
    if (/(締切が近い|提出期限が近い|締切間近|期限切れ|期限切れです|期限切れの課題)/i.test(v)) return true;
    return false;
  };

  const scoreTitle = (value: string): number => {
    let score = 0;
    if (/[課題演習レポート提出テストquiz]/i.test(value)) score += 30;
    if (/第\d+回/.test(value)) score += 15;
    if (value.length >= 6) score += 10;
    if (value.length >= 12) score += 8;
    if (/詳細|利用回数|利用可能期間/.test(value)) score -= 40;
    return score;
  };

  const candidates: string[] = [];
  const anchors = Array.from(element.querySelectorAll("a"));
  for (const anchor of anchors) {
    const clean = stripNewPrefix(normalize(anchor.textContent || ""));
    if (!isNoise(clean)) candidates.push(clean);
  }

  const headingCandidates = [
    element.querySelector("h1")?.textContent,
    element.querySelector("h2")?.textContent,
    element.querySelector("h3")?.textContent,
    element.querySelector("h4")?.textContent,
    element.querySelector("strong")?.textContent,
  ];
  for (const candidate of headingCandidates) {
    const clean = stripNewPrefix(normalize(candidate || ""));
    if (!isNoise(clean)) candidates.push(clean);
  }

  const rawText = element.textContent || "";
  const lines = rawText
    .split("\n")
    .map((line) => stripNewPrefix(normalize(line)))
    .filter(Boolean)
    .filter((line) => !/^(New|詳細|利用可能期間|期限|締切|利用回数|教材|タイムライン|お知らせ|試験)$/.test(line));
  candidates.push(...lines);

  const uniqueCandidates = Array.from(new Set(candidates)).filter((c) => !isNoise(c));
  if (uniqueCandidates.length === 0) return "無題課題";

  uniqueCandidates.sort((a, b) => scoreTitle(b) - scoreTitle(a) || b.length - a.length);
  return uniqueCandidates[0];
};
const renderTasks = (tasks: ExtractedTask[]) => {
  const panel = ensurePanel();
  const listEl = panel.querySelector<HTMLElement>("#mth-list");
  if (!listEl) return;

  const now = Date.now();
  const visibleTasks = tasks.filter((task) => {
    if (task.hidden) return false;
    if (typeof task.endAtMs === "number" && task.endAtMs < now) return false;
    return true;
  });

  const sorted = visibleTasks
    .sort((a, b) => {
      if (a.endAtMs === null && b.endAtMs === null) return 0;
      if (a.endAtMs === null) return 1;
      if (b.endAtMs === null) return -1;
      return a.endAtMs - b.endAtMs;
    });

  if (sorted.length === 0) {
    listEl.innerHTML = '<div style="background:#0f3568;border:1px solid rgba(255,255,255,0.12);border-radius:10px;padding:12px;font-size:13px;">表示できる課題がありません</div>';
    updateCount(0);
    return;
  }

  const renderSection = (title: string, items: ExtractedTask[], accent: string) => {
    if (items.length === 0) return "";
    const cards = items
      .map(
        (task) => `
        <article style="background:#0f3568;border:1px solid rgba(255,255,255,0.14);border-left:4px solid ${accent};border-radius:10px;padding:10px 10px 9px;margin-bottom:8px;position:relative;">
          <button class="mth-delete-btn" data-task-key="${task.taskKey}" style="position:absolute;top:8px;right:8px;border:none;border-radius:10px;padding:2px 8px;background:rgba(255,255,255,0.12);color:#f5f7fa;font-size:11px;cursor:pointer;">削除</button>
          <div style="font-size:12px;opacity:0.92;margin-bottom:6px;">${task.course}</div>
          <div style="font-size:16px;line-height:1.35;font-weight:700;margin-bottom:8px;">${task.title}</div>
          <div style="font-size:13px;">締切: <strong>${formatDueLabel(task)}</strong>${isOverdue(task) ? ' <span style="margin-left:6px;color:#ffb3a8;">(期限切れ)</span>' : ""}</div>
        </article>
      `,
      )
      .join("");
    return `
      <div style="margin-bottom:12px;">
        <div style="font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:#b7c9e2;margin-bottom:6px;">${title}</div>
        ${cards}
      </div>
    `;
  };

  const webclassTasks = sorted.filter((task) => task.source === "WebClass_AutoSync");
  const googleTasks = sorted.filter((task) => task.source === "GoogleClassroom");

  const html =
    renderSection("WebClass", webclassTasks, "#ffd44d") +
    renderSection("Google Classroom", googleTasks, "#6fe0b1");

  listEl.innerHTML = html;
  updateCount(sorted.length);

  const deleteButtons = listEl.querySelectorAll<HTMLButtonElement>(".mth-delete-btn");
  deleteButtons.forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      const key = button.dataset.taskKey;
      if (!key) return;
      const target = tasks.find((t) => t.taskKey === key);
      if (!target) return;
      await handleDeleteTask(target);
    });
  });
};

const handleDeleteTask = async (task: ExtractedTask) => {
  const now = Date.now();
  try {
    if (typeof task.endAtMs === "number" && task.endAtMs < now) {
      await deleteDoc(doc(db, "tasks", task.taskKey));
    } else if (typeof task.endAtMs === "number") {
      await setDoc(
        doc(db, "tasks", task.taskKey),
        { hidden: true, hiddenUntil: task.endAtMs, hiddenAt: now },
        { merge: true },
      );
    } else {
      await setDoc(
        doc(db, "tasks", task.taskKey),
        { hidden: true, hiddenUntil: null, hiddenAt: now },
        { merge: true },
      );
    }
  } catch (error) {
    console.error("❌ 削除処理に失敗:", error);
  }

  lastTasks = lastTasks.filter((t) => t.taskKey !== task.taskKey);
  renderTasks(lastTasks);
};


const isLikelyTaskItem = (element: Element): boolean => {
  const text = (element.textContent || "").replace(/\s+/g, " ").toLowerCase();
  const anchorHref = (element.querySelector("a[href]") as HTMLAnchorElement | null)?.href.toLowerCase() || "";
  const targetText = `${text} ${anchorHref}`;

  if (!targetText.trim()) return false;

  if (TASK_EXCLUDE_KEYWORDS.some((keyword) => targetText.includes(keyword.toLowerCase()))) {
    return false;
  }

  // If there's an explicit task keyword, accept immediately
  if (TASK_INCLUDE_KEYWORDS.some((keyword) => targetText.includes(keyword.toLowerCase()))) {
    return true;
  }

  // If there's an anchor link with an id/content, consider it a task
  if (anchorHref && (anchorHref.includes("content_id=") || anchorHref.includes("id="))) {
    return true;
  }

  // Otherwise, avoid treating standalone short notices (e.g. "締切が近い課題があります。") as tasks.
  // Use resolveTitle to see if a meaningful title can be extracted.
  try {
    const title = resolveTitle(element) || "";
    if (title && title !== "無題課題" && title.trim().length >= 3) {
      // title looks meaningful; accept if there's also a date/締切 mention or a keyword
      if (/(締切|提出期限|期限|due)/i.test(targetText) || TASK_INCLUDE_KEYWORDS.some((k) => targetText.includes(k.toLowerCase()))) {
        return true;
      }
    }
  } catch {
    // fallthrough
    void 0;
  }

  return false;
};

const formatDueLabel = (task: ExtractedTask): string => {
  if (!task.endAtMs) return "期限なし";
  const due = new Date(task.endAtMs);
  return `${due.getFullYear()}/${String(due.getMonth() + 1).padStart(2, "0")}/${String(due.getDate()).padStart(2, "0")} ${String(due.getHours()).padStart(2, "0")}:${String(due.getMinutes()).padStart(2, "0")}`;
};

const isOverdue = (task: ExtractedTask): boolean => {
  if (!task.endAtMs) return false;
  return task.endAtMs < Date.now();
};

const ensurePanel = () => {
  let panel = document.getElementById(PANEL_ID);
  if (panel) return panel;

  panel = document.createElement("section");
  panel.id = PANEL_ID;
  panel.style.position = "fixed";
  panel.style.top = "84px";
  panel.style.left = "16px";
  panel.style.width = "360px";
  panel.style.maxHeight = "80vh";
  panel.style.overflow = "hidden";
  panel.style.zIndex = "2147483647";
  panel.style.borderRadius = "12px";
  panel.style.boxShadow = "0 10px 30px rgba(0,0,0,0.28)";
  panel.style.background = "#06254d";
  panel.style.color = "#f5f7fa";
  panel.style.fontFamily = "'Segoe UI', sans-serif";
  panel.innerHTML = `
    <div class="mth-header" style="padding:12px 14px;padding-right:56px;border-bottom:1px solid rgba(255,255,255,0.15);display:flex;align-items:center;justify-content:space-between;gap:8px;cursor:grab;">
      <div style="display:flex;flex-direction:column;min-width:0;flex:1;">
        <div style="font-weight:700;font-size:20px;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">統一タスクダッシュボード</div>
        <div id="mth-status" style="font-size:12px;opacity:0.9;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">初期化中...</div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;">
          <button id="mth-sync-btn" style="cursor:pointer;border:none;border-radius:8px;padding:8px 10px;background:#ffd44d;color:#3a2b00;font-weight:700;margin-right:8px;">再同期</button>
        </div>
    </div>
    <div id="mth-count-container" style="padding:10px 14px;border-bottom:1px solid rgba(255,255,255,0.15);font-size:13px;">
      取得件数: <span id="mth-count" style="font-weight:700;">0</span>
    </div>
    <div id="mth-list" style="padding:10px 12px;overflow:auto;max-height:56vh;"></div>
  `;

  document.body.appendChild(panel);

  const syncButton = panel.querySelector<HTMLButtonElement>("#mth-sync-btn");
  syncButton?.addEventListener("click", () => {
    void startAutoSync(true);
  });

  // 最小化トグルと位置保持
  // ミニマイズボタンはパネル右上に浮かせる（クリックしやすく、ヘッダーのボタン群と離す）
  let toggleBtn = panel.querySelector<HTMLButtonElement>("#mth-toggle-minimize-btn");
  if (!toggleBtn) {
    toggleBtn = document.createElement("button");
    toggleBtn.id = "mth-toggle-minimize-btn";
    toggleBtn.setAttribute("aria-label", "最小化");
    toggleBtn.style.position = "absolute";
    toggleBtn.style.top = "8px";
    toggleBtn.style.right = "12px";
    toggleBtn.style.width = "34px";
    toggleBtn.style.height = "34px";
    toggleBtn.style.borderRadius = "18px";
    toggleBtn.style.border = "none";
    toggleBtn.style.background = "rgba(0,0,0,0.15)";
    toggleBtn.style.color = "#f5f7fa";
    toggleBtn.style.fontWeight = "700";
    toggleBtn.style.cursor = "pointer";
    toggleBtn.style.display = "flex";
    toggleBtn.style.alignItems = "center";
    toggleBtn.style.justifyContent = "center";
    toggleBtn.style.boxShadow = "0 4px 10px rgba(0,0,0,0.25)";
    toggleBtn.textContent = "—";
    panel.appendChild(toggleBtn);
  }
  const countContainer = panel.querySelector<HTMLElement>("#mth-count-container");
  const listEl = panel.querySelector<HTMLElement>("#mth-list");

  const applyMinimized = (min: boolean) => {
    try {
      if (min) {
        if (countContainer) countContainer.style.display = "none";
        if (listEl) listEl.style.display = "none";
        panel.style.maxHeight = "48px";
        if (toggleBtn) toggleBtn.textContent = "▢";
        if (syncButton) syncButton.style.display = "none";
      } else {
        if (countContainer) countContainer.style.display = "";
        if (listEl) listEl.style.display = "";
        panel.style.maxHeight = "80vh";
        if (toggleBtn) toggleBtn.textContent = "—";
        if (syncButton) syncButton.style.display = "";
      }
      localStorage.setItem("mth-panel-minimized", min ? "1" : "0");
    } catch {
      // ignore
      void 0;
    }
  };

  try {
    const saved = localStorage.getItem("mth-panel-minimized");
    applyMinimized(saved === "1");
  } catch {
    void 0;
  }

  toggleBtn?.addEventListener("click", () => {
    try {
      const cur = localStorage.getItem("mth-panel-minimized") === "1";
      applyMinimized(!cur);
    } catch {
      applyMinimized(true);
    }
  });

  // ドラッグで移動（ヘッダーを掴んで移動）。ボタン上はドラッグしない。
  const headerEl = panel.querySelector<HTMLElement>(".mth-header");
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let origLeft = 0;
  let origTop = 0;

  const savePos = () => {
    try {
      // 保存は左右どちらにドッキングしているかを優先して保存
      const side = localStorage.getItem("mth-panel-side");
      if (side === "right") {
        localStorage.setItem("mth-panel-side", "right");
      } else if (panel.style.left) {
        localStorage.setItem("mth-panel-left", panel.style.left);
        localStorage.removeItem("mth-panel-side");
      }
      localStorage.setItem("mth-panel-top", panel.style.top || "84px");
    } catch {
      void 0;
    }
  };

  try {
    // デフォルトは右端に配置する（画面の主要コンテンツと重なりにくい）
    const savedSide = localStorage.getItem("mth-panel-side");
    const savedLeft = localStorage.getItem("mth-panel-left");
    const savedTop = localStorage.getItem("mth-panel-top");
    if (savedTop) panel.style.top = savedTop;
    if (savedSide === "right") {
      panel.style.right = "16px";
      panel.style.left = "";
    } else if (savedLeft) {
      panel.style.left = savedLeft;
      panel.style.right = "";
    } else {
      // 保存がない場合は右端に配置
      panel.style.right = "16px";
    }
  } catch {
    void 0;
  }

  headerEl?.addEventListener("pointerdown", (ev) => {
    const target = ev.target as HTMLElement;
    if (target.closest("button")) return;
    dragging = true;
    headerEl.setPointerCapture?.(ev.pointerId);
    startX = ev.clientX;
    startY = ev.clientY;
    // ドッキングが右側になっている場合は一時的に解除してフリードラッグにする
    if (panel.style.right) {
      // compute numeric left from current right position
      const computedRight = parseInt(panel.style.right.replace("px", "")) || 16;
      const leftFromRight = Math.max(0, window.innerWidth - (panel.offsetWidth + computedRight));
      panel.style.left = `${leftFromRight}px`;
      panel.style.right = "";
      // store that we left dock state until drop
      localStorage.removeItem("mth-panel-side");
    }
    origLeft = parseInt(panel.style.left || "16", 10);
    origTop = parseInt(panel.style.top || "84", 10);
    panel.style.cursor = "grabbing";
    ev.preventDefault();
  });

  headerEl?.addEventListener("pointermove", (ev) => {
    if (!dragging) return;
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    const newLeft = Math.max(0, origLeft + dx);
    const newTop = Math.max(0, origTop + dy);
    panel.style.left = `${newLeft}px`;
    panel.style.top = `${newTop}px`;
  });

  const stopDrag = (ev?: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    panel.style.cursor = "default";
    try {
      headerEl?.releasePointerCapture?.(ev?.pointerId ?? 0);
    } catch {
      void 0;
    }
    // スナップ: 画面右端に近ければ右ドック、左端に近ければ左にスナップ
    try {
      const rect = panel.getBoundingClientRect();
      const distanceToRight = window.innerWidth - (rect.left + rect.width);
      const distanceToLeft = rect.left;
      const snapThreshold = 120; // px
      if (distanceToRight <= snapThreshold) {
        panel.style.right = "16px";
        panel.style.left = "";
        localStorage.setItem("mth-panel-side", "right");
      } else if (distanceToLeft <= snapThreshold) {
        panel.style.left = "16px";
        panel.style.right = "";
        localStorage.removeItem("mth-panel-side");
      } else {
        // フリー位置として保存
        localStorage.removeItem("mth-panel-side");
        localStorage.setItem("mth-panel-left", panel.style.left || "16px");
      }
    } catch {
      void 0;
    }
    savePos();
  };

  headerEl?.addEventListener("pointerup", stopDrag);
  headerEl?.addEventListener("pointercancel", stopDrag);

  return panel;
};

const updateStatus = (message: string) => {
  const panel = ensurePanel();
  const statusEl = panel.querySelector<HTMLElement>("#mth-status");
  if (statusEl) statusEl.textContent = message;
};

const updateCount = (count: number) => {
  const panel = ensurePanel();
  const countEl = panel.querySelector<HTMLElement>("#mth-count");
  if (countEl) countEl.textContent = String(count);
};

const upsertTask = async (task: ExtractedTask) => {
  await setDoc(
    doc(db, "tasks", task.taskKey),
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
};

const loadTasksFromDb = async (max = 120): Promise<ExtractedTask[]> => {
  const q = query(collection(db, "tasks"), orderBy("updatedAt", "desc"), limit(max));
  const snapshot = await getDocs(q);
  const now = Date.now();
  const toDelete: string[] = [];

  const items: ExtractedTask[] = snapshot.docs.map((row) => {
    const data = row.data() as Record<string, unknown>;
    const endAtMs = typeof data.endAtMs === "number" ? data.endAtMs : null;
    const hidden = typeof data.hidden === "boolean" ? data.hidden : false;
    const hiddenUntil = typeof data.hiddenUntil === "number" ? data.hiddenUntil : null;
    const hiddenAt = typeof data.hiddenAt === "number" ? data.hiddenAt : null;

    const source = data.source === "GoogleClassroom" ? "GoogleClassroom" : "WebClass_AutoSync";
    return {
      taskKey: row.id,
      course: typeof data.course === "string" ? data.course : "不明な教科",
      title: typeof data.title === "string" ? data.title : "無題課題",
      endAtRaw: typeof data.endAt === "string" ? data.endAt : "期限なし",
      endAtMs,
      taskUrl: typeof data.taskUrl === "string" ? data.taskUrl : null,
      courseId: typeof data.courseId === "string" ? data.courseId : null,
      taskId: typeof data.taskId === "string" ? data.taskId : null,
      source,
      hidden,
      hiddenUntil,
      hiddenAt,
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
    await Promise.all(toDelete.map((key) => deleteDoc(doc(db, "tasks", key))));
  }

  const deduped = new Map<string, ExtractedTask>();
  for (const task of visible) {
    if (!deduped.has(task.taskKey)) deduped.set(task.taskKey, task);
  }
  return Array.from(deduped.values());
};

const refreshTasksFromDb = async (label: string) => {
  try {
    const dbTasks = await loadTasksFromDb();
    if (dbTasks.length > 0) {
      lastTasks = dbTasks;
      renderTasks(lastTasks);
      updateStatus(label);
    }
  } catch (error) {
    console.error("❌ DB読込失敗:", error);
  }
};

const extractCourseTasks = (
  courseUrl: string,
  courseName: string,
  index: number,
  total: number,
): Promise<ExtractedTask[]> =>
  new Promise((resolve) => {
    const iframe = document.createElement("iframe");
    iframe.style.display = "none";
    iframe.src = courseUrl;
    document.body.appendChild(iframe);

    console.log(`[${index}/${total}] ${courseName} をチェック中...`);

    let attempts = 0;
    let stableTicks = 0;
    let lastCount = -1;
    const timeout = setTimeout(() => {
      clearInterval(checkInterval);
      if (document.body.contains(iframe)) document.body.removeChild(iframe);
      console.warn(`⚠️ [${courseName}] タイムアウトのためスキップしました`);
      resolve([]);
    }, 20000);

    const checkInterval = setInterval(() => {
      attempts += 1;
      const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
      if (!iframeDoc) return;

      const elements = iframeDoc.querySelectorAll(".cl-contentsList_content");

      if (elements.length !== lastCount) {
        lastCount = elements.length;
        stableTicks = 0;
      } else {
        stableTicks += 1;
      }

      // 要素数が一定時間変化しないか、十分待ったら確定する
      if (attempts <= 40 && !(elements.length > 0 && stableTicks >= 3)) return;

      clearInterval(checkInterval);
      clearTimeout(timeout);

      const filteredElements = Array.from(elements).filter((el) => isLikelyTaskItem(el));

      const tasks: ExtractedTask[] = filteredElements.map((el) => {
        const text = el.textContent?.trim() || "";
        const title = resolveTitle(el);

        const taskAnchor = el.querySelector<HTMLAnchorElement>("a[href]");
        const taskUrl = taskAnchor?.href || null;
        const courseId = extractQueryParam(courseUrl, "course_id") || extractQueryParam(courseUrl, "course") || null;
        const taskId = (taskUrl && (extractQueryParam(taskUrl, "content_id") || extractQueryParam(taskUrl, "id"))) || null;

        const dueInfo = extractDueInfo(text);
        const dueText = dueInfo.raw;
        const dueMs = dueInfo.ms;
        // タスクキーは締切表記の差分で分離されないように、可能ならURL由来のID、
        // なければ科目+タイトル(不要注釈除去)を使用して一意化する。
        let taskKey: string;
        if (taskId) {
          taskKey = normalizeKey(`${courseId || "course"}_${taskId}`);
        } else {
          const sanitizedTitleForKey = sanitizeForKey(title);
          const courseCode = extractCourseCode(text) || extractCourseCode(courseName) || null;
          if (courseCode) {
            taskKey = normalizeKey(`${courseCode}_${sanitizedTitleForKey}`);
          } else {
            taskKey = normalizeKey(`${courseName}_${sanitizedTitleForKey}`);
          }
        }

        return {
          taskKey,
          course: courseName,
          title,
          endAtRaw: dueText,
          endAtMs: dueMs,
          taskUrl,
          courseId,
          taskId,
          source: "WebClass_AutoSync",
        };
      });

      console.log(`📌 [${courseName}] 一覧${elements.length}件 / 課題抽出${tasks.length}件`);

      if (document.body.contains(iframe)) document.body.removeChild(iframe);
      resolve(tasks);
    }, 500);
  });

const getUniqueCourseLinks = (): HTMLAnchorElement[] => {
  const courseLinks = document.querySelectorAll("a[href*='course.php']");
  const processedUrls = new Set<string>();
  const linksArray = Array.from(courseLinks) as HTMLAnchorElement[];
  return linksArray.filter((link) => {
    if (processedUrls.has(link.href)) return false;
    processedUrls.add(link.href);
    return true;
  });
};

const setSyncButtonDisabled = (disabled: boolean) => {
  const panel = ensurePanel();
  const syncButton = panel.querySelector<HTMLButtonElement>("#mth-sync-btn");
  if (!syncButton) return;
  const onTimetable = isTargetTimetablePage();
  const isDisabled = disabled || !onTimetable;

  syncButton.disabled = isDisabled;
  syncButton.style.opacity = isDisabled ? "0.6" : "1";

  if (disabled) {
    syncButton.textContent = "同期中...";
  } else if (!onTimetable) {
    syncButton.textContent = "メイン画面で同期";
  } else {
    syncButton.textContent = "再同期";
  }
};

const startAutoSync = async (manual = false) => {
  if (syncing) return;

  if (!isTargetTimetablePage()) {
    ensurePanel();
    setSyncButtonDisabled(false);
    updateStatus("メイン画面以外では同期しません (DB表示のみ)");

    try {
      const dbTasks = await loadTasksFromDb();
      if (dbTasks.length > 0) {
        lastTasks = dbTasks;
        renderTasks(lastTasks);
      }
    } catch (error) {
      console.error("❌ DB読込失敗:", error);
    }
    return;
  }

  if (!manual) {
    const lastAutoSyncAt = await readStorageNumber(LAST_AUTO_SYNC_AT_KEY);
    if (lastAutoSyncAt) {
      const elapsed = Date.now() - lastAutoSyncAt;
      if (elapsed < AUTO_SYNC_COOLDOWN_MS) {
        const remain = AUTO_SYNC_COOLDOWN_MS - elapsed;
        ensurePanel();
        updateStatus(`自動同期はスキップ (${formatRemainLabel(remain)})`);
        console.log("Meijo Task Hub: 自動同期クールダウン中のためスキップ");

        try {
          const dbTasks = await loadTasksFromDb();
          if (dbTasks.length > 0) {
            lastTasks = dbTasks;
            renderTasks(lastTasks);
            updateStatus(`自動同期はスキップ (${formatRemainLabel(remain)}) / DBから${dbTasks.length}件表示`);
          }
        } catch (error) {
          console.error("❌ DB読込失敗:", error);
        }

        return;
      }
    }
  }

  syncing = true;

  ensurePanel();
  setSyncButtonDisabled(true);
  updateStatus(manual ? "手動同期を開始しました" : "自動同期を開始しました");

  try {
    const googleSyncPromise = requestGoogleClassroomSync(manual);
    const uniqueLinks = getUniqueCourseLinks();
    if (uniqueLinks.length === 0) {
      updateStatus("科目リンクが見つかりませんでした。DBから表示します...");

      try {
        const dbTasks = await loadTasksFromDb();
        lastTasks = dbTasks;
        renderTasks(lastTasks);
        const googleSyncResult = await googleSyncPromise;
        updateStatus(
          `科目リンク未検出 / DBから${dbTasks.length}件表示${googleSyncResult ? ` / ${googleSyncResult}` : ""}`,
        );
      } catch (error) {
        console.error("❌ DB読込失敗:", error);
        renderTasks([]);
        updateStatus("科目リンクが見つからず、DB読込にも失敗しました");
      }

      return;
    }

    const allTasks: ExtractedTask[] = [];
    for (let i = 0; i < uniqueLinks.length; i += 1) {
      const link = uniqueLinks[i];
      const courseName = link.textContent?.trim() || "不明な教科";
      updateStatus(`[${i + 1}/${uniqueLinks.length}] ${courseName} を解析中`);

      try {
        const tasks = await extractCourseTasks(link.href, courseName, i + 1, uniqueLinks.length);
        allTasks.push(...tasks);
      } catch (error) {
        console.error(`❌ [${courseName}] 解析に失敗:`, error);
      }
    }

    const dedupedByKey = new Map<string, ExtractedTask>();
    for (const task of allTasks) {
      if (!dedupedByKey.has(task.taskKey)) dedupedByKey.set(task.taskKey, task);
    }

    const dedupedTasks = Array.from(dedupedByKey.values());
    let writeErrors = 0;

    for (const task of dedupedTasks) {
      try {
        await upsertTask(task);
      } catch (error) {
        writeErrors += 1;
        console.error("❌ Firestore保存失敗:", error);
      }
    }

    try {
      const latestTasks = await loadTasksFromDb();
      lastTasks = latestTasks;
    } catch {
      lastTasks = dedupedTasks;
      void 0;
    }
    renderTasks(lastTasks);

    const successText = `同期完了: ${allTasks.length}件抽出 / ${dedupedTasks.length}件保存対象${writeErrors > 0 ? ` / 保存失敗 ${writeErrors}件` : ""}`;
    updateStatus(successText);
    console.log(`🏁 ${successText}`);

    const googleSyncResult = await googleSyncPromise;
    if (googleSyncResult) {
      await refreshTasksFromDb(`${successText} / ${googleSyncResult}`);
    }

    if (!manual) {
      await writeStorageNumber(LAST_AUTO_SYNC_AT_KEY, Date.now());
    }
  } finally {
    syncing = false;
    setSyncButtonDisabled(false);
  }
};

const isErrorWrapper = (value: unknown): value is { __error: string } => {
  if (!value || typeof value !== "object") return false;
  return "__error" in value && typeof (value as { __error?: unknown }).__error === "string";
};

const isSyncResponse = (value: unknown): value is { ok: boolean; message: string } => {
  if (!value || typeof value !== "object") return false;
  const v = value as { ok?: unknown; message?: unknown };
  return typeof v.ok === "boolean" && typeof v.message === "string";
};

const requestGoogleClassroomSync = async (interactive: boolean): Promise<string | null> => {
  if (!extensionChrome?.runtime?.sendMessage) return null;

  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await new Promise<unknown>((resolve) => {
        extensionChrome.runtime?.sendMessage(
          { type: "mth-sync-google-classroom", interactive },
          (response) => {
            // chrome.runtime.lastError をチェックして、sendMessage の失敗原因を取得
            const lastErr = extensionChrome.runtime?.lastError;
            if (lastErr && typeof lastErr.message === "string") {
              resolve({ __error: lastErr.message });
            } else {
              resolve(response);
            }
          },
        );
      });

      if (!result) return null;

      if (isErrorWrapper(result)) {
        const errMsg: string = result.__error;
        // 拡張コンテキスト無効化は一時的なのでリトライ
        if (errMsg.includes("Extension context invalidated") && attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, 500 * attempt));
          continue;
        }
        console.error("❌ Google Classroom同期失敗:", errMsg);
        return `Google Classroom同期失敗: ${errMsg}`;
      }

      if (!isSyncResponse(result)) return null;
      return result.ok ? result.message : `Google Classroom同期失敗: ${result.message}`;
    } catch (error) {
      console.error("❌ Google Classroom同期失敗:", error);
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 500 * attempt));
        continue;
      }
      return "Google Classroom同期に失敗しました";
    }
  }

  return "Google Classroom同期に失敗しました";
};

const handleRouteState = () => {
  const onTimetable = isTargetTimetablePage();
  const panelExists = Boolean(document.getElementById(PANEL_ID));

  ensurePanel();
  setSyncButtonDisabled(false);

  if (onTimetable && !wasOnTimetablePage) {
    console.log("Meijo Task Hub: 時間割画面を検出");
    ensurePanel();
    if (lastTasks.length > 0) renderTasks(lastTasks);
    void startAutoSync(false);
  }

  if (onTimetable && wasOnTimetablePage && !panelExists) {
    console.log("Meijo Task Hub: パネル消失を検出、再表示します");
    ensurePanel();
    if (lastTasks.length > 0) {
      renderTasks(lastTasks);
      updateStatus("表示を復元しました");
    } else {
      updateStatus("表示を復元しました。必要なら再同期してください");
    }
  }

  if (!onTimetable && wasOnTimetablePage) {
    console.log("Meijo Task Hub: 時間割画面を離脱");
    updateStatus("メイン画面以外では同期しません (DB表示のみ)");
    if (lastTasks.length > 0) {
      renderTasks(lastTasks);
    } else {
      void loadTasksFromDb()
        .then((dbTasks) => {
          lastTasks = dbTasks;
          renderTasks(lastTasks);
        })
        .catch((error) => {
          console.error("❌ DB読込失敗:", error);
        });
    }
  }

  if (!onTimetable && !wasOnTimetablePage) {
    updateStatus("メイン画面以外では同期しません (DB表示のみ)");
  }

  wasOnTimetablePage = onTimetable;
};

const startRouteWatcher = () => {
  if (routeWatcherStarted) return;
  routeWatcherStarted = true;

  setInterval(() => {
    if (!location.href.includes("/webclass/")) return;

    const hrefChanged = location.href !== lastObservedHref;
    const panelMissing = !document.getElementById(PANEL_ID);

    if (hrefChanged) {
      lastObservedHref = location.href;
      handleRouteState();
      return;
    }

    // SPA遷移やDOM差し替えでパネルが消えたケースを自己回復する。
    if (panelMissing) {
      handleRouteState();
    }
  }, 1000);
};

if (location.href.includes("/webclass/")) {
  console.log("Meijo Task Hub: 解析エンジン起動");
  handleRouteState();
  startRouteWatcher();
}