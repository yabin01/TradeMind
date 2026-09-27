import type { UnifiedTrade } from '@trademind/trading-core';
import {
  computeAdvancedMetrics,
  streaks,
  monthlyStats,
  dailyReturnSeries,
  METRIC_META,
} from '../advanced';
import { buildTradeDetail, computeMaeMfe } from '../trade-detail';

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${extra}`);
  }
}
function near(a: number | null | undefined, b: number, eps = 1e-6): boolean {
  if (a === null || a === undefined || !Number.isFinite(a)) return false;
  return Math.abs(a - b) < eps;
}

function mk(
  p: Partial<UnifiedTrade> & { id: string; netPnl: number; openTime: string; closeTime?: string | null },
): UnifiedTrade {
  return {
    id: p.id,
    workspaceId: 'ws',
    accountId: 'acc',
    exchange: 'OKX',
    symbol: p.symbol ?? 'ETH-USDT-SWAP',
    side: p.side ?? 'SELL',
    positionSide: p.positionSide ?? 'SHORT',
    entryPrice: p.entryPrice ?? 3000,
    exitPrice: p.exitPrice ?? 3010,
    quantity: p.quantity ?? 1,
    leverage: p.leverage ?? 10,
    stopLoss: p.stopLoss ?? null,
    takeProfit: p.takeProfit ?? null,
    openTime: p.openTime,
    // closeTime 显式传 null 表示「未平仓」，未传则用 openTime 作为已平仓时间
    closeTime: p.closeTime === null ? null : (p.closeTime ?? p.openTime),
    grossPnl: p.grossPnl ?? p.netPnl,
    fees: p.fees ?? 0,
    funding: p.funding ?? 0,
    netPnl: p.netPnl,
    risk: p.risk ?? null,
    reward: p.reward ?? null,
    rr: p.rr ?? null,
    strategyId: null,
    tags: [],
    mistakes: [],
    confidence: null,
    marketCondition: null,
    notes: null,
    screenshots: [],
    externalTradeId: null,
    metadata: p.metadata ?? {},
    createdAt: p.openTime,
    updatedAt: p.openTime,
  } satisfies UnifiedTrade;
}

console.log('advanced / trade-detail 自测');

// ── 1. 连胜连亏 ────────────────────────────────────────────────────
{
  const t = [
    mk({ id: 'a', netPnl: 10, openTime: '2026-01-01T10:00:00Z' }),
    mk({ id: 'b', netPnl: 10, openTime: '2026-01-01T11:00:00Z' }),
    mk({ id: 'c', netPnl: -5, openTime: '2026-01-02T10:00:00Z' }),
    mk({ id: 'd', netPnl: -5, openTime: '2026-01-02T11:00:00Z' }),
    mk({ id: 'e', netPnl: -5, openTime: '2026-01-03T10:00:00Z' }),
    mk({ id: 'f', netPnl: 100, openTime: '2026-01-04T10:00:00Z' }),
  ];
  const s = streaks(t);
  ok('最长连胜 = 2', s.maxConsecutiveWins === 2, String(s.maxConsecutiveWins));
  ok('最长连亏 = 3', s.maxConsecutiveLosses === 3, String(s.maxConsecutiveLosses));
  ok('最长连亏累计 = -15', near(s.maxConsecutiveLossAmount, -15), String(s.maxConsecutiveLossAmount));
  ok('当前连胜 = 1', s.currentStreak.type === 'WIN' && s.currentStreak.length === 1, JSON.stringify(s.currentStreak));

  // 打平不计入连胜连亏
  const t2 = [
    mk({ id: 'x', netPnl: 10, openTime: '2026-01-01T10:00:00Z' }),
    mk({ id: 'y', netPnl: 0, openTime: '2026-01-01T11:00:00Z' }),
    mk({ id: 'z', netPnl: 10, openTime: '2026-01-01T12:00:00Z' }),
  ];
  const s2 = streaks(t2);
  ok('打平不打断连胜判定（仍记 2 连）', s2.maxConsecutiveWins === 2, String(s2.maxConsecutiveWins));
}

// ── 2. 月度聚合 ────────────────────────────────────────────────────
{
  const t = [
    mk({ id: 'm1', netPnl: 100, openTime: '2026-01-05T10:00:00Z', closeTime: '2026-01-05T11:00:00Z' }),
    mk({ id: 'm2', netPnl: -50, openTime: '2026-02-05T10:00:00Z', closeTime: '2026-02-05T11:00:00Z' }),
    mk({ id: 'm3', netPnl: 20, openTime: '2026-02-06T10:00:00Z', closeTime: '2026-02-06T11:00:00Z' }),
  ];
  const ms = monthlyStats(t);
  ok('月份聚合 = 2 个月', ms.length === 2, String(ms.length));
  ok('2026-01 = +100', ms[0].key === '2026-01' && near(ms[0].pnl, 100), JSON.stringify(ms[0]));
  ok('2026-02 = -30', near(ms[1].pnl, -30), JSON.stringify(ms[1]));
}

// ── 3. 日收益序列含空日 ────────────────────────────────────────────
{
  const t = [
    mk({ id: 'd1', netPnl: 10, openTime: '2026-01-01T10:00:00Z', closeTime: '2026-01-01T11:00:00Z' }),
    mk({ id: 'd2', netPnl: 10, openTime: '2026-01-04T10:00:00Z', closeTime: '2026-01-04T11:00:00Z' }),
  ];
  const s = dailyReturnSeries(t);
  // 01-01 到 01-04 共 4 天，中间 2 天无交易记 0
  ok('日序列长度 = 4（含空日）', s.length === 4, JSON.stringify(s));
  ok('序列 = [10,0,0,10]', JSON.stringify(s) === '[10,0,0,10]', JSON.stringify(s));
}

// ── 4. 高级指标：方向性判断 ────────────────────────────────────────
{
  // 稳定盈利：20 天，每日 +10 / +12 交替（保证日收益标准差 > 0，否则 Sharpe 无定义）
  const t: UnifiedTrade[] = [];
  for (let i = 0; i < 20; i++) {
    const day = String(i + 1).padStart(2, '0');
    const net = i % 2 === 0 ? 10 : 12;
    t.push(mk({
      id: `w${i}`, netPnl: net, grossPnl: net + 1, fees: 1, funding: 0,
      openTime: `2026-01-${day}T10:00:00Z`, closeTime: `2026-01-${day}T10:30:00Z`,
    }));
  }
  const a = computeAdvancedMetrics(t, { startingBalance: 1000 });
  ok('全盈利 → Sharpe > 0', (a.sharpe ?? 0) > 0, String(a.sharpe));
  ok('无下行波动 → Sortino 为 null（除零保护）', a.sortino === null, String(a.sortino));
  ok('ROI = 220/1000 = 0.22', near(a.roi, 0.22), String(a.roi));
  ok('连胜 = 20', a.maxConsecutiveWins === 20, String(a.maxConsecutiveWins));
  ok('连亏 = 0', a.maxConsecutiveLosses === 0);
  ok('成本 = 20', near(a.totalCost, 20), String(a.totalCost));
  ok('成本/毛利 = 20/240', near(a.costRatio, 20 / 240, 1e-4), String(a.costRatio));
  ok('盈利月占比 = 1', near(a.profitableMonthsRatio, 1));
  ok('有交易天数 = 20', a.activeDays === 20, String(a.activeDays));
  ok('日均笔数 = 1', near(a.tradesPerDay, 1));
  ok('平均持仓 = 30 分钟', near(a.avgHoldingMinutes, 30), String(a.avgHoldingMinutes));
  ok('R 倍数样本 = 0（未标 risk）→ null', a.expectancyR === null && a.rSampleSize === 0);
  ok('无回撤时 Calmar/恢复因子为 null', a.calmar === null && a.recoveryFactor === null);
}

// ── 5. 有亏损时 Sharpe 转负、恢复因子可算 ──────────────────────────
{
  // 下行波动幅度不同（-40 / -80），保证下行标准差 > 0
  const t = [
    mk({ id: 'p1', netPnl: 100, openTime: '2026-01-01T10:00:00Z', closeTime: '2026-01-01T10:30:00Z' }),
    mk({ id: 'p2', netPnl: -40, openTime: '2026-01-02T10:00:00Z', closeTime: '2026-01-02T10:30:00Z' }),
    mk({ id: 'p3', netPnl: -80, openTime: '2026-01-03T10:00:00Z', closeTime: '2026-01-03T10:30:00Z' }),
  ];
  const a = computeAdvancedMetrics(t);
  ok('净亏 → Sharpe < 0', (a.sharpe ?? 0) < 0, String(a.sharpe));
  ok('Sortino 可算（有下行）且 < 0', a.sortino !== null && a.sortino < 0, String(a.sortino));
  // 权益 0 → 100 → 60 → -20，峰 100 到谷 -20，最大回撤 120
  ok('恢复因子 = -20/120', near(a.recoveryFactor, -20 / 120, 1e-6), String(a.recoveryFactor));

  // 边界：下行幅度完全相同 → 下行标准差为 0，Sortino 不可算（除零保护，不返回 ∞）
  const flat = [
    mk({ id: 'f1', netPnl: 100, openTime: '2026-02-01T10:00:00Z', closeTime: '2026-02-01T10:30:00Z' }),
    mk({ id: 'f2', netPnl: -60, openTime: '2026-02-02T10:00:00Z', closeTime: '2026-02-02T10:30:00Z' }),
    mk({ id: 'f3', netPnl: -60, openTime: '2026-02-03T10:00:00Z', closeTime: '2026-02-03T10:30:00Z' }),
  ];
  ok('下行波动为 0 → Sortino 返回 null（不返回 ∞）', computeAdvancedMetrics(flat).sortino === null);
  ok('最长连亏累计 = -120', near(a.maxConsecutiveLossAmount, -120));
  ok('无初始资金时 ROI = null', a.roi === null);
}

// ── 6. 空数据 / 单笔不崩 ───────────────────────────────────────────
{
  const a0 = computeAdvancedMetrics([]);
  ok('空数据全为 null/0，不崩', a0.sharpe === null && a0.totalCost === 0 && a0.activeDays === 0);
  const a1 = computeAdvancedMetrics([mk({ id: 'one', netPnl: 5, openTime: '2026-01-01T10:00:00Z', closeTime: '2026-01-01T10:30:00Z' })]);
  ok('单笔：年化与 Sharpe 不可算（样本不足）', a1.years === null && a1.annualizedReturn === null);
  ok('单笔：标准差为 null', a1.stdDevPnl === null);
}

// ── 7. 指标元数据完整性 ────────────────────────────────────────────
{
  ok('元数据非空', METRIC_META.length >= 20, String(METRIC_META.length));
  ok('每条都有中文标签与公式', METRIC_META.every((m) => m.label.length > 0 && m.formula.length > 0));
  ok('每条都有口径说明', METRIC_META.every((m) => m.note.length > 0));
  ok('每条都标注了解读方向', METRIC_META.every((m) => ['higher', 'lower', 'neutral'].includes(m.better)));
  ok('key 唯一', new Set(METRIC_META.map((m) => m.key)).size === METRIC_META.length);
}

// ── 8. 交易明细字段 ────────────────────────────────────────────────
{
  const t = mk({
    id: 'td1',
    netPnl: 60,
    grossPnl: 70,
    fees: -8,
    funding: -2,
    entryPrice: 3000,
    exitPrice: 3030,
    quantity: 2,
    leverage: 20,
    stopLoss: 2950,
    takeProfit: 3025, // 出场 3030 ≥ 3025 → 已触发止盈
    risk: 100,
    reward: 120,
    rr: 1.2,
    side: 'BUY',
    positionSide: 'LONG',
    openTime: '2026-03-05T22:15:00Z',
    closeTime: '2026-03-05T23:45:00Z',
  });
  const d = buildTradeDetail(t);
  ok('方向 = LONG', d.direction === 'LONG', d.direction);
  ok('名义价值 = 6000', near(d.notional, 6000), String(d.notional));
  ok('保证金估算 = 300', near(d.marginEstimate, 300), String(d.marginEstimate));
  ok('持仓 = 90 分钟', near(d.holdingMinutes, 90), String(d.holdingMinutes));
  ok('价格变动 = +1%', near(d.priceChangePct, 1), String(d.priceChangePct));
  ok('净盈亏/名义 = 1%', near(d.netPnlPctOfNotional, 1), String(d.netPnlPctOfNotional));
  ok('总成本 = 10', near(d.totalCost, 10), String(d.totalCost));
  ok('成本/毛利 = 10/70', near(d.costRatioOfGross, 10 / 70, 1e-6), String(d.costRatioOfGross));
  ok('R 倍数 = 0.6', near(d.rMultiple, 0.6), String(d.rMultiple));
  ok('未触发止损', d.hitStopLoss === false, String(d.hitStopLoss));
  ok('已触发止盈', d.hitTakeProfit === true, String(d.hitTakeProfit));
  ok('UTC 小时 = 22', d.hourUtc === 22, String(d.hourUtc));
  ok('判定为盈利单', d.isWin === true);
  ok('净盈亏/小时 = 40', near(d.pnlPerHour, 40), String(d.pnlPerHour));
}

// ── 9. SHORT 方向的价格变动取反 ────────────────────────────────────
{
  const t = mk({
    id: 'td2', netPnl: 100, entryPrice: 3000, exitPrice: 2970, quantity: 1,
    side: 'SELL', positionSide: 'SHORT',
    openTime: '2026-03-06T10:00:00Z', closeTime: '2026-03-06T11:00:00Z',
  });
  const d = buildTradeDetail(t);
  ok('SHORT 方向识别', d.direction === 'SHORT', d.direction);
  ok('SHORT 价格下跌 1% → +1%', near(d.priceChangePct, 1), String(d.priceChangePct));
}

// ── 10. MAE/MFE：数据不足必须返回 null，且不得编造 ─────────────────
{
  const t = mk({
    id: 'td3', netPnl: -50, entryPrice: 3000, exitPrice: 2950, quantity: 1,
    stopLoss: 2940, side: 'BUY', positionSide: 'LONG',
    openTime: '2026-03-07T10:00:00Z', closeTime: '2026-03-07T12:00:00Z',
  });
  const mm = computeMaeMfe(t);
  ok('无价格路径 → MAE/MFE 为 null', mm.mae === null && mm.mfe === null);
  ok('可用标记 = false', mm.available === false);
  ok('给出原因说明', (mm.reason ?? '').includes('价格路径'), mm.reason ?? '');

  // 一旦 metadata 提供极值，自动启用
  const withEx = mk({
    id: 'td4', netPnl: 50, entryPrice: 3000, exitPrice: 3050, quantity: 1,
    side: 'BUY', positionSide: 'LONG',
    openTime: '2026-03-08T10:00:00Z', closeTime: '2026-03-08T12:00:00Z',
    metadata: { extremes: { high: 3100, low: 2900 } },
  });
  const mm2 = computeMaeMfe(withEx);
  ok('提供极值后可用', mm2.available === true);
  ok('MAE = 2900-3000 = -100', near(mm2.mae, -100), String(mm2.mae));
  ok('MFE = 3100-3000 = +100', near(mm2.mfe, 100), String(mm2.mfe));

  // 未平仓不计算
  const open = mk({
    id: 'td5', netPnl: 0, openTime: '2026-03-09T10:00:00Z',
    closeTime: null, exitPrice: null,
    metadata: { extremes: { high: 1, low: 1 } },
  });
  const mm3 = computeMaeMfe(open);
  ok('未平仓不计算 MAE/MFE', mm3.available === false && mm3.mae === null);
}

console.log(`\n通过 ${pass}，失败 ${fail}`);
if (fail > 0) process.exit(1);
