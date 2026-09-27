import type { UnifiedTrade } from '@trademind/trading-core';
import { isClosed, tradeDirectionOf, tradeDurationMs } from '@trademind/trading-core';
import { computeCoreMetrics } from './metrics';
import { buildEquityCurve } from './drawdown';

export interface DimensionStats {
  key: string;
  label: string;
  trades: number;
  winRate: number;
  pnl: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number | null; // Infinity → null（JSON 安全），UI 显示 "∞"
  expectancy: number;
  avgRr: number | null;
  maxDrawdown: number;
  avgDurationMinutes: number | null;
  longPnl?: number;
  shortPnl?: number;
}

export type KeyFn = (t: UnifiedTrade) => string | string[];

function toFinitePf(v: number): number | null {
  return Number.isFinite(v) ? v : null;
}

/**
 * 通用维度聚合：Symbol / Long-Short / Strategy / Tag / Mistake 共用同一实现。
 */
export function aggregateBy(
  trades: UnifiedTrade[],
  keyFn: KeyFn,
  opts: { withSideSplit?: boolean } = {},
): DimensionStats[] {
  const groups = new Map<string, UnifiedTrade[]>();
  for (const t of trades.filter(isClosed)) {
    const keys = keyFn(t);
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      const arr = groups.get(key) ?? [];
      arr.push(t);
      groups.set(key, arr);
    }
  }

  const out: DimensionStats[] = [];
  for (const [key, group] of groups) {
    const m = computeCoreMetrics(group);
    const dd = buildEquityCurve(group, 0);
    const durations = group
      .map((t) => tradeDurationMs(t))
      .filter((v): v is number => v !== null);
    const stats: DimensionStats = {
      key,
      label: key,
      trades: m.closedTrades,
      winRate: m.winRate,
      pnl: m.netPnl,
      avgWin: m.avgWin,
      avgLoss: m.avgLoss,
      profitFactor: toFinitePf(m.profitFactor),
      expectancy: m.expectancy,
      avgRr: m.avgRr,
      maxDrawdown: dd.maxDrawdown,
      avgDurationMinutes:
        durations.length > 0
          ? durations.reduce((a, b) => a + b, 0) / durations.length / 60000
          : null,
    };
    if (opts.withSideSplit) {
      stats.longPnl = group
        .filter((t) => tradeDirectionOf(t) === 'LONG')
        .reduce((a, t) => a + t.netPnl, 0);
      stats.shortPnl = group
        .filter((t) => tradeDirectionOf(t) === 'SHORT')
        .reduce((a, t) => a + t.netPnl, 0);
    }
    out.push(stats);
  }
  return out.sort((a, b) => b.pnl - a.pnl);
}

export function aggregateBySymbol(trades: UnifiedTrade[]): DimensionStats[] {
  return aggregateBy(trades, (t) => t.symbol, { withSideSplit: true });
}

export function aggregateBySide(trades: UnifiedTrade[]): DimensionStats[] {
  return aggregateBy(trades, (t) => tradeDirectionOf(t));
}

export function aggregateByStrategy(
  trades: UnifiedTrade[],
  nameOf: (strategyId: string) => string | null = (id) => id,
): DimensionStats[] {
  return aggregateBy(
    trades.filter((t) => t.strategyId),
    (t) => nameOf(t.strategyId as string) ?? (t.strategyId as string),
  );
}

export function aggregateByTag(trades: UnifiedTrade[]): DimensionStats[] {
  return aggregateBy(trades, (t) => t.tags);
}

export function aggregateByMistake(trades: UnifiedTrade[]): DimensionStats[] {
  return aggregateBy(trades, (t) => t.mistakes);
}
