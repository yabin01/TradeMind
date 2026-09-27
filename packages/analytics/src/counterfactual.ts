import type { UnifiedTrade } from '@trademind/trading-core';
import { closed } from './metrics';
import { computeCoreMetrics } from './metrics';
import { buildEquityCurve } from './drawdown';

/**
 * 反事实推演（纯函数，无 LLM）。
 *
 * 设计原则（对标 TMM AI 教练）：
 *   1. 结论必须可追溯到具体交易 —— 每个分组都返回 tradeRefs（trade id 列表）。
 *   2. 只回答「如果剔除 X 会怎样」这类可由历史数据直接算出的问题，不做预测。
 *   3. 区分「计算事实」（净盈亏、胜率）与「解读」（建议文案），解读单独放 advice 字段。
 */

export interface PatternGroup {
  key: string; // 分组键，如 'ETH-USDT-SWAP' / '14' / 'LONDON'
  label: string; // 展示名，如 '14:00 时段'
  trades: number;
  pnl: number;
  avgPnl: number;
  winRate: number; // 0..1
  profitFactor: number | null;
  /** 该组的交易 id（用于 UI 跳转核对，默认最多 50 条） */
  tradeRefs: string[];
}

export interface WhatIfResult {
  /** 分组维度：symbol | hour | session | weekday | strategy */
  dimension: string;
  /** 被剔除的分组键列表 */
  excludedKeys: string[];
  baseline: {
    trades: number;
    netPnl: number;
    winRate: number;
    profitFactor: number | null;
    maxDrawdown: number;
  };
  scenario: {
    trades: number;
    netPnl: number;
    winRate: number;
    profitFactor: number | null;
    maxDrawdown: number;
  };
  deltaPnl: number; // scenario.netPnl - baseline.netPnl
  deltaWinRate: number;
  /** 保留样本比例：scenario.trades / baseline.trades，过低时结论不可执行 */
  sampleRetention: number;
  /** 推演是否具备参考价值（样本保留率与剩余笔数达标） */
  reliable: boolean;
  /** 事实陈述（可验证） */
  facts: string[];
  /** 解读与建议（主观部分，单独隔离） */
  advice: string[];
  /** 被剔除交易的 id（供核对） */
  excludedTradeRefs: string[];
}

export interface RevengeStats {
  /** 亏损后在 windowMinutes 内开的新仓，且该笔也亏损 */
  count: number;
  pnl: number;
  /** 报复性交易占比（占全部亏损交易） */
  shareOfLosses: number;
  tradeRefs: string[];
  windowMinutes: number;
}

export interface ImprovementPlan {
  rules: { title: string; detail: string; evidence: string[] }[];
  projectedMonthlyPnl: number | null;
  recentTrades: number;
  recentNetPnl: number;
}

function pf(v: number): number | null {
  return Number.isFinite(v) ? v : null;
}

function pnlOf(t: UnifiedTrade): number {
  return t.netPnl;
}

function groupOf(t: UnifiedTrade, dimension: string): string {
  switch (dimension) {
    case 'symbol':
      return t.symbol;
    case 'hour':
      return String(new Date(t.openTime).getUTCHours()).padStart(2, '0');
    case 'weekday':
      return String(new Date(t.openTime).getUTCDay());
    case 'strategy':
      return t.strategyId ?? '未标注策略';
    case 'session':
    default: {
      const h = new Date(t.openTime).getUTCHours();
      if (h < 8) return 'ASIA';
      if (h < 13) return 'LONDON';
      if (h < 21) return 'NEW_YORK';
      return 'OTHER';
    }
  }
}

function labelOf(dimension: string, key: string): string {
  if (dimension === 'hour') return `${key}:00 时段`;
  if (dimension === 'weekday') {
    return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][Number(key)] ?? key;
  }
  if (dimension === 'session') {
    return { ASIA: '亚洲时段', LONDON: '伦敦时段', NEW_YORK: '纽约时段', OTHER: '其他时段' }[key] ?? key;
  }
  return key;
}

