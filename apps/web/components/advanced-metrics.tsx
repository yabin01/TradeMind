'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, filterQuery } from '../lib/api';
import { useFilterStore } from '../lib/store';
import { fmtDuration, fmtNum, fmtPct, fmtUsd, fmtUsdCompact } from '../lib/format';
import { Section } from './ui';
import type { AdvancedMetrics, MetricMeta } from '@trademind/analytics';

interface AdvancedResponse {
  metrics: AdvancedMetrics;
  meta: MetricMeta[];
}

/** 分组展示顺序（与 METRIC_META.group 对应） */
const GROUP_ORDER: MetricMeta['group'][] = [
  '风险调整',
  '回撤恢复',
  '收益规模',
  '分布形态',
  '连胜连亏',
  '成本',
  '频率',
  '稳定性',
];

const GROUP_HINT: Record<string, string> = {
  风险调整: '每承担一单位风险换回多少收益',
  回撤恢复: '最坏的一段时期有多深、多久、赚没赚回来',
  收益规模: '绝对收益与交易体量',
  分布形态: '单笔结果的形状，决定资金曲线是否平滑',
  连胜连亏: '连续结果的极值，决定心理与资金缓冲',
  成本: '手续费与资金费吃掉了多少',
  频率: '交易节奏',
  稳定性: '收益是否依赖少数几个大月',
};

/** 指标为 null 时给用户一句明确原因，而不是让「—」变成谜语 */
function nullReason(key: string): string {
  switch (key) {
    case 'sharpe':
    case 'sortino':
      return '样本不足：需要 ≥2 个交易日，且日收益存在波动';
    case 'calmar':
      return '需要年化收益与最大回撤同时可计算';
    case 'roi':
      return '需在账户设置里填写初始资金 startingBalance';
    case 'annualizedReturn':
    case 'years':
      return '需要 ≥2 笔已平仓交易且时间跨度大于 0';
    case 'ulcerIndex':
      return '无权益曲线（没有已平仓交易）';
    case 'recoveryFactor':
    case 'maxDrawdownDurationDays':
      return '当前没有回撤';
    case 'payoffRatio':
      return '没有亏损交易，无法计算盈亏比';
    case 'expectancyR':
      return '没有交易标注计划风险（risk 字段）';
    case 'costRatio':
      return '毛利为 0 或为负，成本占比无意义';
    case 'avgNotional':
    case 'costPerTrade':
    case 'tradesPerDay':
    case 'avgHoldingMinutes':
    case 'profitableMonthsRatio':
      return '没有已平仓交易';
    case 'stdDevPnl':
      return '需要 ≥2 笔已平仓交易';
    default:
      return '样本不足';
  }
}

function fmtValue(meta: MetricMeta, v: unknown): string {
  if (v === null || v === undefined) return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  switch (meta.unit) {
    case 'usd':
      return meta.key === 'totalNotional' || meta.key === 'avgNotional' ? fmtUsdCompact(n) : fmtUsd(n);
    case 'pct':
      return meta.key === 'costRatio' ? fmtPct(n, 0) : fmtPct(n, 1);
    case 'ratio':
      return fmtNum(n, 2);
    case 'count':
      return String(Math.round(n));
    case 'days':
      return `${Math.round(n)} 天`;
    case 'minutes':
      return fmtDuration(n);
    default:
      return fmtNum(n, 2);
  }
}

function toneOf(meta: MetricMeta, n: number): 'up' | 'down' | 'neutral' {
  // 金额类：成本 / 回撤这类「越小越好」的金额一律标负向
  if (meta.unit === 'usd') {
    if (meta.better === 'lower') return n === 0 ? 'neutral' : 'down';
    return n > 0 ? 'up' : n < 0 ? 'down' : 'neutral';
  }
  if (meta.better === 'higher') return n > 0 ? 'up' : n < 0 ? 'down' : 'neutral';
  if (meta.better === 'lower') return n > 0 ? 'down' : n < 0 ? 'up' : 'neutral';
  return 'neutral';
}

