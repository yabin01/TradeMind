'use client';

import { useState } from 'react';
import Link from 'next/link';
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

const FACT_LABEL_ZH: Record<string, string> = {
  Trades: '交易笔数',
  'Net PNL': '净盈亏',
  'Win Rate': '胜率',
  EV: '期望值 EV',
  PF: '盈亏比 PF',
  'Best Session': '最佳时段',
  'Worst Session': '最差时段',
  'Best Entry Reason': '最佳入场理由',
  'Worst Entry Reason': '最差入场理由',
  'Best Symbol': '最佳标的',
  'Worst Symbol': '最差标的',
};

/**
 * 周期级一键 AI 分析（日 / 周 / 月）
 * 调用 POST /api/ai/period-review —— 结论全部由数据库聚合得出（零虚构），并附 tradeRefs。
 */
export function PeriodReview({
  from,
  to,
  scope,
  buttonLabel,
}: {
  from?: string;
  to?: string;
  scope?: 'day' | 'week' | 'month';
  buttonLabel?: string;
}) {
  const [insight, setInsight] = useState<Insight | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<Insight>('/ai/period-review', {
        method: 'POST',
        body: JSON.stringify({ from, to, scope }),
      });
      setInsight(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="AI 周期复盘">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={run}
            disabled={busy}
            className="rounded-md bg-emerald-500/20 px-3 py-1.5 text-xs text-emerald-200 hover:bg-emerald-500/30 disabled:opacity-50"
          >
            {busy ? '分析中…' : buttonLabel ?? 'AI 分析本周期'}
          </button>
          {from || to ? (
            <span className="text-xs text-slate-500">
              区间 {from ?? '—'} ~ {to ?? '—'}
            </span>
          ) : null}
          <span className="text-[11px] text-slate-600">结论由数据库聚合计算，附交易引用，不做虚构推断</span>
        </div>

        {error ? <p className="text-xs text-down">{error}</p> : null}

        {insight ? (
          <div className="space-y-3">
            <div className="rounded-lg border border-line bg-surface px-3 py-2.5">
              <div className="mb-1 text-xs text-slate-500">{insight.title}</div>
              <p className="text-sm text-slate-200">{insight.summary}</p>
            </div>

            {insight.facts.length > 0 ? (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
                {insight.facts.map((f) => (
                  <div key={f.label} className="rounded-md border border-line bg-surface px-2.5 py-1.5">
                    <div className="text-[11px] text-slate-500">{FACT_LABEL_ZH[f.label] ?? f.label}</div>
                    <div className="text-sm text-slate-200">{f.value}</div>
                  </div>
                ))}
              </div>
            ) : null}

            {insight.tradeRefs.length > 0 ? (
              <div>
                <div className="mb-1 text-xs text-slate-500">
                  相关交易（{insight.tradeRefs.length} 笔，点击前 {Math.min(12, insight.tradeRefs.length)} 笔）
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {insight.tradeRefs.slice(0, 12).map((id) => (
                    <Link
                      key={id}
                      href={`/trades/${id}`}
                      className="rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-[11px] text-slate-400 hover:border-slate-500 hover:text-slate-200"
                    >
                      {id.slice(0, 8)}
                    </Link>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <p className="text-xs text-slate-500">点击上方按钮，对本周期的交易做一次结构化复盘（净盈亏 / 胜率 / EV / PF / 时段 / 理由归因）。</p>
        )}
      </div>
    </Section>
  );
}
