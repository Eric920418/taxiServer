# 🚀 部署腳本快速參考

## 快速選擇指南

| 情況 | 使用腳本 | 命令 |
|------|---------|------|
| 📥 從 Git 更新並部署 | `deploy.sh` | `./deploy.sh` |
| ⚡ 只重啟不更新 | `restart.sh` | `./restart.sh` |
| 🔄 互動式完整部署 | `update-and-deploy.sh` | `./update-and-deploy.sh` |
| 🤖 自動化部署（無確認） | `deploy-no-confirm.sh` | `./deploy-no-confirm.sh` |

---

## 📜 腳本詳細說明

### 1. `deploy.sh` ⭐ 最常用
```bash
./deploy.sh
```
**做什麼**：
- ✅ Git pull 最新代碼
- ✅ 安裝依賴
- ✅ 編譯 TypeScript
- ✅ 重啟 PM2
- ✅ 顯示狀態

**什麼時候用**：
- GitHub 有新代碼推送
- 定期更新生產環境
- 拉取同事的更新

---

### 2. `restart.sh` ⚡ 最快速
```bash
./restart.sh
```
**做什麼**：
- ✅ 重新編譯
- ✅ 重啟 PM2
- ✅ 顯示狀態

**什麼時候用**：
- 修改了本地代碼
- 改了 .env 環境變數
- 需要快速重啟測試

---

### 3. `update-and-deploy.sh` 🔄 完整控制
```bash
./update-and-deploy.sh
```
**做什麼**：
- ✅ 顯示 Git 狀態
- ❓ 詢問是否拉取（互動）
- ✅ 安裝依賴
- ✅ 檢查 .env
- ✅ 編譯 TypeScript
- ✅ 重啟 PM2
- ✅ 保存 PM2 配置
- ✅ 顯示詳細日誌

**什麼時候用**：
- 重要更新前需要確認
- 想先看 Git 狀態
- 需要完整部署流程

---

### 4. `deploy-no-confirm.sh` 🤖 自動化
```bash
./deploy-no-confirm.sh
```
**做什麼**：
- ✅ 自動 Git pull
- ✅ 安裝依賴
- ✅ 編譯 TypeScript
- ✅ 重啟 PM2
- ✅ 健康檢查
- ✅ 記錄到日誌文件

**什麼時候用**：
- Cron 定時任務
- CI/CD 自動部署
- Webhook 觸發部署

---

## 🔧 PM2 常用命令

```bash
# 查看狀態
pm2 status

# 查看即時日誌
pm2 logs taxiserver

# 查看最近 50 行日誌
pm2 logs taxiserver --lines 50 --nostream

# 重啟
pm2 restart taxiserver

# 停止
pm2 stop taxiserver

# 啟動
pm2 start taxiserver

# 監控 CPU 和內存
pm2 monit
```

---

## 📝 實際使用範例

### 範例 1：每天早上從 GitHub 更新
```bash
cd /var/www/taxiServer
./deploy.sh
```

### 範例 2：修改了 API 代碼，快速測試
```bash
# 編輯代碼
nano src/api/orders.ts

# 快速重啟
./restart.sh

# 查看日誌確認
pm2 logs taxiserver
```

### 範例 3：修改環境變數
```bash
# 編輯 .env
nano .env

# 重啟讓變更生效
./restart.sh
```

### 範例 4：設置每天自動更新（Crontab）
```bash
# 編輯 crontab
crontab -e

# 添加以下行（每天凌晨 3 點自動部署）
0 3 * * * cd /var/www/taxiServer && ./deploy-no-confirm.sh >> /var/www/taxiServer/cron-deploy.log 2>&1
```

---

## 🚨 緊急情況處理

### Server 掛了怎麼辦？
```bash
# 1. 查看狀態
pm2 status

# 2. 查看錯誤日誌
pm2 logs taxiserver --err --lines 50

# 3. 嘗試重啟
./restart.sh

# 4. 如果還是不行，完整重啟
pm2 delete taxiserver
pnpm run build
pm2 start dist/index.js --name taxiserver
pm2 save
```

### 部署失敗怎麼辦？
```bash
# 1. 查看具體錯誤
cat /var/www/taxiServer/deploy.log

# 2. 回滾到上一個版本
git log --oneline -5
git reset --hard <上一個commit>
./restart.sh

# 3. 手動執行每個步驟排查
git pull origin main
pnpm install
pnpm run build
pm2 restart taxiserver
```

---

## 📊 查看部署日誌

```bash
# 查看最近的部署日誌
tail -f /var/www/taxiServer/deploy.log

# 查看 PM2 日誌
tail -f /home/ubuntu/.pm2/logs/taxiserver-out.log
tail -f /home/ubuntu/.pm2/logs/taxiserver-error.log
```

---

## 💡 最佳實踐

1. **定期更新**：每週至少執行一次 `./deploy.sh`
2. **測試先行**：重要更新先在測試環境測試
3. **備份資料庫**：部署前備份
   ```bash
   pg_dump -U postgres hualien_taxi > backup_$(date +%Y%m%d_%H%M%S).sql
   ```
4. **查看日誌**：每次部署後查看日誌確認
5. **保持 Git 清潔**：不要在生產環境直接修改代碼

---

## 🔗 更多資訊

- 詳細部署說明：查看 `DEPLOYMENT.md`
- 項目文檔：查看 `README.md`
- 快速開始：查看 `QUICK_START.md`
