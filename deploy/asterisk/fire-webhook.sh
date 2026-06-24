#!/bin/bash
#==============================================================
# fire-webhook.sh — 通話掛斷後通知後端開始處理（MVP / fallback 路徑）
#--------------------------------------------------------------
# ★ 本檔為 box:/etc/asterisk/scripts/fire-webhook.sh 的版控快照。
# 由 taxi-intake 的 h 分機呼叫：
#   System(/etc/asterisk/scripts/fire-webhook.sh "${UNIQUEID}" "${CALLERID(num)}" "${CDR(duration)}")
# 後端 POST /api/phone-calls/webhook（只吃 JSON，故這裡送 application/json）：
#   下載 recording_url 客人音軌 → Whisper → GPT → geocoding → 派單。
# 錄音由本機 nginx 唯讀掛 127.0.0.1:8090，經反向 SSH 隧道供首爾後端 fetch。
#==============================================================
set -uo pipefail
CALL_ID="${1:-}"; CALLER="${2:-unknown}"; DURATION="${3:-0}"
WEBHOOK_URL="https://api.hualientaxi.taxi/api/phone-calls/webhook"
REC_BASE="http://127.0.0.1:8090"
[ -z "$CALL_ID" ] && { echo "[fire-webhook] 缺 call_id" >&2; exit 1; }
sleep 2
JSON=$(printf '{"call_id":"%s","caller_number":"%s","duration_seconds":%s,"recording_url":"%s/%s-caller.wav"}' "$CALL_ID" "$CALLER" "${DURATION:-0}" "$REC_BASE" "$CALL_ID")
RESP=$(curl -sS -m 15 -X POST "$WEBHOOK_URL" -H "Content-Type: application/json" -d "$JSON" 2>&1)
echo "[fire-webhook] $CALL_ID resp=$RESP"
