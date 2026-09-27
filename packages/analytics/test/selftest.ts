/**
 * Analytics Engine 自测脚本（无测试框架依赖，node 直接运行）。
 * 断言所有公式与设计文档一致；全部通过打印 ALL PASSED。
 */
import type { UnifiedTrade } from '@trademind/trading-core';
import { dedupeTrades } from '@trademind/trading-core';
import { computeCoreMetrics } from '../src/metrics';
import { buildEquityCurve } from '../src/drawdown';
import { applyFilter } from '../src/filter';
import { computeCalendar } from '../src/calendar';
import { aggregateBySide, aggregateByTag } from '../src/aggregate';
import { aggregateByTime } from '../src/time';

let passed = 0;
let failed = 0;

function eq(name: string, actual: unknown, expected: unknown, tol = 1e-9): void {
  const bothFinite =
    typeof actual === 'number' &&
    typeof expected === 'number' &&
    Number.isFinite(actual) &&
    Number.isFinite(expected);
  const ok = bothFinite
    ? Math.abs((actual as number) - (expected as number)) <= tol
    : actual === expected;
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.error(`  FAIL  ${name}: actual=${actual} expected=${expected}`);
  }
}

function mk(partial: Partial<UnifiedTrade>): UnifiedTrade {
  const fees = partial.fees ?? 0;
  const funding = partial.funding ?? 0;
  const grossPnl = partial.grossPnl ?? (partial.netPnl ?? 0) + fees + funding;
  const netPnl = partial.netPnl ?? grossPnl - fees - funding;
  return {
    id: partial.id ?? Math.random().toString(36).slice(2),
    workspaceId: 'w1',
    accountId: 'a1',
    exchange: 'BINANCE',
    symbol: 'BTCUSDT',
    side: 'BUY',
    positionSide: 'LONG',
    entryPrice: 100,
    exitPrice: 110,
    quantity: 1,
    leverage: 1,
    stopLoss: null,
    takeProfit: null,
    openTime: partial.openTime ?? '2026-01-01T00:00:00Z',
    closeTime: partial.closeTime ?? null,
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
    ...partial,
  };
}

console.log('\n[1] Core metrics 基本公式');
{
  // netPnl: +100, -50, +200, -30 → GP=300, GL=80, Net=220, WR=0.5, PF=3.75
  const trades = [
    mk({ id: 't1', netPnl: 100, fees: 0, funding: 0, closeTime: '2026-01-02T00:00:00Z' }),
    mk({ id: 't2', netPnl: -50, fees: 0, funding: 0, closeTime: '2026-01-03T00:00:00Z' }),
    mk({ id: 't3', netPnl: 200, fees: 0, funding: 0, closeTime: '2026-01-04T00:00:00Z' }),
    mk({ id: 't4', netPnl: -30, fees: 0, funding: 0, closeTime: '2026-01-05T00:00:00Z' }),
  ];
  const m = computeCoreMetrics(trades);
  eq('grossProfit', m.grossProfit, 300);
  eq('grossLoss', m.grossLoss, 80);
  eq('netPnl', m.netPnl, 220);
  eq('winRate', m.winRate, 0.5);
  eq('profitFactor', m.profitFactor, 3.75);
  eq('avgWin', m.avgWin, 150);
  eq('avgLoss', m.avgLoss, 40); // (50+30)/2
  eq('expectancy(EV)', m.expectancy, 0.5 * 150 - 0.5 * 40);
  eq('closedTrades', m.closedTrades, 4);
  eq('largestWin', m.largestWin, 200);
  eq('largestLoss', m.largestLoss, -50);
}

