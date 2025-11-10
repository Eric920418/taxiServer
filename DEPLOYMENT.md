# 部署腳本使用說明

## 📜 可用腳本

### 1. `./deploy.sh` - 標準部署腳本（推薦）
**用途**：從 Git 拉取最新代碼並自動部署

**執行步驟**：
- 拉取最新代碼 (git pull)
- 安裝/更新依賴 (pnpm install)
- 編譯 TypeScript (pnpm build)
- 重啟 PM2 進程
- 顯示運行狀態

**使用場景**：
- 從 GitHub 更新代碼後部署
- 定期更新生產環境

**命令**：
```bash
cd /var/www/taxiServer
./deploy.sh
```

---

### 2. `./restart.sh` - 快速重啟腳本
**用途**：僅重新編譯和重啟（不拉取代碼）

**執行步驟**：
- 重新編譯 TypeScript
- 重啟 PM2 進程
- 顯示運行狀態

**使用場景**：
- 本地修改代碼後快速測試
- 修改環境變數後重啟
- 不需要從 Git 更新

**命令**：
```bash
cd /var/www/taxiServer
./restart.sh
```

---

### 3. `./update-and-deploy.sh` - 互動式完整部署
**用途**：完整的互動式部署流程（含確認步驟）

**執行步驟**：
- 顯示 Git 狀態
- 詢問是否拉取代碼（互動式）
- 安裝/更新依賴
- 檢查環境變數
- 編譯 TypeScript
- 重啟 PM2 進程
- 保存 PM2 配置
- 顯示詳細日誌

**使用場景**：
- 重要更新前需要確認
- 需要查看 Git 狀態再決定
- 完整的手動控制流程

**命令**：
```bash
cd /var/www/taxiServer
./update-and-deploy.sh
```

---

## 🔄 常見部署流程

### 情況 1：GitHub 有新代碼更新
```bash
cd /var/www/taxiServer
./deploy.sh
```

### 情況 2：本地修改了代碼
```bash
# 方案 A：提交到 Git 再部署
git add .
git commit -m "fix: 修復某個問題"
git push origin main
./deploy.sh

# 方案 B：直接重啟（不提交）
./restart.sh
```

### 情況 3：只修改了 .env 環境變數
```bash
./restart.sh
```

### 情況 4：更新了 package.json 依賴
```bash
./deploy.sh
# 或
./update-and-deploy.sh
```

---

## 🛠️ PM2 管理命令

### 查看狀態
```bash
pm2 status
pm2 status taxiserver
```

### 查看日誌
```bash
# 即時日誌（會持續顯示）
pm2 logs taxiserver

# 最近 50 行日誌
pm2 logs taxiserver --lines 50 --nostream

# 只看錯誤日誌
pm2 logs taxiserver --err
```

### 重啟/停止/啟動
```bash
# 重啟
pm2 restart taxiserver

# 停止
pm2 stop taxiserver

# 啟動
pm2 start taxiserver

# 刪除進程
pm2 delete taxiserver

# 重新啟動（從頭開始）
pm2 start dist/index.js --name taxiserver
```

### 監控
```bash
# 即時監控 CPU 和內存
pm2 monit

# 詳細資訊
pm2 info taxiserver
```

---

## 🚨 故障排除

### 問題：部署後 Server 無法啟動

**檢查步驟**：
```bash
# 1. 查看詳細日誌
pm2 logs taxiserver --lines 100

# 2. 檢查 PM2 狀態
pm2 status

# 3. 檢查編譯錯誤
pnpm run build

# 4. 檢查環境變數
cat .env

# 5. 測試資料庫連接
PGPASSWORD='TaxiServer2025!@#' psql -h localhost -U postgres -d hualien_taxi -c "SELECT 1;"
```

### 問題：Git pull 失敗

**解決方案**：
```bash
# 檢查 Git 狀態
git status

# 如果有本地修改，先暫存
git stash

# 拉取代碼
git pull origin main

# 恢復本地修改
git stash pop
```

### 問題：端口已被佔用

**解決方案**：
```bash
# 查看佔用 3000 端口的進程
sudo lsof -i :3000

# 強制停止並重啟
pm2 delete taxiserver
pm2 start dist/index.js --name taxiserver
pm2 save
```

---

## 📦 完整重新部署（緊急情況）

如果一切都不正常，執行完整重置：

```bash
# 1. 停止並刪除 PM2 進程
pm2 delete taxiserver

# 2. 清理編譯輸出
rm -rf dist/

# 3. 清理依賴（可選）
rm -rf node_modules/

# 4. 重新安裝依賴
pnpm install

# 5. 重新編譯
pnpm run build

# 6. 啟動 Server
pm2 start dist/index.js --name taxiserver

# 7. 保存配置
pm2 save

# 8. 查看狀態
pm2 status
pm2 logs taxiserver
```

---

## 🔐 安全提醒

- **不要**將 `.env` 文件提交到 Git
- **定期**備份資料庫：`pg_dump -U postgres hualien_taxi > backup.sql`
- **定期**更新系統：`sudo apt update && sudo apt upgrade`
- **監控**日誌檔案大小：`du -sh /home/ubuntu/.pm2/logs/`

---

## 📞 需要幫助？

- PM2 文檔：https://pm2.keymetrics.io/docs/usage/quick-start/
- 查看 README.md 獲取更多項目資訊
