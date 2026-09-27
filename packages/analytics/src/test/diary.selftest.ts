import type { UnifiedTrade } from '@trademind/trading-core';
import { diaryYear, diaryWeek, diaryDay, mondayOf, periodStats } from '../diary';

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`  ✗ ${msg}`);
  }
}

let seq = 0;
function mk(p: {
  openTime: string;
  closeTime?: string | null;
  netPnl?: number;
  grossPnl?: number;
  qty?: number;
  px?: number;
  lev?: number;
  dir?: 'LONG' | 'SHORT';
  fees?: number;
  funding?: number;
}): UnifiedTrade {
  seq += 1;
  const closeTime = p.closeTime === null ? null : (p.closeTime ?? p.openTime);
  const grossPnl = p.grossPnl ?? p.netPnl ?? 0;
  const fees = p.fees ?? 0;
  const funding = p.funding ?? 0;
  const netPnl = p.netPnl ?? grossPnl - fees - funding;
  return {
    id: `t${seq}`,
    workspaceId: 'w',
    accountId: 'a',
    exchange: 'OKX',
    symbol: 'ETH-USDT-SWAP',
    side: p.dir === 'SHORT' ? 'SELL' : 'BUY',
    positionSide: p.dir ?? 'LONG',
    entryPrice: p.px ?? 100,
    exitPrice: closeTime ? (p.px ?? 100) : null,
    quantity: p.qty ?? 1,
    leverage: p.lev ?? 1,
    stopLoss: null,
    takeProfit: null,
    openTime: p.openTime,
    closeTime,
    grossPnl,
    fees,
    funding,
    netPnl,
    risk: null,
    reward: null,
    rr: null,
    strategyId: null,
    tags: [],
    mistakes: [],
    confidence: null,
    marketCondition: null,
    notes: null,
    screenshots: [],
    externalTradeId: null,
    metadata: {},
  };
}

// ── mondayOf：周一锚定 ──
// 2026-09-26 是周六 → 周一应是 2026-09-21
ok(mondayOf('2026-09-26') === '2026-09-21', 'mondayOf 周六→周一 09-21');
ok(mondayOf('2026-09-21') === '2026-09-21', 'mondayOf 周一即自身');
ok(mondayOf('2026-09-27') === '2026-09-21', 'mondayOf 周日仍属上一周');

// ── periodStats 基础 ──
const s1 = periodStats([
  mk({ openTime: '2026-09-22T03:00:00Z', netPnl: 10, grossPnl: 12, qty: 2, px: 2500, lev: 10 }),
  mk({ openTime: '2026-09-22T09:00:00Z', netPnl: -4, grossPnl: -4, dir: 'SHORT', lev: 20 }),
]);
ok(s1.trades === 2 && s1.pnl === 6, 'periodStats 聚合 pnl 与笔数');
ok(s1.winRate === 0.5, 'periodStats 胜率 50%');
ok(s1.profitFactor === 3, 'periodStats PF = 12/4 = 3');
ok(s1.volume === 2500 * 2 + 100, 'periodStats 成交量 = Σ价×量');
ok(s1.maxLeverage === 20 && Math.abs((s1.avgLeverage as number) - 15) < 1e-9, 'periodStats 杠杆均值/最大');
ok(s1.longCount === 1 && s1.shortCount === 1, 'periodStats 多空计数');
// 全盈利 → PF 为 null（UI 渲染 ∞）
const s2 = periodStats([mk({ openTime: '2026-09-22T03:00:00Z', netPnl: 5, grossPnl: 5 })]);
ok(s2.profitFactor === null && s2.winRate === 1, '全盈利 PF=null(∞)、胜率 100%');
// 空周期 → 全 0
const s0 = periodStats([]);
ok(s0.trades === 0 && s0.pnl === 0 && s0.winRate === null, '空周期全 0，胜率 null');

// ── diaryYear：跨月周重复出现 ──
// 2026-08-31（周一）~ 09-06（周日）这一周横跨 8 月与 9 月
const crossWeek = [
  mk({ openTime: '2026-08-31T10:00:00Z', netPnl: 2 }),
  mk({ openTime: '2026-09-02T10:00:00Z', netPnl: 3 }),
  mk({ openTime: '2026-09-25T10:00:00Z', netPnl: -1 }),
];
const y = diaryYear(crossWeek, 2026);
const aug = y.months.find((m) => m.key === '2026-08') as { key: string; stats: { trades: number }; weeks: { start: string; stats: { trades: number } }[] };
const sep = y.months.find((m) => m.key === '2026-09') as { key: string; stats: { trades: number }; weeks: { start: string; stats: { trades: number } }[] };
ok(aug.stats.trades === 1 && sep.stats.trades === 2, '月 KPI 按平仓日归属（8 月 1 笔、9 月 2 笔）');
ok(
  aug.weeks.some((w) => w.start === '2026-08-31' && w.stats.trades === 2),
  '跨月周出现在 8 月且统计整周 2 笔',
);
ok(
  sep.weeks.some((w) => w.start === '2026-08-31' && w.stats.trades === 2),
  '同一跨月周也出现在 9 月（不漏交易日）',
);
ok(
  sep.weeks.some((w) => w.start === '2026-09-21' && w.stats.trades === 1),
  '9 月第四周卡片统计 1 笔',
);
// 无交易月份 weeks 为空、stats 为 0
const jan = y.months.find((m) => m.key === '2026-01') as { stats: { trades: number }; weeks: unknown[] };
ok(jan.stats.trades === 0 && jan.weeks.length === 0, '无交易月 stats=0 且无周卡片');

// ── diaryWeek：7 天卡片 + 上周对比 ──
const wk = diaryWeek(crossWeek, '2026-08-31');
ok(wk.days.length === 7 && wk.days[0].date === '2026-08-31', '周视图含 7 天卡片且从周一开始');
ok(wk.stats.trades === 2 && wk.stats.pnl === 5, '周 KPI 聚合 2 笔 +5');
ok(wk.prev.trades === 0, '上周无交易 → prev 全 0');
const wk2 = diaryWeek(crossWeek, '2026-09-21');
ok(wk2.stats.trades === 1 && wk2.days[0].date === '2026-09-21', '09-21 周只含 9/25 那笔');

// ── diaryDay：时间线累计 ──
const dd = diaryDay(
  [
    mk({ openTime: '2026-09-26T01:00:00Z', closeTime: '2026-09-26T02:10:00Z', netPnl: 5 }),
    mk({ openTime: '2026-09-26T05:00:00Z', closeTime: '2026-09-26T06:30:00Z', netPnl: -2 }),
  ],
  '2026-09-26',
);
ok(dd.stats.trades === 2 && dd.stats.pnl === 3, '日 KPI 2 笔 +3');
ok(dd.timeline.length === 2 && dd.timeline[1].cumPnl === 3 && dd.timeline[0].cumPnl === 5, '时间线按平仓时间累计');
ok(dd.trades[0].closeTime !== null, '日视图返回交易列表');
const dd0 = diaryDay([], '2026-09-26');
ok(dd0.stats.trades === 0 && dd0.timeline.length === 0, '无交易日返回空结构');

console.log(`\ndiary.selftest: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
