# 花蓮計程車管理後台系統

## 🚀 系統概述

這是一個完整的計程車平台管理後台系統，提供給平台管理人員使用，可以管理司機、乘客、訂單，並查看各項營運數據。

## ✨ 功能特色

### 已完成功能

1. **管理員認證系統**
   - JWT Token 認證
   - 角色權限控制（超級管理員、管理員、操作員）
   - 安全的密碼加密儲存

2. **司機管理**
   - 司機列表查看（分頁、搜尋、篩選）
   - 新增司機
   - 編輯司機資料
   - 封鎖/解除封鎖司機
   - 查看司機詳細資料和統計

3. **乘客管理**
   - 乘客列表查看
   - 查看乘客詳情
   - 封鎖/解除封鎖乘客
   - 查看乘客歷史訂單

4. **訂單管理**
   - 訂單列表（支援多條件篩選）
   - 訂單詳情查看
   - 訂單狀態追蹤
   - 糾紛處理功能

5. **營運儀表板**
   - 即時統計數據
   - 營收趨勢圖表
   - 訂單狀態分布
   - 熱門時段分析

6. **即時監控**
   - 司機在線狀態
   - 訂單即時更新
   - 系統狀態監控

## 🛠 技術架構

### 前端技術棧
- **框架**: React 18 + TypeScript
- **UI 組件庫**: Ant Design 5.x
- **狀態管理**: Redux Toolkit
- **路由**: React Router v6
- **圖表**: Ant Design Charts / Recharts
- **地圖**: Leaflet / Google Maps
- **HTTP 客戶端**: Axios
- **建構工具**: Vite

### 後端技術棧
- **運行環境**: Node.js + TypeScript
- **框架**: Express.js
- **資料庫**: PostgreSQL
- **認證**: JWT + bcrypt
- **即時通訊**: Socket.IO
- **API 文檔**: RESTful API

## 📦 安裝與部署

### 前置需求
- Node.js 16+
- PostgreSQL 12+
- npm 或 pnpm

### 1. 安裝後端依賴

```bash
cd /var/www/taxiServer
npm install bcryptjs jsonwebtoken @types/bcryptjs @types/jsonwebtoken
```

### 2. 設置資料庫

執行資料庫初始化腳本：

```bash
psql -U your_db_user -d your_database < src/db/create_admin_tables.sql
```

### 3. 創建預設管理員

```bash
node scripts/create_admin.js
```

將輸出的密碼 hash 更新到資料庫中。

### 4. 安裝前端依賴

```bash
cd admin-panel
npm install
```

### 5. 配置環境變數

複製並編輯環境變數檔案：

```bash
cp .env.example .env
```

編輯 `.env` 檔案，設定正確的 API URL：

```env
VITE_API_BASE_URL=http://your-server:3000/api
```

### 6. 啟動服務

#### 開發模式

後端：
```bash
cd /var/www/taxiServer
npm run dev
```

前端：
```bash
cd admin-panel
npm run dev
```

#### 生產模式

建構前端：
```bash
cd admin-panel
npm run build
```

部署靜態檔案到 Web 服務器（nginx/apache）。

## 🔐 預設登入資訊

- **使用者名稱**: admin
- **密碼**: admin123

⚠️ **重要**: 請在首次登入後立即修改密碼！

## 📱 使用說明

### 司機管理

1. **新增司機**
   - 點擊「新增司機」按鈕
   - 填寫司機基本資料
   - 系統會自動產生司機 ID

2. **封鎖司機**
   - 在司機列表中點擊封鎖圖標
   - 輸入封鎖原因
   - 被封鎖的司機將無法接單

3. **查看司機詳情**
   - 點擊眼睛圖標查看完整資料
   - 包含營運統計、評分、收入等

### 乘客管理

1. **查看乘客資料**
   - 可搜尋姓名或電話
   - 查看乘客的歷史訂單

2. **處理違規乘客**
   - 封鎖惡意乘客
   - 記錄封鎖原因

### 訂單管理

1. **訂單篩選**
   - 按狀態篩選
   - 按日期範圍篩選
   - 搜尋特定訂單

2. **處理糾紛**
   - 查看低評分訂單
   - 處理退款或補償

### 數據分析

1. **儀表板**
   - 查看即時營運數據
   - 監控關鍵指標

2. **報表**
   - 營收報表
   - 司機績效報表
   - 熱點分析

## 🔄 API 端點

### 管理員認證
- `POST /api/admin/auth/login` - 管理員登入
- `POST /api/admin/auth/logout` - 登出
- `GET /api/admin/auth/profile` - 取得個人資料
- `POST /api/admin/auth/change-password` - 修改密碼

### 司機管理
- `GET /api/admin/drivers` - 取得司機列表
- `GET /api/admin/drivers/:id` - 取得司機詳情
- `POST /api/admin/drivers` - 新增司機
- `PUT /api/admin/drivers/:id` - 更新司機資料
- `POST /api/admin/drivers/:id/block` - 封鎖司機
- `POST /api/admin/drivers/:id/unblock` - 解除封鎖

### 乘客管理
- `GET /api/admin/passengers` - 取得乘客列表
- `GET /api/admin/passengers/:id` - 取得乘客詳情
- `POST /api/admin/passengers/:id/block` - 封鎖乘客
- `POST /api/admin/passengers/:id/unblock` - 解除封鎖

### 訂單管理
- `GET /api/admin/orders` - 取得訂單列表
- `GET /api/admin/orders/:id` - 取得訂單詳情
- `POST /api/admin/orders/:id/cancel` - 取消訂單
- `POST /api/admin/orders/:id/dispute` - 處理糾紛

### 統計資料
- `GET /api/admin/statistics/dashboard` - 儀表板統計
- `GET /api/admin/statistics/revenue` - 營收統計
- `GET /api/admin/statistics/realtime` - 即時數據

## 🔒 安全性考量

1. **認證與授權**
   - 使用 JWT Token
   - 角色權限控制
   - Token 過期自動處理

2. **資料驗證**
   - 前端表單驗證
   - 後端 API 驗證
   - SQL 注入防護

3. **審計日誌**
   - 記錄所有管理操作
   - 可追溯操作歷史

## 🐛 已知問題與待辦事項

### 待完成功能
- [ ] 管理員管理介面
- [ ] 詳細的數據分析頁面
- [ ] 匯出報表功能
- [ ] 推播通知功能
- [ ] 批量操作功能

### 優化項目
- [ ] 實作 Redis 快取
- [ ] WebSocket 即時更新
- [ ] 國際化支援
- [ ] 深色模式

## 📝 開發指南

### 新增頁面
1. 在 `src/pages` 建立新頁面組件
2. 在 `App.tsx` 添加路由
3. 在 `MainLayout.tsx` 添加選單項

### 新增 API
1. 在 `src/api/admin.ts` 添加後端路由
2. 在 `src/services/api.ts` 添加前端 API 調用
3. 更新 Redux store（如需要）

## 🤝 聯絡與支援

如有問題或需要協助，請聯繫系統管理員。

## 📄 授權

本系統為花蓮計程車平台專屬使用。

---

**最後更新時間**: 2024-11-11