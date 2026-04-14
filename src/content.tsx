import { db } from "./firebase.ts";
// インポートを1つにまとめる
import { doc, setDoc, serverTimestamp} from "firebase/firestore";

console.log("Meijo Task Hub: 同期ロジックを開始します");

const dateRegex = /\d{4}\/\d{2}\/\d{2}.*?\d{2}:\d{2}/;

const pollTasks = setInterval(async () => {
  const elements = document.querySelectorAll(".cl-contentsList_content");

  if (elements && elements.length > 0) {
    console.log(`${elements.length}個の課題を確認しました`);
    clearInterval(pollTasks);

    for (const el of elements) {
      const text = el.textContent?.trim() || "";
      const title = text.split('\n')[0].replace(/New|詳細|利用可能期間/g, "").trim();
      const dateMatch = text.match(dateRegex);
      const dueDate = dateMatch ? dateMatch[0] : "期限なし";

      try {
        if (!db) throw new Error("Firestore 未初期化");

        // スラッシュをアンダースコアに置換して、安全なIDを作る
        const taskId = title.replace(/\//g, "_").replace(/\s+/g, "_"); 

        await setDoc(doc(db, "tasks", taskId), {
          title: title,
          endAt: dueDate,
          source: "WebClass",
          updatedAt: serverTimestamp(), 
        }, { merge: true }); 

        console.log(`✅ 【同期完了】: ${title}`);
      } catch (e) {
        console.error("❌ 同期失敗:", e);
      }
    }
  }
}, 3000);