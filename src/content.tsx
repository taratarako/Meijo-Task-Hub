import { db } from "./firebase";
import { collection, doc, getDocs, limit, orderBy, query, serverTimestamp, setDoc } from "firebase/firestore";

type ExtractedTask = {
  taskKey: string;
  course: string;
  title: string;
  endAtRaw: string;
  endAtMs: number | null;
  taskUrl: string | null;
  courseId: string | null;
  taskId: string | null;
  source: "WebClass_AutoSync";
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
      // 締切ラベルの後ろに複数日時がある場合は、公開開始日ではなく終了側(最大日時)を採用。
      const latestAfterHint = afterHint.reduce((prev, cur) => (cur.ms > prev.ms ? cur : prev));
      return { raw: latestAfterHint.match[0], ms: latestAfterHint.ms };
    }
  }

  // ラベルが曖昧でも、開始日より締切日の方が遅い前提で最大日時を採用。
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
    if (/^(new|詳細|利用回数|教材|タイムライン|お知らせ|試験|利用可能期間|期限|締切)$/i.test(value)) return true;
    if (/^(\d+|\d+件)$/.test(value)) return true;
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

const isLikelyTaskItem = (element: Element): boolean => {
  const text = (element.textContent || "").replace(/\s+/g, " ").toLowerCase();
  const anchorHref = (element.querySelector("a[href]") as HTMLAnchorElement | null)?.href.toLowerCase() || "";
  const targetText = `${text} ${anchorHref}`;

  if (!targetText.trim()) return false;

  if (TASK_EXCLUDE_KEYWORDS.some((keyword) => targetText.includes(keyword.toLowerCase()))) {
    return false;
  }

  if (TASK_INCLUDE_KEYWORDS.some((keyword) => targetText.includes(keyword.toLowerCase()))) {
    return true;
  }

  // 課題語がなくても、締切表記がある項目は課題候補として扱う。
  if (/(締切|提出期限|期限|due)/i.test(targetText)) {
    return true;
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
    <div style="padding:12px 14px;border-bottom:1px solid rgba(255,255,255,0.15);display:flex;align-items:center;justify-content:space-between;gap:8px;">
      <div>
        <div style="font-weight:700;font-size:20px;line-height:1.2;">統一タスクダッシュボード</div>
        <div id="mth-status" style="font-size:12px;opacity:0.9;margin-top:4px;">初期化中...</div>
      </div>
      <button id="mth-sync-btn" style="cursor:pointer;border:none;border-radius:8px;padding:8px 10px;background:#ffd44d;color:#3a2b00;font-weight:700;">再同期</button>
    </div>
    <div style="padding:10px 14px;border-bottom:1px solid rgba(255,255,255,0.15);font-size:13px;">
      取得件数: <span id="mth-count" style="font-weight:700;">0</span>
    </div>
    <div id="mth-list" style="padding:10px 12px;overflow:auto;max-height:56vh;"></div>
  `;

  document.body.appendChild(panel);

  const syncButton = panel.querySelector<HTMLButtonElement>("#mth-sync-btn");
  syncButton?.addEventListener("click", () => {
    void startAutoSync(true);
  });

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

const renderTasks = (tasks: ExtractedTask[]) => {
  const panel = ensurePanel();
  const listEl = panel.querySelector<HTMLElement>("#mth-list");
  if (!listEl) return;

  const sorted = tasks
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

  const html = sorted
    .map(
      (task) => `
      <article style="background:#0f3568;border:1px solid rgba(255,255,255,0.14);border-left:4px solid #ffd44d;border-radius:10px;padding:10px 10px 9px;margin-bottom:8px;">
        <div style="font-size:12px;opacity:0.92;margin-bottom:6px;">${task.course}</div>
        <div style="font-size:16px;line-height:1.35;font-weight:700;margin-bottom:8px;">${task.title}</div>
        <div style="font-size:13px;">締切: <strong>${formatDueLabel(task)}</strong>${isOverdue(task) ? ' <span style="margin-left:6px;color:#ffb3a8;">(期限切れ)</span>' : ""}</div>
      </article>
    `,
    )
    .join("");

  listEl.innerHTML = html;
  updateCount(sorted.length);
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

  const items: ExtractedTask[] = snapshot.docs.map((row) => {
    const data = row.data() as Record<string, unknown>;
    const endAtMs = typeof data.endAtMs === "number" ? data.endAtMs : null;

    return {
      taskKey: row.id,
      course: typeof data.course === "string" ? data.course : "不明な教科",
      title: typeof data.title === "string" ? data.title : "無題課題",
      endAtRaw: typeof data.endAt === "string" ? data.endAt : "期限なし",
      endAtMs,
      taskUrl: typeof data.taskUrl === "string" ? data.taskUrl : null,
      courseId: typeof data.courseId === "string" ? data.courseId : null,
      taskId: typeof data.taskId === "string" ? data.taskId : null,
      source: "WebClass_AutoSync",
    };
  });

  const deduped = new Map<string, ExtractedTask>();
  for (const task of items) {
    if (!deduped.has(task.taskKey)) deduped.set(task.taskKey, task);
  }
  return Array.from(deduped.values());
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
        const taskKey = taskId
          ? normalizeKey(`${courseId || "course"}_${taskId}`)
          : normalizeKey(`${courseName}_${title}_${dueText}`);

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
    const uniqueLinks = getUniqueCourseLinks();
    if (uniqueLinks.length === 0) {
      updateStatus("科目リンクが見つかりませんでした。DBから表示します...");

      try {
        const dbTasks = await loadTasksFromDb();
        lastTasks = dbTasks;
        renderTasks(lastTasks);
        updateStatus(`科目リンク未検出 / DBから${dbTasks.length}件表示`);
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

    lastTasks = dedupedTasks;
    renderTasks(lastTasks);

    const successText = `同期完了: ${allTasks.length}件抽出 / ${dedupedTasks.length}件保存対象${writeErrors > 0 ? ` / 保存失敗 ${writeErrors}件` : ""}`;
    updateStatus(successText);
    console.log(`🏁 ${successText}`);

    if (!manual) {
      await writeStorageNumber(LAST_AUTO_SYNC_AT_KEY, Date.now());
    }
  } finally {
    syncing = false;
    setSyncButtonDisabled(false);
  }
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