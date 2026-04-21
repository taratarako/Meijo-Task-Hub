# Meijo Task Hub 仕様書


## 1. 背景と主目的

WebClass の時間割画面を開いたときに、現在の課題を同じ画面内で確認できることを主目的とします。
確認した課題は、個別または一括で Google Calendar に追加できるようにします。

## 2. スコープ

対象:
- Chrome 拡張機能 (Manifest V3)
- WebClass 時間割画面へのダッシュボード注入
- WebClass 課題の取得、重複排除、保存
- Google Calendar 追加導線

対象外:
- WebClass 本体改修
- サーバーサイド専用 API の新規開発
- モバイルアプリ

## 3. 技術スタック

- フロントエンド: React + TypeScript + Vite
- 拡張機能: Chrome Extension Manifest V3
- データベース: Cloud Firestore
- 認証: Firebase Authentication (Google Sign-In)
- 日時処理: dayjs

## 4. 実行コンポーネント

### 4.1 popup
- 用途: 設定表示、手動同期、一覧確認
- エントリ: index.html -> src/main.tsx -> src/App.tsx

### 4.2 content script
- 用途: WebClass 画面 DOM 解析、課題抽出、画面内ダッシュボード表示
- エントリ: src/content.tsx

### 4.3 background service worker
- 用途: 将来的な定期同期、通知仲介、認証状態監視
- エントリ: src/background.ts

### 4.4 firebase
- 用途: Firebase 初期化、Firestore/Auth クライアント提供
- エントリ: src/firebase.ts

## 5. ユースケース

UC-01 自動同期:
- ユーザーが WebClass 時間割画面を開く
- 自動同期が起動し、課題一覧が更新される

UC-02 手動同期:
- ユーザーが手動再同期を実行する
- 最新データで再取得する

UC-03 個別カレンダー追加:
- ユーザーが課題カードの追加ボタンを押す
- 対象課題のみ Calendar に追加する

UC-04 一括カレンダー追加:
- ユーザーが一括同期ボタンを押す
- 表示中の課題をまとめて Calendar に追加する

## 6. 機能要件

FR-01 起動トリガー:
- WebClass 時間割画面で自動同期する
- popup または画面内ボタンで手動同期できる

FR-02 表示条件:
- 期限切れ課題は表示しない

FR-03 重複判定:
- 第1優先: courseId + taskId
- フォールバック: courseName + title

FR-04 保存形式:
- endAt は Firestore Timestamp とする

FR-05 認証:
- Google ログイン必須
- データはユーザー単位で保存分離

FR-06 UI:
- WebClass 課題と Google Classroom 課題をセクション表示
- 締切順ソート、科目/期限フィルタ、完了チェック
- 同期失敗通知を表示

FR-07 カレンダー連携:
- 個別追加と一括追加の双方を提供

## 7. 同期ロジック仕様

1. 対象ページ判定:
- URL に /webclass/ と main/timetable を含む場合を対象

2. 科目リンク収集:
- a[href*='course.php'] を取得
- href でユニーク化

3. 科目ごとの課題取得:
- 非表示 iframe で科目ページを順次ロード
- .cl-contentsList_content を探索
- 最大 20 秒でタイムアウト

4. 課題抽出:
- タイトル抽出、ノイズ語除去
- 期限文字列を抽出して Timestamp に変換
- 期限切れを除外

5. 一意キー決定:
- courseId/taskId が取得できる場合はそれを使用
- 取得できない場合は courseName/title の正規化キーを使用

6. DB 反映:
- users/{uid}/tasks/{taskKey} へ upsert
- 更新日時を serverTimestamp で記録

7. UI 反映:
- ダッシュボードを再描画
- 失敗件数があれば通知領域に表示

## 8. Firestore データ構造

### 8.1 コレクション設計

users/{uid}
	profile
		- displayName: string
		- email: string
		- university: string
		- createdAt: timestamp
		- updatedAt: timestamp

users/{uid}/tasks/{taskKey}
	- taskKey: string
	- source: string                    # WebClass | GoogleClassroom | Manual
	- courseId: string | null
	- taskId: string | null
	- courseName: string
	- title: string
	- description: string | null
	- taskUrl: string | null
	- endAt: timestamp
	- isCompleted: boolean
	- isOverdue: boolean
	- calendarSynced: boolean
	- calendarEventId: string | null
	- lastSyncAt: timestamp
	- createdAt: timestamp
	- updatedAt: timestamp