/** 按维度分组统计（含 tradeRefs，便于核对） */
export function patternGroups(
  trades: UnifiedTrade[],
  dimension: string,
  opts: { maxRefs?: number } = {},
): PatternGroup[] {
  const maxRefs = opts.maxRefs ?? 50;
  const cs = closed(trades);
  const map = new Map<string, UnifiedTrade[]>();
  for (const t of cs) {
    const k = groupOf(t, dimension);
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(t);
  }
  const out: PatternGroup[] = [];
  for (const [key, list] of map) {
    const m = computeCoreMetrics(list);
    out.push({
      key,
      label: labelOf(dimension, key),
      trades: m.closedTrades,
      pnl: m.netPnl,
      avgPnl: m.closedTrades > 0 ? m.netPnl / m.closedTrades : 0,
      winRate: m.winRate,
      profitFactor: pf(m.profitFactor),
      tradeRefs: list.map((t) => t.id).slice(0, maxRefs),
    });
  }
  return out.sort((a, b) => a.pnl - b.pnl); // 亏损最重的排前面
}

/**
 * 反事实推演：剔除指定分组后的表现对比。
 * 只做「历史重算」，不预测未来。
 */
export function whatIfExclude(
  trades: UnifiedTrade[],
  dimension: string,
  keys: string[],
  opts: { startingBalance?: number; maxRefs?: number } = {},
): WhatIfResult {
  const exclude = new Set(keys);
  const cs = closed(trades);
  const remaining = cs.filter((t) => !exclude.has(groupOf(t, dimension)));
  const excludedList = cs.filter((t) => exclude.has(groupOf(t, dimension)));

  const base = computeCoreMetrics(cs);
  const scen = computeCoreMetrics(remaining);
  const baseDd = buildEquityCurve(cs, opts.startingBalance ?? 0);
  const scenDd = buildEquityCurve(remaining, opts.startingBalance ?? 0);

  const maxRefs = opts.maxRefs ?? 50;
  const deltaPnl = scen.netPnl - base.netPnl;
  const facts: string[] = [];
  const advice: string[] = [];

  facts.push(`当前全部 ${base.closedTrades} 笔已平仓交易，净盈亏 ${base.netPnl.toFixed(2)}，胜率 ${(base.winRate * 100).toFixed(1)}%`);
  facts.push(`剔除后剩余 ${scen.closedTrades} 笔，净盈亏 ${scen.netPnl.toFixed(2)}，胜率 ${(scen.winRate * 100).toFixed(1)}%`);
  facts.push(`净盈亏变化 ${deltaPnl >= 0 ? '+' : ''}${deltaPnl.toFixed(2)}（${base.netPnl !== 0 ? `${((deltaPnl / Math.abs(base.netPnl)) * 100).toFixed(0)}%` : '—'}）`);
  facts.push(`最大回撤 ${baseDd.maxDrawdown.toFixed(2)} → ${scenDd.maxDrawdown.toFixed(2)}`);

  const retention = base.closedTrades > 0 ? scen.closedTrades / base.closedTrades : 0;
  const reliable = retention >= 0.6 && scen.closedTrades >= 50;

  if (!reliable) {
    // 防止「把主力品种/大部分样本砍掉后盈亏自然变好看」的统计陷阱
    advice.push(
      `⚠️ 该推演不可作为行动依据：剔除了 ${(100 - retention * 100).toFixed(0)}% 的交易，剩余仅 ${scen.closedTrades} 笔。` +
        `样本被大幅清空时净盈亏的“改善”只是假象，不代表这些分组该被砍掉。`,
    );
  } else if (deltaPnl > 0) {
    advice.push(`数据显示被剔除的分组在稳定放血：剔除后净盈亏提升 ${deltaPnl.toFixed(2)}，保留 ${(retention * 100).toFixed(0)}% 样本，可作为停掉这些分组的依据。`);
  } else if (deltaPnl < 0) {
    advice.push(`注意：剔除后净盈亏反而下降 ${Math.abs(deltaPnl).toFixed(2)}，说明这些分组并非主要亏损来源，不宜据此砍掉。`);
  } else {
    advice.push('剔除后净盈亏无变化，该分组对整体结果影响中性。');
  }
  if (reliable && scen.closedTrades < 30) {
    advice.push(`剩余样本仅 ${scen.closedTrades} 笔，统计意义有限，结论需谨慎。`);
  }

  return {
    dimension,
    excludedKeys: keys,
    baseline: {
      trades: base.closedTrades,
      netPnl: base.netPnl,
      winRate: base.winRate,
      profitFactor: pf(base.profitFactor),
      maxDrawdown: baseDd.maxDrawdown,
    },
    scenario: {
      trades: scen.closedTrades,
      netPnl: scen.netPnl,
      winRate: scen.winRate,
      profitFactor: pf(scen.profitFactor),
      maxDrawdown: scenDd.maxDrawdown,
    },
    deltaPnl,
    deltaWinRate: scen.winRate - base.winRate,
    sampleRetention: retention,
    reliable,
    facts,
    advice,
    excludedTradeRefs: excludedList.map((t) => t.id).slice(0, maxRefs),
  };
}

