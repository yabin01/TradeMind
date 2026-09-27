'use client';

import { fmtUsd, fmtPct, pnlClass } from '../lib/format';

export function KpiCard(props: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'up' | 'down' | 'neutral';
}) {
  const tone =
    props.tone === 'up' ? 'text-up' : props.tone === 'down' ? 'text-down' : 'text-slate-100';
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3">
      <div className="text-xs text-slate-400">{props.label}</div>
      <div className={`mt-1 text-xl font-medium ${tone}`}>{props.value}</div>
      {props.sub ? <div className="mt-0.5 text-xs text-slate-500">{props.sub}</div> : null}
    </div>
  );
}

export function PnlText({ value, digits = 2 }: { value: number; digits?: number }) {
  return <span className={pnlClass(value)}>{fmtUsd(value, digits)}</span>;
}

export function WinRate({ value }: { value: number }) {
  return (
    <span>
      {value === 0 ? '—' : fmtPct(value)}
    </span>
  );
}

export function Section({ title, children, actions }: { title: string; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-panel">
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <h3 className="text-sm font-medium text-slate-200">{title}</h3>
        {actions}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

export function StatsTable({
  columns,
  rows,
}: {
  columns: { key: string; label: string; render?: (row: Record<string, unknown>) => React.ReactNode }[];
  rows: Record<string, unknown>[];
}) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-xs text-slate-500">
          {columns.map((c) => (
            <th key={c.key} className="pb-2 font-normal">
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i} className="border-t border-line/60">
            {columns.map((c) => (
              <td key={c.key} className="py-1.5">
                {c.render ? c.render(row) : String(row[c.key] ?? '—')}
              </td>
            ))}
          </tr>
        ))}
        {rows.length === 0 ? (
          <tr>
            <td colSpan={columns.length} className="py-6 text-center text-slate-500">
              暂无数据
            </td>
          </tr>
        ) : null}
      </tbody>
    </table>
  );
}

export { fmtUsd, fmtPct, pnlClass };
