import { fareConfigService } from '../src/services/FareConfigService';

const cases: Array<{ label: string; distance: number; at: string; slow?: number; expected: number }> = [
  { label: '日 1km (週三 14:00)', distance: 1000, at: '2026-04-22T14:00:00+08:00', expected: 100 },
  { label: '日 2km', distance: 2000, at: '2026-04-22T14:00:00+08:00', expected: 125 }, // 100 + ceil(1000/230)*5 = 100 + 5*5
  { label: '日 5km', distance: 5000, at: '2026-04-22T14:00:00+08:00', expected: 190 }, // 100 + ceil(4000/230)*5 = 100 + 18*5
  { label: '夜 1km (23:00)', distance: 1000, at: '2026-04-22T23:00:00+08:00', expected: 105 }, // 100 + ceil(166/192)*5 = 100 + 1*5
  { label: '夜 2km', distance: 2000, at: '2026-04-22T23:00:00+08:00', expected: 135 }, // 100 + ceil(1166/192)*5 = 100 + 7*5
  { label: '夜 22:30 邊界', distance: 1000, at: '2026-04-22T22:30:00+08:00', expected: 105 },
  { label: '夜 05:59 邊界', distance: 1000, at: '2026-04-22T05:59:00+08:00', expected: 105 },
  { label: '夜 06:00 邊界 (不算夜)', distance: 1000, at: '2026-04-22T06:00:00+08:00', expected: 100 },
  { label: '日 + 240 秒低速', distance: 1000, at: '2026-04-22T14:00:00+08:00', slow: 240, expected: 110 }, // 100 + (240/120)*5 = 110
  { label: '日 + 300 秒低速', distance: 1000, at: '2026-04-22T14:00:00+08:00', slow: 300, expected: 110 }, // 100 + floor(300/120)*5 = 100 + 2*5
  { label: '夜 + 100 秒低速', distance: 1000, at: '2026-04-22T23:00:00+08:00', slow: 100, expected: 110 }, // 105 + (100/100)*5
];

console.log('費率配置：', JSON.stringify(fareConfigService.getConfig(), null, 2));
console.log('\n--- 試算驗證 ---\n');

let pass = 0;
let fail = 0;
for (const c of cases) {
  const result = fareConfigService.calculateFare(c.distance, new Date(c.at), c.slow ?? 0);
  const ok = result.totalFare === c.expected;
  console.log(
    `${ok ? '✅' : '❌'} ${c.label}: 預期 ${c.expected} / 實際 ${result.totalFare}` +
    `  [base=${result.baseFare} dist=${result.distanceFare} slow=${result.slowTrafficFare} sf=${result.springFestivalSurcharge} jumps=${result.meterJumps} schedule=${result.appliedSchedule} isNight=${result.isNight} isSF=${result.isSpringFestival}]`
  );
  if (ok) pass++; else fail++;
}

console.log('\n--- 春節情境（需先啟用） ---\n');
fareConfigService.updateConfig({
  springFestival: { enabled: true, startDate: '2026-02-16', endDate: '2026-02-22', perTripSurcharge: 50 },
}).then(() => {
  const sfCases = [
    { label: '春節 14:00 + 1km', distance: 1000, at: '2026-02-17T14:00:00+08:00', expected: 155 }, // 105 + 50
    { label: '春節 14:00 + 2km', distance: 2000, at: '2026-02-17T14:00:00+08:00', expected: 185 }, // 135 + 50
    { label: '春節最後一天 23:59 + 1km', distance: 1000, at: '2026-02-22T23:59:00+08:00', expected: 155 },
    { label: '春節隔天 14:00 + 1km (應退回日費率)', distance: 1000, at: '2026-02-23T14:00:00+08:00', expected: 100 },
  ];
  for (const c of sfCases) {
    const result = fareConfigService.calculateFare(c.distance, new Date(c.at), 0);
    const ok = result.totalFare === c.expected;
    console.log(
      `${ok ? '✅' : '❌'} ${c.label}: 預期 ${c.expected} / 實際 ${result.totalFare}` +
      `  [schedule=${result.appliedSchedule} isNight=${result.isNight} isSF=${result.isSpringFestival} sf=${result.springFestivalSurcharge}]`
    );
    if (ok) pass++; else fail++;
  }
  console.log(`\n總結：${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
});
