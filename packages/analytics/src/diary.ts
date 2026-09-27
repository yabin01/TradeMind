import type { UnifiedTrade } from '@trademind/trading-core';
import { tradeDirectionOf, tradeDurationMs } from '@trademind/trading-core';
import { closed } from './metrics';

/**
 * Diary（交易日志）聚合 —— 纯函数，供 /api/diary 系列接口使用。
 *
 * 口径：
 *   - 归属日 = 平仓日（用户确认的口径；未平仓交易一律不进 Diary）
 *   - 周 = 周一起始（UTC），与 TMM 一致；跨月的周会在两个月里都出现，保证不漏任何交易日
 *   - 盈亏比 = 毛利 / 毛损（与 TMM「盈亏比 $3.63/$0.65」同口径，即我们的 PF）
 *   - 成交量 = Σ 开仓价 × 数量（USD）
 *   - 一天没有平仓交易 → stats 为全 0（Diary 显示「无成交」，不隐藏该日）
 */

export interface DiaryPeriodStats {
  pnl: number;
  trades: number;
  wins: number;
  winRate: number | null; // wins/trades，无交易时 null
  volume: number;
  fees: number;
  funding: number;
  /** 盈亏比 = 毛利 / 毛损（GL=0 且有盈利时为 ∞ → 用 null 表示，由 UI 渲染 ∞） */
  profitFactor: number | null;
  longCount: number;
  shortCount: number;
  avgLeverage: number | null;
  maxLeverage: number | null;
  avgHoldMinutes: number | null;
}

export interface DiaryMonth {
  key: string; // YYYY-MM
  stats: DiaryPeriodStats;
  weeks: { start: string; end: string; stats: DiaryPeriodStats }[];
}

export interface DiaryDay {
  date: string; // YYYY-MM-DD
  stats: DiaryPeriodStats;
}

const ZERO: DiaryPeriodStats = {
  pnl: 0,
  trades: 0,
  wins: 0,
  winRate: null,
  volume: 0,
  fees: 0,
  funding: 0,
  profitFactor: null,
  longCount: 0,
  shortCount: 0,
  avgLeverage: null,
  maxLeverage: null,
  avgHoldMinutes: null,
};

