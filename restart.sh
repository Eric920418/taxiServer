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

echo -e "${YELLOW}[1/5]${NC} 檢查並啟動 Redis..."
# 檢查 Redis 是否已經運行
if pgrep -x "redis-server" > /dev/null; then
    echo -e "${GREEN}✓${NC} Redis 已經在運行中"
else
    echo -e "${BLUE}→${NC} 啟動 Redis 服務..."
    if command -v redis-server &> /dev/null; then
        # 嘗試以背景模式啟動 Redis
        redis-server --daemonize yes --port 6379 2>/dev/null || {
            echo -e "${YELLOW}⚠${NC} 無法以 daemon 模式啟動 Redis，嘗試使用系統服務..."
            sudo systemctl start redis-server 2>/dev/null || sudo service redis-server start 2>/dev/null || {
                echo -e "${YELLOW}⚠${NC} 警告：Redis 啟動失敗，某些快取功能可能無法使用"
            }
        }
        sleep 1
        # 驗證 Redis 是否啟動成功
        if redis-cli ping &> /dev/null; then
            echo -e "${GREEN}✓${NC} Redis 啟動成功"
        else
            echo -e "${YELLOW}⚠${NC} Redis 可能未正確啟動"
        fi
    else
        echo -e "${YELLOW}⚠${NC} 警告：未找到 redis-server，請先安裝 Redis"
        echo -e "${BLUE}→${NC} 安裝指令: sudo apt-get install redis-server"
    fi
fi
echo ""

echo -e "${YELLOW}[2/5]${NC} 進入項目目錄..."
cd "$PROJECT_DIR"
echo -e "${GREEN}✓${NC} 當前目錄: $(pwd)"
echo ""

echo -e "${YELLOW}[3/5]${NC} 重新編譯後端 TypeScript..."
pnpm run build
echo -e "${GREEN}✓${NC} 後端編譯完成"
echo ""

echo -e "${YELLOW}[4/5]${NC} 建構管理後台..."
cd "$ADMIN_DIR"
if [ ! -d "node_modules" ]; then
    echo -e "${BLUE}→${NC} 首次執行，安裝前端依賴..."
    npm install --legacy-peer-deps
fi
echo -e "${BLUE}→${NC} 建構前端..."
npm run build
echo -e "${GREEN}✓${NC} 管理後台建構完成"
echo ""

echo -e "${YELLOW}[5/5]${NC} 重啟 PM2 進程..."
cd "$PROJECT_DIR"
pm2 restart taxiserver
echo -e "${GREEN}✓${NC} Server 重啟完成"
echo ""

# 顯示服務狀態
echo -e "${BLUE}→${NC} 服務狀態檢查..."
pm2 status taxiserver
echo ""

# 檢查 Redis 連線狀態
if redis-cli ping &> /dev/null; then
    REDIS_MEMORY=$(redis-cli info memory 2>/dev/null | grep "used_memory_human" | cut -d: -f2 | tr -d '\r')
    REDIS_KEYS=$(redis-cli dbsize 2>/dev/null | cut -d: -f2 | tr -d ' \r')
    echo -e "${GREEN}✓${NC} Redis 運行中"
    echo -e "  └─ 記憶體使用: ${REDIS_MEMORY}"
    echo -e "  └─ 快取鍵數量: ${REDIS_KEYS}"
else
    echo -e "${YELLOW}⚠${NC} Redis 未連接（某些功能可能受限）"
fi
echo ""

echo -e "${GREEN}╔════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║              重啟完成！                     ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${BLUE}訪問管理後台：${NC} http://localhost:3000/admin"
echo -e "${BLUE}登入帳號：${NC} admin / admin123"
echo ""
