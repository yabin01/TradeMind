import type { UnifiedTrade } from '@trademind/trading-core';
import { isClosed, tradeDurationMs } from '@trademind/trading-core';
import { closed } from './metrics';

/**
 * 交易规则引擎（纯函数，无 DB / 无 IO）。
 *
 * 与「AI 反事实推演」的分工：
 *   - 反事实推演是「观察」：告诉你历史上哪些分组在放血。
 *   - 规则引擎是「纪律」：把观察结论固化成可执行阈值，并逐笔打标违规。
 *
 * 设计原则：
 *   1. 每条违规都能指出具体交易 + 触发原因（detail 里带数字，可核对）。
 *   2. 只判定已平仓交易（未平仓的持仓分钟数用「至今」计算，单独标记）。
 *   3. 同一 (tradeId, ruleId) 只会产出一条违规（DB 侧也有唯一索引兜底）。
 */

export type RuleType =
  | 'MAX_LOSS_PER_TRADE'
  | 'MAX_DAILY_LOSS'
  | 'REVENGE_AFTER_LOSS'
  | 'MAX_LEVERAGE'
  | 'SESSION_BLACKLIST'
  | 'MAX_HOLDING_MINUTES'
  | 'MIN_RR';

export interface RuleDef {
  id: string;
  name: string;
  type: RuleType;
  enabled: boolean;
  /** 参数形状见 RULE_TYPES[].paramsHint */
  params: Record<string, unknown>;
}

export interface Violation {
  tradeId: string;
  ruleId: string;
  ruleType: RuleType;
  ruleName: string;
  /** 人类可读的触发原因，含具体数字便于核对 */
  detail: string;
}

export interface RuleTypeMeta {
  type: RuleType;
  label: string;
  description: string;
  /** 参数说明（同时用于前端表单生成） */
  params: { key: string; label: string; kind: 'number' | 'hours'; default: unknown; hint: string }[];
}

export const RULE_TYPES: RuleTypeMeta[] = [
  {
    type: 'MAX_LOSS_PER_TRADE',
    label: '单笔最大亏损',
    description: '单笔已平仓交易净亏损超过阈值即违规（控制尾部风险）',
    params: [{ key: 'value', label: '阈值（USDT）', kind: 'number', default: 100, hint: 'netPnl < -value 时触发' }],
  },
  {
    type: 'MAX_DAILY_LOSS',
    label: '单日最大亏损',
    description: '同一 UTC 交易日净亏损合计超过阈值，当日所有平仓交易标记违规',
    params: [{ key: 'value', label: '阈值（USDT）', kind: 'number', default: 300, hint: '当日 ΣnetPnl ≤ -value 时触发' }],
  },
  {
    type: 'REVENGE_AFTER_LOSS',
    label: '亏损后冷却期',
    description: '上一笔亏损平仓后，在冷却分钟内又开新仓即违规（防报复性交易）',
    params: [
      { key: 'withinMinutes', label: '冷却时长（分钟）', kind: 'number', default: 30, hint: '距上一笔平仓 ≤ N 分钟开仓即触发' },
    ],
  },
  {
    type: 'MAX_LEVERAGE',
    label: '最大杠杆',
    description: '开仓杠杆超过上限即违规',
    params: [{ key: 'value', label: '杠杆上限（倍）', kind: 'number', default: 10, hint: 'leverage > value 时触发' }],
  },
  {
    type: 'SESSION_BLACKLIST',
    label: '时段黑名单',
    description: '在黑名单时段（UTC 小时）开仓即违规',
    params: [{ key: 'hours', label: '黑名单小时（UTC）', kind: 'hours', default: [22], hint: '选择要禁止开仓的 UTC 小时' }],
  },
  {
    type: 'MAX_HOLDING_MINUTES',
    label: '最长持仓时间',
    description: '持仓时长超过上限即违规（防止亏损单死扛）',
    params: [{ key: 'value', label: '上限（分钟）', kind: 'number', default: 240, hint: '持仓分钟数 > value 时触发' }],
  },
  {
    type: 'MIN_RR',
    label: '最小盈亏比',
    description: '已标注盈亏比的交易，R:R 低于下限即违规（只校验有 rr 的交易）',
    params: [{ key: 'value', label: 'R:R 下限', kind: 'number', default: 1.5, hint: 'rr < value 时触发' }],
  },
];

