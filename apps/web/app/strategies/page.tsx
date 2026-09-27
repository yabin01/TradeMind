'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { fmtPct, fmtUsd, pnlClass } from '../../lib/format';
import { Section } from '../../components/ui';
import type { DimensionStats } from '@trademind/analytics';

interface StrategyRow {
  id: string;
  name: string;
  description: string | null;
  stats: DimensionStats | null;
}

export default function StrategiesPage() {
  const { data } = useQuery({ queryKey: ['strategies'], queryFn: () => api<StrategyRow[]>('/strategies') });

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-medium">策略</h2>
      <div className="grid gap-3 xl:grid-cols-2">
        {(data ?? []).map((s) => (
          <Section key={s.id} title={s.name}>
            {s.description ? <p className="mb-3 text-xs text-slate-500">{s.description}</p> : null}
            {s.stats ? (
              <div className="grid grid-cols-4 gap-y-2 text-sm">
                <Stat label="笔数" value={String(s.stats.trades)} />
                <Stat label="胜率" value={fmtPct(s.stats.winRate)} />
                <Stat label="PNL" value={fmtUsd(s.stats.pnl)} tone={pnlClass(s.stats.pnl)} />
                <Stat label="最大回撤" value={fmtUsd(s.stats.maxDrawdown)} tone="text-down" />
                <Stat label="PF" value={s.stats.profitFactor === null ? '∞' : s.stats.profitFactor.toFixed(2)} />
                <Stat label="EV" value={fmtUsd(s.stats.expectancy)} tone={pnlClass(s.stats.expectancy)} />
                <Stat label="平均风险回报" value={s.stats.avgRr ? s.stats.avgRr.toFixed(2) : '—'} />
                <Stat label="平均时长" value={s.stats.avgDurationMinutes ? `${Math.round(s.stats.avgDurationMinutes)}m` : '—'} />
              </div>
            ) : (
              <p className="text-sm text-slate-500">该策略暂无已平仓交易</p>
            )}
          </Section>
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div className="text-xs text-slate-500">{label}</div>
      <div className={tone ?? 'text-slate-200'}>{value}</div>
    </div>
  );
}
