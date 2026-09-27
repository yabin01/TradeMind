import type { UnifiedTrade } from '@trademind/trading-core';
import { isClosed, tradeDurationMs } from '@trademind/trading-core';
import { closed, computeCoreMetrics } from './metrics';
import { buildEquityCurve } from './drawdown';

/**
 * 高级指标（纯函数，无 IO）。
 *
 * 与 core metrics 的分工：
 *   - CoreMetrics 回答「赚了多少、赢了多少次」
 *   - AdvancedMetrics 回答「承担了多少风险换来的、是否稳定、成本吃掉多少」
 *
 * 口径说明（写死在实现里，避免歧义）：
 *   - 日收益序列 = 从首笔平仓日到末笔平仓日的**每一个日历日**（无交易日记 0），
 *     因为 crypto 是 7×24 市场，跳过空日会系统性高估 Sharpe。
 *   - 年化因子 365（7×24 市场）。
 *   - Sharpe/Sortino 无风险利率取 0（交易日志场景惯例，避免引入外部利率假设）。
 *   - Calmar 用金额口径：年化净利 / |最大回撤|，因此不依赖 startingBalance。
 *   - 样本不足（< 2 个交易日 / 无回撤 / 无盈利）时返回 null，绝不返回 0 充数。
 */

export interface MonthStat {
  key: string; // YYYY-MM
  pnl: number;
  trades: number;
}

export interface AdvancedMetrics {
  /** 风险调整收益 */
  sharpe: number | null;
  sortino: number | null;
  calmar: number | null;
  /** 回撤痛苦指数：sqrt(mean(dd_i²))，金额口径，越小越好 */
  ulcerIndex: number | null;

  /** 收益与规模 */
  roi: number | null; // netPnl / startingBalance（startingBalance ≤ 0 时为 null）
  annualizedReturn: number | null; // netPnl / 年数
  years: number | null;
  totalNotional: number;
  avgNotional: number | null;

  /** 回撤与恢复 */
  maxDrawdown: number; // ≤ 0
  maxDrawdownDurationDays: number | null;
  recoveryFactor: number | null; // netPnl / |maxDD|，越大越好

  /** 连胜连亏 */
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  /** 最长连亏期间的累计亏损（≤ 0），衡量最糟的一段时间 */
  maxConsecutiveLossAmount: number;
  currentStreak: { type: 'WIN' | 'LOSS' | 'NONE'; length: number };

  /** 分布形态 */
  payoffRatio: number | null; // avgWin / avgLoss（盈亏比，注意与 PF 不同）
  stdDevPnl: number | null; // 单笔净盈亏样本标准差
  expectancyR: number | null; // 期望值以 R 为单位（仅统计标注了 risk 的交易）
  rSampleSize: number; // 有多少笔交易标注了 risk

  /** 成本拖累 */
  totalCost: number; // fees + funding（正数表示付出的成本）
  costRatio: number | null; // totalCost / grossProfit
  costPerTrade: number | null;

  /** 交易频率 */
  activeDays: number; // 有平仓的天数
  tradesPerDay: number | null;
  avgHoldingMinutes: number | null;

  /** 稳定性 */
  months: MonthStat[];
  profitableMonthsRatio: number | null;
  bestMonth: MonthStat | null;
  worstMonth: MonthStat | null;
}

/** 样本标准差（n-1）；样本 < 2 时返回 null */
function stdDev(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const varr = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(varr);
}

