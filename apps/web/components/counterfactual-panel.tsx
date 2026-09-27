'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import { Section } from './ui';

interface Insight {
  type: string;
  title: string;
  summary: string;
  facts: { label: string; value: string }[];
  tradeRefs: string[];
  generatedBy: string;
}

interface PatternGroup {
  key: string;
  label: string;
  trades: number;
  pnl: number;
  avgPnl: number;
  winRate: number;
  profitFactor: number | null;
  tradeRefs: string[];
}

interface WhatIf {
  dimension: string;
  excludedKeys: string[];
  baseline: { trades: number; netPnl: number; winRate: number; profitFactor: number | null; maxDrawdown: number };
  scenario: { trades: number; netPnl: number; winRate: number; profitFactor: number | null; maxDrawdown: number };
  deltaPnl: number;
  deltaWinRate: number;
  sampleRetention: number;
  reliable: boolean;
  facts: string[];
  advice: string[];
  excludedTradeRefs: string[];
}

interface CfResult {
  generatedBy: string;
  dimension: string;
  baseline: { trades: number; netPnl: number; winRate: number; profitFactor: number | null };
  groups: PatternGroup[];
  whatIf: WhatIf;
  revenge: {
    loose: { count: number; pnl: number; shareOfLosses: number; tradeRefs: string[]; windowMinutes: number };
    strict: { count: number; pnl: number; shareOfLosses: number; tradeRefs: string[]; windowMinutes: number };
  };
  plan: {
    rules: { title: string; detail: string; evidence: string[] }[];
    projectedMonthlyPnl: number | null;
    recentTrades: number;
    recentNetPnl: number;
  };
}

const ACTIONS: { label: string; path: string; body: object }[] = [
  { label: '今日复盘（Daily Review）', path: '/ai/daily-review', body: {} },
  { label: '模式检测（Pattern Detection）', path: '/ai/pattern-analysis', body: {} },
  { label: '风险分析（Risk Analysis）', path: '/ai/risk-analysis', body: {} },
];

const DIMENSIONS: { key: string; label: string }[] = [
  { key: 'hour', label: '按时段（UTC 小时）' },
  { key: 'symbol', label: '按品种' },
  { key: 'session', label: '按交易时段' },
  { key: 'weekday', label: '按星期' },
];