/** 自动挑出亏损最重的 N 个分组并做反事实推演（保证每组至少 minTrades 笔） */
export function whatIfDropWorst(
  trades: UnifiedTrade[],
  dimension: string,
  opts: { topN?: number; minTrades?: number; startingBalance?: number } = {},
): WhatIfResult {
  const topN = opts.topN ?? 3;
  const minTrades = opts.minTrades ?? 5;
  const groups = patternGroups(trades, dimension)
    .filter((g) => g.trades >= minTrades && g.pnl < 0)
    .slice(0, topN);
  return whatIfExclude(trades, dimension, groups.map((g) => g.key), opts);
}

/**
 * 报复性交易检测：上一笔亏损后 windowMinutes 内开的仓，且这笔也亏损。
 * （ revenge = 连续亏损的连锁反应，是散户最典型的亏损放大器）
 */
export function detectRevengeTrades(
  trades: UnifiedTrade[],
  opts: { windowMinutes?: number; maxRefs?: number; requireLargerSize?: boolean } = {},
): RevengeStats {
  const windowMinutes = opts.windowMinutes ?? 60;
  const maxRefs = opts.maxRefs ?? 50;
  // requireLargerSize：只有「仓位比上一笔更大」才算报复性。
  // 算法交易连续开仓是常态，仅凭时间间隔会大量误判，仓位放大才是“上头”的可靠信号。
  const requireLargerSize = opts.requireLargerSize ?? false;
  const cs = closed(trades).sort(
    (a, b) => new Date(a.openTime).getTime() - new Date(b.openTime).getTime(),
  );
  const hits: UnifiedTrade[] = [];
  for (let i = 1; i < cs.length; i++) {
    const prev = cs[i - 1];
    const cur = cs[i];
    if (pnlOf(prev) >= 0) continue;
    const gapMin =
      (new Date(cur.openTime).getTime() - new Date(prev.closeTime as string).getTime()) / 60000;
    if (gapMin < 0 || gapMin > windowMinutes) continue;
    if (pnlOf(cur) >= 0) continue;
    if (requireLargerSize && cur.quantity <= prev.quantity) continue;
    hits.push(cur);
  }
  const losses = cs.filter((t) => pnlOf(t) < 0);
  return {
    count: hits.length,
    pnl: hits.reduce((a, t) => a + pnlOf(t), 0),
    shareOfLosses: losses.length > 0 ? hits.length / losses.length : 0,
    tradeRefs: hits.map((t) => t.id).slice(0, maxRefs),
    windowMinutes,
  };
}

/**
 * 生成 30 天改进计划：基于最近 30 天数据，输出 3 条可量化规则。
 * 所有 evidence 均为可验证的计算事实。
 */
