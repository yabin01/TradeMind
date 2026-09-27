import type { FilterSet, UnifiedTrade } from '@trademind/trading-core';
import { tradeDirectionOf, tradeDurationMs } from '@trademind/trading-core';
import { getSession, DEFAULT_SESSION_CONFIG } from './time';

/**
 * 全局 Filter Engine —— 所有 KPI / 图表 / 表格 / 日历 / 分析查询前必须先过此函数。
 * 日期按平仓时间（未平仓用开仓时间）过滤。
 *
 * v2（对齐 TMM Filters）：账户/标签多选、any/all 模式、≠ 排除、
 * 盈亏/杠杆/持仓时长区间、胜负、星期与小时、归档隔离。
 */

function matchNames(values: string[] | undefined, present: string[], mode: 'any' | 'all' = 'any'): boolean {
  if (!values || values.length === 0) return true;
  return mode === 'all' ? values.every((v) => present.includes(v)) : values.some((v) => present.includes(v));
}

export function applyFilter(trades: UnifiedTrade[], f: FilterSet): UnifiedTrade[] {
  if (!f) return trades;
  return trades.filter((t) => {
    // 归档隔离：除非显式 includeArchived，否则一律排除（Archive 分类语义）
    if (!f.includeArchived && t.archived) return false;
    if (f.closedOnly && (t.closeTime === null || t.closeTime === undefined)) return false;

    const refTime = t.closeTime ?? t.openTime;
    if (f.from && refTime < f.from) return false;
    if (f.to) {
      const toEnd = f.to.length === 10 ? `${f.to}T23:59:59.999Z` : f.to;
      if (refTime > toEnd) return false;
    }
    if (f.accountIds?.length && !f.accountIds.includes(t.accountId)) return false;
    if (f.exchanges?.length && !f.exchanges.includes(t.exchange)) return false;
    if (f.symbols?.length && !f.symbols.includes(t.symbol)) return false;
    if (f.sides?.length && !f.sides.includes(tradeDirectionOf(t))) return false;
    if (f.strategyIds?.length && (!t.strategyId || !f.strategyIds.includes(t.strategyId)))
      return false;
    if (f.tagIds?.length) {
      const ok =
        (f.tagMode ?? 'any') === 'all'
          ? f.tagIds.every((id) => t.tags.includes(id))
          : t.tags.some((id) => f.tagIds!.includes(id));
      if (!ok) return false;
    }
    if (f.excludeTags?.length && t.tags.some((id) => f.excludeTags!.includes(id))) return false;
    if (f.mistakeIds?.length && !t.mistakes.some((id) => f.mistakeIds!.includes(id)))
      return false;

    // 入场 / 出场理由标签（按名称）
    if (!matchNames(f.entryTags, t.entryTags ?? [], f.entryTagMode ?? 'any')) return false;
    if (!matchNames(f.exitTags, t.exitTags ?? [], f.exitTagMode ?? 'any')) return false;
    if (f.excludeEntryTags?.length && (t.entryTags ?? []).some((x) => f.excludeEntryTags!.includes(x)))
      return false;

    // 数值区间
    if (f.minPnl !== undefined && f.minPnl !== null && t.netPnl < f.minPnl) return false;
    if (f.maxPnl !== undefined && f.maxPnl !== null && t.netPnl > f.maxPnl) return false;
    if (f.minLeverage !== undefined && f.minLeverage !== null && t.leverage < f.minLeverage) return false;
    if (f.maxLeverage !== undefined && f.maxLeverage !== null && t.leverage > f.maxLeverage) return false;

    const durMin = tradeDurationMs(t);
    const holdMin = durMin === null ? null : durMin / 60000;
    if (f.minHoldMinutes !== undefined && f.minHoldMinutes !== null) {
      if (holdMin === null || holdMin < f.minHoldMinutes) return false;
    }
    if (f.maxHoldMinutes !== undefined && f.maxHoldMinutes !== null) {
      if (holdMin === null || holdMin > f.maxHoldMinutes) return false;
    }

    // 资金费率 / 手续费（合约账户的风控维度：资金费吃掉的利润、手续费占比）
    if (f.minFunding !== undefined && f.minFunding !== null && t.funding < f.minFunding) return false;
    if (f.maxFunding !== undefined && f.maxFunding !== null && t.funding > f.maxFunding) return false;
    if (f.minFee !== undefined && f.minFee !== null && t.fees < f.minFee) return false;
    if (f.maxFee !== undefined && f.maxFee !== null && t.fees > f.maxFee) return false;

    // 成交量（名义 = 入场价 × 数量）/ 下单数量
    const volume = (t.entryPrice ?? 0) * (t.quantity ?? 0);
    if (f.minVolume !== undefined && f.minVolume !== null && volume < f.minVolume) return false;
    if (f.maxVolume !== undefined && f.maxVolume !== null && volume > f.maxVolume) return false;
    if (f.minQuantity !== undefined && f.minQuantity !== null && t.quantity < f.minQuantity)
      return false;
    if (f.maxQuantity !== undefined && f.maxQuantity !== null && t.quantity > f.maxQuantity)
      return false;

    // 结果
    if (f.outcome) {
      if (t.closeTime === null || t.closeTime === undefined) return false;
      if (f.outcome === 'WIN' && t.netPnl <= 0) return false;
      if (f.outcome === 'LOSS' && t.netPnl >= 0) return false;
      if (f.outcome === 'FLAT' && t.netPnl !== 0) return false;
    }

    // 星期 / 小时（按平仓时间 UTC）
    if (f.weekdays?.length) {
      if (t.closeTime === null) return false;
      const dow = new Date(t.closeTime).getUTCDay();
      if (!f.weekdays.includes(dow)) return false;
    }
    if (f.hours?.length) {
      if (t.closeTime === null) return false;
      const h = new Date(t.closeTime).getUTCHours();
      if (!f.hours.includes(h)) return false;
    }

    if (f.sessions?.length) {
      const s = getSession(refTime, DEFAULT_SESSION_CONFIG);
      if (!f.sessions.includes(s)) return false;
    }
    return true;
  });
}
