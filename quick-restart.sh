#!/bin/bash

# 花蓮計程車 Server - 超快速重啟（僅後端）
# 用途：修改後端代碼後快速重新編譯並重啟
# 使用方式：./quick-restart.sh

set -e

echo "🔄 快速重啟 taxiServer..."
echo ""

# 編譯 TypeScript
echo "📦 編譯 TypeScript..."
pnpm run build

# 重啟 PM2
echo "🚀 重啟服務..."
pm2 restart taxiserver

echo ""
echo "✅ 重啟完成！"
pm2 status taxiserver
