# Meijo Task Hub (MTH) - 技術仕様書 (v1.8)

## 1. プロジェクト概要
名城大学 WebClass と Google Classroom の課題情報を統合し、カレンダー同期とタスク管理を実現する拡張機能。既存セッションを維持したまま、実機検証済みのロジックで自動巡回を行う。

## 2. ターゲット環境
- 対象: https://rpwebcls.meijo-u.ac.jp/webclass/*
- 基盤: Vite + React + TypeScript + CRXJS (Manifest V3)

---

## 3. 実証済み抽出ロジック (Verified Logic)

### 3.1 巡回・正規化 (抽出確認済み)
1. 教科抽出: メインページ table a からリンク収集、URLで重複排除。
2. 教科名正規化: ハッシュ生成前に /\s*\(20\d{2}-.*?\)$/ で年度・時限を除去。

### 3.2 動的解析と待機処理 (抽出確認済み)
- 動的待機: .cl-contentsList_content 出現まで最大15秒、500ms毎に監視。
- 区分判定: innerText から優先順にキーワード抽出（試験 > レポート > 演習 > 資料）。
- 締切取得: 正規表現 \d{4}\/\d{2}\/\d{2}.*?\d{2}:\d{2} の最後の一致を採用。

### 3.3 決定論的ID生成
- 方式: SHA-256(normalizeCourseName + title + deadline)
- 実装: crypto.subtle.digest を使い、先頭16文字を採用。

---

## 4. 機能要件 (Manual-First Policy)
- 自動判定: レポート提出数 > 0 等を確認。
- 手動管理: ユーザーのチェック操作を completedIds (storage.local) に永続化し、スキャン結果より優先してマージ。

---

## 5. データ構造定義 (TypeScript)
```typescript
type TaskType = '試験' | 'レポート' | '演習' | '資料' | 'その他';

interface UnifiedTask {
  readonly id: string;           // 検証済み SHA-256 ID
  readonly source: 'WebClass' | 'Classroom' | 'Manual';
  readonly courseName: string;   // 正規化済み教科名
  title: string;
  type: TaskType;
  endAt: string | null;          // ISO8601
  link?: string;
  isCompleted: boolean;          // 手動・自動マージ後
}

interface StorageSchema {
  tasks: UnifiedTask[];
  completedIds: string[];        // 完了済みID配列
  lastScanAt: number;
}
```
---

## 6. 実装フェーズ詳細コード (Implementation Blueprint)

### 6.1 核心ロジックの参照実装
```
// src/utils/crypto.ts: ID生成
export const generateId = async (course: string, title: string, deadline: string): Promise<string> => {
  const seed = `${course.trim()}_${title.trim()}_${deadline || 'none'}`;
  const msgUint8 = new TextEncoder().encode(seed);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
};

// src/utils/scanner.ts: 区分判定
export const classifyType = (text: string): TaskType => {
  if (text.includes('試験')) return '試験';
  if (text.includes('レポート')) return 'レポート';
  if (text.includes('演習')) return '演習';
  if (text.includes('資料')) return '資料';
  return 'その他';
};
```
---

## 7. 開発開始用コマンド

### 7.1 環境構築
# 1. プロジェクト作成
```
npm create vite@latest meijo-task-hub -- --template react-ts
cd meijo-task-hub
```
# 2. 依存関係
```
npm install @crxjs/vite-plugin@latest lucide-react dayjs -D
```
# 3. CSS
```
npm install -D tailwindcss postcss autoprefixer
npx tailwindcss init -p
```
### 7.2 Manifest V3 構成テンプレート
```
{
  "manifest_version": 3,
  "name": "Meijo Task Hub",
  "version": "1.0.0",
  "permissions": ["storage", "cookies", "identity", "alarms", "offscreen"],
  "host_permissions": ["https://rpwebcls.meijo-u.ac.jp/*"],
  "background": { "service_worker": "src/background.ts", "type": "module" }
}
```
