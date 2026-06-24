#!/usr/bin/env bash
#==============================================================
# setup-asterisk.sh — 一鍵安裝 Asterisk + 套用遠傳 FET trunk 設定
#--------------------------------------------------------------
# 在 asterisk-pbx（Ubuntu Server）本地執行：
#   curl -fsSL https://api.hualientaxi.taxi/uploads/setup-asterisk.sh | sudo bash
# 或下載後：sudo bash setup-asterisk.sh
#
# 做什麼：
#   1. 安裝 Asterisk 20 + sngrep（抓 SIP 封包用）
#   2. 寫入遠傳 FET trunk 設定（pjsip / dialplan）
#   3. 建錄音目錄 + webhook 觸發腳本
#   4. reload Asterisk、印出版本與下一步
#
# ★ 注意：本腳本「不動網路設定」。遠傳實體線接好、確認 box 拿到
#   公網 IP 210.243.167.33 之後，trunk 才會真正通（見最後說明）。
#==============================================================
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then echo "請用 sudo 執行：sudo bash setup-asterisk.sh"; exit 1; fi

log(){ echo -e "\n\033[1;32m==> $*\033[0m"; }

#--- 1. 安裝套件 ---------------------------------------------
log "更新套件庫並安裝 Asterisk + sngrep"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y asterisk asterisk-modules sngrep curl

log "Asterisk 版本"
asterisk -V || true

#--- 2. 建目錄 -----------------------------------------------
log "建立錄音目錄與 scripts 目錄"
install -d -o asterisk -g asterisk /var/spool/asterisk/recording
install -d /etc/asterisk/scripts

#--- 3. 寫 pjsip_fet.conf -----------------------------------
log "寫入 /etc/asterisk/pjsip_fet.conf（遠傳 trunk）"
cat > /etc/asterisk/pjsip_fet.conf <<'PJSIP'
; 遠傳 FET SIP Trunk（大豐計程車行）
; 本端 210.243.167.33:5060/TCP ; FET SBC 訊令 123.51.252.5 / RTP 123.51.252.4
; IP 認證（無帳密）; DID 03-8907320~329
[transport-fet-tcp]
type=transport
protocol=tcp
bind=0.0.0.0:5060
; 若 box 在數據機 NAT 後（拿到的是 192.168.x），解除下兩行註解：
;external_signaling_address=210.243.167.33
;external_media_address=210.243.167.33

[fet-endpoint]
type=endpoint
transport=transport-fet-tcp
context=from-fet
disallow=all
allow=alaw
allow=ulaw
direct_media=no
rtp_symmetric=yes
force_rport=yes
rewrite_contact=yes
dtmf_mode=rfc2833
language=zh
from_user=0388907320
from_domain=210.243.167.33
aors=fet-aor

[fet-aor]
type=aor
contact=sip:123.51.252.5:5060

[fet-identify]
type=identify
endpoint=fet-endpoint
match=123.51.252.5
PJSIP

#--- 4. 寫 extensions_fet.conf ------------------------------
log "寫入 /etc/asterisk/extensions_fet.conf（進線落地 + 送碼）"
cat > /etc/asterisk/extensions_fet.conf <<'DIALPLAN'
; 進線落地：10 門 DID（含連字號或純數字皆收）。第一通用 sngrep 確認 To 格式後可收斂。
[from-fet]
exten => _038890732X,1,Goto(taxi-intake,s,1)
exten => _03-890732X,1,Goto(taxi-intake,s,1)
exten => _.,1,Goto(taxi-intake,s,1)

[taxi-intake]
exten => s,1,NoOp(電話叫車 來電=${CALLERID(num)} DID=${EXTEN} UID=${UNIQUEID})
 same => n,Answer()
 same => n,MixMonitor(${UNIQUEID}.wav,r(/var/spool/asterisk/recording/${UNIQUEID}-caller.wav))
 same => n,Playback(custom/greeting-taxi)        ; 歡迎語音檔缺也不會中斷，只會 warning
 same => n,WaitForSilence(4000,2,45)
 same => n,Playback(custom/got-it)
 same => n,Hangup()
