import { db } from "./firebase.ts";
import { doc, setDoc, serverTimestamp } from "firebase/firestore";

const dateRegex = /\d{4}\/\d{2}\/\d{2}.*?\d{2}:\d{2}/;

function syncCourseWithIframe(courseUrl: string, courseName: string, index: number, total: number): Promise<void> {
  return new Promise((resolve) => {
    const iframe = document.createElement("iframe");
    iframe.style.display = "none";
    iframe.src = courseUrl;
    document.body.appendChild(iframe);

    console.log(`[${index}/${total}] ${courseName} をチェック中...`);

    let attempts = 0;
    // 20秒経ったら強制終了するタイマー
    const timeout = setTimeout(() => {
      clearInterval(checkInterval);
      if (document.body.contains(iframe)) document.body.removeChild(iframe);
      console.warn(`⚠️ [${courseName}] タイムアウトのためスキップしました`);
      resolve();
    }, 20000);

    const checkInterval = setInterval(async () => {
      attempts++;
      const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
      if (!iframeDoc) return;

      const elements = iframeDoc.querySelectorAll(".cl-contentsList_content");

      if (elements.length > 0 || attempts > 30) {
        clearInterval(checkInterval);
        clearTimeout(timeout); // 正常に終わったのでタイムアウトを解除
        
        if (elements.length > 0) {
          for (const el of elements) {
            const text = el.textContent?.trim() || "";
            const title = text.split('\n')[0].replace(/New|詳細|利用可能期間/g, "").trim();
            const dateMatch = text.match(dateRegex);
            const dueDate = dateMatch ? dateMatch[0] : "期限なし";
            const taskId = `${courseName}_${title}`.replace(/[/\s]+/g, "_");

            await setDoc(doc(db, "tasks", taskId), {
              course: courseName,
              title: title,
              endAt: dueDate,
              source: "WebClass_AutoSync",
              updatedAt: serverTimestamp(),
            }, { merge: true });
          }
          console.log(`✅ [${index}/${total}] ${courseName} (${elements.length}件) 同期完了`);
        } else {
          console.log(`ℹ️ [${index}/${total}] ${courseName}: 課題なし`);
        }

        if (document.body.contains(iframe)) document.body.removeChild(iframe);
        resolve();
      }
    }, 500);
  });
}

const startAutoSync = async () => {
  const courseLinks = document.querySelectorAll("a[href*='course.php']");
  if (courseLinks.length === 0) return;

  const processedUrls = new Set();
  const linksArray = Array.from(courseLinks) as HTMLAnchorElement[];
  const uniqueLinks = linksArray.filter(link => {
    if (processedUrls.has(link.href)) return false;
    processedUrls.add(link.href);
    return true;
  });

  console.log(`Meijo Task Hub: ${uniqueLinks.length}件の同期を開始します...`);
  
  for (let i = 0; i < uniqueLinks.length; i++) {
    const link = uniqueLinks[i];
    const name = link.textContent?.trim() || "不明な教科";
    // 1つずつ順番に、かつエラーが起きても次へ進むようにする
    try {
      await syncCourseWithIframe(link.href, name, i + 1, uniqueLinks.length);
    } catch (e) {
      console.error(`❌ [${name}] 予期せぬエラー:`, e);
    }
  }
  console.log("🏁 すべての教科の同期処理が終わりました");
};

if (location.href.includes("/webclass/")) {
  console.log("Meijo Task Hub: 解析エンジン起動");
  startAutoSync();
}