export function buildImprovementPlan(
  trades: UnifiedTrade[],
  opts: { startingBalance?: number } = {},
): ImprovementPlan {
  const cs = closed(trades);
  const now = cs.length > 0 ? new Date(cs[cs.length - 1].closeTime as string).getTime() : Date.now();
  const recent = cs.filter((t) => now - new Date(t.closeTime as string).getTime() <= 30 * 86400000);
  const recentNet = recent.reduce((a, t) => a + pnlOf(t), 0);

  const rules: ImprovementPlan['rules'] = [];

  // 规则 1：时段黑名单（亏损最重且样本足够的时段）
  const hours = patternGroups(trades, 'hour').filter((g) => g.trades >= 5 && g.pnl < 0).slice(0, 3);
  if (hours.length > 0) {
    const totalLoss = hours.reduce((a, g) => a + g.pnl, 0);
    rules.push({
      title: `避开亏损时段：${hours.map((g) => g.label.replace(' 时段', '')).join('、')}`,
      detail: `这些时段合计亏损 ${totalLoss.toFixed(2)}，胜率 ${hours.map((g) => `${(g.winRate * 100).toFixed(0)}%`).join('/')}。在这些时段不做新开仓。`,
      evidence: hours.map((g) => `${g.label}：${g.trades} 笔，${g.pnl.toFixed(2)}，胜率 ${(g.winRate * 100).toFixed(0)}%`),
    });
  }

  // 规则 2：报复性交易（同时给出宽松与严格口径，避免算法高频连续开仓被误判）
  const revenge = detectRevengeTrades(trades);
  const revengeStrict = detectRevengeTrades(trades, { requireLargerSize: true });
  if (revenge.count > 0) {
    rules.push({
      title: '亏损后强制冷却：平仓亏损后 60 分钟内不开新仓',
      detail: `检测到 ${revenge.count} 笔「亏损后 60 分钟内再次开仓且继续亏损」的交易，合计 ${revenge.pnl.toFixed(2)}，占全部亏损交易的 ${(revenge.shareOfLosses * 100).toFixed(0)}%。其中仓位比上一笔更大的有 ${revengeStrict.count} 笔（合计 ${revengeStrict.pnl.toFixed(2)}），这部分更像情绪化加仓。`,
      evidence: [
        `宽松口径 ${revenge.count} 笔，合计 ${revenge.pnl.toFixed(2)}`,
        `严格口径（仓位放大）${revengeStrict.count} 笔，合计 ${revengeStrict.pnl.toFixed(2)}`,
      ],
    });
  }

  // 规则 3：品种黑名单（仅在推演可靠时给出，避免「砍掉主力品种」的假象结论）
  const syms = patternGroups(trades, 'symbol').filter((g) => g.trades >= 5 && g.pnl < 0).slice(0, 3);
  if (syms.length > 0) {
    const wi = whatIfExclude(trades, 'symbol', syms.map((g) => g.key), opts);
    if (wi.reliable) {
      rules.push({
        title: `暂停亏损品种：${syms.map((g) => g.key).join('、')}`,
        detail: `剔除后净盈亏由 ${wi.baseline.netPnl.toFixed(2)} 变为 ${wi.scenario.netPnl.toFixed(2)}（${wi.deltaPnl >= 0 ? '+' : ''}${wi.deltaPnl.toFixed(2)}），保留 ${(wi.sampleRetention * 100).toFixed(0)}% 样本，结论可用。`,
        evidence: syms.map((g) => `${g.key}：${g.trades} 笔，${g.pnl.toFixed(2)}，均值 ${g.avgPnl.toFixed(2)}`),
      });
    } else {
      // 只陈述事实，不下达行动建议
      rules.push({
        title: `亏损集中在：${syms.map((g) => g.key).join('、')}（但不建议整体停掉）`,
        detail: `这些品种贡献了主要亏损，但它们同时占样本的 ${(100 - wi.sampleRetention * 100).toFixed(0)}%，剔除后仅剩 ${wi.scenario.trades} 笔——样本被清空带来的“改善”是假象。应改为限制单笔风险或缩小仓位，而不是停掉。`,
        evidence: syms.map((g) => `${g.key}：${g.trades} 笔，${g.pnl.toFixed(2)}，均值 ${g.avgPnl.toFixed(2)}`),
      });
    }
  }

  // 预计：假设剔除亏损时段+品种后，近期表现按比例改善（仅作参考，明确标注为情景推演）
  const hoursWi = hours.length > 0 ? whatIfExclude(recent.length >= 10 ? recent : trades, 'hour', hours.map((g) => g.key), opts) : null;
  const projected = hoursWi ? recentNet + hoursWi.deltaPnl : null;

  return {
    rules,
    projectedMonthlyPnl: projected,
    recentTrades: recent.length,
    recentNetPnl: recentNet,
  };
}
