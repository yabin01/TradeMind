'use client';

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { fmtUsd, pnlClass } from '../lib/format';
import { useAppearance } from '../lib/use-appearance';

const axisStyle = { fontSize: 11, fill: '#64748b' };

type TooltipEntry = {
  name?: string | number;
  value?: number | string;
  dataKey?: string | number;
};

/**
 * 统一的图表 tooltip。用主题 token（bg-surface / border-line / text-slate-*）
 * 而不是写死的深色底，这样亮色主题下不会出现「黑底黑字」。
 *
 * pnlTone=true 时按数值正负着色（盈亏类图表），否则用中性文字色（权益类图表）。
 */
export function ChartTooltip({
  active,
  payload,
  label,
  pnlTone = false,
}: {
  active?: boolean;
  payload?: TooltipEntry[];
  label?: string | number;
  pnlTone?: boolean;
}) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-lg">
      {label !== undefined && label !== '' ? (
        <div className="mb-1 text-[11px] text-slate-500">{label}</div>
      ) : null}
      <div className="space-y-0.5">
        {payload.map((p, i) => {
          const v = Number(p.value);
          const dot = pnlTone
            ? v > 0
              ? 'bg-up'
              : v < 0
                ? 'bg-down'
                : 'bg-slate-500'
            : 'bg-slate-500';
          return (
            <div key={String(p.dataKey ?? i)} className="flex items-center gap-3 whitespace-nowrap">
              <span className="flex items-center gap-1.5 text-slate-400">
                <span className={`inline-block h-1.5 w-1.5 rounded-full ${dot}`} />
                {p.name}
              </span>
              <span
                className={`ml-auto font-medium tabular-nums ${pnlTone ? pnlClass(v) : 'text-slate-200'}`}
              >
                {fmtUsd(v)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function EquityChart({
  data,
}: {
  data: { t: string; equity: number; hwm: number }[];
}) {
  const [appearance] = useAppearance();
  const points = data.map((d) => ({
    t: d.t.slice(5, 10),
    equity: Math.round(d.equity * 100) / 100,
    hwm: Math.round(d.hwm * 100) / 100,
  }));
  // 权益曲线按「收尾相对起点」的涨跌着色，跟随「设置 → 外观」里的盈亏配色
  const rising = points.length > 1 ? points[points.length - 1].equity >= points[0].equity : true;
  const lineColor = rising ? appearance.pnlUp : appearance.pnlDown;
  const cursorFill =
    appearance.theme === 'dark' ? 'rgba(148,163,184,0.10)' : 'rgba(100,116,139,0.10)';
  return (
    <ResponsiveContainer width="100%" height={260}>
      <AreaChart data={points} margin={{ top: 5, right: 10, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id="eqFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={lineColor} stopOpacity={0.25} />
            <stop offset="100%" stopColor={lineColor} stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis dataKey="t" tick={axisStyle} tickLine={false} axisLine={false} minTickGap={40} />
        <YAxis tick={axisStyle} tickLine={false} axisLine={false} width={70} domain={['auto', 'auto']} />
        <Tooltip content={<ChartTooltip />} cursor={{ fill: cursorFill }} />
        <Area
          type="monotone"
          dataKey="equity"
          name="权益"
          stroke={lineColor}
          strokeWidth={1.5}
          fill="url(#eqFill)"
        />
        <Area
          type="monotone"
          dataKey="hwm"
          name="高水位"
          stroke="#475569"
          strokeDasharray="4 4"
          strokeWidth={1}
          fill="none"
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function DailyPnlChart({ data }: { data: { date: string; pnl: number }[] }) {
  const [appearance] = useAppearance();
  const points = data.map((d) => ({ day: d.date.slice(5), pnl: Math.round(d.pnl * 100) / 100 }));
  const cursorFill =
    appearance.theme === 'dark' ? 'rgba(148,163,184,0.10)' : 'rgba(100,116,139,0.10)';
  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={points} margin={{ top: 5, right: 10, bottom: 0, left: 0 }}>
        <XAxis dataKey="day" tick={axisStyle} tickLine={false} axisLine={false} minTickGap={30} />
        <YAxis tick={axisStyle} tickLine={false} axisLine={false} width={70} />
        <Tooltip content={<ChartTooltip pnlTone />} cursor={{ fill: cursorFill }} />
        <Bar dataKey="pnl" name="当日盈亏" radius={[2, 2, 0, 0]}>
          {points.map((p, i) => (
            <Cell key={i} fill={p.pnl >= 0 ? appearance.pnlUp : appearance.pnlDown} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
