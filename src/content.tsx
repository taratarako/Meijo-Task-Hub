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

type Calendar = {
  id: string;
  summary: string;
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
let selectedCalendarId: string | null = null;
let availableCalendars: Calendar[] = [];

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
  if (path.includes("/main/timetable") || search.includes("timetable") || href.includes("/main/timetable")) return true;
  const headingText = document.querySelector("h1")?.textContent || document.querySelector("h2")?.textContent || document.querySelector(".cl-pageTitle")?.textContent || "";
  if (headingText.includes("時間割")) return true;
  const breadcrumbText = document.querySelector(".breadcrumb")?.textContent || "";
  if (breadcrumbText.includes("時間割")) return true;
  const courseLinkCount = document.querySelectorAll("a[href*='course.php']").length;
  if (courseLinkCount >= 3) return true;
  return false;
};

const normalizeKey = (value: string): string =>
  value.replace(/[\r\n\t]+/g, " ").replace(/[\\/\s]+/g, "_").replace(/_+/g, "_").trim();

const extractCourseCode = (value: string): string | null => {
  if (!value) return null;
  const m = value.match(/\b(\d{5})\b/);
  return m ? m[1] : null;
};

const normalizeSpaces = (s: string) => s.replace(/\u3000/g, " ").replace(/\s+/g, " ").trim();

const sanitizeForKey = (value: string): string => {
  if (!value) return value;
  let v = normalizeSpaces(value);
  const noisePatterns = ["締切が近い課題があります", "締切が近い", "提出期限が近い", "締切間近", "期限切れ", "期限切れです"];
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
  const withMs = matches.map((m) => ({ match: m, ms: parseDatePartsToMs(m) })).filter((item) => item.ms !== null) as Array<{ match: RegExpMatchArray; ms: number }>;
  if (withMs.length === 0) return { raw: matches[matches.length - 1][0], ms: null };
  const dueHintLabels = ["締切", "提出期限", "期限", "終了", "〆切"];
  const hintIndex = dueHintLabels.map((label) => normalized.lastIndexOf(label)).filter((index) => index >= 0).sort((a, b) => b - a)[0];
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
  const headingCandidates = [element.querySelector("h1")?.textContent, element.querySelector("h2")?.textContent, element.querySelector("h3")?.textContent, element.querySelector("h4")?.textContent, element.querySelector("strong")?.textContent];
  for (const candidate of headingCandidates) {
    const clean = stripNewPrefix(normalize(candidate || ""));
    if (!isNoise(clean)) candidates.push(clean);
  }
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
  const sortByDue = (a: ExtractedTask, b: ExtractedTask) => {
    if (a.endAtMs === null && b.endAtMs === null) return a.title.localeCompare(b.title, "ja");
    if (a.endAtMs === null) return 1;
    if (b.endAtMs === null) return -1;
    if (a.endAtMs !== b.endAtMs) return a.endAtMs - b.endAtMs;
    return a.title.localeCompare(b.title, "ja");
  };
  const visibleTasks = tasks.filter((task) => {
    if (task.hidden) return false;
    if (typeof task.endAtMs === "number" && task.endAtMs < now) return false;
    return true;
  });
  if (visibleTasks.length === 0) {
    listEl.innerHTML = '<div style="background:#0f3568;border:1px solid rgba(255,255,255,0.12);border-radius:10px;padding:12px;font-size:13px;">表示できる課題がありません</div>';
    updateCount(0);
    return;
  }
  const renderSection = (title: string, items: ExtractedTask[], accent: string) => {
    if (items.length === 0) return "";
    const cards = items.map((task) => `
        <article style="background:#0f3568;border:1px solid rgba(255,255,255,0.14);border-left:4px solid ${accent};border-radius:10px;padding:10px 64px 9px 10px;margin-bottom:8px;position:relative;">
          <button class="mth-delete-btn" data-task-key="${task.taskKey}" style="position:absolute;top:8px;right:8px;border:none;border-radius:6px;padding:6px 12px;background:rgba(255,255,255,0.15);color:#f5f7fa;font-size:12px;cursor:pointer;z-index:2;line-height:1;">削除</button>
          <button class="mth-calendar-add-btn" data-task-key="${task.taskKey}" style="position:absolute;top:32px;right:8px;border:none;border-radius:6px;padding:6px 12px;background:rgba(111,224,177,0.3);color:#6fe0b1;font-size:11px;cursor:pointer;z-index:2;line-height:1;${task.endAtMs === null ? 'opacity:0.5;cursor:not-allowed;' : ''}">📅追加</button>
          <div style="font-size:12px;opacity:0.92;margin-bottom:6px;">${task.course}</div>
          <div style="font-size:16px;line-height:1.35;font-weight:700;margin-bottom:8px;">${task.title}</div>
          <div style="font-size:13px;">締切: <strong>${formatDueLabel(task)}</strong>${isOverdue(task) ? ' <span style="margin-left:6px;color:#ffb3a8;">(期限切れ)</span>' : ""}</div>
        </article>
      `).join("");
    return `<div style="margin-bottom:12px;"><div style="font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:#b7c9e2;margin-bottom:6px;">${title}</div>${cards}</div>`;
  };
  const webclassTasks = visibleTasks.filter((task) => task.source === "WebClass_AutoSync").sort(sortByDue);
  const googleTasks = visibleTasks.filter((task) => task.source === "GoogleClassroom").sort(sortByDue);
  const html = renderSection("WebClass", webclassTasks, "#ffd44d") + renderSection("Google Classroom", googleTasks, "#6fe0b1");
  listEl.innerHTML = html;
  updateCount(webclassTasks.length + googleTasks.length);
  const deleteButtons = listEl.querySelectorAll<HTMLButtonElement>(".mth-delete-btn");
  deleteButtons.forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      const key = button.dataset.taskKey;
      if (!key) return;
      const target = tasks.find((t) => t.taskKey === key);
      if (!target) return;
      if (!window.confirm(`課題「${target.title}」をリストから削除しますか？\n（※元のシステムからは削除されません）`)) return;
      await handleDeleteTask(target);
    });
  });
  const calendarAddButtons = listEl.querySelectorAll<HTMLButtonElement>(".mth-calendar-add-btn");
  calendarAddButtons.forEach((button) => {
    if (button.dataset.taskKey) {
      const task = tasks.find((t) => t.taskKey === button.dataset.taskKey);
      if (!task || task.endAtMs === null) {
        button.disabled = true;
        return;
      }
      button.addEventListener("click", async (event) => {
        event.stopPropagation();
        await addTaskToCalendar(task);
      });
    }
  });
};