export function defaultRules(): Omit<RuleDef, 'id'>[] {
  return [
    { name: '单笔亏损不超过 100 U', type: 'MAX_LOSS_PER_TRADE', enabled: true, params: { value: 100 } },
    { name: '单日亏损不超过 300 U', type: 'MAX_DAILY_LOSS', enabled: true, params: { value: 300 } },
    { name: '亏损后冷却 30 分钟', type: 'REVENGE_AFTER_LOSS', enabled: false, params: { withinMinutes: 30 } },
    { name: '杠杆不超过 10 倍', type: 'MAX_LEVERAGE', enabled: true, params: { value: 10 } },
    { name: '不做 22:00 时段（UTC）', type: 'SESSION_BLACKLIST', enabled: false, params: { hours: [22] } },
    { name: '持仓不超过 4 小时', type: 'MAX_HOLDING_MINUTES', enabled: false, params: { value: 240 } },
    { name: 'R:R 不低于 1.5', type: 'MIN_RR', enabled: false, params: { value: 1.5 } },
  ];
}

export interface RuleTemplate {
  key: string;
  /** 模板展示名（= 规则类型 label） */
  name: string;
  type: RuleType;
  description: string;
  /** 是否列入「推荐常用」 */
  recommended: boolean;
  /** 直接可用于 POST /rules 的默认参数 */
  params: Record<string, unknown>;
}

/**
 * 规则模板库：把 RULE_TYPES 的元数据直接变成「可一键应用」的规则。
 * 数据驱动——新增规则类型时这里自动出现，不需要再维护一份重复清单。
 */
export function ruleTemplates(): RuleTemplate[] {
  return RULE_TYPES.map((meta) => {
    const params: Record<string, unknown> = {};
    for (const p of meta.params) params[p.key] = p.default;
    return {
      key: meta.type.toLowerCase(),
      name: meta.label,
      type: meta.type,
      description: meta.description,
      recommended:
        meta.type === 'MAX_LOSS_PER_TRADE' ||
        meta.type === 'MAX_DAILY_LOSS' ||
        meta.type === 'MAX_LEVERAGE',
      params,
    };
  });
}

function num(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function hoursOf(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => Number(x)).filter((n) => Number.isInteger(n) && n >= 0 && n <= 23);
}

