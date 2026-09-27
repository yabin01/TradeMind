import type { Session } from './types';

/**
 * 全局过滤器 —— Dashboard / Analytics / Calendar / Trades 全站共用。
 * 修改后所有 KPI、图表、表格、日历实时联动。
 */
export interface FilterSet {
  from?: string | null; // ISO date（含）
  to?: string | null; // ISO date（含）
  portfolioIds?: string[];
  accountIds?: string[];
  exchanges?: string[];
  symbols?: string[];
  sides?: ('LONG' | 'SHORT')[]; // 语义方向
  strategyIds?: string[];
  tagIds?: string[];
  mistakeIds?: string[];
  sessions?: Session[];
  timeframes?: string[];

  // ── 筛选 v2（对齐 TMM Filters）──
  /** 标签匹配模式：any=命中任一，all=全部包含 */
  tagMode?: 'any' | 'all';
  /** 入场理由标签（按名称匹配） */
  entryTags?: string[];
  entryTagMode?: 'any' | 'all';
  /** 出场理由标签（按名称匹配） */
  exitTags?: string[];
  exitTagMode?: 'any' | 'all';
  /** 排除：命中任一标签即剔除（≠ 模式） */
  excludeEntryTags?: string[];
  excludeTags?: string[];
  /** 净盈亏区间（含边界） */
  minPnl?: number;
  maxPnl?: number;
  /** 杠杆区间 */
  minLeverage?: number;
  maxLeverage?: number;
  /** 持仓时长（分钟）区间 */
  minHoldMinutes?: number;
  maxHoldMinutes?: number;
  /** 资金费率区间（含边界） */
  minFunding?: number;
  maxFunding?: number;
  /** 手续费区间（含边界） */
  minFee?: number;
  maxFee?: number;
  /** 成交量区间（USDT 名义 ≈ entryPrice × quantity） */
  minVolume?: number;
  maxVolume?: number;
  /** 下单数量区间（合约张数 / 标的单位） */
  minQuantity?: number;
  maxQuantity?: number;
  /** 结果过滤 */
  outcome?: 'WIN' | 'LOSS' | 'FLAT';
  /** 星期（0=周日 … 6=周六，按平仓日 UTC） */
  weekdays?: number[];
  /** 小时（0-23，按平仓时间 UTC） */
  hours?: number[];
  /** 是否包含已归档交易（默认排除） */
  includeArchived?: boolean;
  /** 仅看已平仓（Diary 等场景默认 true 语义由调用方控制） */
  closedOnly?: boolean;
}

export function emptyFilter(): FilterSet {
  return {};
}

export function isFilterEmpty(f: FilterSet): boolean {
  return Object.values(f).every(
    (v) => v === null || v === undefined || (Array.isArray(v) && v.length === 0),
  );
}