exten => h,1,System(/etc/asterisk/scripts/fire-webhook.sh "${UNIQUEID}" "${CALLERID(num)}" "${CDR(duration)}")

; 出局送碼（手機加 9004 / 市話長途 0+AC+SN / 國際 007）
[fet-outbound]
exten => _09XXXXXXXX,1,Set(CALLERID(num)=0388907320)
 same => n,Dial(PJSIP/9004${EXTEN}@fet-endpoint,60)
 same => n,Hangup()
exten => _007X.,1,Set(CALLERID(num)=0388907320)
 same => n,Dial(PJSIP/${EXTEN}@fet-endpoint,90)
 same => n,Hangup()
exten => _0X.,1,Set(CALLERID(num)=0388907320)
 same => n,Dial(PJSIP/${EXTEN}@fet-endpoint,60)
 same => n,Hangup()
DIALPLAN

#--- 5. 寫 webhook 腳本 -------------------------------------
log "寫入 /etc/asterisk/scripts/fire-webhook.sh"
cat > /etc/asterisk/scripts/fire-webhook.sh <<'HOOK'
#!/bin/bash
set -uo pipefail
CALL_ID="${1:-}"; CALLER="${2:-unknown}"; DURATION="${3:-0}"
WEBHOOK_URL="https://api.hualientaxi.taxi/api/phone-calls/webhook"
REC_BASE="http://210.243.167.33:8090"   # 錄音 HTTP（Phase 2 再開 nginx）
[ -z "$CALL_ID" ] && { echo "[fire-webhook] 缺 call_id" >&2; exit 1; }
sleep 2   # 等 MixMonitor flush 關檔
OUT=$(curl -sS -m 15 -w "\n[HTTP %{http_code}]" -X POST "$WEBHOOK_URL" \
  --data-urlencode "call_id=$CALL_ID" \
  --data-urlencode "caller_number=$CALLER" \
  --data-urlencode "duration_seconds=$DURATION" \
  --data-urlencode "recording_url=${REC_BASE}/${CALL_ID}-caller.wav" 2>&1) \
  && echo "[fire-webhook] OK $CALL_ID $OUT" \
  || echo "[fire-webhook] FAIL $CALL_ID $OUT" >&2
HOOK
chmod +x /etc/asterisk/scripts/fire-webhook.sh

#--- 6. 掛上 include --------------------------------------
log "把設定 include 進主設定檔（避免重複）"
grep -q '^#include pjsip_fet.conf'      /etc/asterisk/pjsip.conf      || echo '#include pjsip_fet.conf'      >> /etc/asterisk/pjsip.conf
grep -q '^#include extensions_fet.conf' /etc/asterisk/extensions.conf || echo '#include extensions_fet.conf' >> /etc/asterisk/extensions.conf

#--- 7. reload --------------------------------------------
log "重新載入 Asterisk"
systemctl enable --now asterisk || true
asterisk -rx "core reload" || true
sleep 1
echo "--- pjsip endpoint ---"; asterisk -rx "pjsip show endpoints" 2>/dev/null | head -20 || true

#--- 完成 --------------------------------------------------
log "完成！下一步（接遠傳實體線後）"
cat <<'NEXT'
1. 把 box 的「第二張網卡」接到遠傳 P880 路由器的 LAN 孔
2. 設那張網卡：IP 210.243.167.33 / 遮罩 255.255.255.0 / 閘道 210.243.167.1
   （若拿到的是 192.168.x，代表數據機在 NAT，回報我，要改 pjsip 的 external 位址）
3. 測試：ping 123.51.252.5  通 = 連得到遠傳
4. 第一通打進來時：sudo sngrep  抓 SIP，看 To 號碼格式與 TCP/UDP
把以上結果貼回給工程師（Claude）判讀。
NEXT
