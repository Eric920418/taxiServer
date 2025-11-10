#!/bin/bash

# 花蓮計程車 Server - 快速重啟腳本
# 用途：僅重新編譯和重啟（不拉取代碼）
# 使用方式：./restart.sh

set -e

echo "╔════════════════════════════════════════════╗"
echo "║   花蓮計程車 Server - 快速重啟             ║"
echo "╚════════════════════════════════════════════╝"
echo ""

# 顏色定義
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PROJECT_DIR="/var/www/taxiServer"

echo -e "${YELLOW}[1/3]${NC} 進入項目目錄..."
cd "$PROJECT_DIR"
echo -e "${GREEN}✓${NC} 當前目錄: $(pwd)"
echo ""

echo -e "${YELLOW}[2/3]${NC} 重新編譯 TypeScript..."
pnpm run build
echo -e "${GREEN}✓${NC} 編譯完成"
echo ""

echo -e "${YELLOW}[3/3]${NC} 重啟 PM2 進程..."
pm2 restart taxiserver
echo -e "${GREEN}✓${NC} Server 重啟完成"
echo ""

pm2 status taxiserver
echo ""

echo -e "${GREEN}╔════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║              重啟完成！                     ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════╝${NC}"
