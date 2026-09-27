import type { UnifiedTrade } from '@trademind/trading-core';
import { isClosed, tradeDurationMs } from '@trademind/trading-core';

/**
 * 核心指标（全部为纯函数，输入已 applyFilter 的交易数组）。
 *
 * 公式（与设计文档一致）：
 *   Gross Profit  = Σ grossPnl > 0          ← 基于 grossPnl，保证恒等式成立
 *   Gross Loss    = Σ |grossPnl < 0|
 *   Net PNL       = Gross Profit − Gross Loss − Fees − Funding （= Σ netPnl）
 *   Win Rate      = WinningTrades / TotalClosedTrades（盈亏按 netPnl 判定）
 *   Profit Factor = Gross Profit / Gross Loss （Gross Loss=0 → Infinity，无交易 → 0）
 *   EV            = WinRate × AvgWin − LossRate × AvgLoss（Avg 基于 netPnl，净期望）
 */
export interface CoreMetrics {
  totalTrades: number; // 全部（含未平仓）
  closedTrades: number;
  winningTrades: number;
  losingTrades: number;
  breakEvenTrades: number;
  grossProfit: number;
  grossLoss: number;
  realizedPnl: number;
  fees: number;
  funding: number;
  netPnl: number;
  winRate: number; // 0..1
  profitFactor: number; // Infinity 表示无亏损；0 表示无交易或无盈利
  avgWin: number;
  avgLoss: number;
  expectancy: number; // EV（每笔净期望值）
  avgRr: number | null;
  largestWin: number;
  largestLoss: number; // ≤ 0
  avgDurationMinutes: number | null;
}

export function closed(trades: UnifiedTrade[]): UnifiedTrade[] {
  return trades.filter(isClosed);
}

export function computeCoreMetrics(trades: UnifiedTrade[]): CoreMetrics {
  const cs = closed(trades);
  const netPnls = cs.map((t) => t.netPnl);
  const grossPnls = cs.map((t) => t.grossPnl);
  const winSet = netPnls.filter((p) => p > 0);
  const lossSet = netPnls.filter((p) => p < 0);
  const grossProfit = grossPnls.filter((p) => p > 0).reduce((a, b) => a + b, 0);
  const grossLoss = grossPnls
    .filter((p) => p < 0)
    .reduce((a, b) => a + Math.abs(b), 0);
  const fees = trades.reduce((a, t) => a + t.fees, 0);
  const funding = trades.reduce((a, t) => a + t.funding, 0);
  const netPnl = cs.reduce((a, t) => a + t.netPnl, 0);

  const winningTrades = winSet.length;
  const losingTrades = lossSet.length;
  const breakEvenTrades = cs.length - winningTrades - losingTrades;
  const totalClosed = cs.length;

  const winRate = totalClosed > 0 ? winningTrades / totalClosed : 0;
  const lossRate = totalClosed > 0 ? losingTrades / totalClosed : 0;
  const avgWin = winningTrades > 0 ? winSet.reduce((a, b) => a + b, 0) / winningTrades : 0;
  const avgLoss =
    losingTrades > 0 ? lossSet.reduce((a, b) => a + Math.abs(b), 0) / losingTrades : 0;

  const profitFactor =
    totalClosed === 0
      ? 0
      : grossLoss === 0
        ? (grossProfit > 0 ? Infinity : 0)
        : grossProfit / grossLoss;

  const rrValues = cs.map((t) => t.rr).filter((v): v is number => v !== null && Number.isFinite(v));
  const durations = cs
    .map((t) => tradeDurationMs(t))
    .filter((v): v is number => v !== null);

  return {
    totalTrades: trades.length,
    closedTrades: totalClosed,
    winningTrades,
    losingTrades,
    breakEvenTrades,
    grossProfit,
    grossLoss,
    realizedPnl: netPnl,
    fees,
    funding,
    netPnl,
    winRate,
    profitFactor,
    avgWin,
    avgLoss,
    expectancy: winRate * avgWin - lossRate * avgLoss,
    avgRr: rrValues.length > 0 ? rrValues.reduce((a, b) => a + b, 0) / rrValues.length : null,
    largestWin: winSet.length > 0 ? Math.max(...winSet) : 0,
    largestLoss: lossSet.length > 0 ? Math.min(...lossSet) : 0,
    avgDurationMinutes:
      durations.length > 0
        ? durations.reduce((a, b) => a + b, 0) / durations.length / 60000
        : null,
  };
}
