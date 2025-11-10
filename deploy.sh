#!/bin/bash

# 花蓮計程車 Server - 自動部署腳本
# 用途：更新代碼後自動重啟 server
# 使用方式：./deploy.sh

set -e  # 遇到錯誤立即停止

echo "╔════════════════════════════════════════════╗"
echo "║   花蓮計程車 Server - 自動部署腳本         ║"
echo "╚════════════════════════════════════════════╝"
echo ""

# 顏色定義
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# 項目目錄
PROJECT_DIR="/var/www/taxiServer"

echo -e "${YELLOW}[1/6]${NC} 進入項目目錄..."
cd "$PROJECT_DIR"
echo -e "${GREEN}✓${NC} 當前目錄: $(pwd)"
echo ""

echo -e "${YELLOW}[2/6]${NC} 拉取最新代碼..."
git pull origin main
echo -e "${GREEN}✓${NC} 代碼更新完成"
echo ""

echo -e "${YELLOW}[3/6]${NC} 安裝/更新依賴..."
pnpm install --frozen-lockfile
echo -e "${GREEN}✓${NC} 依賴安裝完成"
echo ""

echo -e "${YELLOW}[4/6]${NC} 編譯 TypeScript..."
pnpm run build
echo -e "${GREEN}✓${NC} TypeScript 編譯完成"
echo ""

echo -e "${YELLOW}[5/6]${NC} 重啟 PM2 進程..."
pm2 restart taxiserver
echo -e "${GREEN}✓${NC} Server 重啟完成"
echo ""

echo -e "${YELLOW}[6/6]${NC} 查看 Server 狀態..."
pm2 status taxiserver
echo ""

echo -e "${YELLOW}📝 查看最近日誌:${NC}"
pm2 logs taxiserver --lines 10 --nostream
echo ""

echo -e "${GREEN}╔════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║          部署完成！Server 已重啟            ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════╝${NC}"
echo ""
echo "查看即時日誌: pm2 logs taxiserver"
echo "查看狀態: pm2 status"
echo ""
