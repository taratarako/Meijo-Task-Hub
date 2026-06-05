import { ensureSignedIn } from "./content/auth";
import { AUTO_SYNC_COOLDOWN_MS, LAST_AUTO_SYNC_AT_KEY, PANEL_ID } from "./content/constants";
import { deleteTask, hideTask, loadTasksFromDb, upsertTask } from "./content/db";
import {
  extractCourseCode,
  extractDueInfo,
  extractQueryParam,
  isLikelyTaskItem,
  normalizeKey,
  resolveTitle,
  sanitizeForKey,
} from "./content/extract";
import { extensionChrome } from "./content/runtime";
import { readStorageNumber, writeStorageNumber } from "./content/storage";
import type {
  AddCalendarEventResponse,
  Calendar,
  CalendarListResponse,
  ExtractedTask,
  GoogleSyncResponse,
} from "./content/types";

let syncing = false;
let lastTasks: ExtractedTask[] = [];
let routeWatcherStarted = false;
let lastObservedHref = location.href;
let wasOnTimetablePage = false;
let selectedCalendarId: string | null = null;
let availableCalendars: Calendar[] = [];

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
  if ((path === "/webclass/" || path === "/webclass") && search.includes("acs_=")) return true;
  const headingText = document.querySelector("h1")?.textContent || document.querySelector("h2")?.textContent || document.querySelector(".cl-pageTitle")?.textContent || "";
  if (headingText.includes("時間割")) return true;
  const breadcrumbText = document.querySelector(".breadcrumb")?.textContent || "";
  if (breadcrumbText.includes("時間割")) return true;
  const courseLinkCount = document.querySelectorAll("a[href*='course.php']").length;
  if (courseLinkCount >= 3) return true;
  return false;
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
  const uid = await ensureSignedIn(true);
  if (!uid) {
    alert("ログインが必要です");
    return;
  }
  const now = Date.now();
  // 楽観的UI更新
  lastTasks = lastTasks.filter((t) => t.taskKey !== task.taskKey);
  renderTasks(lastTasks);

  try {
    if (typeof task.endAtMs === "number" && task.endAtMs < now) {
      await deleteTask(uid, task.taskKey);
    } else if (typeof task.endAtMs === "number") {
      await hideTask(uid, task.taskKey, true, task.endAtMs, now);
    } else {
      await hideTask(uid, task.taskKey, true, null, now);
    }
  } catch (error) {
    console.error("❌ 削除処理に失敗:", error);
    void refreshTasksFromDb("同期エラーのため再取得");
  }
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
    const res = await new Promise<CalendarListResponse | undefined>((r) =>
      extensionChrome?.runtime?.sendMessage?.(
        { type: "mth-get-calendars", interactive: true },
        (response) => r(response as CalendarListResponse | undefined)
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
    const res = await new Promise<AddCalendarEventResponse | undefined>((r) =>
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
        (response) => r(response as AddCalendarEventResponse | undefined)
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
      const res = await new Promise<AddCalendarEventResponse | undefined>((r) =>
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
          (response) => r(response as AddCalendarEventResponse | undefined)
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

const refreshTasksFromDb = async (label: string) => {
  try {
    const uid = await ensureSignedIn(false);
    if (!uid) {
      updateStatus("ログインが必要です");
      return;
    }
    const dbTasks = await loadTasksFromDb(uid);
    if (dbTasks.length > 0) { lastTasks = dbTasks; renderTasks(lastTasks); updateStatus(label); }
  } catch (error) { console.error("❌ DB読込失敗:", error); }
};

const extractCourseTasks = (courseUrl: string, courseName: string): Promise<ExtractedTask[]> =>
  new Promise((resolve) => {
    const iframe = document.createElement("iframe");
    iframe.style.display = "none"; iframe.src = courseUrl; document.body.appendChild(iframe);
    let attempts = 0;
    const timeout = setTimeout(() => {
      clearInterval(checkInterval); if (document.body.contains(iframe)) document.body.removeChild(iframe);
      resolve([]);
    }, 20000);
    const checkInterval = setInterval(() => {
      attempts += 1; const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
      if (!iframeDoc) return;
      const elements = iframeDoc.querySelectorAll(".cl-contentsList_content");
      // Proceed as soon as any content appears, or after a minimal wait.
      if (attempts < 2 && elements.length === 0) return;
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

const resolveTimetableUrl = (): string | null => {
  if (!location.href.includes("/webclass/")) return null;
  const path = location.pathname.toLowerCase();
  const search = location.search.toLowerCase();
  if ((path === "/webclass/" || path === "/webclass") && search.includes("acs_=")) return location.href;
  if (path.includes("/main/timetable") || search.includes("timetable")) return location.href;
  const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"));
  const timetableAnchor = anchors.find((anchor) => {
    const text = anchor.textContent || "";
    const href = anchor.href.toLowerCase();
    return (text.includes("時間割") || href.includes("timetable")) && !href.includes("course.php");
  });
  if (timetableAnchor?.href) return timetableAnchor.href;
  return `${location.origin}/webclass/`;
};

const touchPage = (url: string): Promise<void> =>
  new Promise((resolve) => {
    const iframe = document.createElement("iframe");
    iframe.style.display = "none";
    iframe.src = url;
    document.body.appendChild(iframe);
    const cleanup = () => {
      try { iframe.remove(); } catch { void 0; }
      resolve();
    };
    iframe.addEventListener("load", () => cleanup(), { once: true });
    setTimeout(() => cleanup(), 2500);
  });

const logoutAndReturnToLogin = (): Promise<void> =>
  new Promise((resolve) => {
    const iframe = document.createElement("iframe");
    iframe.style.display = "none";
    iframe.src = "https://rpwebcls.meijo-u.ac.jp/webclass/logout.php?acs_=7a478e38";
    document.body.appendChild(iframe);

    const cleanup = () => {
      try { iframe.remove(); } catch { void 0; }
      resolve();
    };

    const tryClick = (): boolean => {
      const doc = iframe.contentDocument || iframe.contentWindow?.document;
      if (!doc) return false;
      const candidates = Array.from(doc.querySelectorAll<HTMLElement>(
        "button, input[type='button'], input[type='submit'], a"
      ));
      const target = candidates.find((el) => {
        const text = (el.textContent || "").trim();
        const value = (el instanceof HTMLInputElement ? el.value : "").trim();
        return text.includes("ログイン画面に戻る") || value.includes("ログイン画面に戻る");
      });
      if (!target) return false;
      target.click();
      return true;
    };

    let tries = 0;
    const interval = setInterval(() => {
      tries += 1;
      if (tryClick() || tries >= 12) {
        clearInterval(interval);
        setTimeout(() => cleanup(), 800);
      }
    }, 300);

    setTimeout(() => {
      clearInterval(interval);
      cleanup();
    }, 5000);
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
  const returnHref = resolveTimetableUrl() || location.href;
  const uid = await ensureSignedIn(manual);
  if (!uid) {
    updateStatus("ログインが必要です");
    return;
  }
  if (!isTargetTimetablePage()) {
    ensurePanel(); setSyncButtonDisabled(false); updateStatus("メイン画面以外では同期しません (DB表示のみ)");
    try { const dbTasks = await loadTasksFromDb(uid); if (dbTasks.length > 0) { lastTasks = dbTasks; renderTasks(lastTasks); } } catch { void 0; }
    return;
  }
  if (!manual) {
    const last = await readStorageNumber(LAST_AUTO_SYNC_AT_KEY);
    if (last && Date.now() - last < AUTO_SYNC_COOLDOWN_MS) {
      updateStatus(`自動同期はスキップ\n(${formatRemainLabel(AUTO_SYNC_COOLDOWN_MS - (Date.now() - last))})`);
      try { const dbTasks = await loadTasksFromDb(uid); if (dbTasks.length > 0) { lastTasks = dbTasks; renderTasks(lastTasks); } } catch { void 0; }
      return;
    }
  }
  syncing = true; ensurePanel(); setSyncButtonDisabled(true);
  updateStatus(manual ? "手動同期を開始しました" : "自動同期を開始しました");
  try {
    const googlePromise = requestGoogleClassroomSync(manual), links = getUniqueCourseLinks();
    if (links.length === 0) {
      const dbTasks = await loadTasksFromDb(uid); lastTasks = dbTasks; renderTasks(lastTasks);
      updateStatus(`科目未検出 / DBから${dbTasks.length}件表示 / ${await googlePromise || ""}`);
      return;
    }
    const allTasks: ExtractedTask[] = [];
    for (let i = 0; i < links.length; i++) {
      updateStatus(`[${i + 1}/${links.length}] ${links[i].textContent?.trim()} を解析中`);
      try { allTasks.push(...await extractCourseTasks(links[i].href, links[i].textContent?.trim() || "不明")); } catch { void 0; }
    }
    const deduped = Array.from(new Map(allTasks.map(t => [t.taskKey, t])).values());
    console.log(`[MTH] upsert開始: ${deduped.length}件`);
    for (const t of deduped) try { await upsertTask(uid, t); } catch (e) { console.error("❌ upsert失敗:", t.taskKey, e); }
    console.log("[MTH] upsert完了、DB読込開始");
    lastTasks = await loadTasksFromDb(uid); renderTasks(lastTasks);
    console.log(`[MTH] DB読込完了: ${lastTasks.length}件`);
    updateStatus(`同期完了: ${deduped.length}件抽出 / ${await googlePromise || ""}`);
    if (!manual) await writeStorageNumber(LAST_AUTO_SYNC_AT_KEY, Date.now());
    if (returnHref.includes("/webclass/")) {
      await touchPage(returnHref);
    }
    await logoutAndReturnToLogin();
  } finally { syncing = false; setSyncButtonDisabled(false); }
};

const requestGoogleClassroomSync = async (interactive: boolean): Promise<string | null> => {
  if (!extensionChrome?.runtime?.sendMessage) return null;
  try {
    const res = await new Promise<GoogleSyncResponse | undefined>((r) =>
      extensionChrome?.runtime?.sendMessage?.(
        { type: "mth-sync-google-classroom", interactive },
        (response) => r(response as GoogleSyncResponse | undefined)
      )
    );
    return res?.ok ? (res.message || "同期完了") : `Google Classroom失敗: ${res?.message || "不明"}`;
  } catch { return "Google Classroom同期に失敗"; }
};

const handleRouteState = () => {
  const onTimetable = isTargetTimetablePage();
  ensurePanel(); setSyncButtonDisabled(false);
  if (onTimetable && !wasOnTimetablePage) { void startAutoSync(false); }
  else if (!onTimetable) {
    updateStatus("メイン画面以外では同期しません (DB表示のみ)");
    if (lastTasks.length === 0) {
      void (async () => {
        const uid = await ensureSignedIn(false);
        if (!uid) return;
        const tasks = await loadTasksFromDb(uid);
        lastTasks = tasks;
        renderTasks(tasks);
      })();
    }
  }
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