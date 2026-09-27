import type { UnifiedTrade } from '@trademind/trading-core';
import { isClosed, tradeDurationMs } from '@trademind/trading-core';
import { getSession } from './time';

/**
 * 单笔交易的派生明细字段（纯函数）。
 *
 * 目的：把「原始字段」翻译成「能直接判断这笔交易做得好不好」的口径。
 * 所有字段都由已有数据精确计算，不做估算、不编造。
 *
 * ⚠️ MAE / MFE 的处理（重要）：
 *   MAE（最大不利偏移）/ MFE（最大有利偏移）需要**持仓期间的价格路径**（逐笔成交或分钟 K 线），
 *   而当前数据源（OKX 仓位历史）只提供 openAvgPx / closeAvgPx 两个均价，因此**无法计算**。
 *   这里一律返回 null 并给出原因，绝不拿 stopLoss/rr 反推一个假值。
 *   若 metadata 中带了持仓期间极值（metadata.extremes = { high, low }），则自动启用计算——
 *   为将来接入逐笔或 K 线数据预留，无需改代码。
 */

export interface TradeDetail {
  id: string;
  symbol: string;
  exchange: string;
  /** LONG | SHORT（NET 时按 side 推断） */
  direction: 'LONG' | 'SHORT';
  isClosed: boolean;

  // ── 价格与规模 ──
  entryPrice: number;
  exitPrice: number | null;
  quantity: number;
  /** 名义价值 = 开仓价 × 数量 */
  notional: number;
  leverage: number;
  /** 保证金估算 = 名义价值 / 杠杆（未考虑维持保证金与逐仓/全仓差异） */
  marginEstimate: number | null;

  // ── 时间与持仓 ──
  openTime: string;
  closeTime: string | null;
  holdingMinutes: number | null;
  session: string;
  weekday: string;
  hourUtc: number;
  /** 该笔是当天（UTC）的第几笔平仓，用于识别「当日最后一笔」等场景 */
  sequenceInDay: number | null;

  // ── 盈亏拆解 ──
  grossPnl: number;
  fees: number;
  funding: number;
  netPnl: number;
  /** 总成本 = |手续费| + |资金费|（正数） */
  totalCost: number;
  isWin: boolean | null;

  // ── 相对口径（可跨品种/跨仓位比较） ──
  /** 价格有利变动百分比（已按方向取正负） */
  priceChangePct: number | null;
  /** 净盈亏 / 名义价值 */
  netPnlPctOfNotional: number | null;
  /** 成本 / 名义价值 */
  costPctOfNotional: number | null;
  /** 成本 / |毛利|（>100% 表示成本吃掉全部毛利） */
  costRatioOfGross: number | null;
  /** 净盈亏 / 持仓小时（资金效率） */
  pnlPerHour: number | null;

  // ── 风险 ──
  stopLoss: number | null;
  takeProfit: number | null;
  risk: number | null;
  reward: number | null;
  rr: number | null;
  /** R 倍数 = 净盈亏 / 计划风险（风险归一化后的结果） */
  rMultiple: number | null;
  /** 出场价是否触及止损（null = 未设止损或未平仓） */
  hitStopLoss: boolean | null;
  hitTakeProfit: boolean | null;

  // ── MAE / MFE ──
  mae: number | null;
  mfe: number | null;
  /** 是否具备计算条件（需要持仓期间价格路径） */
  maeMfeAvailable: boolean;
  maeMfeReason: string | null;