function toneClass(tone: 'up' | 'down' | 'neutral'): string {
  return tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : 'text-slate-100';
}

function MetricCard({ meta, value }: { meta: MetricMeta; value: unknown }) {
  const n = value === null || value === undefined ? null : Number(value);
  const isNull = n === null || !Number.isFinite(n);
  const tone = isNull ? 'neutral' : toneOf(meta, n as number);
  return (
    <div
      className="rounded-lg border border-line bg-surface px-3 py-2.5"
      title={isNull ? nullReason(meta.key) : `${meta.formula}\n${meta.note}`}
    >
      <div className="truncate text-xs text-slate-400">{meta.label}</div>
      <div className={`mt-1 text-lg font-medium ${toneClass(tone)}`}>
        {isNull ? <span className="text-slate-500">—</span> : fmtValue(meta, n)}
      </div>
      <div className="mt-0.5 truncate text-[11px] text-slate-600">
        {isNull ? nullReason(meta.key) : meta.formula}
      </div>
    </div>
  );
}

/** 月度盈亏条形：一眼看出收益是否集中在少数月份 */
function MonthBars({ months }: { months: { key: string; pnl: number; trades: number }[] }) {
  if (months.length === 0) return null;
  const max = Math.max(...months.map((m) => Math.abs(m.pnl)), 1);
  return (
    <div className="mt-3 space-y-1">
      {months.map((m) => {
        const w = (Math.abs(m.pnl) / max) * 100;
        return (
          <div key={m.key} className="flex items-center gap-2 text-xs">
            <span className="w-16 shrink-0 text-slate-500">{m.key}</span>
            <div className="relative h-3 flex-1 rounded bg-surface">
              <div
                className={`absolute top-0 h-3 rounded ${m.pnl >= 0 ? 'bg-up/60' : 'bg-down/60'}`}
                style={{ width: `${Math.max(w, 1.5)}%` }}
              />
            </div>
            <span className={`w-20 shrink-0 text-right ${m.pnl >= 0 ? 'text-up' : 'text-down'}`}>{fmtUsd(m.pnl)}</span>
            <span className="w-12 shrink-0 text-right text-slate-600">{m.trades} 笔</span>
          </div>
        );
      })}
    </div>
  );
}