console.log('\n[2] 边界：Gross Loss = 0 / 无交易 / fees+funding');
{
  const allWin = [
    mk({ id: 'w1', netPnl: 50, fees: 0, funding: 0, closeTime: '2026-01-02T00:00:00Z' }),
    mk({ id: 'w2', netPnl: 30, fees: 0, funding: 0, closeTime: '2026-01-03T00:00:00Z' }),
  ];
  eq('PF=Infinity when no loss', computeCoreMetrics(allWin).profitFactor, Infinity);
  eq('PF=0 when no trades', computeCoreMetrics([]).profitFactor, 0);
  eq('winRate=0 when no trades', computeCoreMetrics([]).winRate, 0);

  const withCosts = [
    mk({
      id: 'c1',
      grossPnl: 120,
      fees: 10,
      funding: 5,
      netPnl: 105,
      closeTime: '2026-01-02T00:00:00Z',
    }),
    mk({
      id: 'c2',
      grossPnl: -40,
      fees: 6,
      funding: 0,
      netPnl: -46,
      closeTime: '2026-01-03T00:00:00Z',
    }),
  ];
  const m2 = computeCoreMetrics(withCosts);
  eq('fees sum', m2.fees, 16);
  eq('funding sum', m2.funding, 5);
  eq('net = GP - GL - fees - funding', m2.netPnl, 120 - 40 - 16 - 5);
}

console.log('\n[3] Equity curve / Drawdown / HWM / Recovery');
{
  // 序列: +100, -50, +200, -30, 起始 1000
  // equity: 1100, 1050, 1250, 1220
  // HWM:    1100, 1100, 1250, 1250
  // DD:     0,    -50,  0,    -30
  const trades = [
    mk({ id: 'e1', netPnl: 100, closeTime: '2026-01-02T00:00:00Z' }),
    mk({ id: 'e2', netPnl: -50, closeTime: '2026-01-03T00:00:00Z' }),
    mk({ id: 'e3', netPnl: 200, closeTime: '2026-01-04T00:00:00Z' }),
    mk({ id: 'e4', netPnl: -30, closeTime: '2026-01-05T00:00:00Z' }),
  ];
  const dd = buildEquityCurve(trades, 1000);
  eq('curve length', dd.curve.length, 4);
  eq('maxDrawdown', dd.maxDrawdown, -50);
  // Max Runup（教科书定义）：max(峰值 − 其前全局最低点) = 1250 − 1000 = 250
  eq('maxRunup', dd.maxRunup, 250);
  eq('currentDrawdown', dd.currentDrawdown, -30);
  eq('maxDD time', dd.maxDrawdownTime, '2026-01-03T00:00:00Z');
  eq('recoveryDays (1050→1250 = 1d)', dd.recoveryDays, 1);
  eq('final equity', dd.curve[3].equity, 1220);
  eq('hwm at idx3', dd.curve[3].hwm, 1250);

  // 永不恢复的回撤
  const never = [
    mk({ id: 'n1', netPnl: 100, closeTime: '2026-01-02T00:00:00Z' }),
    mk({ id: 'n2', netPnl: -200, closeTime: '2026-01-03T00:00:00Z' }),
  ];
  const dd2 = buildEquityCurve(never, 1000);
  eq('recovery=null when never recovered', dd2.recoveryDays, null);
}

console.log('\n[4] Filter Engine');
{
  const trades = [
    mk({ id: 'f1', symbol: 'BTCUSDT', netPnl: 10, closeTime: '2026-01-02T10:00:00Z', positionSide: 'LONG' }),
    mk({ id: 'f2', symbol: 'ETHUSDT', netPnl: -5, closeTime: '2026-01-03T10:00:00Z', side: 'SELL', positionSide: 'SHORT' }),
    mk({ id: 'f3', symbol: 'BTCUSDT', netPnl: 20, closeTime: '2026-02-01T10:00:00Z' }),
    mk({ id: 'f4', netPnl: 99, closeTime: null, openTime: '2026-01-04T10:00:00Z' }),
  ];
  eq('filter by symbol', applyFilter(trades, { symbols: ['ETHUSDT'] }).length, 1);
  eq('filter by date range', applyFilter(trades, { from: '2026-01-01', to: '2026-01-31' }).length, 3);
  eq('filter by side SHORT', applyFilter(trades, { sides: ['SHORT'] }).length, 1);
  eq('filter empty returns all', applyFilter(trades, {}).length, 4);
}

