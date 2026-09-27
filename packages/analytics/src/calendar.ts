import type { UnifiedTrade } from '@trademind/trading-core';
import { isClosed } from '@trademind/trading-core';

export interface DayStats {
  date: string; // yyyy-MM-dd (UTC)
  pnl: number;
  trades: number;
  wins: number;
  winRate: number;
}

/** Trading Calendar：每日 PNL / Trades / WinRate（只含有交易的日子） */
export function computeCalendar(trades: UnifiedTrade[]): DayStats[] {
  const map = new Map<string, { pnl: number; trades: number; wins: number }>();
  for (const t of trades.filter(isClosed)) {
    const date = new Date(t.closeTime as string).toISOString().slice(0, 10);
    const agg = map.get(date) ?? { pnl: 0, trades: 0, wins: 0 };
    agg.trades++;
    if (t.netPnl > 0) agg.wins++;
    agg.pnl += t.netPnl;
    map.set(date, agg);
  }
  return [...map.entries()]
    .map(([date, agg]) => ({
      date,
      pnl: agg.pnl,
      trades: agg.trades,
      wins: agg.wins,
      winRate: agg.trades > 0 ? agg.wins / agg.trades : 0,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}
