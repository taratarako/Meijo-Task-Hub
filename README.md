# Meijo Task Hub (MTH) - 技術仕様書 (v1.2)

## 1. プロジェクト概要
名城大学の LMS (WebClass) と Google Classroom の課題情報を統合し、手動タスク管理および Google カレンダーへの同期を実現するブラウザ拡張機能。
**「ID/パスワードを保持せず、既存セッションで自動巡回を完遂する」**ことをコアバリューとする。

## 2. ターゲット環境
- **対象サイト**: `https://rpwebcls.meijo-u.ac.jp/webclass/*`
- **開発基盤**: Vite + React + TypeScript + CRXJS (Manifest V3)
- **外部連携**: Google Classroom API, Google Calendar API (OAuth 2.0)

---

## 3. 実証済みデータ抽出ロジック (Verified)

### 3.1 巡回アルゴリズム
メインページの `table a` から全教科 URL を取得し、URL ベースで重複排除。

### 3.2 粘着型抽出ロジック (抽出確認済み)
WebClass の動的生成・低速応答に対応するため、以下の処理を実装。
- **ポーリング監視**: `.cl-contentsList_content` が出現するまで最大 15 秒間、500ms 間隔で監視。
- **タイムアウト処理**: 15 秒経過時は「教材なし」として正常終了（ループ停止を防止）。
- **抽出規則**: 
  - **タイトル**: `innerText` を改行分割し、不要語（`New`, `詳細`, `利用可能期間` 等）を除外した有効な 1 行目。
  - **締切**: 正規表現 `\d{4}\/\d{2}\/\d{2}.*?\d{2}:\d{2}` でマッチする**最後**の日時。

---

## 4. 機能要件 (Functional Requirements)

### 4.1 セッション利用型・自動巡回
- **認証**: ID/パスワードは DB に保存せず、ブラウザの Cookie を利用。
- **実行環境**: `background.ts` (Service Worker) での Fetch。
- **負荷分散**: 教科間 Fetch に `1000ms` 以上の待機を設定。

### 4.2 統合タスク管理
- **ソース混合**: WebClass、Classroom、および**手動追加タスク**を単一リストに統合。
- **手動追加**: サイドバーから「タイトル」「締切」を任意入力・保存可能。
- **永続化**: `chrome.storage.local` を使用。

### 4.3 Google カレンダー同期
- **OAuth 認証**: `chrome.identity` によるトークン取得。
- **不整合防止**: 課題ハッシュを `extendedProperties` に付与し、重複登録を防止。

---

## 5. データ構造定義 (TypeScript)

```typescript
type TaskSource = 'WebClass' | 'Classroom' | 'Manual';

interface UnifiedTask {
  readonly id: string;           // URLハッシュまたはUUID
  readonly source: TaskSource;
  readonly courseName: string;   // 手動の場合は「個人」等
  title: string;                 // 課題名
  endAt: string | null;          // 締切日時 (ISO8601)
  link?: string;                 // WebClassへの直リンク
  isCompleted: boolean;          // 完了フラグ
  isSyncedToCalendar: boolean;   // カレンダー登録済みフラグ
  lastUpdatedAt: number;
}
```

---

## 6. 実装ロードマップ

### Phase 1: 巡回エンジンの移植
- [ ] `manifest.json` の設定（`cookies`, `identity`, `host_permissions`）
- [ ] 検証済み iframe ロジックを `background.ts` 用の Fetch 処理へ昇華。

### Phase 2: サイドバー UI & 手動追加
- [ ] React + Tailwind によるサイドバー描画。
- [ ] `chrome.storage` を介した手動タスクの CRUD 操作。

### Phase 3: カレンダー連携
- [ ] Google Cloud Console での API 有効化。
- [ ] `events.insert` を用いた同期ロジック実装。

---

## 7. 開発開始用コマンド
```bash
# プロジェクト作成
npm create vite@latest meijo-task-hub -- --template react-ts

# 依存ライブラリのインストール
# @crxjs/vite-plugin: 拡張機能開発に必須
# lucide-react: アイコン素材
# dayjs: 日付操作
npm install @crxjs/vite-plugin@latest lucide-react dayjs -D
```
