import { DATE_TOKEN_REGEX, TASK_EXCLUDE_KEYWORDS, TASK_INCLUDE_KEYWORDS } from "./constants";

export const normalizeKey = (value: string): string =>
  value.replace(/[\r\n\t]+/g, " ").replace(/[\\/\s]+/g, "_").replace(/_+/g, "_").trim();

export const extractCourseCode = (value: string): string | null => {
  if (!value) return null;
  const m = value.match(/\b(\d{5})\b/);
  return m ? m[1] : null;
};

const normalizeSpaces = (s: string) => s.replace(/\u3000/g, " ").replace(/\s+/g, " ").trim();

export const sanitizeForKey = (value: string): string => {
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

export const extractDueInfo = (text: string): { raw: string; ms: number | null } => {
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

export const extractQueryParam = (url: string, key: string): string | null => {
  try {
    const parsed = new URL(url, location.origin);
    return parsed.searchParams.get(key);
  } catch {
    return null;
  }
};

export const resolveTitle = (element: Element): string => {
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
  const uniqueCandidates = Array.from(new Set(candidates)).filter((c) => !isNoise(c));
  if (uniqueCandidates.length === 0) return "無題課題";
  uniqueCandidates.sort((a, b) => scoreTitle(b) - scoreTitle(a) || b.length - a.length);
  return uniqueCandidates[0];
};

export const isLikelyTaskItem = (element: Element): boolean => {
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
  } catch {
    void 0;
  }
  return false;
};
