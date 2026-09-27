import type { FilterSet, UnifiedTrade } from '@trademind/trading-core';
import { applyFilter } from './filter';
import { computeCoreMetrics, type CoreMetrics } from './metrics';
import { buildEquityCurve, type DrawdownStats } from './drawdown';
import { computeCalendar, type DayStats } from './calendar';
import {
  aggregateBySymbol,
  aggregateBySide,
  aggregateByStrategy,
  aggregateByTag,
  aggregateByMistake,
  type DimensionStats,
} from './aggregate';

export interface DashboardData {
  kpis: CoreMetrics;
  equity: DrawdownStats;
  daily: DayStats[];
  symbols: DimensionStats[];
  longShort: DimensionStats[];
  strategies: DimensionStats[];
  tags: DimensionStats[];
  mistakes: DimensionStats[];
  recentTrades: UnifiedTrade[];
}

/**
 * Dashboard 六行布局的一站式计算（所有数据已经过全局 Filter）。
 */
export function computeDashboard(
  trades: UnifiedTrade[],
  opts: {
    filter?: FilterSet;
    startingBalance?: number;
    strategyNameOf?: (id: string) => string | null;
    recentLimit?: number;
  } = {},
): DashboardData {
  const filtered = applyFilter(trades, opts.filter ?? {});
  const recentLimit = opts.recentLimit ?? 10;

  return {
    kpis: computeCoreMetrics(filtered),
    equity: buildEquityCurve(filtered, opts.startingBalance ?? 0),
    daily: computeCalendar(filtered),
    symbols: aggregateBySymbol(filtered),
    longShort: aggregateBySide(filtered),
    strategies: aggregateByStrategy(filtered, opts.strategyNameOf),
    tags: aggregateByTag(filtered),
    mistakes: aggregateByMistake(filtered),
    recentTrades: [...filtered]
      .sort(
        (a, b) =>
          new Date(b.closeTime ?? b.openTime).getTime() -
          new Date(a.closeTime ?? a.openTime).getTime(),
      )
      .slice(0, recentLimit),
  };
}

export { aggregateByTime } from './time';