  // ── 元信息 ──
  strategyId: string | null;
  tags: string[];
  mistakes: string[];
  confidence: number | null;
  marketCondition: string | null;
  notes: string | null;
  externalTradeId: string | null;
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function directionOf(t: UnifiedTrade): 'LONG' | 'SHORT' {
  if (t.positionSide && t.positionSide !== 'NET') return t.positionSide === 'LONG' ? 'LONG' : 'SHORT';
  return t.side === 'BUY' ? 'LONG' : 'SHORT';
}

/**
 * 从 metadata 里尝试读取持仓期间极值。
 * 支持两种约定（将来接入 K 线/逐笔数据时任选其一即可生效）：
 *   metadata.extremes = { high: number, low: number }
 *   metadata.maePrice / metadata.mfePrice
 */
function readExtremes(t: UnifiedTrade): { high: number; low: number } | null {
  const md = (t.metadata ?? {}) as Record<string, unknown>;
  const ex = md.extremes as { high?: unknown; low?: unknown } | undefined;
  if (ex) {
    const high = Number(ex.high);
    const low = Number(ex.low);
    if (Number.isFinite(high) && Number.isFinite(low)) return { high, low };
  }
  const maeP = Number(md.maePrice);
  const mfeP = Number(md.mfePrice);
  if (Number.isFinite(maeP) && Number.isFinite(mfeP)) {
    return { high: Math.max(maeP, mfeP), low: Math.min(maeP, mfeP) };
  }
  return null;
}

/**
 * 单笔交易的 MAE / MFE。
 * MAE = 持仓期间朝不利方向的最大偏移（负值表示不利，单位与 pnl 同口径）
 * MFE = 持仓期间朝有利方向的最大偏移（正值）
 * 需要持仓期间的最高价/最低价；数据不足时返回 null。
 */
export function computeMaeMfe(
  t: UnifiedTrade,
): { mae: number | null; mfe: number | null; available: boolean; reason: string | null } {
  const reason =
    'MAE/MFE 需要持仓期间的价格路径（逐笔成交或分钟 K 线）。当前数据源仅提供开仓/平仓均价，无法计算——不做估算。';
  const ex = readExtremes(t);
  if (!ex) return { mae: null, mfe: null, available: false, reason };
  if (!isClosed(t) || t.exitPrice === null) {
    return { mae: null, mfe: null, available: false, reason: '交易尚未平仓。' };
  }
  const dir = directionOf(t);
  const qty = t.quantity;
  // 对 LONG：低点是不利方向、高点是有利方向；SHORT 相反
  const adversePrice = dir === 'LONG' ? ex.low : ex.high;
  const favorablePrice = dir === 'LONG' ? ex.high : ex.low;
  const sign = dir === 'LONG' ? 1 : -1;
  const mae = (adversePrice - t.entryPrice) * qty * sign; // ≤ 0 表示不利
  const mfe = (favorablePrice - t.entryPrice) * qty * sign; // ≥ 0 表示有利
  return { mae, mfe, available: true, reason: null };
}

/**
 * 计算单笔交易的完整明细。
 * @param allTrades 同工作区的全部交易（用于算「当日第几笔」这样的相对位置），可省略
 */
export function buildTradeDetail(
  t: UnifiedTrade,
  allTrades?: UnifiedTrade[],
): TradeDetail {
  const dir = directionOf(t);
  const notional = t.entryPrice * t.quantity;
  const durationMs = tradeDurationMs(t);
  const holdingMinutes = durationMs === null ? null : durationMs / 60000;

  const cost = Math.abs(t.fees) + Math.abs(t.funding);
  const closed = isClosed(t);

  // 相对口径
  const priceChangePct =
    closed && t.exitPrice !== null && t.entryPrice !== 0
      ? ((t.exitPrice - t.entryPrice) / t.entryPrice) * 100 * (dir === 'LONG' ? 1 : -1)
      : null;
  const netPnlPctOfNotional = notional !== 0 ? (t.netPnl / notional) * 100 : null;
  const costPctOfNotional = notional !== 0 ? (cost / notional) * 100 : null;
  const costRatioOfGross = t.grossPnl !== 0 ? cost / Math.abs(t.grossPnl) : null;
  const pnlPerHour =
    holdingMinutes !== null && holdingMinutes > 0 ? t.netPnl / (holdingMinutes / 60) : null;

  // 风险
  const rMultiple = t.risk !== null && t.risk !== undefined && t.risk > 0 ? t.netPnl / t.risk : null;
  let hitStopLoss: boolean | null = null;
  let hitTakeProfit: boolean | null = null;
  if (closed && t.exitPrice !== null) {
    if (t.stopLoss !== null && t.stopLoss !== undefined) {
      hitStopLoss = dir === 'LONG' ? t.exitPrice <= t.stopLoss : t.exitPrice >= t.stopLoss;
    }
    if (t.takeProfit !== null && t.takeProfit !== undefined) {
      hitTakeProfit = dir === 'LONG' ? t.exitPrice >= t.takeProfit : t.exitPrice <= t.takeProfit;
    }
  }

  const mm = computeMaeMfe(t);

  // 当日第几笔平仓
  let sequenceInDay: number | null = null;
  if (closed && allTrades && allTrades.length > 0) {
    const day = new Date(t.closeTime as string).toISOString().slice(0, 10);
    const sameDay = allTrades
      .filter((x) => isClosed(x) && new Date(x.closeTime as string).toISOString().slice(0, 10) === day)
      .sort(
        (a, b) =>
          new Date(a.closeTime as string).getTime() - new Date(b.closeTime as string).getTime(),
      );
    sequenceInDay = sameDay.findIndex((x) => x.id === t.id) + 1 || null;
  }

  return {
    id: t.id,
    symbol: t.symbol,
    exchange: t.exchange,
    direction: dir,
    isClosed: closed,
    entryPrice: t.entryPrice,
    exitPrice: t.exitPrice,
    quantity: t.quantity,
    notional,
    leverage: t.leverage,
    marginEstimate: t.leverage > 0 ? notional / t.leverage : null,
    openTime: t.openTime,
    closeTime: t.closeTime,
    holdingMinutes,
    session: getSession(t.openTime),
    weekday: WEEKDAYS[new Date(t.openTime).getUTCDay()] ?? '—',
    hourUtc: new Date(t.openTime).getUTCHours(),
    sequenceInDay,
    grossPnl: t.grossPnl,
    fees: t.fees,
    funding: t.funding,
    netPnl: t.netPnl,
    totalCost: cost,
    isWin: closed ? t.netPnl > 0 : null,
    priceChangePct,
    netPnlPctOfNotional,
    costPctOfNotional,
    costRatioOfGross,
    pnlPerHour,
    stopLoss: t.stopLoss,
    takeProfit: t.takeProfit,
    risk: t.risk,
    reward: t.reward,
    rr: t.rr,
    rMultiple,
    hitStopLoss,
    hitTakeProfit,
    mae: mm.mae,
    mfe: mm.mfe,
    maeMfeAvailable: mm.available,
    maeMfeReason: mm.reason,
    strategyId: t.strategyId,
    tags: t.tags,
    mistakes: t.mistakes,
    confidence: t.confidence,
    marketCondition: t.marketCondition,
    notes: t.notes,
    externalTradeId: t.externalTradeId,
  };
}

/** 批量构建（保持调用方简洁） */
export function buildTradeDetails(
  trades: UnifiedTrade[],
  allTrades?: UnifiedTrade[],
): TradeDetail[] {
  const pool = allTrades ?? trades;
  return trades.map((t) => buildTradeDetail(t, pool));
}
