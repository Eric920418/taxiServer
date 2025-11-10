#!/bin/bash

# 花蓮計程車 Server - 無確認自動部署腳本
# 用途：自動化部署（用於 CI/CD 或定時任務）
# 使用方式：./deploy-no-confirm.sh

set -e

echo "╔════════════════════════════════════════════╗"
echo "║   花蓮計程車 Server - 自動部署 (無確認)    ║"
echo "╚════════════════════════════════════════════╝"
echo ""
echo "開始時間: $(date '+%Y-%m-%d %H:%M:%S')"
echo ""

# 顏色定義
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

PROJECT_DIR="/var/www/taxiServer"
LOG_FILE="/var/www/taxiServer/deploy.log"

# 記錄日誌函數
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

log "========== 開始部署 =========="

echo -e "${YELLOW}[1/7]${NC} 進入項目目錄..."
cd "$PROJECT_DIR" || { log "錯誤: 無法進入項目目錄"; exit 1; }
log "當前目錄: $(pwd)"
echo ""

echo -e "${YELLOW}[2/7]${NC} 拉取最新代碼..."
if git pull origin main; then
    log "代碼更新成功"
    echo -e "${GREEN}✓${NC} 代碼更新完成"
else
    log "錯誤: Git pull 失敗"
    exit 1
fi
echo ""

echo -e "${YELLOW}[3/7]${NC} 檢查是否有代碼變更..."
COMMIT_HASH=$(git rev-parse HEAD)
log "當前 commit: $COMMIT_HASH"
echo ""

echo -e "${YELLOW}[4/7]${NC} 安裝/更新依賴..."
if pnpm install --frozen-lockfile; then
    log "依賴安裝成功"
    echo -e "${GREEN}✓${NC} 依賴安裝完成"
else
    log "錯誤: 依賴安裝失敗"
    exit 1
fi
echo ""

echo -e "${YELLOW}[5/7]${NC} 編譯 TypeScript..."
if pnpm run build; then
    log "TypeScript 編譯成功"
    echo -e "${GREEN}✓${NC} 編譯完成"
else
    log "錯誤: TypeScript 編譯失敗"
    exit 1
fi
echo ""

echo -e "${YELLOW}[6/7]${NC} 重啟 PM2 進程..."
if pm2 restart taxiserver; then
    log "PM2 重啟成功"
    echo -e "${GREEN}✓${NC} Server 重啟完成"
else
    log "錯誤: PM2 重啟失敗"
    exit 1
fi
echo ""

echo -e "${YELLOW}[7/7]${NC} 等待 Server 啟動..."
sleep 3
echo ""

# 健康檢查
echo -e "${YELLOW}🏥 執行健康檢查...${NC}"
HEALTH_CHECK=$(curl -s http://localhost:3000/health || echo "failed")
if [[ $HEALTH_CHECK == *"healthy"* ]]; then
    log "健康檢查通過: $HEALTH_CHECK"
    echo -e "${GREEN}✓${NC} Server 運行正常"
else
    log "警告: 健康檢查失敗: $HEALTH_CHECK"
    echo -e "${RED}✗${NC} Server 可能未正常啟動"
fi
echo ""

pm2 status taxiserver
echo ""

log "========== 部署完成 =========="
echo -e "${GREEN}╔════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║          自動部署完成！                     ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════╝${NC}"
echo ""
echo "結束時間: $(date '+%Y-%m-%d %H:%M:%S')"
echo "查看部署日誌: tail -f $LOG_FILE"
echo ""
