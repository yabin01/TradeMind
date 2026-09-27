'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, filterQuery } from '../../lib/api';
import { useFilterStore } from '../../lib/store';
import { fmtPct, fmtUsd, pnlClass } from '../../lib/format';
import { Section, StatsTable } from '../../components/ui';
import type { BucketStats, DimensionStats } from '@trademind/analytics';

interface BreakdownResponse {
  symbols?: DimensionStats[];
  longShort?: DimensionStats[];
  strategies?: DimensionStats[];
  tags?: DimensionStats[];
  mistakes?: DimensionStats[];
  hour?: BucketStats[];
  dayOfWeek?: BucketStats[];
  session?: BucketStats[];
  duration?: BucketStats[];
}

const TABS = ['标的', '多空对比', '时间', '标签', '错误'] as const;
type Tab = (typeof TABS)[number];

export default function AnalyticsPage() {
  const filter = useFilterStore((s) => s.filter);
  const [tab, setTab] = useState<Tab>('标的');
  const { data } = useQuery({
    queryKey: ['analytics', filter],
    queryFn: () => api<BreakdownResponse>(`/analytics${filterQuery(filter)}`),
  });

  const dimCols = [
    { key: 'label', label: '方向', render: (r: Record<string, unknown>) => (String(r.label) === 'LONG' ? '做多' : String(r.label) === 'SHORT' ? '做空' : String(r.label)) },
    { key: 'trades', label: 'Trades' },
    { key: 'winRate', label: 'Win%', render: (r: Record<string, unknown>) => fmtPct(r.winRate as number) },
    { key: 'pnl', label: 'PNL', render: (r: Record<string, unknown>) => <span className={pnlClass(r.pnl as number)}>{fmtUsd(r.pnl as number)}</span> },
    { key: 'profitFactor', label: 'PF', render: (r: Record<string, unknown>) => (r.profitFactor === null ? '∞' : (r.profitFactor as number).toFixed(2)) },
    { key: 'expectancy', label: 'EV', render: (r: Record<string, unknown>) => fmtUsd(r.expectancy as number) },
    { key: 'avgRr', label: 'R:R', render: (r: Record<string, unknown>) => (r.avgRr ? (r.avgRr as number).toFixed(2) : '—') },
    { key: 'maxDrawdown', label: '最大回撤', render: (r: Record<string, unknown>) => fmtUsd(r.maxDrawdown as number) },
    { key: 'avgDurationMinutes', label: '平均时长', render: (r: Record<string, unknown>) => (r.avgDurationMinutes ? `${Math.round(r.avgDurationMinutes as number)}m` : '—') },
  ];

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-medium">分析</h2>
      <div className="flex gap-1">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-md px-3 py-1.5 text-sm ${tab === t ? 'bg-surface text-slate-100' : 'text-slate-400 hover:bg-surface/60'}`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === '标的' ? (
        <Section title="标的表现">
          <StatsTable columns={dimCols} rows={(data?.symbols ?? []) as unknown as Record<string, unknown>[]} />
        </Section>
      ) : null}
      {tab === '多空对比' ? (
        <Section title="多空对比">
          <StatsTable columns={dimCols} rows={(data?.longShort ?? []) as unknown as Record<string, unknown>[]} />
        </Section>
      ) : null}
      {tab === '时间' ? (
        <div className="grid gap-4 xl:grid-cols-2">
          <Section title="按小时"><StatsTable columns={bucketCols} rows={(data?.hour ?? []) as unknown as Record<string, unknown>[]} /></Section>
          <Section title="交易时段"><StatsTable columns={bucketCols} rows={(data?.session ?? []) as unknown as Record<string, unknown>[]} /></Section>
          <Section title="按星期"><StatsTable columns={bucketCols} rows={(data?.dayOfWeek ?? []) as unknown as Record<string, unknown>[]} /></Section>
          <Section title="持仓时长"><StatsTable columns={bucketCols} rows={(data?.duration ?? []) as unknown as Record<string, unknown>[]} /></Section>
        </div>
      ) : null}
      {tab === '标签' ? (
        <Section title="标签分析"><StatsTable columns={dimCols} rows={(data?.tags ?? []) as unknown as Record<string, unknown>[]} /></Section>
      ) : null}
      {tab === '错误' ? (
        <Section title="错误标记影响"><StatsTable columns={dimCols} rows={(data?.mistakes ?? []) as unknown as Record<string, unknown>[]} /></Section>
      ) : null}
    </div>
  );
}

const BUCKET_LABEL: Record<string, string> = {
  ASIA: '亚洲时段', LONDON: '伦敦时段', NEW_YORK: '纽约时段', OTHER: '其他',
  MON: '周一', TUE: '周二', WED: '周三', THU: '周四', FRI: '周五', SAT: '周六', SUN: '周日',
};

const bucketCols = [
  { key: 'label', label: '区间', render: (r: Record<string, unknown>) => BUCKET_LABEL[String(r.label)] ?? String(r.label) },
  { key: 'trades', label: 'Trades' },
  { key: 'winRate', label: 'Win%', render: (r: Record<string, unknown>) => fmtPct(r.winRate as number) },
  { key: 'pnl', label: 'PNL', render: (r: Record<string, unknown>) => <span className={pnlClass(r.pnl as number)}>{fmtUsd(r.pnl as number)}</span> },
];
