#!/bin/bash

# 設置快捷命令別名
# 執行此腳本將在 ~/.bashrc 中添加便捷別名

echo "正在設置快捷命令別名..."
echo ""

BASHRC="$HOME/.bashrc"
ALIAS_MARKER="# Taxi Server Aliases"

# 檢查是否已經設置
if grep -q "$ALIAS_MARKER" "$BASHRC"; then
    echo "⚠️  別名已經設置過了"
    echo "如需重新設置，請手動刪除 ~/.bashrc 中的相關內容"
    exit 0
fi

# 添加別名到 .bashrc
cat >> "$BASHRC" << 'EOF'

# Taxi Server Aliases
alias taxi-deploy='cd /var/www/taxiServer && ./deploy.sh'
alias taxi-restart='cd /var/www/taxiServer && ./restart.sh'
alias taxi-status='pm2 status taxiserver'
alias taxi-logs='pm2 logs taxiserver'
alias taxi-stop='pm2 stop taxiserver'
alias taxi-start='pm2 start taxiserver'
alias taxi-monit='pm2 monit'
alias taxi-cd='cd /var/www/taxiServer'
alias taxi-health='curl http://localhost:3000/health'
EOF

echo "✓ 別名已添加到 ~/.bashrc"
echo ""
echo "請執行以下命令使別名生效："
echo "  source ~/.bashrc"
echo ""
echo "可用的快捷命令："
echo "  taxi-deploy    - 部署最新代碼"
echo "  taxi-restart   - 快速重啟"
echo "  taxi-status    - 查看狀態"
echo "  taxi-logs      - 查看日誌"
echo "  taxi-stop      - 停止 server"
echo "  taxi-start     - 啟動 server"
echo "  taxi-monit     - 監控面板"
echo "  taxi-cd        - 進入項目目錄"
echo "  taxi-health    - 健康檢查"
echo ""
