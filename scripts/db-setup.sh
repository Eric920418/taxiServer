#!/bin/bash

# 花蓮計程車系統 - 資料庫設定腳本
# 用途：建立 PostgreSQL 資料庫和測試資料

set -e  # 遇到錯誤立即停止

echo "============================================"
echo "  花蓮計程車系統 - 資料庫初始化"
echo "============================================"
echo ""

# 顏色定義
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0;0m' # No Color

# 檢查 PostgreSQL 是否安裝
if ! command -v psql &> /dev/null; then
    echo -e "${RED}✗ PostgreSQL 未安裝${NC}"
    echo ""
    echo "請先安裝 PostgreSQL:"
    echo "  macOS:   brew install postgresql@15"
    echo "  Ubuntu:  sudo apt install postgresql postgresql-contrib"
    echo "  其他:    https://www.postgresql.org/download/"
    exit 1
fi

echo -e "${GREEN}✓ PostgreSQL 已安裝${NC}"

# 載入環境變數
if [ -f ../.env ]; then
    export $(cat ../.env | grep -v '^#' | xargs)
fi

# 資料庫設定（從環境變數或預設值）
DB_HOST=${DB_HOST:-localhost}
DB_PORT=${DB_PORT:-5432}
DB_NAME=${DB_NAME:-hualien_taxi}
DB_USER=${DB_USER:-postgres}
DB_PASSWORD=${DB_PASSWORD:-}

echo ""
echo "資料庫連線資訊:"
echo "  Host:     $DB_HOST"
echo "  Port:     $DB_PORT"
echo "  Database: $DB_NAME"
echo "  User:     $DB_USER"
echo ""

# 詢問是否繼續
read -p "是否繼續建立資料庫? (y/n) " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "已取消"
    exit 0
fi

# 步驟 1: 建立資料庫（如果不存在）
echo ""
echo "步驟 1: 建立資料庫..."
if [ -z "$DB_PASSWORD" ]; then
    psql -h $DB_HOST -U $DB_USER -tc "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME'" | grep -q 1 || psql -h $DB_HOST -U $DB_USER -c "CREATE DATABASE $DB_NAME"
else
    PGPASSWORD=$DB_PASSWORD psql -h $DB_HOST -U $DB_USER -tc "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME'" | grep -q 1 || PGPASSWORD=$DB_PASSWORD psql -h $DB_HOST -U $DB_USER -c "CREATE DATABASE $DB_NAME"
fi

echo -e "${GREEN}✓ 資料庫 '$DB_NAME' 已建立或已存在${NC}"

# 步驟 2: 執行 Schema（建立資料表）
echo ""
echo "步驟 2: 建立資料表..."
cd ..
if [ -z "$DB_PASSWORD" ]; then
    psql -h $DB_HOST -U $DB_USER -d $DB_NAME -f src/db/schema.sql
else
    PGPASSWORD=$DB_PASSWORD psql -h $DB_HOST -U $DB_USER -d $DB_NAME -f src/db/schema.sql
fi

echo -e "${GREEN}✓ 資料表建立完成${NC}"

# 步驟 3: 插入測試資料
echo ""
echo "步驟 3: 插入測試資料..."
pnpm exec ts-node src/db/init.ts

echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}  ✓ 資料庫初始化完成！${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""
echo "測試帳號:"
echo "  司機 1: 0912345678 / 123456 (王大明)"
echo "  司機 2: 0987654321 / 123456 (李小華)"
echo "  司機 3: 0965432100 / 123456 (陳建國)"
echo "  乘客 1: 0911111111 (測試乘客A)"
echo ""
echo "下一步:"
echo "  1. 啟動 server:    pnpm dev"
echo "  2. 測試 API:       curl http://localhost:3000/health"
echo "  3. 查看資料庫:     psql -h $DB_HOST -U $DB_USER -d $DB_NAME"
echo ""
