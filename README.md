# Meijo Task Hub - 技術仕様書

## 1. プロジェクト概要
名城大学の LMS (WebClass) と Google Classroom の課題情報を統合し、Google カレンダーへの自動同期および一元的なタスク管理を実現するブラウザ拡張機能。

## 2. ターゲット環境
- **対象サイト**: `https://rpwebcls.meijo-u.ac.jp/webclass/*`
- **開発基盤**: Vite + React + TypeScript + CRXJS (Manifest V3)
- **外部連携**: Google Classroom API, Google Calendar API

---

## 3. 実証済みデータ抽出ロジック (Verified Logic)

### 3.1 巡回アルゴリズム (Crawler)
メインページ（時間割画面）から履修中の全教科リンクを抽出する。
- **Selector**: `table a`
- **Logic**: 
  - `innerText` をトリミングして教科名を取得。
  - `href` から各教科のユニークな URL を取得。
  - 重複（同じ教科が複数コマある場合）を URL ベースで排除。

### 3.2 ページ解析と待機処理 (Extractor & Waiting)　抽出確認済み
各教科ページは動的・不安定なため、以下の抽出ロジックを採用する。
- **対象要素**: `.cl-contentsList_content`
- **待機アルゴリズム**: 
  - ページ読み込み (`readyState === 'complete'`) を待つだけでなく、上記対象要素が出現するまで最大 15 秒間、500ms おきにポーリング監視を行う。
- **タイトル抽出**: 
  1. `innerText` を改行で分割。
  2. 不要キーワード（`New`, `詳細`, `利用可能期間` 等）を正規表現で除外。
  3. 残った行の先頭を「課題タイトル」とする。
- **期限取得**: `\d{4}\/\d{2}\/\d{2}.*?\d{2}:\d{2}` の正規表現で、教材ブロック内から最後に出現する日時を「締切」として抽出。

---

## 4. 機能要件 (Functional Requirements)

### 4.1 セッション利用型・自動巡回
- **認証**: ユーザーの ID/パスワードは DB に保存せず、ブラウザの既存ログインセッション（Cookie）をそのまま利用する。
- **実行環境**: 
  - 基本は `background.ts` (Service Worker) での Fetch を推奨。
  - 通信制限がある場合は `iframe` を用いた不可視巡回をバックアッププランとする。
- **負荷分散**: 大学サーバーへの負荷を考慮し、教科間の Fetch には `1000ms` 以上の待機時間を設ける。

### 4.2 統合 UI インジェクション
- **配置**: WebClass メインページの右側に `fixed` サイドバーを React で描画。
- **内容**: 抽出した WebClass の課題と Classroom の課題を混合し、締切昇順で表示。

---

## 5. データ構造定義 (TypeScript)

```typescript
type TaskSource = 'WebClass' | 'Classroom';

interface UnifiedTask {
  readonly id: string;           // URL/Title ハッシュ
  readonly source: TaskSource;
  readonly courseName: string;   // 教科名
  title: string;                 // 課題名
  type: string;                  // 試験/レポート/資料等
  endAt: string | null;          // 締切日時 (ISO8601)
  link: string;                  // 教材直リンク
  syncStatus: 'synced' | 'pending';
  lastUpdatedAt: number;         // 最終同期スタンプ
}
```

---

## 6. 実装ロードマップ

### Phase 1: 基盤とバックグラウンド通信
- [ ] `manifest.json` の定義（`cookies`, `host_permissions` の設定）
- [ ] Service Worker による全教科 Fetch ロジックの移植
- [ ] `chrome.storage.local` への取得データ保存実装

### Phase 2: UI 実装
- [ ] WebClass メインページへの React マウント
- [ ] Tailwind CSS を用いたダッシュボードのデザイン
- [ ] Google Classroom API との疎通確認

---

## 7. 開発開始用コマンド
```bash
# Viteプロジェクトの作成
npm create vite@latest meijo-task-hub -- --template react-ts
# 依存ライブラリのインストール
npm install @crxjs/vite-plugin@latest firebase lucide-react dayjs -D
```