export function CounterfactualPanel() {
  const [insight, setInsight] = useState<Insight | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dimension, setDimension] = useState('hour');
  const [cf, setCf] = useState<CfResult | null>(null);
  const [cfLoading, setCfLoading] = useState(false);
  const [cfError, setCfError] = useState<string | null>(null);

  const { data: strategies } = useQuery({
    queryKey: ['strategies-list'],
    queryFn: () => api<{ id: string; name: string }[]>('/strategies'),
  });

  async function run(label: string, path: string, body: object) {
    setLoading(label);
    setError(null);
    try {
      setInsight(await api<Insight>(path, { method: 'POST', body: JSON.stringify(body) }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(null);
    }
  }

  async function runCounterfactual(dim?: string) {
    const d = dim ?? dimension;
    setCfLoading(true);
    setCfError(null);
    try {
      setCf(await api<CfResult>('/ai/counterfactual', { method: 'POST', body: JSON.stringify({ dimension: d }) }));
    } catch (e) {
      setCfError((e as Error).message);
    } finally {
      setCfLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {ACTIONS.map((a) => (
          <button
            key={a.path}
            onClick={() => run(a.label, a.path, a.body)}
            disabled={loading !== null}
            className="rounded-md border border-line bg-surface px-3 py-1.5 text-sm hover:border-slate-500 disabled:opacity-50"
          >
            {loading === a.label ? '分析中…' : a.label}
          </button>
        ))}
        {(strategies ?? []).map((s) => (
          <button
            key={s.id}
            onClick={() => run(`策略分析:${s.name}`, '/ai/strategy-review', { strategyId: s.id })}
            disabled={loading !== null}
            className="rounded-md border border-line bg-surface px-3 py-1.5 text-sm hover:border-slate-500 disabled:opacity-50"
          >
            分析策略：{s.name}
          </button>
        ))}
      </div>

      {error ? <p className="text-sm text-down">{error}</p> : null}

      {/* 反事实推演 */}
      <Section
        title="反事实推演（What-if）"
        actions={
          <div className="flex items-center gap-2">
            <select
              value={dimension}
              onChange={(e) => setDimension(e.target.value)}
              className="rounded border border-line bg-surface px-2 py-1 text-xs"
            >
              {DIMENSIONS.map((d) => (
                <option key={d.key} value={d.key}>
                  {d.label}
                </option>
              ))}
            </select>
            <button
              onClick={() => runCounterfactual()}
              disabled={cfLoading}
              className="rounded bg-sky-600 px-2.5 py-1 text-xs text-white hover:bg-sky-500 disabled:opacity-40"
            >
              {cfLoading ? '推演中…' : '开始推演'}
            </button>
          </div>
        }
      >
        <p className="mb-3 text-xs text-slate-500">
          只回答「如果我不做 X，历史会怎样」——纯历史重算，<b className="text-slate-300">不做预测</b>。
          自动挑出亏损最重的分组做剔除对比，并标注结论是否具备统计意义。
        </p>

        {cfError ? <p className="text-sm text-down">{cfError}</p> : null}

        {cf ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <div className="rounded border border-line bg-surface px-3 py-2">
                <div className="text-xs text-slate-500">当前净盈亏</div>
                <div className={`text-lg ${cf.baseline.netPnl >= 0 ? 'text-up' : 'text-down'}`}>
                  {cf.baseline.netPnl >= 0 ? '+' : ''}
                  {cf.baseline.netPnl.toFixed(2)}
                </div>
                <div className="text-[11px] text-slate-600">
                  {cf.baseline.trades} 笔 · 胜率 {(cf.baseline.winRate * 100).toFixed(1)}%
                </div>
              </div>
              <div className="rounded border border-line bg-surface px-3 py-2">
                <div className="text-xs text-slate-500">剔除后净盈亏</div>
                <div className={`text-lg ${cf.whatIf.scenario.netPnl >= 0 ? 'text-up' : 'text-down'}`}>
                  {cf.whatIf.scenario.netPnl >= 0 ? '+' : ''}
                  {cf.whatIf.scenario.netPnl.toFixed(2)}
                </div>
                <div className="text-[11px] text-slate-600">
                  {cf.whatIf.scenario.trades} 笔 · 胜率 {(cf.whatIf.scenario.winRate * 100).toFixed(1)}%
                </div>
              </div>
              <div className="rounded border border-line bg-surface px-3 py-2">
                <div className="text-xs text-slate-500">净盈亏变化</div>
                <div className={`text-lg ${cf.whatIf.deltaPnl >= 0 ? 'text-up' : 'text-down'}`}>
                  {cf.whatIf.deltaPnl >= 0 ? '+' : ''}
                  {cf.whatIf.deltaPnl.toFixed(2)}
                </div>
                <div className="text-[11px] text-slate-600">
                  剔除 {cf.whatIf.excludedKeys.join('、') || '—'} · 保留 {(cf.whatIf.sampleRetention * 100).toFixed(0)}% 样本
                </div>
              </div>
              <div className="rounded border border-line bg-surface px-3 py-2">
                <div className="text-xs text-slate-500">结论可信度</div>
                <div className={`text-lg ${cf.whatIf.reliable ? 'text-up' : 'text-amber-400'}`}>
                  {cf.whatIf.reliable ? '可参考' : '不可作为依据'}
                </div>
                <div className="text-[11px] text-slate-600">
                  最大回撤 {cf.whatIf.baseline.maxDrawdown.toFixed(0)} → {cf.whatIf.scenario.maxDrawdown.toFixed(0)}
                </div>
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded border border-line/70 bg-surface/60 px-3 py-2">
                <div className="mb-1 text-xs font-medium text-slate-300">计算事实（可核对）</div>
                <ul className="space-y-1 text-xs text-slate-400">
                  {cf.whatIf.facts.map((f, i) => (
                    <li key={i}>· {f}</li>
                  ))}
                </ul>
              </div>
              <div className="rounded border border-line/70 bg-surface/60 px-3 py-2">
                <div className="mb-1 text-xs font-medium text-slate-300">解读（主观部分）</div>
                <ul className="space-y-1 text-xs text-slate-400">
                  {cf.whatIf.advice.map((a, i) => (
                    <li key={i}>· {a}</li>
                  ))}
                </ul>
              </div>
            </div>

            <div>
              <div className="mb-1 text-xs font-medium text-slate-300">分组明细（亏损最重在前）</div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-500">
                    <th className="pb-2 font-normal">分组</th>
                    <th className="pb-2 font-normal text-right">笔数</th>
                    <th className="pb-2 font-normal text-right">净盈亏</th>
                    <th className="pb-2 font-normal text-right">均值</th>
                    <th className="pb-2 font-normal text-right">胜率</th>
                    <th className="pb-2 font-normal text-right">PF</th>
                  </tr>
                </thead>
                <tbody>
                  {cf.groups.map((g) => (
                    <tr key={g.key} className="border-t border-line/60">
                      <td className="py-1.5 text-slate-200">{g.label}</td>
                      <td className="py-1.5 text-right text-slate-400">{g.trades}</td>
                      <td className={`py-1.5 text-right ${g.pnl >= 0 ? 'text-up' : 'text-down'}`}>{g.pnl.toFixed(2)}</td>
                      <td className="py-1.5 text-right text-slate-400">{g.avgPnl.toFixed(2)}</td>
                      <td className="py-1.5 text-right text-slate-400">{(g.winRate * 100).toFixed(0)}%</td>
                      <td className="py-1.5 text-right text-slate-400">
                        {g.profitFactor === null ? '∞' : g.profitFactor.toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="rounded border border-line/70 bg-surface/60 px-3 py-2">
              <div className="mb-1 text-xs font-medium text-slate-300">连锁亏损（报复性交易）</div>
              <p className="text-xs text-slate-400">
                宽松口径 {cf.revenge.loose.count} 笔（{cf.revenge.loose.pnl.toFixed(2)}）·
                严格口径（仓位比上一笔更大）{cf.revenge.strict.count} 笔（{cf.revenge.strict.pnl.toFixed(2)}）
                <span className="ml-1 text-slate-600">
                  算法账户连续开仓是常态，严格口径才更像「上头加仓」
                </span>
              </p>
            </div>

            {cf.plan.rules.length > 0 ? (
              <div>
                <div className="mb-1 text-xs font-medium text-slate-300">
                  30 天改进计划（近 {cf.plan.recentTrades} 笔，净盈亏 {cf.plan.recentNetPnl.toFixed(2)}）
                </div>
                <div className="space-y-2">
                  {cf.plan.rules.map((r, i) => (
                    <div key={i} className="rounded border border-line/70 bg-surface/60 px-3 py-2">
                      <div className="text-sm text-slate-200">{r.title}</div>
                      <p className="mt-0.5 text-xs text-slate-400">{r.detail}</p>
                      {r.evidence.length > 0 ? (
                        <ul className="mt-1 space-y-0.5 text-[11px] text-slate-600">
                          {r.evidence.map((e, j) => (
                            <li key={j}>证据：{e}</li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  ))}
                </div>
                {cf.plan.projectedMonthlyPnl !== null ? (
                  <p className="mt-2 text-[11px] text-slate-600">
                    情景参考：若执行上述约束，按月粗略外推净盈亏约 {cf.plan.projectedMonthlyPnl.toFixed(2)}（仅为历史情景推演，非收益承诺）。
                  </p>
                ) : null}
              </div>
            ) : null}

            <p className="text-[11px] text-slate-600">{cf.generatedBy}</p>
          </div>
        ) : null}
      </Section>

      {insight ? (
        <Section title={insight.title}>
          <pre className="whitespace-pre-wrap font-sans text-sm text-slate-200">{insight.summary}</pre>
          {insight.facts.length > 0 ? (
            <dl className="mt-4 grid grid-cols-2 gap-y-1.5 text-sm xl:grid-cols-3">
              {insight.facts.map((f, i) => (
                <div key={i} className="contents">
                  <dt className="text-slate-500">{f.label}</dt>
                  <dd className="text-slate-200">{f.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          <p className="mt-3 text-[11px] text-slate-600">{insight.generatedBy}</p>
        </Section>
      ) : null}
    </div>
  );
}