function dayKey(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

function monthKey(iso: string): string {
  return new Date(iso).toISOString().slice(0, 7);
}

/** 计算连胜/连亏（按平仓时间排序） */
export function streaks(trades: UnifiedTrade[]): {
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  maxConsecutiveLossAmount: number;
  currentStreak: { type: 'WIN' | 'LOSS' | 'NONE'; length: number };
} {
  const cs = closed(trades).sort(
    (a, b) => new Date(a.closeTime as string).getTime() - new Date(b.closeTime as string).getTime(),
  );
  let maxWins = 0;
  let maxLosses = 0;
  let maxLossAmount = 0;
  let curType: 'WIN' | 'LOSS' | 'NONE' = 'NONE';
  let curLen = 0;
  let curLossSum = 0;

  for (const t of cs) {
    const type = t.netPnl > 0 ? 'WIN' : t.netPnl < 0 ? 'LOSS' : 'NONE';
    if (type === 'NONE') continue; // 打平不计入连胜连亏
    if (type === curType) {
      curLen += 1;
      if (type === 'LOSS') curLossSum += t.netPnl;
    } else {
      curType = type;
      curLen = 1;
      curLossSum = type === 'LOSS' ? t.netPnl : 0;
    }
    if (type === 'WIN') maxWins = Math.max(maxWins, curLen);
    else {
      maxLosses = Math.max(maxLosses, curLen);
      if (curLossSum < maxLossAmount) maxLossAmount = curLossSum;
    }
  }
  return {
    maxConsecutiveWins: maxWins,
    maxConsecutiveLosses: maxLosses,
    maxConsecutiveLossAmount: maxLossAmount,
    currentStreak: { type: curType, length: curLen },
  };
}

/** 按月聚合净盈亏 */
export function monthlyStats(trades: UnifiedTrade[]): MonthStat[] {
  const map = new Map<string, MonthStat>();
  for (const t of closed(trades)) {
    const k = monthKey(t.closeTime as string);
    const cur = map.get(k) ?? { key: k, pnl: 0, trades: 0 };
    cur.pnl += t.netPnl;
    cur.trades += 1;
    map.set(k, cur);
  }
  return [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * 日收益序列（含空日填 0）。
 * crypto 7×24 交易，跳过无交易日会让波动率被低估、Sharpe 被高估。
 */
export function dailyReturnSeries(trades: UnifiedTrade[]): number[] {
  const cs = closed(trades);
  if (cs.length === 0) return [];
  const map = new Map<string, number>();
  for (const t of cs) {
    const k = dayKey(t.closeTime as string);
    map.set(k, (map.get(k) ?? 0) + t.netPnl);
  }
  const keys = [...map.keys()].sort();
  const first = new Date(`${keys[0]}T00:00:00Z`).getTime();
  const last = new Date(`${keys[keys.length - 1]}T00:00:00Z`).getTime();
  const out: number[] = [];
  for (let ts = first; ts <= last; ts += 86_400_000) {
    const k = new Date(ts).toISOString().slice(0, 10);
    out.push(map.get(k) ?? 0);
  }
  return out;
}

export function computeAdvancedMetrics(
  trades: UnifiedTrade[],
  opts: { startingBalance?: number } = {},
): AdvancedMetrics {
  const cs = closed(trades);
  const core = computeCoreMetrics(trades);
  const dd = buildEquityCurve(trades, opts.startingBalance ?? 0);

  // ── 日收益序列 → Sharpe / Sortino ──────────────────────────────
  const daily = dailyReturnSeries(trades);
  const dailyMean = daily.length > 0 ? daily.reduce((a, b) => a + b, 0) / daily.length : 0;
  const dailySd = stdDev(daily);
  const downside = daily.filter((v) => v < 0);
  const downsideSd = stdDev(downside.length > 0 ? downside : [0]);

  const sharpe = dailySd && dailySd > 0 ? (dailyMean / dailySd) * Math.sqrt(365) : null;
  const sortino = downsideSd && downsideSd > 0 ? (dailyMean / downsideSd) * Math.sqrt(365) : null;

  // ── 时间跨度 / 年化 ────────────────────────────────────────────
  let years: number | null = null;
  let annualizedReturn: number | null = null;
  if (cs.length >= 2) {
    const times = cs.map((t) => new Date(t.closeTime as string).getTime());
    const spanMs = Math.max(...times) - Math.min(...times);
    const spanDays = spanMs / 86_400_000;
    if (spanDays > 0) {
      years = spanDays / 365;
      annualizedReturn = core.netPnl / years;
    }
  }

  const roi =
    opts.startingBalance && opts.startingBalance > 0 ? core.netPnl / opts.startingBalance : null;

  // ── Calmar / Ulcer / 恢复因子 ──────────────────────────────────
  const maxDD = Math.abs(dd.maxDrawdown);
  const calmar =
    annualizedReturn !== null && maxDD > 0 ? annualizedReturn / maxDD : null;
  const recoveryFactor = maxDD > 0 ? core.netPnl / maxDD : null;

  // Ulcer：用权益曲线每个点的回撤（金额）平方均值开根
  let ulcerIndex: number | null = null;
  if (dd.curve.length > 0) {
    const meanSq =
      dd.curve.reduce((a, p) => a + (p.drawdown ?? 0) ** 2, 0) / dd.curve.length;
    ulcerIndex = Math.sqrt(meanSq);
  }

  // ── 名义敞口 ───────────────────────────────────────────────────
  const totalNotional = cs.reduce((a, t) => a + t.entryPrice * t.quantity, 0);
  const avgNotional = cs.length > 0 ? totalNotional / cs.length : null;

  // ── 成本 ───────────────────────────────────────────────────────
  const totalCost = trades.reduce((a, t) => a + Math.abs(t.fees) + Math.abs(t.funding), 0);
  const costRatio = core.grossProfit > 0 ? totalCost / core.grossProfit : null;
  const costPerTrade = trades.length > 0 ? totalCost / trades.length : null;

  // ── 频率 ───────────────────────────────────────────────────────
  const activeDays = new Set(cs.map((t) => dayKey(t.closeTime as string))).size;
  const tradesPerDay = activeDays > 0 ? cs.length / activeDays : null;

  const durations = cs
    .map((t) => tradeDurationMs(t))
    .filter((v): v is number => v !== null);
  const avgHoldingMinutes =
    durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length / 60000 : null;

  // ── R 倍数（仅统计标注了 risk 的交易） ──────────────────────────
  const rValues = cs
    .filter((t) => t.risk !== null && t.risk !== undefined && t.risk > 0)
    .map((t) => t.netPnl / (t.risk as number));

  // ── 月度稳定性 ─────────────────────────────────────────────────
  const months = monthlyStats(trades);
  const profitableMonths =
    months.length > 0 ? months.filter((m) => m.pnl > 0).length / months.length : null;
  const sortedMonths = [...months].sort((a, b) => b.pnl - a.pnl);

  const st = streaks(trades);

  return {
    sharpe,
    sortino,
    calmar,
    ulcerIndex,
    roi,
    annualizedReturn,
    years,
    totalNotional,
    avgNotional,
    maxDrawdown: dd.maxDrawdown,
    maxDrawdownDurationDays: dd.maxDrawdownDurationDays,
    recoveryFactor,
    maxConsecutiveWins: st.maxConsecutiveWins,
    maxConsecutiveLosses: st.maxConsecutiveLosses,
    maxConsecutiveLossAmount: st.maxConsecutiveLossAmount,
    currentStreak: st.currentStreak,
    payoffRatio: core.avgLoss > 0 ? core.avgWin / core.avgLoss : null,
    stdDevPnl: stdDev(cs.map((t) => t.netPnl)),
    expectancyR: rValues.length > 0 ? rValues.reduce((a, b) => a + b, 0) / rValues.length : null,
    rSampleSize: rValues.length,
    totalCost,
    costRatio,
    costPerTrade,
    activeDays,
    tradesPerDay,
    avgHoldingMinutes,
    months,
    profitableMonthsRatio: profitableMonths,
    bestMonth: sortedMonths[0] ?? null,
    worstMonth: sortedMonths[sortedMonths.length - 1] ?? null,
  };
}

/** 指标元数据：前端渲染说明 + 计算口径，避免指标被误读 */
export interface MetricMeta {
  key: string;
  label: string;
  group: '风险调整' | '收益规模' | '回撤恢复' | '连胜连亏' | '分布形态' | '成本' | '频率' | '稳定性';
  unit: 'ratio' | 'usd' | 'count' | 'pct' | 'days' | 'minutes' | 'none';
  /** 数值解读方向：higher 越大越好，lower 越小越好，neutral 中性 */
  better: 'higher' | 'lower' | 'neutral';
  formula: string;
  note: string;
}

export const METRIC_META: MetricMeta[] = [
  { key: 'sharpe', label: 'Sharpe', group: '风险调整', unit: 'ratio', better: 'higher', formula: '日均收益 / 日收益标准差 × √365', note: '无风险利率取 0；>1 可接受，>2 优秀，<0 表示收益不抵波动' },
  { key: 'sortino', label: 'Sortino', group: '风险调整', unit: 'ratio', better: 'higher', formula: '日均收益 / 下行标准差 × √365', note: '只惩罚亏损波动，比 Sharpe 更贴合交易者直觉' },
  { key: 'calmar', label: 'Calmar', group: '风险调整', unit: 'ratio', better: 'higher', formula: '年化净利 / |最大回撤|', note: '金额口径，不依赖初始资金；>1 表示年化收益覆盖最大回撤' },
  { key: 'ulcerIndex', label: 'Ulcer 指数', group: '风险调整', unit: 'usd', better: 'lower', formula: '√(回撤² 的均值)', note: '同时惩罚回撤深度与持续时间，比最大回撤更全面' },
  { key: 'roi', label: 'ROI', group: '收益规模', unit: 'pct', better: 'higher', formula: '净盈亏 / 初始资金', note: '需在账户里设置 startingBalance 才能计算' },
  { key: 'annualizedReturn', label: '年化净利', group: '收益规模', unit: 'usd', better: 'higher', formula: '净盈亏 / 年数', note: '按首末笔平仓时间跨度年化，样本过短会失真' },
  { key: 'totalNotional', label: '累计名义敞口', group: '收益规模', unit: 'usd', better: 'neutral', formula: 'Σ 开仓价 × 数量', note: '衡量交易规模，非占用保证金' },
  { key: 'avgNotional', label: '平均每笔名义', group: '收益规模', unit: 'usd', better: 'neutral', formula: '累计名义敞口 / 笔数', note: '与净盈亏对比可看资金效率' },
  { key: 'maxDrawdown', label: '最大回撤', group: '回撤恢复', unit: 'usd', better: 'lower', formula: '权益曲线最高点到最低点的跌幅', note: '负值；绝对值越小越稳' },
  { key: 'maxDrawdownDurationDays', label: '最长回撤持续', group: '回撤恢复', unit: 'days', better: 'lower', formula: '连续处于回撤状态的天数', note: '比回撤深度更影响持有体验' },
  { key: 'recoveryFactor', label: '恢复因子', group: '回撤恢复', unit: 'ratio', better: 'higher', formula: '净盈亏 / |最大回撤|', note: '>1 表示从最大回撤中赚回来了' },
  { key: 'maxConsecutiveWins', label: '最长连胜', group: '连胜连亏', unit: 'count', better: 'neutral', formula: '连续盈利笔数的最大值', note: '打平不计入' },
  { key: 'maxConsecutiveLosses', label: '最长连亏', group: '连胜连亏', unit: 'count', better: 'lower', formula: '连续亏损笔数的最大值', note: '决定需要多大的心理与资金缓冲' },
  { key: 'maxConsecutiveLossAmount', label: '最长连亏累计', group: '连胜连亏', unit: 'usd', better: 'lower', formula: '最长连亏区间内的净盈亏合计', note: '最糟的一段时间实际亏了多少' },
  { key: 'payoffRatio', label: '盈亏比', group: '分布形态', unit: 'ratio', better: 'higher', formula: '平均盈利 / 平均亏损', note: '注意与 Profit Factor 不同：PF 用总额，盈亏比用均值' },
  { key: 'stdDevPnl', label: '单笔盈亏标准差', group: '分布形态', unit: 'usd', better: 'lower', formula: 'netPnl 的样本标准差', note: '衡量单笔结果的离散程度' },
  { key: 'expectancyR', label: '期望值（R）', group: '分布形态', unit: 'ratio', better: 'higher', formula: 'Σ(netPnl / risk) / n', note: '仅统计标注了计划风险 risk 的交易；未标注时为 null' },
  { key: 'totalCost', label: '总成本', group: '成本', unit: 'usd', better: 'lower', formula: '|手续费| + |资金费|', note: '真实付出，不含滑点' },
  { key: 'costRatio', label: '成本 / 毛利', group: '成本', unit: 'pct', better: 'lower', formula: '总成本 / 毛利', note: '超过 30% 说明交易频率相对收益过高' },
  { key: 'costPerTrade', label: '单笔成本', group: '成本', unit: 'usd', better: 'lower', formula: '总成本 / 笔数', note: '与平均盈利对比可判断是否被手续费吃掉' },
  { key: 'activeDays', label: '有交易天数', group: '频率', unit: 'count', better: 'neutral', formula: '存在平仓记录的日历日数', note: '按 UTC 日统计' },
  { key: 'tradesPerDay', label: '日均笔数', group: '频率', unit: 'ratio', better: 'neutral', formula: '已平仓笔数 / 有交易天数', note: '高频策略此项通常很高' },
  { key: 'avgHoldingMinutes', label: '平均持仓', group: '频率', unit: 'minutes', better: 'neutral', formula: '持仓时长的均值', note: '按开仓→平仓计算' },
  { key: 'profitableMonthsRatio', label: '盈利月占比', group: '稳定性', unit: 'pct', better: 'higher', formula: '盈利月数 / 总月数', note: '衡量收益是否依赖少数几个大月' },
];
