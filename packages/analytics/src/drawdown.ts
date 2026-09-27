import type { UnifiedTrade } from '@trademind/trading-core';
import { closed } from './metrics';

export interface EquityPoint {
  t: string; // closeTime ISO
  equity: number;
  hwm: number; // high water mark
  drawdown: number; // ≤ 0
}

export interface DrawdownStats {
  curve: EquityPoint[];
  maxDrawdown: number; // ≤ 0（绝对金额）
  maxDrawdownPct: number | null; // 相对 maxDD 时的 HWM
  maxDrawdownTime: string | null;
  maxRunup: number; // ≥ 0
  currentDrawdown: number; // ≤ 0
  currentDrawdownPct: number | null;
  drawdownDurationDays: number | null; // 当前这轮 DD 已持续天数（未在回撤中则为 0/null）
  maxDrawdownDurationDays: number | null; // 历史上最长连续回撤天数
  recoveryDays: number | null; // 触达 MaxDD 后回到 HWM 的天数；未恢复 → null
}

/**
 * Equity Curve / 高水位 / 回撤曲线。
 * equity_t = startingBalance + Σ (closeTime ≤ t 的已平仓 netPnl)
 */
export function buildEquityCurve(
  trades: UnifiedTrade[],
  startingBalance = 0,
): DrawdownStats {
  const cs = closed(trades).sort(
    (a, b) => new Date(a.closeTime as string).getTime() - new Date(b.closeTime as string).getTime(),
  );

  const curve: EquityPoint[] = [];
  let equity = startingBalance;
  let hwm = startingBalance;
  let hwmTime: string | null = cs.length > 0 ? cs[0].openTime : null;
  let trough = startingBalance;
  let maxRunup = 0;
  let maxDrawdown = 0;
  let maxDrawdownTime: string | null = null;
  let maxDrawdownHwm = startingBalance;
  let inDd = false;
  let ddStart: string | null = null;
  let maxDdDuration = 0;

  for (const t of cs) {
    const time = t.closeTime as string;
    equity += t.netPnl;

    if (equity > hwm) {
      if (inDd && ddStart) {
        const durDays =
          (new Date(time).getTime() - new Date(ddStart).getTime()) / 86400000;
        maxDdDuration = Math.max(maxDdDuration, durDays);
      }
      hwm = equity;
      hwmTime = time;
      inDd = false;
      ddStart = null;
    } else if (equity < hwm && !inDd) {
      inDd = true;
      ddStart = hwmTime ?? time;
    }

    const dd = equity - hwm;
    if (dd < maxDrawdown) {
      maxDrawdown = dd;
      maxDrawdownTime = time;
      maxDrawdownHwm = hwm;
    }
    if (equity < trough) trough = equity;
    maxRunup = Math.max(maxRunup, equity - trough);

    curve.push({ t: time, equity, hwm, drawdown: dd });
  }

  // MaxDD 恢复时间：从最大回撤点之后首次 equity ≥ 当时 HWM
  let recoveryDays: number | null = null;
  if (maxDrawdownTime && maxDrawdownHwm > startingBalance) {
    const ddT = new Date(maxDrawdownTime).getTime();
    const point = curve.find(
      (p) => new Date(p.t).getTime() >= ddT && p.equity >= maxDrawdownHwm,
    );
    if (point) {
      recoveryDays = (new Date(point.t).getTime() - ddT) / 86400000;
    }
  }

  const last = curve.length > 0 ? curve[curve.length - 1] : null;
  const currentDrawdown = last ? last.drawdown : 0;
  const pct = (dd: number, base: number): number | null =>
    base > 0 ? dd / base : null;

  return {
    curve,
    maxDrawdown,
    maxDrawdownPct: pct(maxDrawdown, maxDrawdownHwm),
    maxDrawdownTime,
    maxRunup,
    currentDrawdown,
    currentDrawdownPct: last && last.hwm > 0 ? pct(currentDrawdown, last.hwm) : null,
    drawdownDurationDays:
      inDd && ddStart && last
        ? (new Date(last.t).getTime() - new Date(ddStart).getTime()) / 86400000
        : null,
    maxDrawdownDurationDays: maxDdDuration > 0 ? maxDdDuration : null,
    recoveryDays,
  };
}
