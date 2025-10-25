#!/bin/bash

echo "📞 模擬乘客叫車..."
curl -X POST http://localhost:3000/api/orders \
  -H "Content-Type: application/json" \
  -d '{
    "passengerName": "測試乘客王小明",
    "passengerPhone": "0912-345-678",
    "pickupLat": 23.9871,
    "pickupLng": 121.6015,
    "pickupAddress": "花蓮火車站前站",
    "destLat": 24.0051,
    "destLng": 121.6082,
    "destAddress": "東大門夜市",
    "paymentType": "CASH"
  }'

echo -e "\n\n✅ 訂單已建立！請查看司機App是否收到訂單推播。"