export function AdvancedMetricsPanel() {
  const filter = useFilterStore((s) => s.filter);
  const [showMeta, setShowMeta] = useState(false);
  const { data, isLoading, error } = useQuery({
    queryKey: ['analytics-advanced', filter],
    queryFn: () => api<AdvancedResponse>(`/analytics/advanced${filterQuery(filter)}`),
  });

  if (isLoading) return <p className="text-sm text-slate-500">加载高级指标…</p>;
  if (error || !data) return <p className="text-sm text-down">高级指标加载失败：{(error as Error)?.message}</p>;

  const m = data.metrics;
  const meta = data.meta;
  const streak = m.currentStreak;

  return (
    <Section
      title="高级指标"
      actions={
        <button
          type="button"
          onClick={() => setShowMeta((v) => !v)}
          className="text-xs text-slate-400 hover:text-slate-200"
        >
          {showMeta ? '收起口径说明' : '查看口径说明'}
        </button>
      }
    >
      <div className="space-y-4">
        {/* 连胜连亏状态条：单独一行，因为它描述「现在」而不是历史极值 */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 rounded-lg border border-line bg-surface px-3 py-2 text-xs">
          <span className="text-slate-400">
            当前连续：
            {streak.type === 'NONE' ? (
              <span className="ml-1 text-slate-200">—</span>
            ) : (
              <span className={`ml-1 ${streak.type === 'WIN' ? 'text-up' : 'text-down'}`}>
                {streak.type === 'WIN' ? '盈利' : '亏损'} {streak.length} 笔
              </span>
            )}
          </span>
          <span className="text-slate-400">
            历史最长连胜 <span className="text-up">{m.maxConsecutiveWins}</span> 笔
          </span>
          <span className="text-slate-400">
            历史最长连亏 <span className="text-down">{m.maxConsecutiveLosses}</span> 笔
            {m.maxConsecutiveLosses > 0 ? (
              <span className="ml-1 text-slate-500">（合计 {fmtUsd(m.maxConsecutiveLossAmount)}）</span>
            ) : null}
          </span>
          <span className="text-slate-400">
            跨度 <span className="text-slate-200">{m.years ? `${m.years.toFixed(2)} 年` : '—'}</span>
          </span>
          <span className="text-slate-400">
            有交易 <span className="text-slate-200">{m.activeDays}</span> 天
            {m.tradesPerDay ? <span className="ml-1 text-slate-500">（日均 {m.tradesPerDay.toFixed(1)} 笔）</span> : null}
          </span>
        </div>

        {GROUP_ORDER.map((g) => {
          const items = meta.filter((x) => x.group === g);
          if (items.length === 0) return null;
          return (
            <div key={g}>
              <div className="mb-1.5 flex items-baseline gap-2">
                <h4 className="text-xs font-medium text-slate-300">{g}</h4>
                <span className="text-[11px] text-slate-600">{GROUP_HINT[g]}</span>
              </div>
              <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-4">
                {items.map((metaItem) => (
                  <MetricCard
                    key={metaItem.key}
                    meta={metaItem}
                    value={(m as unknown as Record<string, unknown>)[metaItem.key]}
                  />
                ))}
              </div>
              {g === '稳定性' && m.months.length > 0 ? (
                <>
                  <div className="mt-3 flex flex-wrap gap-x-5 text-xs text-slate-400">
                    <span>
                      最好月 <span className="text-up">{m.bestMonth?.key ?? '—'} {fmtUsd(m.bestMonth?.pnl ?? null)}</span>
                    </span>
                    <span>
                      最差月 <span className="text-down">{m.worstMonth?.key ?? '—'} {fmtUsd(m.worstMonth?.pnl ?? null)}</span>
                    </span>
                    <span>
                      共 <span className="text-slate-200">{m.months.length}</span> 个月
                    </span>
                  </div>
                  <MonthBars months={m.months} />
                </>
              ) : null}
            </div>
          );
        })}

        {m.costRatio !== null && m.costRatio > 0.3 ? (
          <p className="rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-xs text-slate-300">
            成本占毛利 <span className="text-down">{fmtPct(m.costRatio, 0)}</span>，累计付出 {fmtUsd(m.totalCost)}。
            在这个量级下，单纯「提高胜率」收益有限，优先降低交易频率或换更低成本的成交方式。
          </p>
        ) : null}

        {showMeta ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-xs">
              <thead>
                <tr className="text-left text-slate-500">
                  {['指标', '分组', '计算口径', '怎么读'].map((h) => (
                    <th key={h} className="pb-1.5 font-normal">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {meta.map((x) => (
                  <tr key={x.key} className="border-t border-line/60 align-top">
                    <td className="py-1.5 pr-3 text-slate-200">{x.label}</td>
                    <td className="py-1.5 pr-3 text-slate-500">{x.group}</td>
                    <td className="py-1.5 pr-3 text-slate-400">{x.formula}</td>
                    <td className="py-1.5 text-slate-400">{x.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-[11px] text-slate-600">
              通用口径：日收益序列覆盖首末平仓之间的每一个日历日（无交易日记 0，crypto 7×24）；年化因子 365；无风险利率取 0；Calmar/恢复因子为金额口径，不依赖初始资金。样本不足时返回「—」，不用 0 充数。
            </p>
          </div>
        ) : null}
      </div>
    </Section>
  );
}
