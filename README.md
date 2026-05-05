# 間歇運動計時器 — Firebase 雲端版

iOS 風格的間歇訓練計時器，**Google 登入後**自動同步設定到雲端，並記錄每次訓練。

## 功能（在原版功能之上）

- **Google 一鍵登入**（Firebase Auth）
- **跨裝置同步** — 階段、回合、開關設定即時同步到 Firestore
- **訓練紀錄** — 每次完成的訓練自動寫入雲端
- **統計儀表板** — 總訓練次數、總時間、連續天數、本週次數
- **歷史紀錄列表** — 最近 100 筆，可單筆刪除
- **離線可用** — 未登入時退化為 localStorage（同原版體驗）

## 檔案結構

```
interval-timer-firebase/
├── index.html
├── style.css
├── app.js                      # 主邏輯（ES module）
├── firebase.js                 # Firebase Auth + Firestore wrapper
├── firestore.rules             # 安全規則（要貼到 Firebase Console）
├── .github/workflows/deploy.yml
└── README.md
```

## ⚠️ 上線前必做（Firebase Console）

### 1. 啟用 Authentication

到 <https://console.firebase.google.com/> → 進專案 `interval-timer-cec3f` → **Build → Authentication**：

- **Sign-in method** 啟用 **Google**

### 2. 加入 Authorized domains

仍在 Authentication → **Settings → Authorized domains**，**新增**：

```
tom-riddle-sr.github.io
```

（`localhost` 預設已包含。如果你還會用其他網域，也加進去。）

### 3. 建立 Firestore Database

**Build → Firestore Database → Create database**：

- 模式：**Production mode**
- 地區：**asia-east1**（或就近的）

### 4. 套用安全規則

進 Firestore → **Rules** 分頁，把 `firestore.rules` 的內容整段貼上去 → **Publish**：

```js
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid}/{document=**} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
  }
}
```

這條規則確保每個使用者只能讀寫自己的資料。

## 部署到 GitHub Pages

跟原版一樣：

```bash
cd interval-timer-firebase
gh repo create interval-timer-firebase --public --source=. --remote=origin --push
gh api -X POST "repos/{owner}/{repo}/pages" -f build_type=workflow
```

或合併到既有的 repo 也可以（直接放在原 repo 下另一個資料夾，網址會是 `https://tom-riddle-sr.github.io/interval-timer/firebase/`）。

## 資料模型（Firestore）

```
users/{uid}/
  meta/settings           # 階段、回合、開關
  workouts/{auto}         # 每次訓練紀錄
    - startedAt:  number   (epoch ms)
    - completedAt: serverTimestamp
    - durationSec: number
    - rounds: number
    - stages: [{ name, duration, color, phase }]
```

## 鍵盤快捷鍵（執行中）

| 按鍵 | 動作 |
|------|------|
| Space | 暫停 / 繼續 |
| → | 下一階段 |
| ← | 上一階段 / 重置目前階段 |
| Esc | 結束訓練 |

## 安全性說明

`firebaseConfig` 中的 `apiKey` 是**前端公開金鑰**，本來就會出現在瀏覽器，不是機密。真正的安全靠 Firestore Rules + Authorized domains 限制。

## 授權

MIT
