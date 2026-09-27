import type { UnifiedTrade } from './models/trade';

/**
 * 去重键（数据去重是硬需求：同一笔交易可能从 Broker API / CSV / 手动导入重复进入）。
 *
 * 优先级 1：externalTradeId 存在 → (exchange, accountId, externalTradeId)
 * 优先级 2：无 externalTradeId（CSV/手动）→ (exchange, accountId, openTime, closeTime, symbol, side)
 */
export function dedupKey(t: UnifiedTrade): string {
  if (t.externalTradeId) {
    return `${t.exchange}:${t.accountId}:${t.externalTradeId}`;
  }
  return [
    t.exchange,
    t.accountId,
    t.openTime,
    t.closeTime ?? 'OPEN',
    t.symbol,
    t.side,
  ].join(':');
}

/**
 * 去重：键相同保留 updatedAt 更新（或数组中靠后）的那条。
 */
export function dedupeTrades(trades: UnifiedTrade[]): {
  trades: UnifiedTrade[];
  duplicates: number;
} {
  const map = new Map<string, UnifiedTrade>();
  let duplicates = 0;
  for (const t of trades) {
    const key = dedupKey(t);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, t);
      continue;
    }
    duplicates++;
    const existingTs = existing.updatedAt ? Date.parse(existing.updatedAt) : 0;
    const incomingTs = t.updatedAt ? Date.parse(t.updatedAt) : 0;
    if (incomingTs >= existingTs) map.set(key, t);
  }
  return { trades: [...map.values()], duplicates };
}
