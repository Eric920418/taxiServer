#!/bin/bash

# 花蓮計程車 Server - 完整更新部署腳本
# 用途：從 Git 更新代碼並完整部署（包含數據庫遷移）
# 使用方式：./update-and-deploy.sh

set -e

echo "╔════════════════════════════════════════════╗"
echo "║   花蓮計程車 Server - 完整更新部署         ║"
echo "╚════════════════════════════════════════════╝"
echo ""

# 顏色定義
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

PROJECT_DIR="/var/www/taxiServer"

echo -e "${YELLOW}[1/8]${NC} 進入項目目錄..."
cd "$PROJECT_DIR"
echo -e "${GREEN}✓${NC} 當前目錄: $(pwd)"
echo ""

echo -e "${YELLOW}[2/8]${NC} 顯示當前分支和狀態..."
git branch
git status --short
echo ""

echo -e "${BLUE}是否要拉取最新代碼? (y/n)${NC}"
read -r -p "> " response
if [[ "$response" =~ ^([yY][eE][sS]|[yY])$ ]]; then
    echo -e "${YELLOW}[3/8]${NC} 拉取最新代碼..."
    git pull origin main
    echo -e "${GREEN}✓${NC} 代碼更新完成"
else
    echo -e "${YELLOW}[3/8]${NC} 跳過代碼更新"
fi
echo ""

echo -e "${YELLOW}[4/8]${NC} 安裝/更新依賴..."
pnpm install
echo -e "${GREEN}✓${NC} 依賴安裝完成"
echo ""

echo -e "${YELLOW}[5/8]${NC} 檢查環境變數..."
if [ -f .env ]; then
    echo -e "${GREEN}✓${NC} .env 文件存在"
else
    echo -e "${RED}✗${NC} .env 文件不存在，請創建"
    exit 1
fi
echo ""

echo -e "${YELLOW}[6/8]${NC} 編譯 TypeScript..."
pnpm run build
echo -e "${GREEN}✓${NC} 編譯完成"
echo ""

echo -e "${YELLOW}[7/8]${NC} 重啟 PM2 進程..."
pm2 restart taxiserver
echo -e "${GREEN}✓${NC} Server 重啟完成"
echo ""

echo -e "${YELLOW}[8/8]${NC} 保存 PM2 配置..."
pm2 save
echo -e "${GREEN}✓${NC} PM2 配置已保存"
echo ""

echo -e "${YELLOW}📊 Server 狀態:${NC}"
pm2 status taxiserver
echo ""

echo -e "${YELLOW}📝 最近日誌 (最後 15 行):${NC}"
pm2 logs taxiserver --lines 15 --nostream
echo ""

echo -e "${GREEN}╔════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║          部署完成！Server 運行中            ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════╝${NC}"
echo ""
echo "可用命令:"
echo "  - 查看即時日誌: pm2 logs taxiserver"
echo "  - 查看狀態: pm2 status"
echo "  - 重啟 server: pm2 restart taxiserver"
echo "  - 停止 server: pm2 stop taxiserver"
echo ""