const handleDeleteTask = async (task: ExtractedTask) => {
  const now = Date.now();
  // 楽観的UI更新
  lastTasks = lastTasks.filter((t) => t.taskKey !== task.taskKey);
  renderTasks(lastTasks);

  try {
    if (typeof task.endAtMs === "number" && task.endAtMs < now) {
      await deleteDoc(doc(db, "tasks", task.taskKey));
    } else if (typeof task.endAtMs === "number") {
      await setDoc(doc(db, "tasks", task.taskKey), { hidden: true, hiddenUntil: task.endAtMs, hiddenAt: now }, { merge: true });
    } else {
      await setDoc(doc(db, "tasks", task.taskKey), { hidden: true, hiddenUntil: null, hiddenAt: now }, { merge: true });
    }
  } catch (error) {
    console.error("❌ 削除処理に失敗:", error);
    void refreshTasksFromDb("同期エラーのため再取得");
  }
};

const isLikelyTaskItem = (element: Element): boolean => {
  const text = (element.textContent || "").replace(/\s+/g, " ").toLowerCase();
  const anchorHref = (element.querySelector("a[href]") as HTMLAnchorElement | null)?.href.toLowerCase() || "";
  const targetText = `${text} ${anchorHref}`;
  if (!targetText.trim()) return false;
  if (TASK_EXCLUDE_KEYWORDS.some((keyword) => targetText.includes(keyword.toLowerCase()))) return false;
  if (TASK_INCLUDE_KEYWORDS.some((keyword) => targetText.includes(keyword.toLowerCase()))) return true;
  if (anchorHref && (anchorHref.includes("content_id=") || anchorHref.includes("id="))) return true;
  try {
    const title = resolveTitle(element) || "";
    if (title && title !== "無題課題" && title.trim().length >= 3) {
      if (/(締切|提出期限|期限|due)/i.test(targetText) || TASK_INCLUDE_KEYWORDS.some((k) => targetText.includes(k.toLowerCase()))) return true;
    }
  } catch { void 0; }
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

const fetchCalendars = async (): Promise<void> => {
  if (!extensionChrome?.runtime?.sendMessage) return;
  try {
    const res = await new Promise<{ ok?: boolean; calendars?: Calendar[] } | undefined>(r =>
      extensionChrome?.runtime?.sendMessage?.(
        { type: "mth-get-calendars", interactive: true },
        (response) => r(response as { ok?: boolean; calendars?: Calendar[] } | undefined)
      )
    );
    if (res?.ok && res.calendars) {
      availableCalendars = res.calendars;
      if (availableCalendars.length > 0 && !selectedCalendarId) {
        selectedCalendarId = availableCalendars[0].id;
      }
    }
  } catch { void 0; }
};

const addTaskToCalendar = async (task: ExtractedTask): Promise<void> => {
  if (!selectedCalendarId || !extensionChrome?.runtime?.sendMessage) return;
  if (!task.endAtMs) {
    alert("締切がない課題はカレンダーに追加できません");
    return;
  }

  try {
    const res = await new Promise<{ ok?: boolean; message?: string } | undefined>(r =>
      extensionChrome?.runtime?.sendMessage?.(
        {
          type: "mth-add-calendar-event",
          calendarId: selectedCalendarId,
          task: {
            taskKey: task.taskKey,
            title: task.title,
            endAtMs: task.endAtMs,
            course: task.course,
            taskUrl: task.taskUrl,
          },
          interactive: true,
        },
        (response) => r(response as { ok?: boolean; message?: string } | undefined)
      )
    );
    if (res?.ok) {
      alert(`✓ カレンダーに追加しました: ${task.title}`);
    } else {
      alert(`⚠ ${res?.message || "カレンダーへの追加に失敗しました"}`);
    }
  } catch{
    alert("⚠ カレンダーへの追加に失敗しました");
  }
};

const addAllTasksToCalendar = async (): Promise<void> => {
  if (!selectedCalendarId) {
    alert("カレンダーを選択してください");
    return;
  }

  const now = Date.now();
  const tasksToAdd = lastTasks.filter((task) => {
    if (task.hidden) return false;
    if (typeof task.endAtMs === "number" && task.endAtMs < now) return false;
    if (task.endAtMs === null) return false;
    return true;
  });

  if (tasksToAdd.length === 0) {
    alert("追加可能な課題がありません");
    return;
  }

  const panel = ensurePanel();
  const bulkBtn = panel.querySelector<HTMLButtonElement>("#mth-bulk-add-btn");
  if (bulkBtn) bulkBtn.disabled = true;

  let added = 0;
  for (const task of tasksToAdd) {
    try {
      const res = await new Promise<{ ok?: boolean; message?: string } | undefined>(r =>
        extensionChrome?.runtime?.sendMessage?.(
          {
            type: "mth-add-calendar-event",
            calendarId: selectedCalendarId,
            task: {
              taskKey: task.taskKey,
              title: task.title,
              endAtMs: task.endAtMs,
              course: task.course,
              taskUrl: task.taskUrl,
            },
            interactive: false,
          },
          (response) => r(response as { ok?: boolean; message?: string } | undefined)
        )
      );
      if (res?.ok) added += 1;
    } catch { void 0; }
  }

  if (bulkBtn) bulkBtn.disabled = false;
  alert(`${added}/${tasksToAdd.length} 件の課題をカレンダーに追加しました`);
};

const ensurePanel = () => {
  let panel = document.getElementById(PANEL_ID);
  if (panel) return panel;
  panel = document.createElement("section");
  panel.id = PANEL_ID;
  panel.style.cssText = "position:fixed;top:84px;left:16px;width:360px;max-height:80vh;overflow:hidden;z-index:2147483647;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,0.28);background:#06254d;color:#f5f7fa;font-family:'Segoe UI',sans-serif;";
  panel.innerHTML = `
    <div class="mth-header" style="padding:12px 14px;padding-right:56px;border-bottom:1px solid rgba(255,255,255,0.15);display:flex;align-items:center;justify-content:space-between;gap:8px;cursor:grab;">
      <div style="display:flex;flex-direction:column;min-width:0;flex:1;">
        <div style="font-weight:700;font-size:20px;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">TASKS</div>
        <div id="mth-status" style="font-size:12px;opacity:0.9;margin-top:4px;white-space:pre-line;">初期化中...</div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;"><button id="mth-sync-btn" style="cursor:pointer;border:none;border-radius:8px;padding:8px 10px;background:#ffd44d;color:#3a2b00;font-weight:700;margin-right:8px;">再同期</button></div>
    </div>
    <div id="mth-count-container" style="padding:10px 14px;border-bottom:1px solid rgba(255,255,255,0.15);font-size:13px;">取得件数: <span id="mth-count" style="font-weight:700;">0</span></div>
    <div id="mth-calendar-container" style="padding:8px 14px;border-bottom:1px solid rgba(255,255,255,0.15);display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
      <select id="mth-calendar-select" style="flex:1;min-width:120px;border:none;border-radius:4px;padding:6px 8px;background:#0a1e3f;color:#f5f7fa;font-size:12px;cursor:pointer;border:1px solid rgba(255,255,255,0.2);">
        <option value="">カレンダーを選択</option>
      </select>
      <button id="mth-bulk-add-btn" style="border:none;border-radius:4px;padding:6px 10px;background:rgba(111,224,177,0.4);color:#6fe0b1;font-size:11px;cursor:pointer;font-weight:700;">一括追加</button>
    </div>
    <div id="mth-list" style="padding:10px 12px;overflow:auto;max-height:56vh;"></div>
  `;
  document.body.appendChild(panel);
  const syncButton = panel.querySelector<HTMLButtonElement>("#mth-sync-btn");
  syncButton?.addEventListener("click", () => { void startAutoSync(true); });
  let toggleBtn = panel.querySelector<HTMLButtonElement>("#mth-toggle-minimize-btn");
  if (!toggleBtn) {
    toggleBtn = document.createElement("button");
    toggleBtn.id = "mth-toggle-minimize-btn";
    toggleBtn.style.cssText = "position:absolute;top:8px;right:12px;width:34px;height:34px;border-radius:18px;border:none;background:rgba(0,0,0,0.15);color:#f5f7fa;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 10px rgba(0,0,0,0.25);";
    toggleBtn.textContent = "—";
    panel.appendChild(toggleBtn);
  }
  const countContainer = panel.querySelector<HTMLElement>("#mth-count-container");
  const calendarContainer = panel.querySelector<HTMLElement>("#mth-calendar-container");
  const listEl = panel.querySelector<HTMLElement>("#mth-list");
  const statusEl = panel.querySelector<HTMLElement>("#mth-status");
  const applyMinimized = (min: boolean) => {
    if (min) {
      if (countContainer) countContainer.style.display = "none";
      if (calendarContainer) calendarContainer.style.display = "none";
      if (listEl) listEl.style.display = "none";
      if (statusEl) statusEl.style.display = "none";
      panel.style.maxHeight = "48px";
      if (toggleBtn) toggleBtn.textContent = "▢";
      if (syncButton) syncButton.style.display = "none";
    } else {
      if (countContainer) countContainer.style.display = "";
      if (calendarContainer) calendarContainer.style.display = "";
      if (listEl) listEl.style.display = "";
      if (statusEl) statusEl.style.display = "";
      panel.style.maxHeight = "80vh";
      if (toggleBtn) toggleBtn.textContent = "—";
      if (syncButton) syncButton.style.display = "";
    }
    localStorage.setItem("mth-panel-minimized", min ? "1" : "0");
  };
  try { applyMinimized(localStorage.getItem("mth-panel-minimized") === "1"); } catch { void 0; }
  toggleBtn?.addEventListener("click", () => {
    const cur = localStorage.getItem("mth-panel-minimized") === "1";
    applyMinimized(!cur);
  });
  const headerEl = panel.querySelector<HTMLElement>(".mth-header");
  let dragging = false, startX = 0, startY = 0, origLeft = 0, origTop = 0;
  headerEl?.addEventListener("pointerdown", (ev) => {
    if ((ev.target as HTMLElement).closest("button")) return;
    dragging = true;
    headerEl?.setPointerCapture?.(ev.pointerId);
    startX = ev.clientX; startY = ev.clientY;
    if (panel.style.right) {
      const computedRight = parseInt(panel.style.right) || 16;
      panel.style.left = `${window.innerWidth - (panel.offsetWidth + computedRight)}px`;
      panel.style.right = "";
    }
    origLeft = parseInt(panel.style.left || "16"); origTop = parseInt(panel.style.top || "84");
    panel.style.cursor = "grabbing"; ev.preventDefault();
  });
  headerEl?.addEventListener("pointermove", (ev) => {
    if (!dragging) return;
    panel.style.left = `${origLeft + (ev.clientX - startX)}px`;
    panel.style.top = `${origTop + (ev.clientY - startY)}px`;
  });
  const stopDrag = (ev?: PointerEvent) => {
    if (!dragging) return; dragging = false; panel.style.cursor = "default";
    try { headerEl?.releasePointerCapture?.(ev?.pointerId ?? 0); } catch { void 0; }
    const rect = panel.getBoundingClientRect();
    if (window.innerWidth - (rect.left + rect.width) <= 120) {
      panel.style.right = "16px"; panel.style.left = "";
      localStorage.setItem("mth-panel-side", "right");
    } else {
      localStorage.removeItem("mth-panel-side");
      localStorage.setItem("mth-panel-left", panel.style.left);
    }
    localStorage.setItem("mth-panel-top", panel.style.top);
  };
  headerEl?.addEventListener("pointerup", stopDrag);
  try {
    const side = localStorage.getItem("mth-panel-side"), top = localStorage.getItem("mth-panel-top"), left = localStorage.getItem("mth-panel-left");
    if (top) panel.style.top = top;
    if (side === "right") { panel.style.right = "16px"; panel.style.left = ""; }
    else if (left) { panel.style.left = left; panel.style.right = ""; }
    else { panel.style.right = "16px"; }
  } catch { void 0; }

  // カレンダー選択と一括追加ボタンの初期化
  const calendarSelect = panel.querySelector<HTMLSelectElement>("#mth-calendar-select");
  const bulkAddBtn = panel.querySelector<HTMLButtonElement>("#mth-bulk-add-btn");

  if (calendarSelect) {
    calendarSelect.addEventListener("change", (e) => {
      selectedCalendarId = (e.target as HTMLSelectElement).value || null;
    });
  }

  if (bulkAddBtn) {
    bulkAddBtn.addEventListener("click", () => {
      void addAllTasksToCalendar();
    });
  }

  // カレンダー一覧を取得して初期化
  void (async () => {
    await fetchCalendars();
    if (calendarSelect && availableCalendars.length > 0) {
      calendarSelect.innerHTML = '<option value="">カレンダーを選択</option>' +
        availableCalendars.map((cal) => `<option value="${cal.id}">${cal.summary}</option>`).join("");
      if (selectedCalendarId) {
        calendarSelect.value = selectedCalendarId;
      }
    }
  })();

  return panel;
};

const updateStatus = (message: string) => {
  const statusEl = ensurePanel().querySelector<HTMLElement>("#mth-status");
  if (statusEl) statusEl.textContent = message;
};

const updateCount = (count: number) => {
  const countEl = ensurePanel().querySelector<HTMLElement>("#mth-count");
  if (countEl) countEl.textContent = String(count);
};

const upsertTask = async (task: ExtractedTask) => {
  await setDoc(doc(db, "tasks", task.taskKey), {
    course: task.course, title: task.title, endAt: task.endAtRaw, endAtMs: task.endAtMs,
    taskUrl: task.taskUrl, courseId: task.courseId, taskId: task.taskId, source: task.source, updatedAt: serverTimestamp(),
  }, { merge: true });
};

const loadTasksFromDb = async (max = 120): Promise<ExtractedTask[]> => {
  const q = query(collection(db, "tasks"), orderBy("updatedAt", "desc"), limit(max));
  const snapshot = await getDocs(q), now = Date.now(), toDelete: string[] = [];
  const items: ExtractedTask[] = snapshot.docs.map((row) => {
    const data = row.data();
    return {
      taskKey: row.id, course: data.course || "不明な教科", title: data.title || "無題課題",
      endAtRaw: data.endAt || "期限なし", endAtMs: data.endAtMs, taskUrl: data.taskUrl || null,
      courseId: data.courseId || null, taskId: data.taskId || null,
      source: data.source === "GoogleClassroom" ? "GoogleClassroom" : "WebClass_AutoSync",
      hidden: data.hidden, hiddenUntil: data.hiddenUntil, hiddenAt: data.hiddenAt,
    };
  });
  const visible = items.filter((task) => {
    if (typeof task.endAtMs === "number" && task.endAtMs < now) { toDelete.push(task.taskKey); return false; }
    if (task.hidden) { if (typeof task.hiddenUntil === "number" && task.hiddenUntil <= now) toDelete.push(task.taskKey); return false; }
    return true;
  });
  if (toDelete.length > 0) await Promise.all(toDelete.map((key) => deleteDoc(doc(db, "tasks", key))));
  return Array.from(new Map(visible.map(t => [t.taskKey, t])).values());
};

const refreshTasksFromDb = async (label: string) => {
  try {
    const dbTasks = await loadTasksFromDb();
    if (dbTasks.length > 0) { lastTasks = dbTasks; renderTasks(lastTasks); updateStatus(label); }
  } catch (error) { console.error("❌ DB読込失敗:", error); }
};

const extractCourseTasks = (courseUrl: string, courseName: string): Promise<ExtractedTask[]> =>
  new Promise((resolve) => {
    const iframe = document.createElement("iframe");
    iframe.style.display = "none"; iframe.src = courseUrl; document.body.appendChild(iframe);
    let attempts = 0, stableTicks = 0, lastCount = -1;
    const timeout = setTimeout(() => {
      clearInterval(checkInterval); if (document.body.contains(iframe)) document.body.removeChild(iframe);
      resolve([]);
    }, 20000);
    const checkInterval = setInterval(() => {
      attempts += 1; const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
      if (!iframeDoc) return;
      const elements = iframeDoc.querySelectorAll(".cl-contentsList_content");
      if (elements.length !== lastCount) { lastCount = elements.length; stableTicks = 0; } else { stableTicks += 1; }
      if (attempts <= 40 && !(elements.length > 0 && stableTicks >= 3)) return;
      clearInterval(checkInterval); clearTimeout(timeout);
      const tasks: ExtractedTask[] = Array.from(elements).filter((el) => isLikelyTaskItem(el)).map((el) => {
        const text = el.textContent?.trim() || "", title = resolveTitle(el);
        const taskUrl = el.querySelector<HTMLAnchorElement>("a[href]")?.href || null;
        const courseId = extractQueryParam(courseUrl, "course_id") || extractQueryParam(courseUrl, "course") || null;
        const taskId = (taskUrl && (extractQueryParam(taskUrl, "content_id") || extractQueryParam(taskUrl, "id"))) || null;
        const dueInfo = extractDueInfo(text);
        const taskKey = taskId ? normalizeKey(`${courseId || "course"}_${taskId}`) : normalizeKey(`${extractCourseCode(courseName) || courseName}_${sanitizeForKey(title)}`);
        return { taskKey, course: courseName, title, endAtRaw: dueInfo.raw, endAtMs: dueInfo.ms, taskUrl, courseId, taskId, source: "WebClass_AutoSync" };
      });
      if (document.body.contains(iframe)) document.body.removeChild(iframe);
      resolve(tasks);
    }, 500);
  });

const getUniqueCourseLinks = (): HTMLAnchorElement[] => {
  const processed = new Set<string>();
  return (Array.from(document.querySelectorAll("a[href*='course.php']")) as HTMLAnchorElement[]).filter(link => {
    if (processed.has(link.href)) return false; processed.add(link.href); return true;
  });
};

const setSyncButtonDisabled = (disabled: boolean) => {
  const syncBtn = ensurePanel().querySelector<HTMLButtonElement>("#mth-sync-btn");
  if (!syncBtn) return;
  const onTimetable = isTargetTimetablePage(), isDisabled = disabled || !onTimetable;
  syncBtn.disabled = isDisabled; syncBtn.style.opacity = isDisabled ? "0.6" : "1";
  syncBtn.textContent = disabled ? "同期中..." : (!onTimetable ? "メイン画面で同期" : "再同期");
};

const startAutoSync = async (manual = false) => {
  if (syncing) return;
  if (!isTargetTimetablePage()) {
    ensurePanel(); setSyncButtonDisabled(false); updateStatus("メイン画面以外では同期しません (DB表示のみ)");
    try { const dbTasks = await loadTasksFromDb(); if (dbTasks.length > 0) { lastTasks = dbTasks; renderTasks(lastTasks); } } catch { void 0; }
    return;
  }
  if (!manual) {
    const last = await readStorageNumber(LAST_AUTO_SYNC_AT_KEY);
    if (last && Date.now() - last < AUTO_SYNC_COOLDOWN_MS) {
      updateStatus(`自動同期はスキップ\n(${formatRemainLabel(AUTO_SYNC_COOLDOWN_MS - (Date.now() - last))})`);
      try { const dbTasks = await loadTasksFromDb(); if (dbTasks.length > 0) { lastTasks = dbTasks; renderTasks(lastTasks); } } catch { void 0; }
      return;
    }
  }
  syncing = true; ensurePanel(); setSyncButtonDisabled(true);
  updateStatus(manual ? "手動同期を開始しました" : "自動同期を開始しました");
  try {
    const googlePromise = requestGoogleClassroomSync(manual), links = getUniqueCourseLinks();
    if (links.length === 0) {
      const dbTasks = await loadTasksFromDb(); lastTasks = dbTasks; renderTasks(lastTasks);
      updateStatus(`科目未検出 / DBから${dbTasks.length}件表示 / ${await googlePromise || ""}`);
      return;
    }
    const allTasks: ExtractedTask[] = [];
    for (let i = 0; i < links.length; i++) {
      updateStatus(`[${i + 1}/${links.length}] ${links[i].textContent?.trim()} を解析中`);
      try { allTasks.push(...await extractCourseTasks(links[i].href, links[i].textContent?.trim() || "不明")); } catch { void 0; }
    }
    const deduped = Array.from(new Map(allTasks.map(t => [t.taskKey, t])).values());
    for (const t of deduped) try { await upsertTask(t); } catch { void 0; }
    lastTasks = await loadTasksFromDb(); renderTasks(lastTasks);
    updateStatus(`同期完了: ${deduped.length}件抽出 / ${await googlePromise || ""}`);
    if (!manual) await writeStorageNumber(LAST_AUTO_SYNC_AT_KEY, Date.now());
  } finally { syncing = false; setSyncButtonDisabled(false); }
};

const requestGoogleClassroomSync = async (interactive: boolean): Promise<string | null> => {
  if (!extensionChrome?.runtime?.sendMessage) return null;
  try {
    const res = await new Promise<{ ok?: boolean; message?: string } | undefined>(r =>
      extensionChrome.runtime?.sendMessage?.(
        { type: "mth-sync-google-classroom", interactive },
        (response) => r(response as { ok?: boolean; message?: string } | undefined)
      )
    );
    return res?.ok ? (res.message || "同期完了") : `Google Classroom失敗: ${res?.message || "不明"}`;
  } catch { return "Google Classroom同期に失敗"; }
};

const handleRouteState = () => {
  const onTimetable = isTargetTimetablePage();
  ensurePanel(); setSyncButtonDisabled(false);
  if (onTimetable && !wasOnTimetablePage) { void startAutoSync(false); }
  else if (!onTimetable) { updateStatus("メイン画面以外では同期しません (DB表示のみ)"); if (lastTasks.length === 0) void loadTasksFromDb().then(t => { lastTasks = t; renderTasks(t); }); }
  wasOnTimetablePage = onTimetable;
};

const startRouteWatcher = () => {
  if (routeWatcherStarted) return; routeWatcherStarted = true;
  setInterval(() => {
    if (!location.href.includes("/webclass/")) return;
    if (location.href !== lastObservedHref || !document.getElementById(PANEL_ID)) {
      lastObservedHref = location.href; handleRouteState();
    }
  }, 1000);
};

if (location.href.includes("/webclass/")) { handleRouteState(); startRouteWatcher(); }