export function dayKeyOf(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

/** 周一起始的周一日期（UTC） */
export function mondayOf(dateKey: string): string {
  const d = new Date(`${dateKey}T00:00:00Z`);
  const dow = d.getUTCDay(); // 0=周日
  const delta = (dow + 6) % 7; // 周一偏移
  d.setUTCDate(d.getUTCDate() - delta);
  return d.toISOString().slice(0, 10);
}

function addDays(dateKey: string, n: number): string {
  const d = new Date(`${dateKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 聚合任意一组已平仓交易为周期统计（调用方保证传入的就是该周期的交易） */
export function periodStats(trades: UnifiedTrade[]): DiaryPeriodStats {
  const cs = closed(trades);
  if (cs.length === 0) return { ...ZERO };
  let pnl = 0;
  let wins = 0;
  let volume = 0;
  let fees = 0;
  let funding = 0;
  let gp = 0;
  let gl = 0;
  let longCount = 0;
  let shortCount = 0;
  let levSum = 0;
  let maxLev = 0;
  const holds: number[] = [];
  for (const t of cs) {
    pnl += t.netPnl;
    if (t.netPnl > 0) wins += 1;
    volume += t.entryPrice * t.quantity;
    fees += Math.abs(t.fees);
    funding += Math.abs(t.funding);
    if (t.grossPnl > 0) gp += t.grossPnl;
    else if (t.grossPnl < 0) gl += -t.grossPnl;
    const dir = tradeDirectionOf(t);
    if (dir === 'LONG') longCount += 1;
    else shortCount += 1;
    levSum += t.leverage;
    if (t.leverage > maxLev) maxLev = t.leverage;
    const d = tradeDurationMs(t);
    if (d !== null) holds.push(d / 60000);
  }
  return {
    pnl,
    trades: cs.length,
    wins,
    winRate: wins / cs.length,
    volume,
    fees,
    funding,
    profitFactor: gl > 0 ? gp / gl : gp > 0 ? null : 0, // GL=0 有盈利 → null（UI 渲染 ∞）
    longCount,
    shortCount,
    avgLeverage: levSum / cs.length,
    maxLeverage: maxLev,
    avgHoldMinutes: holds.length > 0 ? holds.reduce((a, b) => a + b, 0) / holds.length : null,
  };
}

function inRange(t: UnifiedTrade, startKey: string, endKey: string): boolean {
  if (!t.closeTime) return false;
  const k = dayKeyOf(t.closeTime);
  return k >= startKey && k <= endKey;
}

function tradesOfDay(all: UnifiedTrade[], dateKey: string): UnifiedTrade[] {
  return all.filter((t) => t.closeTime && dayKeyOf(t.closeTime) === dateKey);
}

/** 某年逐月视图：每月 KPI（按平仓日归属）+ 覆盖该月的周卡片（整周 KPI，跨月周会重复出现） */
export function diaryYear(all: UnifiedTrade[], year: number): { year: number; months: DiaryMonth[] } {
  const cs = all.filter((t) => t.closeTime);
  const months: DiaryMonth[] = [];
  for (let m = 1; m <= 12; m++) {
    const mm = String(m).padStart(2, '0');
    const monthStart = `${year}-${mm}-01`;
    const monthEnd = new Date(Date.UTC(year, m, 0)).toISOString().slice(0, 10); // 当月最后一天
    const monthTrades = cs.filter((t) => {
      const k = dayKeyOf(t.closeTime as string);
      return k >= monthStart && k <= monthEnd;
    });

    // 该月覆盖到的周：从月内第一天所在周开始，逐周推进直到周起始日 > 月末
    const weeks: { start: string; end: string; stats: DiaryPeriodStats }[] = [];
    let cursor = mondayOf(monthStart);
    while (cursor <= monthEnd) {
      const end = addDays(cursor, 6);
      const weekTrades = cs.filter((t) => inRange(t, cursor, end));
      if (weekTrades.length > 0) {
        weeks.push({ start: cursor, end, stats: periodStats(weekTrades) });
      }
      cursor = addDays(cursor, 7);
    }
    months.push({ key: `${year}-${mm}`, stats: periodStats(monthTrades), weeks });
  }
  return { year, months };
}

/** 周视图：本周 KPI + 上一周 KPI（对比用）+ 每日卡片（7 天，无交易也返回全 0） */
export function diaryWeek(
  all: UnifiedTrade[],
  weekStartKey: string,
): {
  start: string;
  end: string;
  stats: DiaryPeriodStats;
  prev: DiaryPeriodStats;
  days: DiaryDay[];
} {
  const start = mondayOf(weekStartKey);
  const end = addDays(start, 6);
  const weekTrades = all.filter((t) => inRange(t, start, end));
  const prevStart = addDays(start, -7);
  const prevEnd = addDays(start, -1);
  const prevTrades = all.filter((t) => inRange(t, prevStart, prevEnd));
  const days: DiaryDay[] = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(start, i);
    days.push({ date: d, stats: periodStats(tradesOfDay(all, d)) });
  }
  return { start, end, stats: periodStats(weekTrades), prev: periodStats(prevTrades), days };
}

/** 日视图：当日 KPI + 按平仓时间累计的盈亏时间线 + 当日交易列表 */
export function diaryDay(
  all: UnifiedTrade[],
  dateKey: string,
): {
  date: string;
  stats: DiaryPeriodStats;
  timeline: { t: string; cumPnl: number }[];
  trades: UnifiedTrade[];
} {
  const dayTrades = tradesOfDay(all, dateKey).sort(
    (a, b) => new Date(a.closeTime as string).getTime() - new Date(b.closeTime as string).getTime(),
  );
  let cum = 0;
  const timeline = dayTrades.map((t) => {
    cum += t.netPnl;
    return { t: (t.closeTime as string).slice(11, 19), cumPnl: Math.round(cum * 100) / 100 };
  });
  return { date: dateKey, stats: periodStats(dayTrades), timeline, trades: dayTrades };
}