users/{uid}/syncLogs/{logId}
	- startedAt: timestamp
	- finishedAt: timestamp
	- status: string                    # success | partial | failed
	- scannedCourses: number
	- upsertedTasks: number
	- skippedOverdue: number
	- errorCount: number
	- errors: array<string>

### 8.2 インデックス要件

- users/{uid}/tasks:
	- source ASC, endAt ASC
	- isCompleted ASC, endAt ASC
	- courseName ASC, endAt ASC

### 8.3 データ整合ルール

- taskKey はドキュメント ID と一致
- isOverdue は endAt との比較結果を反映
- updatedAt は更新毎に serverTimestamp

## 9. Firestore セキュリティルール方針

- users/{uid} 以下は request.auth.uid == uid のみアクセス可能
- 未認証アクセスは deny
- universities など共通マスタを追加する場合は read のみ開放、write は管理者限定

## 10. DOM セレクタ契約

本章のセレクタは、将来変更時にまず更新すべき契約です。

- courseLinkSelector: a[href*='course.php']
- taskItemSelector: .cl-contentsList_content
- dashboardMountPoint: WebClass 時間割画面の左ペイン先頭

セレクタ変更時の実装ルール:
- 文字列を単一点管理 (selectors 定数) する
- 本番変更前に最低 3 科目以上で同期確認する

## 11. Google Calendar 連携仕様

### 11.1 個別追加

- 課題カードのボタン押下で 1 件追加
- 成功時は calendarSynced=true
- 失敗時は UI 通知と syncLogs 記録

### 11.2 一括追加

- フィルタ後の可視課題を対象に逐次登録
- API 制限対策として短い間隔で送信する

### 11.3 競合時ポリシー

- 同一 taskKey で既存 calendarEventId がある場合は重複作成しない

## 12. 権限と設定

### 12.1 Chrome 権限

- storage
- identity
- alarms
- host_permissions: https://rpwebcls.meijo-u.ac.jp/webclass/*

### 12.2 環境変数

- VITE_FIREBASE_API_KEY
- VITE_FIREBASE_AUTH_DOMAIN
- VITE_FIREBASE_PROJECT_ID
- VITE_FIREBASE_STORAGE_BUCKET
- VITE_FIREBASE_MESSAGING_SENDER_ID
- VITE_FIREBASE_APP_ID

## 13. エラーハンドリング仕様

エラー分類:
- E_AUTH_REQUIRED: 未ログイン
- E_SELECTOR_NOT_FOUND: DOM 変更疑い
- E_IFRAME_TIMEOUT: 科目ページ読み込み失敗
- E_DB_WRITE_FAILED: Firestore 書き込み失敗
- E_CALENDAR_FAILED: Calendar 追加失敗

表示仕様:
- 画面内通知エリアに最新エラーを表示
- 同期サマリに件数表示 (成功件数/失敗件数)

## 14. 受け入れ基準

AC-01:
- WebClass 時間割画面表示後、5 秒以内にダッシュボードが表示される

AC-02:
- 手動再同期後、一覧が再取得結果で更新される

AC-03:
- 期限切れ課題は表示されない

AC-04:
- courseId/taskId が取得できる課題で重複が発生しない

AC-05:
- 同期失敗時にユーザーへ UI 通知される

AC-06:
- 個別追加・一括追加で Calendar 追加できる

AC-07:
- 認証なし状態ではデータ保存が拒否される

## 15. 実装タスクの優先順

P0:
- Google ログイン導入
- users/{uid}/tasks スキーマで保存処理へ移行
- ダッシュボード UI の最小実装

P1:
- Timestamp 正規化
- 重複判定の C 優先 + A フォールバック実装
- 同期エラー通知

P2:
- Calendar 個別追加
- Calendar 一括追加
- フィルタ/完了チェック

## 16. 現状実装との差分

- popup はテンプレート画面で、要件 UI は未実装
- 認証必須化と users/{uid} 分離保存は未実装
- 期限は文字列抽出中心で Timestamp 化が未完了
- 主キーは現状 courseName + title 中心
- background の本格利用は未着手

## 17. AI 実装ガイド

この章は、AI に実装依頼するときの最小指示セットです。

必須順序:
1. 認証導入 (FR-05)
2. DB スキーマ移行 (第8章)
3. 同期ロジック改修 (第7章)
4. ダッシュボード UI (第6章 FR-06)
5. Calendar 連携 (第11章)

完了条件:
- 受け入れ基準 AC-01 から AC-07 を満たす
- E2E 手順で手動同期と個別カレンダー追加が再現できる