/** UTC 日期键（与日历一致，避免本地时区漂移） */
export function dayKey(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

/**
 * 逐条规则评估，返回违规列表（已去重：同一 tradeId+ruleId 只保留第一条）。
 */
export function evaluateRules(trades: UnifiedTrade[], rules: RuleDef[]): Violation[] {
  const out: Violation[] = [];
  const seen = new Set<string>();
  const push = (v: Violation) => {
    const key = `${v.tradeId}:${v.ruleId}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(v);
  };

  const cs = closed(trades);
  const byOpen = [...cs].sort(
    (a, b) => new Date(a.openTime).getTime() - new Date(b.openTime).getTime(),
  );
  // 按 closeTime 排序，用于「上一笔平仓 → 本笔开仓」的连锁判定
  const byClose = [...cs].sort(
    (a, b) =>
      new Date(a.closeTime as string).getTime() - new Date(b.closeTime as string).getTime(),
  );

  // 预计算每日净盈亏（只在需要时算）
  let dayPnl: Map<string, number> | null = null;
  const dailyPnl = () => {
    if (dayPnl) return dayPnl;
    dayPnl = new Map<string, number>();
    for (const t of cs) {
      const k = dayKey(t.closeTime as string);
      dayPnl.set(k, (dayPnl.get(k) ?? 0) + t.netPnl);
    }
    return dayPnl;
  };

  for (const rule of rules) {
    if (!rule.enabled) continue;
    switch (rule.type) {
      case 'MAX_LOSS_PER_TRADE': {
        const limit = num(rule.params.value, 100);
        for (const t of cs) {
          if (t.netPnl < -limit) {
            push({
              tradeId: t.id,
              ruleId: rule.id,
              ruleType: rule.type,
              ruleName: rule.name,
              detail: `单笔净亏损 ${t.netPnl.toFixed(2)}，超过阈值 ${limit}`,
            });
          }
        }
        break;
      }
      case 'MAX_DAILY_LOSS': {
        const limit = num(rule.params.value, 300);
        const map = dailyPnl();
        for (const [day, pnl] of map) {
          if (pnl > -limit) continue;
          for (const t of cs.filter((x) => dayKey(x.closeTime as string) === day)) {
            push({
              tradeId: t.id,
              ruleId: rule.id,
              ruleType: rule.type,
              ruleName: rule.name,
              detail: `${day}（UTC）当日净亏损 ${pnl.toFixed(2)}，超过阈值 ${limit}`,
            });
          }
        }
        break;
      }
      case 'REVENGE_AFTER_LOSS': {
        const within = num(rule.params.withinMinutes, 30);
        // 以开仓顺序遍历：找「本笔开仓之前最近的一笔已平仓交易」，若其为亏损且间隔 ≤ within 分钟 → 违规
        for (let i = 1; i < byOpen.length; i++) {
          const cur = byOpen[i];
          const curOpen = new Date(cur.openTime).getTime();
          let prev: UnifiedTrade | null = null;
          for (let j = i - 1; j >= 0; j--) {
            const cand = byOpen[j];
            if (new Date(cand.openTime).getTime() <= curOpen) {
              prev = cand;
              break;
            }
          }
          if (!prev || !isClosed(prev)) continue;
          if (prev.netPnl >= 0) continue;
          const gapMin = (curOpen - new Date(prev.closeTime as string).getTime()) / 60000;
          if (gapMin < 0 || gapMin > within) continue;
          push({
            tradeId: cur.id,
            ruleId: rule.id,
            ruleType: rule.type,
            ruleName: rule.name,
            detail: `上一笔 ${prev.symbol} 亏损 ${prev.netPnl.toFixed(2)}，平仓后仅 ${gapMin.toFixed(0)} 分钟即开新仓（冷却 ${within} 分钟）`,
          });
        }
        void byClose; // 保留：未来扩展「按平仓时点连锁」时使用
        break;
      }
      case 'MAX_LEVERAGE': {
        const limit = num(rule.params.value, 10);
        for (const t of cs) {
          if ((t.leverage ?? 1) > limit) {
            push({
              tradeId: t.id,
              ruleId: rule.id,
              ruleType: rule.type,
              ruleName: rule.name,
              detail: `杠杆 ${t.leverage}x，超过上限 ${limit}x`,
            });
          }
        }
        break;
      }
      case 'SESSION_BLACKLIST': {
        const hours = hoursOf(rule.params.hours);
        if (hours.length === 0) break;
        for (const t of cs) {
          const h = new Date(t.openTime).getUTCHours();
          if (hours.includes(h)) {
            push({
              tradeId: t.id,
              ruleId: rule.id,
              ruleType: rule.type,
              ruleName: rule.name,
              detail: `开仓时间 ${t.openTime.slice(11, 16)} 落在黑名单时段 ${String(h).padStart(2, '0')}:00（UTC）`,
            });
          }
        }
        break;
      }
      case 'MAX_HOLDING_MINUTES': {
        const limit = num(rule.params.value, 240);
        for (const t of cs) {
          const ms = tradeDurationMs(t);
          if (ms === null) continue;
          const mins = ms / 60000;
          if (mins > limit) {
            push({
              tradeId: t.id,
              ruleId: rule.id,
              ruleType: rule.type,
              ruleName: rule.name,
              detail: `持仓 ${mins.toFixed(0)} 分钟，超过上限 ${limit} 分钟`,
            });
          }
        }
        break;
      }
      case 'MIN_RR': {
        const limit = num(rule.params.value, 1.5);
        for (const t of cs) {
          if (t.rr === null || t.rr === undefined || !Number.isFinite(t.rr)) continue;
          if (t.rr < limit) {
            push({
              tradeId: t.id,
              ruleId: rule.id,
              ruleType: rule.type,
              ruleName: rule.name,
              detail: `盈亏比 ${t.rr.toFixed(2)}，低于下限 ${limit}`,
            });
          }
        }
        break;
      }
    }
  }
  return out;
}

export interface RuleSuggestion {
  name: string;
  type: RuleType;
  params: Record<string, unknown>;
  /** 阈值是怎么来的（用真实分位数说话，可核对） */
  rationale: string;
  /** 用当前历史估算的命中笔数（0 表示该规则在当前数据下不会触发） */
  estimatedHits: number;
  enabled: boolean;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))));
  return sorted[idx];
}

/** 向上取整到「好看」的刻度：1/2/5 × 10^n */
function niceCeil(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 0;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (v <= m * mag) return Math.ceil(m * mag);
  }
  return Math.ceil(10 * mag);
}

/**
 * 基于用户自己的历史推荐阈值。
 *
 * 为什么需要它：写死的默认阈值（如「杠杆 ≤ 10x」）在真实账户上会命中 99% 的交易，
 * 标记全部等于没标记。这里用分位数取「比你现在做得好一点、但够得着」的线：
 *   - 单笔/单日亏损：取亏损分布的 P90（约 10% 的亏损单会被点名）
 *   - 杠杆 / 持仓时长：取 P90（同样只点名最极端的 10%）
 *   - 时段黑名单：只选「样本 ≥ 5 且确实在放血」的 UTC 小时
 */
export function suggestRules(trades: UnifiedTrade[]): RuleSuggestion[] {
  const cs = closed(trades);
  if (cs.length === 0) return [];

  const losses = cs
    .map((t) => Math.abs(t.netPnl))
    .filter((v) => v > 0)
    .sort((a, b) => a - b);
  const p90Loss = quantile(losses, 0.9);
  const maxLossPerTrade = niceCeil(p90Loss);

  // 每日净盈亏（UTC）
  const dayMap = new Map<string, number>();
  for (const t of cs) {
    const k = dayKey(t.closeTime as string);
    dayMap.set(k, (dayMap.get(k) ?? 0) + t.netPnl);
  }
  const dayLosses = [...dayMap.values()].filter((v) => v < 0).map(Math.abs).sort((a, b) => a - b);
  // 取 P90 而不是 P75：单日亏损是「今天该停手」的红线，点名的应当是最糟的少数几天，
  // 阈值太松会把近 1/4 的交易都标成违规，等于没标。
  const maxDailyLoss = niceCeil(quantile(dayLosses, 0.9));

  const levs = cs.map((t) => t.leverage ?? 1).sort((a, b) => a - b);
  const p90Lev = quantile(levs, 0.9);
  const maxLev = Math.max(1, Math.ceil(p90Lev));

  const durations = cs
    .map((t) => tradeDurationMs(t))
    .filter((v): v is number => v !== null)
    .map((v) => v / 60000)
    .sort((a, b) => a - b);
  const p90Hold = quantile(durations, 0.9);
  const maxHold = p90Hold > 0 ? Math.ceil(p90Hold / 15) * 15 : 240; // 取整到 15 分钟刻度

  const rrVals = cs
    .map((t) => t.rr)
    .filter((v): v is number => v !== null && Number.isFinite(v))
    .sort((a, b) => a - b);

  // 时段黑名单：样本 ≥ 5、净亏、胜率 < 45% 的 UTC 小时
  const hourMap = new Map<number, { trades: number; pnl: number; wins: number }>();
  for (const t of cs) {
    const h = new Date(t.openTime).getUTCHours();
    const cur = hourMap.get(h) ?? { trades: 0, pnl: 0, wins: 0 };
    cur.trades += 1;
    cur.pnl += t.netPnl;
    if (t.netPnl > 0) cur.wins += 1;
    hourMap.set(h, cur);
  }
  const blackHours = [...hourMap.entries()]
    .filter(([, v]) => v.trades >= 5 && v.pnl < 0 && v.wins / v.trades < 0.45)
    .sort((a, b) => a[1].pnl - b[1].pnl)
    .slice(0, 3)
    .map(([h]) => h);

  const out: RuleSuggestion[] = [];

  if (maxLossPerTrade > 0) {
    const hits = cs.filter((t) => t.netPnl < -maxLossPerTrade).length;
    out.push({
      name: `单笔亏损不超过 ${maxLossPerTrade} U`,
      type: 'MAX_LOSS_PER_TRADE',
      params: { value: maxLossPerTrade },
      rationale: `你当前亏损单金额的 90 分位是 ${p90Loss.toFixed(2)}，取 ${maxLossPerTrade} 只点名最极端的约 ${((hits / cs.length) * 100).toFixed(0)}% 亏损单。`,
      estimatedHits: hits,
      enabled: hits > 0 && hits / cs.length < 0.35,
    });
  }

  if (maxDailyLoss > 0) {
    const badDays = [...dayMap.entries()].filter(([, v]) => v <= -maxDailyLoss).map(([k]) => k);
    const hits = cs.filter((t) => badDays.includes(dayKey(t.closeTime as string))).length;
    out.push({
      name: `单日亏损不超过 ${maxDailyLoss} U`,
      type: 'MAX_DAILY_LOSS',
      params: { value: maxDailyLoss },
      rationale: `你有 ${dayLosses.length} 个亏损日，亏损额 90 分位是 ${quantile(dayLosses, 0.9).toFixed(2)}，超过它就说明当天该停手了。`,
      estimatedHits: hits,
      enabled: hits > 0 && hits / cs.length < 0.35,
    });
  }

  {
    const hits = cs.filter((t) => (t.leverage ?? 1) > maxLev).length;
    out.push({
      name: `杠杆不超过 ${maxLev} 倍`,
      type: 'MAX_LEVERAGE',
      params: { value: maxLev },
      rationale: `你实际使用的杠杆 90 分位是 ${p90Lev}x（最高 ${levs[levs.length - 1]}x）。超过 ${maxLev}x 的只有 ${hits} 笔，属真正的异常。`,
      estimatedHits: hits,
      enabled: hits > 0 && hits / cs.length < 0.35,
    });
  }

  if (durations.length > 0) {
    const hits = cs.filter((t) => {
      const ms = tradeDurationMs(t);
      return ms !== null && ms / 60000 > maxHold;
    }).length;
    out.push({
      name: `持仓不超过 ${maxHold} 分钟`,
      type: 'MAX_HOLDING_MINUTES',
      params: { value: maxHold },
      rationale: `你持仓时长 90 分位是 ${p90Hold.toFixed(0)} 分钟，超过 ${maxHold} 分钟的多半是死扛单。`,
      estimatedHits: hits,
      enabled: hits > 0 && hits / cs.length < 0.35,
    });
  }

  // 冷却期规则的命中率天然偏高：算法/高频账户连续开仓是常态，
  // 「上一笔亏损后 30 分钟内又开仓」会命中大量正常交易。因此这里用更严的 15% 门槛，
  // 超出就只作为「可开启的预防性约束」呈现，不默认打标。
  const revengeHits = detectRevengeCount(cs, 30);
  const revengeRatio = revengeHits / cs.length;
  out.push({
    name: '亏损后冷却 30 分钟',
    type: 'REVENGE_AFTER_LOSS',
    params: { withinMinutes: 30 },
    rationale:
      revengeHits > 0
        ? `历史上有 ${revengeHits} 笔（${(revengeRatio * 100).toFixed(0)}%）是在上一笔亏损平仓后 30 分钟内开的仓并继续亏损。` +
          (revengeRatio >= 0.15
            ? ' 占比偏高——算法/高频账户连续开仓本就是常态，直接套用会大量误判，请确认后再开启。'
            : '')
        : '当前数据未检出明显连锁开仓，可开启作为预防性约束。',
    estimatedHits: revengeHits,
    enabled: revengeHits > 0 && revengeRatio < 0.15,
  });

  if (blackHours.length > 0) {
    const hits = cs.filter((t) => blackHours.includes(new Date(t.openTime).getUTCHours())).length;
    out.push({
      name: `避开 ${blackHours.map((h) => `${String(h).padStart(2, '0')}:00`).join('、')} 时段（UTC）`,
      type: 'SESSION_BLACKLIST',
      params: { hours: blackHours },
      rationale: `这些时段样本 ≥ 5 笔、净亏损且胜率低于 45%，合计 ${blackHours.reduce((a, h) => a + (hourMap.get(h)?.pnl ?? 0), 0).toFixed(2)}。`,
      estimatedHits: hits,
      enabled: hits > 0 && hits / cs.length < 0.35,
    });
  }

  if (rrVals.length >= 8) {
    const minRr = Math.round(quantile(rrVals, 0.25) * 10) / 10;
    const hits = cs.filter(
      (t) => t.rr !== null && Number.isFinite(t.rr) && t.rr < minRr,
    ).length;
    out.push({
      name: `R:R 不低于 ${minRr}`,
      type: 'MIN_RR',
      params: { value: minRr },
      rationale: `你有 ${rrVals.length} 笔标注了盈亏比，25 分位是 ${minRr}，低于这个值的交易风险回报不划算。`,
      estimatedHits: hits,
      enabled: false, // 只作提示，默认不开启（多数账户 R:R 标注不全）
    });
  }

  return out;
}

/** 连锁开仓计数（供 suggestRules 估算，逻辑与 REVENGE_AFTER_LOSS 一致） */
function detectRevengeCount(cs: UnifiedTrade[], withinMinutes: number): number {
  const byOpen = [...cs].sort(
    (a, b) => new Date(a.openTime).getTime() - new Date(b.openTime).getTime(),
  );
  let n = 0;
  for (let i = 1; i < byOpen.length; i++) {
    const cur = byOpen[i];
    const curOpen = new Date(cur.openTime).getTime();
    let prev: UnifiedTrade | null = null;
    for (let j = i - 1; j >= 0; j--) {
      if (new Date(byOpen[j].openTime).getTime() <= curOpen) {
        prev = byOpen[j];
        break;
      }
    }
    if (!prev || !isClosed(prev) || prev.netPnl >= 0) continue;
    const gapMin = (curOpen - new Date(prev.closeTime as string).getTime()) / 60000;
    if (gapMin < 0 || gapMin > withinMinutes) continue;
    n++;
  }
  return n;
}

export interface ViolationSummary {
  total: number;
  affectedTrades: number;
  byRule: { ruleId: string; ruleName: string; ruleType: RuleType; count: number; pnl: number }[];
  /** 违规交易合计净盈亏（用于回答「遵守规则能省多少钱」） */
  violationPnl: number;
  /** 违规交易占全部已平仓交易的比例 */
  shareOfTrades: number;
}

/** 违规汇总：按规则聚合 + 违规交易合计盈亏 */
export function summarizeViolations(
  trades: UnifiedTrade[],
  violations: Violation[],
): ViolationSummary {
  const cs = closed(trades);
  const byId = new Map(cs.map((t) => [t.id, t]));
  const affected = new Set(violations.map((v) => v.tradeId));
  const map = new Map<string, ViolationSummary['byRule'][number]>();
  for (const v of violations) {
    const cur = map.get(v.ruleId) ?? {
      ruleId: v.ruleId,
      ruleName: v.ruleName,
      ruleType: v.ruleType,
      count: 0,
      pnl: 0,
    };
    const t = byId.get(v.tradeId);
    // 同一笔交易命中多条规则时，盈亏只在「受影响交易数」层面统计一次；
    // byRule.pnl 是「该规则命中的交易盈亏之和」，会重复计入同一笔交易，属预期口径。
    cur.count += 1;
    cur.pnl += t ? t.netPnl : 0;
    map.set(v.ruleId, cur);
  }
  const violationPnl = [...affected].reduce((a, id) => a + (byId.get(id)?.netPnl ?? 0), 0);
  return {
    total: violations.length,
    affectedTrades: affected.size,
    byRule: [...map.values()].sort((a, b) => b.count - a.count),
    violationPnl,
    shareOfTrades: cs.length > 0 ? affected.size / cs.length : 0,
  };
}
