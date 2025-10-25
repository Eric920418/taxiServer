#!/bin/bash
# 測試用：模擬乘客叫車

echo "🚕 模擬乘客叫車中..."
echo ""

curl -X POST http://localhost:3000/api/orders \
  -H "Content-Type: application/json" \
  -d '{
    "passengerName": "測試乘客",
    "passengerPhone": "0900-123-456",
    "pickupLat": 23.9871,
    "pickupLng": 121.6015,
    "pickupAddress": "花蓮火車站",
    "destLat": 24.0051,
    "destLng": 121.6082,
    "destAddress": "東大門夜市",
    "paymentType": "CASH"
  }' | jq .

echo ""
echo "✅ 訂單建立完成！"
echo ""
echo "查看所有訂單："
curl -s http://localhost:3000/api/orders | jq .
