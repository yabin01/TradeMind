'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { api, filterQuery } from '../../lib/api';
import { useFilterStore } from '../../lib/store';
import { fmtPct, fmtTsDate, fmtUsd, pnlClass } from '../../lib/format';
import { DailyPnlChart, EquityChart } from '../../components/charts';
import { AdvancedMetricsPanel } from '../../components/advanced-metrics';
import { KpiCard, Section, StatsTable } from '../../components/ui';
import type { DimensionStats, CoreMetrics, DayStats } from '@trademind/analytics';
import type { UnifiedTrade } from '@trademind/trading-core';

interface DashboardResponse {
  kpis: CoreMetrics;
  equity: { curve: { t: string; equity: number; hwm: number }[]; maxDrawdown: number; maxDrawdownPct: number | null };
  daily: DayStats[];
  symbols: DimensionStats[];
  longShort: DimensionStats[];
  strategies: DimensionStats[];
  mistakes: DimensionStats[];
  recentTrades: UnifiedTrade[];
}

export default function DashboardPage() {
  const filter = useFilterStore((s) => s.filter);
  const { data, isLoading, error } = useQuery({
    queryKey: ['dashboard', filter],
    queryFn: () => api<DashboardResponse>(`/dashboard${filterQuery(filter)}`),
  });

  if (isLoading) return <p className="text-sm text-slate-500">加载中…</p>;
  if (error) return <p className="text-sm text-down">API 连接失败：{(error as Error).message}</p>;
  if (!data) return null;

  const k = data.kpis;
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-medium">总览</h2>

      <div className="grid grid-cols-3 gap-3 xl:grid-cols-6">
        <KpiCard label="净利润" value={fmtUsd(k.netPnl)} tone={k.netPnl >= 0 ? 'up' : 'down'} sub={`${k.closedTrades} 笔交易`} />
        <KpiCard label="胜率" value={fmtPct(k.winRate)} sub={`${k.winningTrades}W / ${k.losingTrades}L`} />
        <KpiCard label="盈亏比 PF" value={Number.isFinite(k.profitFactor) ? k.profitFactor.toFixed(2) : '∞'} />
        <KpiCard label="平均风险回报" value={k.avgRr ? k.avgRr.toFixed(2) : '—'} />
        <KpiCard label="期望值 EV" value={fmtUsd(k.expectancy)} tone={k.expectancy >= 0 ? 'up' : 'down'} />
        <KpiCard
          label="最大回撤"
          value={fmtUsd(data.equity.maxDrawdown)}
          tone="down"
          sub={data.equity.maxDrawdownPct ? fmtPct(data.equity.maxDrawdownPct) : undefined}
        />
      </div>
      <div className="grid grid-cols-3 gap-3 xl:grid-cols-4">
        <KpiCard label="手续费" value={fmtUsd(k.fees)} />
        <KpiCard label="资金费" value={fmtUsd(k.funding)} />
        <KpiCard label="毛利 / 毛损" value={`${fmtUsd(k.grossProfit)} / ${fmtUsd(-k.grossLoss)}`} />
        <KpiCard label="平均持仓时长" value={k.avgDurationMinutes ? `${Math.round(k.avgDurationMinutes)}m` : '—'} />
      </div>

      <Section title="资金曲线">
        <EquityChart data={data.equity.curve} />
      </Section>

      <Section title="每日盈亏">
        <DailyPnlChart data={data.daily} />
      </Section>

      <AdvancedMetricsPanel />

      <div className="grid gap-4 xl:grid-cols-2">
        <Section title="标的表现">
          <StatsTable
            columns={[
              { key: 'label', label: '标的' },
              { key: 'trades', label: '笔数' },
              { key: 'winRate', label: '胜率', render: (r) => fmtPct(r.winRate as number) },
              { key: 'pnl', label: 'PNL', render: (r) => <span className={pnlClass(r.pnl as number)}>{fmtUsd(r.pnl as number)}</span> },
              { key: 'profitFactor', label: 'PF', render: (r) => (r.profitFactor === null ? '∞' : (r.profitFactor as number).toFixed(2)) },
              { key: 'longPnl', label: '做多', render: (r) => fmtUsd(r.longPnl as number) },
              { key: 'shortPnl', label: '做空', render: (r) => fmtUsd(r.shortPnl as number) },
            ]}
            rows={data.symbols as unknown as Record<string, unknown>[]}
          />
        </Section>

        <Section title="多空对比">
          <StatsTable
            columns={[
              { key: 'label', label: '方向', render: (r) => (String(r.label) === 'LONG' ? '做多' : String(r.label) === 'SHORT' ? '做空' : String(r.label)) },
              { key: 'trades', label: '笔数' },
              { key: 'winRate', label: '胜率', render: (r) => fmtPct(r.winRate as number) },
              { key: 'pnl', label: 'PNL', render: (r) => <span className={pnlClass(r.pnl as number)}>{fmtUsd(r.pnl as number)}</span> },
              { key: 'expectancy', label: 'EV', render: (r) => fmtUsd(r.expectancy as number) },
              { key: 'profitFactor', label: 'PF', render: (r) => (r.profitFactor === null ? '∞' : (r.profitFactor as number).toFixed(2)) },
            ]}
            rows={data.longShort as unknown as Record<string, unknown>[]}
          />
        </Section>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Section title="策略分析">
          <StatsTable
            columns={[
              { key: 'label', label: '策略' },
              { key: 'trades', label: '笔数' },
              { key: 'winRate', label: '胜率', render: (r) => fmtPct(r.winRate as number) },
              { key: 'pnl', label: 'PNL', render: (r) => <span className={pnlClass(r.pnl as number)}>{fmtUsd(r.pnl as number)}</span> },
              { key: 'maxDrawdown', label: 'MaxDD', render: (r) => fmtUsd(r.maxDrawdown as number) },
            ]}
            rows={data.strategies as unknown as Record<string, unknown>[]}
          />
        </Section>

        <Section title="错误标记影响">
          <StatsTable
            columns={[
              { key: 'label', label: '错误' },
              { key: 'trades', label: '笔数' },
              { key: 'winRate', label: '胜率', render: (r) => fmtPct(r.winRate as number) },
              { key: 'pnl', label: 'PNL', render: (r) => <span className={pnlClass(r.pnl as number)}>{fmtUsd(r.pnl as number)}</span> },
            ]}
            rows={data.mistakes as unknown as Record<string, unknown>[]}
          />
        </Section>
      </div>

      <Section
        title="最近交易"
        actions={
          <Link href="/trades" className="text-xs text-slate-400 hover:text-slate-200">
            View all →
          </Link>
        }
      >
        <StatsTable
          columns={[
            { key: 'symbol', label: '标的' },
            { key: 'dir', label: '方向', render: (r) => String(r.dir) },
            { key: 'closeTime', label: '平仓日期', render: (r) => fmtTsDate(String(r.closeTime)) },
            { key: 'netPnl', label: '净利润', render: (r) => <span className={pnlClass(r.netPnl as number)}>{fmtUsd(r.netPnl as number)}</span> },
          ]}
          rows={data.recentTrades.map((t) => ({
            id: t.id,
            symbol: t.symbol,
            dir: t.positionSide === 'NET' ? (t.side === 'BUY' ? '做多' : '做空') : t.positionSide === 'SHORT' ? '做空' : '做多',
            closeTime: t.closeTime ?? t.openTime,
            netPnl: t.netPnl,
          }))}
        />
      </Section>
    </div>
  );
}
