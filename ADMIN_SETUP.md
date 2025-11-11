# 管理後台整合說明

## ✅ 已完成整合

管理後台已經**完全整合**到主服務中，不需要額外的服務或腳本！

## 🚀 使用方式

### 重啟服務（會自動建構管理後台）

```bash
./restart.sh
```

這個腳本會自動：
1. 編譯後端 TypeScript
2. 建構管理後台前端
3. 重啟 PM2 服務

### 訪問管理後台

**網址**: `http://your-server:3000/admin`

**登入資訊**:
- 使用者名稱: `admin`
- 密碼: `admin123`

⚠️ **請在首次登入後立即修改密碼！**

## 📋 架構說明

```
同一個 Express Server (Port 3000)
├── / ..................... 主 API (司機、乘客端)
├── /api/admin ............ 管理員 API
├── /admin ................ 管理後台前端 (靜態檔案)
└── WebSocket ............. 即時通訊
```

### 優點
- ✅ 只需要一個服務
- ✅ 只需要一個 Port (3000)
- ✅ 統一管理和部署
- ✅ 自動整合 API（相同網域，無 CORS 問題）

## 🔄 更新流程

當您修改管理後台程式碼時：

```bash
./restart.sh  # 會自動重新建構並重啟
```

## 📂 檔案結構

```
/var/www/taxiServer/
├── src/
│   ├── index.ts .......... 後端主程式（已整合管理後台路由）
│   └── api/admin.ts ...... 管理員 API
├── admin-panel/
│   ├── src/ .............. 管理後台原始碼
│   └── dist/ ............. 建構後的靜態檔案（由 restart.sh 自動生成）
└── restart.sh ............ 統一重啟腳本
```

## 🔧 開發模式

如果需要開發管理後台（即時預覽）：

```bash
cd admin-panel
npm run dev  # 會在 http://localhost:5173 啟動開發服務器
```

開發完成後執行 `./restart.sh` 部署到生產環境。

## 🛡️ 安全建議

1. 修改預設管理員密碼
2. 設定防火牆限制管理後台訪問 IP
3. 使用 HTTPS（建議配置 Nginx 反向代理）
4. 定期更新依賴套件

## 📞 問題排查

### 管理後台無法訪問
- 確認服務是否啟動: `pm2 status taxiserver`
- 檢查 dist 目錄是否存在: `ls admin-panel/dist`
- 重新建構: `./restart.sh`

### API 調用失敗
- 檢查後端日誌: `pm2 logs taxiserver`
- 確認管理員資料表已建立:
  ```bash
  psql -U postgres -d hualien_taxi -c "SELECT * FROM admins;"
  ```

---

最後更新: 2024-11-11
