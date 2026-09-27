'use client';

/** 教练回答里内嵌的迷你条形图（同一条结论既给数也给形） */
export function MiniBars({
  data,
  unit,
}: {
  data: { label: string; value: number }[];
  unit: string;
}) {
  if (data.length === 0) return null;
  const max = Math.max(...data.map((d) => Math.abs(d.value)), 1);
  // 计数类（违规次数等）全部非负，用中性色；盈亏类按 up/down（用户自定义涨跌配色）
  const allPositive = data.every((d) => d.value >= 0);

  return (
    <div className="space-y-1">
      {data.map((d) => {
        const w = Math.max((Math.abs(d.value) / max) * 100, 1.5);
        const bar = allPositive ? 'bg-sky-500' : d.value >= 0 ? 'bg-up' : 'bg-down';
        const text = allPositive ? 'text-slate-300' : d.value >= 0 ? 'text-up' : 'text-down';
        return (
          <div key={`${d.label}-${d.value}`} className="flex items-center gap-2 text-[11px]">
            <div className="w-24 shrink-0 truncate text-slate-400" title={d.label}>
              {d.label}
            </div>
            <div className="relative h-3 flex-1 overflow-hidden rounded bg-surface">
              <div className={`absolute top-0 h-full rounded ${bar}`} style={{ width: `${w}%` }} />
            </div>
            <div className={`w-20 shrink-0 text-right ${text}`}>
              {d.value >= 0 ? '+' : ''}
              {d.value.toFixed(2)}
              {unit === '次' || unit === '笔' ? '' : ''}
            </div>
          </div>
        );
      })}
    </div>
  );
}
