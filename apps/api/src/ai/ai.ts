import { Module } from '@nestjs/common';
import { Body, Controller, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { FilterSet, UnifiedTrade } from '@trademind/trading-core';
import { tradeDirectionOf } from '@trademind/trading-core';
import {
  aggregateByMistake,
  aggregateBySide,
  aggregateBySymbol,
  aggregateByTag,
  aggregateByTime,
  buildEquityCurve,
  computeCoreMetrics,
  getSession,
  patternGroups,
  whatIfExclude,
  whatIfDropWorst,
  detectRevengeTrades,
  buildImprovementPlan,
} from '@trademind/analytics';
import { eq } from 'drizzle-orm';
import { mistakes as mistakesTable, strategies as strategiesTable, tags as tagsTable } from '@trademind/database';
import { createTradeRepo } from '../common/trades-repo';
import { parseFilter, workspaceOf } from '../common/workspace';

interface AiInsight {
  type: string;
  title: string;
  summary: string;
  facts: { label: string; value: string }[];
  tradeRefs: string[];
  generatedBy: string;
}

/**
 * Phase 1：规则引擎（零虚构——每条结论都由 DB 聚合计算并附 tradeRefs）。
 * Phase 3：把同一数据上下文喂给 LLM 生成自然语言，规则引擎输出作为 Citation 事实层。
 */
export class AiService {
  private repo = createTradeRepo();
  private static readonly GENERATED_BY = 'rule-engine-v0（结论全部来自数据库聚合，可回溯）';

  private async load(workspaceId: string): Promise<{
    all: UnifiedTrade[];
    nameOf: (id: string) => string | null;
    nameMaps: { tags: Map<string, string>; mistakes: Map<string, string> };
  }> {
    const all = await this.repo.loadTrades(workspaceId);
    const strategies = await this.repo.db
      .select()
      .from(strategiesTable)
      .where(eq(strategiesTable.workspaceId, workspaceId));
    const tagRows = await this.repo.db
      .select()
      .from(tagsTable)
      .where(eq(tagsTable.workspaceId, workspaceId));
    const mistakeRows = await this.repo.db
      .select()
      .from(mistakesTable)
      .where(eq(mistakesTable.workspaceId, workspaceId));
    return {
      all,
      nameOf: (id) => strategies.find((s) => s.id === id)?.name ?? null,
      nameMaps: {
        tags: new Map(tagRows.map((r) => [r.id, r.name])),
        mistakes: new Map(mistakeRows.map((r) => [r.id, r.name])),
      },
    };
  }

  private insight(i: Omit<AiInsight, 'generatedBy'>): AiInsight {
    return { ...i, generatedBy: AiService.GENERATED_BY };
  }

  /** AI Daily Review */
  async dailyReview(workspaceId: string, dateStr?: string): Promise<AiInsight> {
    const { all } = await this.load(workspaceId);
    const date = dateStr ?? new Date().toISOString().slice(0, 10);
    const dayTrades = all.filter(
      (t) => t.closeTime && t.closeTime.slice(0, 10) === date,
    );
    const refs = dayTrades.map((t) => t.id);
    if (dayTrades.length === 0) {
      return this.insight({
        type: 'DAILY_REVIEW',
        title: `Daily Review · ${date}`,
        summary: `根据数据库记录，${date} 没有已平仓交易。`,
        facts: [{ label: 'Closed trades', value: '0' }],
        tradeRefs: [],
      });
    }

    const m = computeCoreMetrics(dayTrades);
    const sorted = [...dayTrades].sort((a, b) => b.netPnl - a.netPnl);
    const best = sorted[0];
    const worst = sorted[sorted.length - 1];
    const mistakesOf = (ts: UnifiedTrade[]) => ts.flatMap((t) => t.mistakes);
    const mistakeCount = mistakesOf(dayTrades).length;

    // 风险：仓位 vs 前 30 天均值
    const from30 = new Date(new Date(date).getTime() - 30 * 86400000).toISOString();
    const prior = all.filter((t) => t.closeTime && t.closeTime >= from30 && t.closeTime.slice(0, 10) < date);
    const priorAvgNotional =
      prior.length > 0
        ? prior.reduce((a, t) => a + t.entryPrice * t.quantity, 0) / prior.length
        : 0;
    const todayAvgNotional =
      dayTrades.reduce((a, t) => a + t.entryPrice * t.quantity, 0) / dayTrades.length;
    const sizeDeltaPct =
      priorAvgNotional > 0 ? (todayAvgNotional / priorAvgNotional - 1) * 100 : null;

    const facts = [
      { label: 'Trades', value: String(m.closedTrades) },
      { label: 'Net PNL', value: m.netPnl.toFixed(2) },
      { label: 'Win Rate', value: `${(m.winRate * 100).toFixed(1)}%` },
      {
        label: 'Best',
        value: `${best.symbol} ${tradeDirectionOf(best)} ${best.netPnl >= 0 ? '+' : ''}${best.netPnl.toFixed(2)}`,
      },
      {
        label: 'Worst',
        value: `${worst.symbol} ${tradeDirectionOf(worst)} ${worst.netPnl.toFixed(2)}`,
      },
      { label: 'Mistakes tagged', value: String(mistakeCount) },
    ];
    if (sizeDeltaPct !== null) {
      facts.push({
        label: 'Position size vs 30d avg',
        value: `${sizeDeltaPct >= 0 ? '+' : ''}${sizeDeltaPct.toFixed(1)}%`,
      });
    }

    const summary =
      `${date} 共 ${m.closedTrades} 笔已平仓交易，Net PNL ${m.netPnl >= 0 ? '+' : ''}${m.netPnl.toFixed(2)}，` +
      `最佳 ${best.symbol}（${best.netPnl.toFixed(2)}），最差 ${worst.symbol}（${worst.netPnl.toFixed(2)}）。` +
      (mistakeCount > 0 ? ` 有 ${mistakeCount} 笔被标记了错误标签。` : '') +
      (sizeDeltaPct !== null && Math.abs(sizeDeltaPct) > 20
        ? ` 注意：当日平均仓位较前 30 天均值偏离 ${sizeDeltaPct.toFixed(1)}%。`
        : '');

    return this.insight({
      type: 'DAILY_REVIEW',
      title: `Daily Review · ${date}`,
      summary,
      facts,
      tradeRefs: refs,
    });
  }

  /** AI Strategy Analyst */
  async strategyReview(workspaceId: string, strategyId: string): Promise<AiInsight> {
    const { all, nameOf } = await this.load(workspaceId);
    const stratTrades = all.filter((t) => t.strategyId === strategyId);
    if (stratTrades.length === 0) {
      return this.insight({
        type: 'STRATEGY_REVIEW',
        title: 'Strategy Review',
        summary: '数据库中没有该策略的交易记录。',
        facts: [],
        tradeRefs: [],
      });
    }
    const m = computeCoreMetrics(stratTrades);
    const bySymbol = aggregateBySymbol(stratTrades);
    const byTime = aggregateByTime(stratTrades, 'session');
    const bestSymbol = bySymbol[0];
    const worstSymbol = bySymbol[bySymbol.length - 1];
    const bestTime = [...byTime].sort((a, b) => b.pnl - a.pnl)[0];
    const worstTime = [...byTime].sort((a, b) => a.pnl - b.pnl)[0];
    const dd = buildEquityCurve(stratTrades, 0);

    return this.insight({
      type: 'STRATEGY_REVIEW',
      title: `Strategy Report · ${nameOf(strategyId) ?? strategyId}`,
      summary:
        `该策略共 ${m.closedTrades} 笔已平仓交易，Win Rate ${(m.winRate * 100).toFixed(1)}%，` +
        `PF ${Number.isFinite(m.profitFactor) ? m.profitFactor.toFixed(2) : '∞'}，EV ${m.expectancy.toFixed(2)}，` +
        `MaxDD ${dd.maxDrawdown.toFixed(2)}。` +
        (bestSymbol ? ` 最佳标的 ${bestSymbol.key}（${bestSymbol.pnl.toFixed(2)}）` : '') +
        (worstSymbol && worstSymbol !== bestSymbol ? `，最差 ${worstSymbol.key}（${worstSymbol.pnl.toFixed(2)}）` : '') +
        (bestTime ? `。最佳时段 ${bestTime.label}（${bestTime.pnl.toFixed(2)}），最差 ${worstTime?.label}（${worstTime?.pnl.toFixed(2)}）。` : ''),
      facts: [
        { label: 'Trades', value: String(m.closedTrades) },
        { label: 'Win Rate', value: `${(m.winRate * 100).toFixed(1)}%` },
        {
          label: 'Profit Factor',
          value: Number.isFinite(m.profitFactor) ? m.profitFactor.toFixed(2) : '∞',
        },
        { label: 'EV', value: m.expectancy.toFixed(2) },
        { label: 'Avg R:R', value: m.avgRr ? m.avgRr.toFixed(2) : 'N/A' },
        { label: 'Max Drawdown', value: dd.maxDrawdown.toFixed(2) },
        { label: 'Best Symbol', value: bestSymbol ? `${bestSymbol.key} (${bestSymbol.pnl.toFixed(2)})` : 'N/A' },
        { label: 'Worst Symbol', value: worstSymbol ? `${worstSymbol.key} (${worstSymbol.pnl.toFixed(2)})` : 'N/A' },
        { label: 'Best Time', value: bestTime ? `${bestTime.label} (${bestTime.pnl.toFixed(2)})` : 'N/A' },
        { label: 'Worst Time', value: worstTime ? `${worstTime.label} (${worstTime.pnl.toFixed(2)})` : 'N/A' },
      ],
      tradeRefs: stratTrades.map((t) => t.id),
    });
  }

  /** AI Pattern Detection：搜索亏损集中的 (时段×方向/标签/错误/标的) 组合 */
  async patternAnalysis(workspaceId: string, filter: FilterSet): Promise<AiInsight> {
    const { all, nameMaps } = await this.load(workspaceId);
    const { applyFilter } = await import('@trademind/analytics');
    const trades = applyFilter(all, filter).map((t) => ({
      ...t,
      tags: t.tags.map((id) => nameMaps.tags.get(id) ?? id),
      mistakes: t.mistakes.map((id) => nameMaps.mistakes.get(id) ?? id),
    }));
    const patterns: { label: string; trades: number; winRate: number; pnl: number }[] = [];

    const add = (label: string, subset: UnifiedTrade[]) => {
      if (subset.length < 5) return;
      const m = computeCoreMetrics(subset);
      patterns.push({
        label,
        trades: m.closedTrades,
        winRate: m.winRate,
        pnl: m.netPnl,
      });
    };

    // 时段 × 方向
    const sessions = ['ASIA', 'LONDON', 'NEW_YORK', 'OTHER'] as const;
    for (const s of sessions) {
      for (const side of ['LONG', 'SHORT'] as const) {
        add(
          `${s} session ${side}`,
          trades.filter(
            (t) =>
              t.closeTime && getSession(t.closeTime) === s && tradeDirectionOf(t) === side,
          ),
        );
      }
    }
    // 标的 × 方向
    const symbols = [...new Set(trades.map((t) => t.symbol))];
    for (const sym of symbols) {
      for (const side of ['LONG', 'SHORT'] as const) {
        add(
          `${sym} ${side}`,
          trades.filter((t) => t.symbol === sym && tradeDirectionOf(t) === side),
        );
      }
    }

    const tagStats = aggregateByTag(trades).filter((s) => s.trades >= 5);
    for (const s of tagStats) {
      patterns.push({ label: `Tag: ${s.key}`, trades: s.trades, winRate: s.winRate, pnl: s.pnl });
    }
    const mistakeStats = aggregateByMistake(trades).filter((s) => s.trades >= 5);
    for (const s of mistakeStats) {
      patterns.push({
        label: `Mistake: ${s.key}`,
        trades: s.trades,
        winRate: s.winRate,
        pnl: s.pnl,
      });
    }
    const sideStats = aggregateBySide(trades);
    for (const s of sideStats) {
      patterns.push({ label: `${s.key} overall`, trades: s.trades, winRate: s.winRate, pnl: s.pnl });
    }

    const losing = patterns.filter((p) => p.pnl < 0).sort((a, b) => a.pnl - b.pnl).slice(0, 5);
    const winning = patterns.filter((p) => p.pnl > 0).sort((a, b) => b.pnl - a.pnl).slice(0, 3);

    const fmt = (p: { label: string; trades: number; winRate: number; pnl: number }) =>
      `${p.label}: ${p.trades} trades, win ${(p.winRate * 100).toFixed(0)}%, PNL ${p.pnl.toFixed(2)}`;

    const refs = trades
      .filter(
        (t) =>
          losing.some((p) => p.label.includes(t.symbol)) ||
          (t.closeTime !== null &&
            t.closeTime !== undefined &&
            losing.some((p) => p.label.startsWith(getSession(t.closeTime as string)))),
      )
      .map((t) => t.id)
      .slice(0, 100);

    return this.insight({
      type: 'PATTERN',
      title: 'Pattern Detection',
      summary:
        (losing.length > 0
          ? `检测到的主要亏损模式：\n${losing.map(fmt).join('\n')}`
          : '未检测到显著亏损模式（样本 ≥ 5 笔的组合中无明显亏损集中）。') +
        (winning.length > 0 ? `\n\n表现较好的模式：\n${winning.map(fmt).join('\n')}` : ''),
      facts: losing.concat(winning).map((p) => ({
        label: p.label,
        value: `${p.trades} 笔 · 胜率 ${(p.winRate * 100).toFixed(0)}% · PNL ${p.pnl.toFixed(2)}`,
      })),
      tradeRefs: refs,
    });
  }

  /** AI Risk Analysis */
  async riskAnalysis(workspaceId: string, filter: FilterSet): Promise<AiInsight> {
    const { all } = await this.load(workspaceId);
    const { applyFilter } = await import('@trademind/analytics');
    const trades = applyFilter(all, filter);
    const m = computeCoreMetrics(trades);
    const dd = buildEquityCurve(trades, 0);

    const noSl = trades.filter((t) => t.stopLoss === null && t.closeTime);
    const refs: string[] = [];
    const facts: { label: string; value: string }[] = [
      { label: 'Max Drawdown', value: dd.maxDrawdown.toFixed(2) },
      { label: 'Current Drawdown', value: dd.currentDrawdown.toFixed(2) },
      { label: 'Max Runup', value: dd.maxRunup.toFixed(2) },
      { label: 'Closed trades without SL', value: `${noSl.length} / ${m.closedTrades}` },
    ];
    if (dd.maxDrawdownTime) {
      facts.push({ label: 'Max DD at', value: dd.maxDrawdownTime.slice(0, 10) });
    }
    if (noSl.length > 0) refs.push(...noSl.slice(0, 50).map((t) => t.id));

    // 仓位放大检测：最近 10 笔名义价值 vs 此前均值
    const sorted = [...trades.filter((t) => t.closeTime)].sort(
      (a, b) => new Date(b.closeTime as string).getTime() - new Date(a.closeTime as string).getTime(),
    );
    const recent = sorted.slice(0, 10);
    const priorAvg =
      sorted.length > 10
        ? sorted.slice(10).reduce((a, t) => a + t.entryPrice * t.quantity, 0) /
          (sorted.length - 10)
        : 0;
    if (priorAvg > 0 && recent.length > 0) {
      const recentAvg = recent.reduce((a, t) => a + t.entryPrice * t.quantity, 0) / recent.length;
      const pct = (recentAvg / priorAvg - 1) * 100;
      facts.push({ label: 'Recent size vs prior avg', value: `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%` });
      if (pct > 24) refs.push(...recent.slice(0, 10).map((t) => t.id));
    }

    const summary =
      `基于 ${m.closedTrades} 笔已平仓交易：MaxDD ${dd.maxDrawdown.toFixed(2)}` +
      `（${dd.maxDrawdownPct ? `${(dd.maxDrawdownPct * 100).toFixed(1)}%` : 'N/A'}），` +
      `当前回撤 ${dd.currentDrawdown.toFixed(2)}。` +
      (noSl.length > 0 ? ` 有 ${noSl.length} 笔平仓交易未设置止损。` : ' 所有交易均设置了止损。');

    return this.insight({
      type: 'RISK',
      title: 'Risk Analysis',
      summary,
      facts,
      tradeRefs: [...new Set(refs)].slice(0, 100),
    });
  }

  /**
   * AI 反事实推演：回答「如果我不做 X，历史结果会怎样」。
   * 纯历史重算，不做预测；每个结论都带 tradeRefs 可回溯。
   */
  async counterfactual(
    workspaceId: string,
    opts: { dimension?: string; keys?: string[]; topN?: number } = {},
  ) {
    const { all } = await this.load(workspaceId);
    const dimension = opts.dimension ?? 'hour';
    const keys = opts.keys && opts.keys.length > 0 ? opts.keys : null;

    const groups = patternGroups(all, dimension);
    const whatIf = keys
      ? whatIfExclude(all, dimension, keys)
      : whatIfDropWorst(all, dimension, { topN: opts.topN ?? 3 });

    const revengeLoose = detectRevengeTrades(all);
    const revengeStrict = detectRevengeTrades(all, { requireLargerSize: true });
    const plan = buildImprovementPlan(all);

    const baseline = computeCoreMetrics(all);
    return {
      generatedBy: AiService.GENERATED_BY,
      dimension,
      baseline: {
        trades: baseline.closedTrades,
        netPnl: baseline.netPnl,
        winRate: baseline.winRate,
        profitFactor: Number.isFinite(baseline.profitFactor) ? baseline.profitFactor : null,
      },
      groups,
      whatIf,
      revenge: { loose: revengeLoose, strict: revengeStrict },
      plan,
    };
  }

  /** 单笔/批次交易复盘 */
  async tradeReview(workspaceId: string, tradeIds: string[]): Promise<AiInsight> {
    const { all } = await this.load(workspaceId);
    const trades = all.filter((t) => tradeIds.includes(t.id));
    if (trades.length === 0) {
      return this.insight({
        type: 'TRADE_REVIEW',
        title: 'Trade Review',
        summary: '未找到指定交易。',
        facts: [],
        tradeRefs: [],
      });
    }
    const lines = trades.map((t) => {
      const dir = tradeDirectionOf(t);
      const rr = t.rr ? ` R:R ${t.rr.toFixed(2)}` : '';
      const mistakeTxt = t.mistakes.length > 0 ? `，标记错误 ${t.mistakes.length} 个` : '';
      return `${t.symbol} ${dir} · ${t.closeTime?.slice(0, 10) ?? 'OPEN'} · PNL ${t.netPnl.toFixed(2)}${rr}${mistakeTxt}`;
    });
    const m = computeCoreMetrics(trades);
    return this.insight({
      type: 'TRADE_REVIEW',
      title: `Trade Review · ${trades.length} trades`,
      summary: `选中 ${trades.length} 笔交易，合计 PNL ${m.netPnl.toFixed(2)}，胜率 ${(m.winRate * 100).toFixed(0)}%。\n${lines.join('\n')}`,
      facts: [
        { label: 'Trades', value: String(trades.length) },
        { label: 'Total PNL', value: m.netPnl.toFixed(2) },
        { label: 'Win Rate', value: `${(m.winRate * 100).toFixed(1)}%` },
      ],
      tradeRefs: trades.map((t) => t.id),
    });
  }

  /**
   * 周期复盘（日 / 周 / 月）：一键分析所选周期。
   * 与 dailyReview 区别：可覆盖任意区间（本周 / 本月 / 自定义），
   * 且额外给出「最佳/最差时段」与「最佳/最差入场理由」，对齐 TMM 的「分析本周」。
   * 全部结论来自数据库聚合，附 tradeRefs 可回溯。
   */
  async periodReview(
    workspaceId: string,
    opts: { from?: string; to?: string; scope?: 'day' | 'week' | 'month' } = {},
  ): Promise<AiInsight> {
    const { all } = await this.load(workspaceId);

    // 区间解析：优先用显式 from/to，否则按 scope 推算（周一为周起始，UTC 口径）
    let fromDay = (opts.from ?? '').slice(0, 10);
    let toDay = (opts.to ?? '').slice(0, 10);
    if (!fromDay || !toDay) {
      const scope = opts.scope ?? 'week';
      const now = new Date();
      const start = new Date(now);
      if (scope === 'day') {
        start.setUTCHours(0, 0, 0, 0);
      } else if (scope === 'week') {
        const dow = now.getUTCDay(); // 0=周日
        start.setUTCDate(now.getUTCDate() - ((dow + 6) % 7));
        start.setUTCHours(0, 0, 0, 0);
      } else {
        start.setUTCDate(1);
        start.setUTCHours(0, 0, 0, 0);
      }
      fromDay = start.toISOString().slice(0, 10);
      toDay = now.toISOString().slice(0, 10);
    }

    const period = all.filter(
      (t) => t.closeTime && t.closeTime.slice(0, 10) >= fromDay && t.closeTime.slice(0, 10) <= toDay,
    );

    const range = `${fromDay} ~ ${toDay}`;
    if (period.length === 0) {
      return this.insight({
        type: 'PERIOD_REVIEW',
        title: `Period Review · ${range}`,
        summary: `根据数据库记录，${range} 区间内没有已平仓交易。`,
        facts: [{ label: 'Trades', value: '0' }],
        tradeRefs: [],
      });
    }

    const m = computeCoreMetrics(period);

    // 最佳 / 最差时段
    const sessions = aggregateByTime(period, 'session');
    const byPnlDesc = [...sessions].sort((a, b) => b.pnl - a.pnl);
    const bestSession = byPnlDesc[0];
    const worstSession = byPnlDesc[byPnlDesc.length - 1];

    // 最佳 / 最差入场理由（entryTags 是名称数组，借 aggregateByTag 按名称聚合）
    const entryNamed = period.map((t) => ({ ...t, tags: t.entryTags ?? [] }));
    const tagStats = aggregateByTag(entryNamed).sort((a, b) => b.pnl - a.pnl);
    const bestTag = tagStats[0];
    const worstTag = tagStats.length > 1 ? tagStats[tagStats.length - 1] : null;

    const fmtMoney = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;
    const facts: { label: string; value: string }[] = [
      { label: 'Trades', value: String(m.closedTrades) },
      { label: 'Net PNL', value: fmtMoney(m.netPnl) },
      { label: 'Win Rate', value: `${(m.winRate * 100).toFixed(1)}%` },
      { label: 'EV', value: m.expectancy.toFixed(2) },
      {
        label: 'Profit Factor',
        value: Number.isFinite(m.profitFactor) ? m.profitFactor.toFixed(2) : '∞',
      },
      {
        label: 'Best Session',
        value: bestSession
          ? `${bestSession.label} (${fmtMoney(bestSession.pnl)})`
          : 'N/A',
      },
      {
        label: 'Worst Session',
        value: worstSession
          ? `${worstSession.label} (${fmtMoney(worstSession.pnl)})`
          : 'N/A',
      },
      {
        label: 'Best Entry Reason',
        value: bestTag ? `${bestTag.key} (${fmtMoney(bestTag.pnl)})` : 'N/A（未标注入场理由）',
      },
      {
        label: 'Worst Entry Reason',
        value: worstTag ? `${worstTag.key} (${fmtMoney(worstTag.pnl)})` : 'N/A（未标注入场理由）',
      },
    ];

    const summary =
      `${range} 共 ${m.closedTrades} 笔已平仓交易，净盈亏 ${fmtMoney(m.netPnl)}，` +
      `胜率 ${(m.winRate * 100).toFixed(1)}%，EV ${m.expectancy.toFixed(2)}，` +
      `PF ${Number.isFinite(m.profitFactor) ? m.profitFactor.toFixed(2) : '∞'}。` +
      (bestSession && worstSession && bestSession !== worstSession
        ? ` 最佳时段 ${bestSession.label}（${fmtMoney(bestSession.pnl)}），最差 ${worstSession.label}（${fmtMoney(worstSession.pnl)}）。`
        : '') +
      (bestTag && worstTag && bestTag !== worstTag
        ? ` 入场理由中「${bestTag.key}」贡献 ${fmtMoney(bestTag.pnl)}，「${worstTag.key}」拖累 ${fmtMoney(worstTag.pnl)}。`
        : '');

    return this.insight({
      type: 'PERIOD_REVIEW',
      title: `Period Review · ${range}`,
      summary,
      facts,
      tradeRefs: period.map((t) => t.id).slice(0, 200),
    });
  }
}

@Controller('ai')
export class AiController {
  constructor(private readonly service: AiService) {}

  @Post('daily-review')
  dailyReview(@Req() req: Request, @Body() body: { date?: string }) {
    return this.service.dailyReview(workspaceOf(req), body.date);
  }

  @Post('strategy-review')
  strategyReview(@Req() req: Request, @Body() body: { strategyId: string }) {
    return this.service.strategyReview(workspaceOf(req), body.strategyId);
  }

  @Post('pattern-analysis')
  patternAnalysis(@Req() req: Request, @Body() body: { filter?: FilterSet }) {
    return this.service.patternAnalysis(workspaceOf(req), body.filter ?? {});
  }

  @Post('risk-analysis')
  riskAnalysis(@Req() req: Request, @Body() body: { filter?: FilterSet }) {
    return this.service.riskAnalysis(workspaceOf(req), body.filter ?? {});
  }

  @Post('trade-review')
  tradeReview(@Req() req: Request, @Body() body: { tradeIds: string[] }) {
    return this.service.tradeReview(workspaceOf(req), body.tradeIds ?? []);
  }

  /** 周期复盘（日/周/月）：scope = day|week|month，或显式 from/to（YYYY-MM-DD） */
  @Post('period-review')
  periodReview(
    @Req() req: Request,
    @Body() body: { from?: string; to?: string; scope?: 'day' | 'week' | 'month' },
  ) {
    return this.service.periodReview(workspaceOf(req), body ?? {});
  }

  /** AI 反事实推演（What-if）：dimension = symbol|hour|session|weekday|strategy */
  @Post('counterfactual')
  counterfactual(
    @Req() req: Request,
    @Body() body: { dimension?: string; keys?: string[]; topN?: number },
  ) {
    return this.service.counterfactual(workspaceOf(req), body ?? {});
  }
}

@Module({
  controllers: [AiController],
  providers: [AiService],
})
export class AiModule {}
