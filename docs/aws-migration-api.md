# API仕様とフロント移行手順（Cognito排除構成）

本書は、既存のフロントエンド（拡張機能）実装を極力維持しながら、Firebase依存をHTTP APIへ段階的に置換するための仕様書です。

## 前提

- 認証はGoogleのみ
- フロントはDOM解析を継続
- 同期はDOM解析時にオンデマンド実行
- フロントからAPIを呼び出す

## 1. API仕様（Request/Responseマッピング）

### 1.1 Task型（APIレベル）

既存 `ExtractedTask` に準拠する。

```json
{
  "taskKey": "string",
  "course": "string",
  "title": "string",
  "endAtRaw": "string",
  "endAtMs": 1717410000000,
  "taskUrl": "string|null",
  "courseId": "string|null",
  "taskId": "string|null",
  "source": "WebClass_AutoSync|GoogleClassroom",
  "hidden": true,
  "hiddenUntil": 1717410000000,
  "hiddenAt": 1717410000000
}
```

### 1.2 DynamoDB吸収ポイント

- PK: `userId`
- SK: `taskKey`
- `taskKey` は現行の生成ロジックを温存
- 同一 `taskKey` は上書きでidempotent

### 1.3 POST /tasks/upsert

**目的**

Firestore `setDoc(..., { merge: true })` 相当のupsert。

**更新ルール**

- DynamoDBは `PutItem` ではなく `UpdateItem` を使用
- Requestで渡されたフィールドのみ `SET`
- `hidden`, `hiddenUntil`, `hiddenAt` は保持（上書きしない）

**Request**

```json
{
  "tasks": [
    {
      "taskKey": "string",
      "course": "string",
      "title": "string",
      "endAtRaw": "string",
      "endAtMs": 1717410000000,
      "taskUrl": "string|null",
      "courseId": "string|null",
      "taskId": "string|null",
      "source": "WebClass_AutoSync|GoogleClassroom"
    }
  ],
  "clientUpdatedAt": 1717410000000
}
```

**Response**

```json
{
  "ok": true,
  "upserted": 12,
  "skipped": 0,
  "errors": []
}
```

**Error例**

```json
{ "ok": false, "message": "Invalid taskKey" }
```

### 1.4 GET /tasks

**目的**

Firestore `getDocs + orderBy(updatedAt) + limit` 相当。

**Query**

- `limit` (default: 120)
- `since` (optional, unix ms)
- `includeHidden` (optional, default: false)

**Response**

```json
{
  "ok": true,
  "tasks": [
    {
      "taskKey": "string",
      "course": "string",
      "title": "string",
      "endAtRaw": "string",
      "endAtMs": 1717410000000,
      "taskUrl": "string|null",
      "courseId": "string|null",
      "taskId": "string|null",
      "source": "WebClass_AutoSync|GoogleClassroom",
      "hidden": false
    }
  ],
  "serverTime": 1717410000000
}
```

**補足**

- `includeHidden=false` の場合は `hidden` を除外
- `includeHidden=true` で非表示タスクを含める

## 2. フロント移行方針（Firebase -> fetch）

### 2.1 置換対象（概念）

現行の呼び出し順は以下。

```
ensureSignedIn -> upsertTask -> loadTasksFromDb
```

これをAPIラッパーに置換。

```
ensureSignedIn (JWTチェック) -> apiUpsertTasks -> apiGetTasks
```

### 2.2 Before/Afterの構造

**Before（概念）**

```ts
await upsertTask(uid, task);
const dbTasks = await loadTasksFromDb(uid);
```

**After（概念）**

```ts
await apiUpsertTasks([task]);
const dbTasks = await apiGetTasks();
```

### 2.3 置換方針

- `ensureSignedIn` はJWTの有効性確認に簡略化
- `upsertTask` / `loadTasksFromDb` はHTTP APIラッパに差し替え
- Firebase依存 import を削除し、`api.ts` を新設するのが最小変更

## 3. 認証の境界（Authヘッダー / Cookie）

### 3.1 トークンの役割

- Access JWT: `Authorization: Bearer <token>`
- Refresh JWT: HttpOnly Cookie

### 3.2 fetchの作法

```ts
const res = await fetch(`${API_BASE}/tasks`, {
  method: "GET",
  headers: {
    "Authorization": `Bearer ${accessToken}`
  },
  credentials: "include"
});
```

### 3.3 401時のリフレッシュ

- 401を検知したら `/auth/refresh` を呼び出す
- RefreshはCookieで完結し、JS側でトークンを触らない
- 多重発火を防ぐため、リフレッシュ中は他のAPI呼び出しを待機させる

### 3.4 Cookie推奨設定

- `HttpOnly; Secure; SameSite=None; Path=/; Max-Age=2592000`

**補足**

- Chrome拡張機能からのクロスオリジン通信を想定するため `SameSite=None` が必須
- CORSで拡張機能のOriginを許可する

## 4. DOM解析の変更を想定した安全策

- `taskKey` と `source` を維持する限り、下流のデータ構造は安定
- 解析対象の変更があっても `/tasks/upsert` の契約は維持する
