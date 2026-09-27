'use client';

import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { api, filterQuery } from '../../lib/api';
import { useFilterStore } from '../../lib/store';
import { fmtTs, fmtUsd } from '../../lib/format';
import type { DayStats } from '@trademind/analytics';
import type { UnifiedTrade } from '@trademind/trading-core';

type ColorBy = 'pnl' | 'trades';

const WD = ['日', '一', '二', '三', '四', '五', '六'];

export default function CalendarPage() {
  const filter = useFilterStore((s) => s.filter);
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [selected, setSelected] = useState<string | null>(null);
  const [colorBy, setColorBy] = useState<ColorBy>('pnl');

  const { data } = useQuery({
    queryKey: ['calendar', filter],
    queryFn: () => api<{ days: DayStats[] }>(`/calendar${filterQuery(filter)}`),
  });
  const dayMap = useMemo(() => new Map((data?.days ?? []).map((d) => [d.date, d])), [data]);

  const { data: dayTrades } = useQuery({
    queryKey: ['calendar-day', selected],
    queryFn: () =>
      api<{ items: UnifiedTrade[] }>(`/trades${filterQuery({ from: selected, to: selected })}`),
    enabled: selected !== null,
  });

  const year = Number(month.slice(0, 4));
  const mon = Number(month.slice(5, 7));
  const firstDow = new Date(Date.UTC(year, mon - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  const cells: (string | null)[] = [
    ...Array.from({ length: firstDow }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`),
  ];

  // 当月统计
  const monthDays = useMemo(
    () => (data?.days ?? []).filter((d) => d.date.startsWith(month)),
    [data, month],
  );
  const summary = useMemo(() => {
    const pnl = monthDays.reduce((a, d) => a + d.pnl, 0);
    const trades = monthDays.reduce((a, d) => a + d.trades, 0);
    const winDays = monthDays.filter((d) => d.pnl > 0).length;
    const loseDays = monthDays.filter((d) => d.pnl < 0).length;
    const best = monthDays.reduce<DayStats | null>((a, d) => (!a || d.pnl > a.pnl ? d : a), null);
    const worst = monthDays.reduce<DayStats | null>((a, d) => (!a || d.pnl < a.pnl ? d : a), null);
    return {
      pnl,
      trades,
      activeDays: monthDays.length,
      winDays,
      loseDays,
      avgTrades: monthDays.length > 0 ? trades / monthDays.length : 0,
      best,
      worst,
    };
  }, [monthDays]);

  const maxAbs = Math.max(1, ...monthDays.map((d) => Math.abs(d.pnl)));
  const maxTrades = Math.max(1, ...monthDays.map((d) => d.trades));

  function cellStyle(d: DayStats | undefined): React.CSSProperties {
    if (!d) return {};
    if (colorBy === 'trades') {
      const i = 0.12 + 0.6 * Math.min(1, d.trades / maxTrades);
      return { background: `rgb(var(--pnl-up) / ${i.toFixed(3)})` };
    }
    const i = 0.15 + 0.6 * Math.min(1, Math.abs(d.pnl) / maxAbs);
    return { background: `rgb(var(${d.pnl >= 0 ? '--pnl-up' : '--pnl-down'}) / ${i.toFixed(3)})` };
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-medium">交易日历热力图</h2>
        <div className="flex items-center gap-2">
          <div className="flex overflow-hidden rounded-md border border-line">
            {([
              { v: 'pnl' as ColorBy, label: '按盈亏着色' },
              { v: 'trades' as ColorBy, label: '按笔数着色' },
            ]).map((o) => (
              <button
                key={o.v}
                type="button"
                onClick={() => setColorBy(o.v)}
                className={`px-2.5 py-1 text-xs ${
                  colorBy === o.v ? 'bg-emerald-500/20 text-emerald-300' : 'bg-surface text-slate-400 hover:text-slate-200'
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setMonth(new Date().toISOString().slice(0, 7))}
            className="rounded border border-line px-2 py-1 text-xs text-slate-400 hover:text-slate-200"
          >
            本月
          </button>
          <button className="rounded border border-line px-2 py-1 text-xs" onClick={() => shiftMonth(-1)}>←</button>
          <span className="text-sm">{month}</span>
          <button className="rounded border border-line px-2 py-1 text-xs" onClick={() => shiftMonth(1)}>→</button>
        </div>
      </div>

      {/* 月度汇总 */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="本月净盈亏" value={fmtUsd(summary.pnl)} tone={summary.pnl > 0 ? 'up' : summary.pnl < 0 ? 'down' : 'flat'} />
        <Stat label="交易天数" value={`${summary.activeDays} 天`} sub={`共 ${summary.trades} 笔`} />
        <Stat label="盈利 / 亏损天" value={`${summary.winDays} / ${summary.loseDays}`} sub={`日均 ${summary.avgTrades.toFixed(1)} 笔`} />
        <Stat
          label="最佳日"
          value={summary.best ? fmtUsd(summary.best.pnl) : '—'}
          sub={summary.best ? summary.best.date.slice(5) : ''}
          tone={summary.best && summary.best.pnl >= 0 ? 'up' : 'down'}
        />
        <Stat
          label="最差日"
          value={summary.worst ? fmtUsd(summary.worst.pnl) : '—'}
          sub={summary.worst ? summary.worst.date.slice(5) : ''}
          tone={summary.worst && summary.worst.pnl >= 0 ? 'up' : 'down'}
        />
        <Stat
          label="胜率（按天）"
          value={summary.activeDays > 0 ? `${((summary.winDays / summary.activeDays) * 100).toFixed(0)}%` : '—'}
          sub="盈利天 / 有交易天"
        />
      </div>

      <div className="rounded-xl border border-line bg-panel p-4">
        <div className="grid grid-cols-7 gap-1 text-center text-xs text-slate-500">
          {WD.map((d) => (
            <div key={d} className="py-1">{d}</div>
          ))}
          {cells.map((date, i) => {
            if (!date) return <div key={`e${i}`} />;
            const d = dayMap.get(date);
            return (
              <button
                key={date}
                onClick={() => setSelected(date)}
                style={cellStyle(d)}
                className={`min-h-[4.5rem] rounded-md border p-1 text-left transition-colors ${
                  selected === date ? 'border-slate-400' : 'border-line'
                } hover:border-slate-500`}
              >
                <div className="text-xs text-slate-400">{Number(date.slice(8))}</div>
                {d ? (
                  <>
                    <div className={`text-xs font-medium ${d.pnl >= 0 ? 'text-up' : 'text-down'}`}>{fmtUsd(d.pnl, 0)}</div>
                    <div className="text-[11px] text-slate-500">{d.trades} 笔 · {(d.winRate * 100).toFixed(0)}%</div>
                  </>
                ) : (
                  <div className="text-[11px] text-slate-600">—</div>
                )}
              </button>
            );
          })}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3 text-[11px] text-slate-500">
          <span>图例</span>
          <div className="flex items-center gap-1">
            <span>弱</span>
            {[0.15, 0.35, 0.55, 0.75].map((i) => (
              <span key={i} style={{ background: `rgb(var(--pnl-up) / ${i})` }} className="inline-block h-3 w-4 rounded-sm" />
            ))}
            <span>强</span>
          </div>
          <div className="flex items-center gap-1">
            <span>弱</span>
            {[0.15, 0.35, 0.55, 0.75].map((i) => (
              <span key={i} style={{ background: `rgb(var(--pnl-down) / ${i})` }} className="inline-block h-3 w-4 rounded-sm" />
            ))}
            <span>强</span>
          </div>
          <span className="text-slate-600">
            {colorBy === 'pnl' ? '颜色深浅 = 当日净盈亏强度（盈亏配色可在「设置 → 外观」自定义）' : '颜色深浅 = 当日交易笔数（笔数越多越容易过度交易）'}
          </span>
        </div>
      </div>

      {selected ? (
        <div className="rounded-xl border border-line bg-panel p-4">
          <h3 className="mb-2 text-sm font-medium">{selected} 的交易</h3>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500">
                <th className="pb-1 font-normal">标的</th>
                <th className="pb-1 font-normal">方向</th>
                <th className="pb-1 font-normal">开仓时间</th>
                <th className="pb-1 font-normal text-right">净利润</th>
              </tr>
            </thead>
            <tbody>
              {(dayTrades?.items ?? []).map((t) => (
                <tr key={t.id} className="border-t border-line/60">
                  <td className="py-1.5">
                    <Link href={`/trades/${t.id}`} className="hover:underline">{t.symbol}</Link>
                  </td>
                  <td className="text-slate-400">{t.positionSide === 'NET' ? (t.side === 'BUY' ? '做多' : '做空') : t.positionSide === 'SHORT' ? '做空' : '做多'}</td>
                  <td className="text-xs text-slate-500" title="北京时间">{fmtTs(t.openTime)}</td>
                  <td className={`text-right ${t.netPnl >= 0 ? 'text-up' : 'text-down'}`}>{fmtUsd(t.netPnl)}</td>
                </tr>
              ))}
              {(dayTrades?.items.length ?? 0) === 0 ? <tr><td className="py-3 text-slate-500" colSpan={4}>无交易</td></tr> : null}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );

  function shiftMonth(delta: number) {
    const d = new Date(Date.UTC(year, mon - 1 + delta, 1));
    setMonth(d.toISOString().slice(0, 7));
  }
}

function Stat({
  label,
  value,
  sub,
  tone = 'flat',
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'up' | 'down' | 'flat';
}) {
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2">
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className={`text-sm font-medium ${tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : 'text-slate-200'}`}>
        {value}
      </div>
      {sub ? <div className="text-[11px] text-slate-500">{sub}</div> : null}
    </div>
  );
}