console.log('\n[5] Session / Time buckets');
{
  const asia = mk({ id: 's1', closeTime: '2026-01-05T03:00:00Z', netPnl: 10 });
  const london = mk({ id: 's2', closeTime: '2026-01-05T09:00:00Z', netPnl: -4 });
  const ny = mk({ id: 's3', closeTime: '2026-01-05T15:00:00Z', netPnl: 7 });
  const late = mk({ id: 's4', closeTime: '2026-01-05T23:00:00Z', netPnl: 1 });
  const sess = aggregateByTime([asia, london, ny, late], 'session');
  eq('session buckets', sess.length, 4);
  eq('asia pnl', sess.find((b) => b.key === 'ASIA')?.pnl, 10);
  eq('ny pnl', sess.find((b) => b.key === 'NEW_YORK')?.pnl, 7);

  const byHour = aggregateByTime([asia, london, ny, late], 'hour');
  eq('hour 03 pnl', byHour.find((b) => b.key === '03')?.pnl, 10);
  const byDow = aggregateByTime([asia, london, ny, late], 'dayOfWeek');
  eq('all Monday(1)', byDow.length, 1);
}

console.log('\n[6] Calendar / Tag / Side 聚合');
{
  const trades = [
    mk({ id: 'g1', netPnl: 100, closeTime: '2026-01-02T01:00:00Z', tags: ['t-breakout'] }),
    mk({ id: 'g2', netPnl: -40, closeTime: '2026-01-02T05:00:00Z', tags: ['t-breakout'] }),
    mk({ id: 'g3', netPnl: 60, closeTime: '2026-01-03T01:00:00Z', tags: ['t-fomo'], side: 'SELL', positionSide: 'SHORT' }),
  ];
  const cal = computeCalendar(trades);
  eq('calendar days', cal.length, 2);
  eq('2026-01-02 pnl', cal.find((d) => d.date === '2026-01-02')?.pnl, 60);
  eq('2026-01-02 winRate', cal.find((d) => d.date === '2026-01-02')?.winRate, 0.5);

  const tags = aggregateByTag(trades);
  eq('tag count', tags.length, 2);
  eq('breakout pnl', tags.find((t) => t.key === 't-breakout')?.pnl, 60);

  const sides = aggregateBySide(trades);
  const long = sides.find((s) => s.key === 'LONG');
  const short = sides.find((s) => s.key === 'SHORT');
  eq('long pnl', long?.pnl, 60);
  eq('short pnl', short?.pnl, 60);
}

console.log('\n[7] 去重');
{
  const base = mk({ id: 'd1', netPnl: 10, closeTime: '2026-01-02T01:00:00Z' });
  const dup1 = { ...base, externalTradeId: 'X1' };
  const dup2 = { ...base, externalTradeId: 'X1', netPnl: 11, updatedAt: '2026-01-10T00:00:00Z' };
  const dup3 = { ...base, externalTradeId: 'X1', netPnl: 99, updatedAt: '2026-01-05T00:00:00Z' };
  const other = mk({ id: 'd2', externalTradeId: 'X2', closeTime: '2026-01-02T02:00:00Z' });
  const noExt1 = { ...mk({ id: 'd3', externalTradeId: null, closeTime: '2026-01-02T03:00:00Z' }) };
  const noExt2 = { ...noExt1, id: 'd4' }; // 同键无 externalTradeId → 去重
  const res = dedupeTrades([dup1, dup2, dup3, other, noExt1, noExt2]);
  eq('dedup count', res.trades.length, 3);
  eq('duplicates flagged', res.duplicates, 3);
  eq('keep latest updatedAt', res.trades.find((t) => t.externalTradeId === 'X1')?.netPnl, 11);
}

console.log(`\n结果: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log('ALL PASSED ✓');
