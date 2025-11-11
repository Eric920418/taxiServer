#!/bin/bash

# 花蓮計程車 Server - 快速重啟腳本（含管理後台）
# 用途：重新編譯後端、建構前端、重啟服務
# 使用方式：./restart.sh

set -e

echo "╔════════════════════════════════════════════╗"
echo "║   花蓮計程車 Server - 快速重啟             ║"
echo "╚════════════════════════════════════════════╝"
echo ""

# 顏色定義
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

PROJECT_DIR="/var/www/taxiServer"
ADMIN_DIR="$PROJECT_DIR/admin-panel"

echo -e "${YELLOW}[1/4]${NC} 進入項目目錄..."
cd "$PROJECT_DIR"
echo -e "${GREEN}✓${NC} 當前目錄: $(pwd)"
echo ""

echo -e "${YELLOW}[2/4]${NC} 重新編譯後端 TypeScript..."
pnpm run build
echo -e "${GREEN}✓${NC} 後端編譯完成"
echo ""

echo -e "${YELLOW}[3/4]${NC} 建構管理後台..."
cd "$ADMIN_DIR"
if [ ! -d "node_modules" ]; then
    echo -e "${BLUE}→${NC} 首次執行，安裝前端依賴..."
    npm install --legacy-peer-deps
fi
echo -e "${BLUE}→${NC} 建構前端..."
npm run build
echo -e "${GREEN}✓${NC} 管理後台建構完成"
echo ""

echo -e "${YELLOW}[4/4]${NC} 重啟 PM2 進程..."
cd "$PROJECT_DIR"
pm2 restart taxiserver
echo -e "${GREEN}✓${NC} Server 重啟完成"
echo ""

pm2 status taxiserver
echo ""

echo -e "${GREEN}╔════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║              重啟完成！                     ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${BLUE}訪問管理後台：${NC} http://localhost:3000/admin"
echo -e "${BLUE}登入帳號：${NC} admin / admin123"
echo ""
