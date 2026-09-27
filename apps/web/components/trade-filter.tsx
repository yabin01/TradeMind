'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useFilterStore } from '../lib/store';
import { getFacets } from '../lib/api';
import { MultiSelect } from './multi-select';
import { TagChipsInput } from './tag-chips-input';
import { ENTRY_REASON_PRESETS, EXIT_REASON_PRESETS } from '../lib/reason-presets';
import type { FilterSet } from '@trademind/trading-core';

const WEEKDAYS = [
  { v: 0, label: '日' },
  { v: 1, label: '一' },
  { v: 2, label: '二' },
  { v: 3, label: '三' },
  { v: 4, label: '四' },
  { v: 5, label: '五' },
  { v: 6, label: '六' },
];

function Segmented<T extends string | null>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex overflow-hidden rounded-md border border-line">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          onClick={() => onChange(o.value)}
          className={`px-2.5 py-1.5 text-xs ${
            value === o.value ? 'bg-emerald-500/20 text-emerald-200' : 'bg-surface text-slate-400 hover:text-slate-200'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function NumField({
  value,
  onChange,
  placeholder,
}: {
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  placeholder: string;
}) {
  return (
    <input
      type="number"
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
      placeholder={placeholder}
      className="w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs text-slate-200 outline-none focus:border-slate-500"
    />
  );
}

export function TradeFilter() {
  const filter = useFilterStore((s) => s.filter);
  const setFilter = useFilterStore((s) => s.setFilter);
  const applyPreset = useFilterStore((s) => s.applyPreset);
  const reset = useFilterStore((s) => s.reset);
  const [open, setOpen] = useState(true);

  const { data: facets } = useQuery({ queryKey: ['facets'], queryFn: getFacets, staleTime: 5 * 60 * 1000 });

  const symbolOpts = (facets?.symbols ?? []).map((s) => ({ value: s, label: s }));
  const exchangeOpts = (facets?.exchanges ?? []).map((s) => ({ value: s, label: s }));
  const strategyOpts = (facets?.strategies ?? []).map((s) => ({ value: s.id, label: s.name }));
  const tagOpts = (facets?.tags ?? []).map((s) => ({ value: s.id, label: s.name }));

  const sides = filter.sides?.[0] ?? null;
  const outcome = filter.outcome ?? null;

  return (
    <div className="rounded-xl border border-line bg-panel">
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="text-sm font-medium text-slate-200"
        >
          筛选 {open ? '▾' : '▸'}
        </button>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => applyPreset('90d')}
            className="rounded-md border border-line px-2.5 py-1 text-xs text-slate-400 hover:text-slate-200"
          >
            重置时间
          </button>
          <button
            type="button"
            onClick={reset}
            className="rounded-md border border-line px-2.5 py-1 text-xs text-slate-400 hover:text-slate-200"
          >
            清空全部
          </button>
        </div>
      </div>

      {open ? (
        <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {/* 时间预设 */}
          <div className="space-y-1.5">
            <div className="text-xs text-slate-500">时间范围</div>
            <div className="flex flex-wrap gap-1.5">
              {(['7d', '30d', '90d', 'all'] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => applyPreset(p)}
                  className="rounded-md border border-line bg-surface px-2.5 py-1 text-xs text-slate-300 hover:border-slate-500"
                >
                  {p === '7d' ? '7 天' : p === '30d' ? '30 天' : p === '90d' ? '90 天' : '全部'}
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                type="date"
                value={filter.from ?? ''}
                onChange={(e) => setFilter({ from: e.target.value || null })}
                className="w-full rounded-md border border-line bg-surface px-2 py-1.5 text-xs text-slate-200 outline-none"
              />
              <input
                type="date"
                value={filter.to ?? ''}
                onChange={(e) => setFilter({ to: e.target.value || null })}
                className="w-full rounded-md border border-line bg-surface px-2 py-1.5 text-xs text-slate-200 outline-none"
              />
            </div>
          </div>

          {/* 方向 */}
          <div className="space-y-1.5">
            <div className="text-xs text-slate-500">方向</div>
            <Segmented
              value={sides}
              onChange={(v) => setFilter({ sides: v ? [v as 'LONG' | 'SHORT'] : undefined })}
              options={[
                { value: null, label: '全部' },
                { value: 'LONG', label: '做多' },
                { value: 'SHORT', label: '做空' },
              ]}
            />
            <div className="text-xs text-slate-500">结果</div>
            <Segmented
              value={outcome}
              onChange={(v) => setFilter({ outcome: v ?? undefined })}
              options={[
                { value: null, label: '全部' },
                { value: 'WIN', label: '盈利' },
                { value: 'LOSS', label: '亏损' },
                { value: 'FLAT', label: '打平' },
              ]}
            />
          </div>

          {/* 标的 / 交易所 */}
          <div className="space-y-1.5">
            <MultiSelect label="标的" options={symbolOpts} selected={filter.symbols ?? []} onChange={(v) => setFilter({ symbols: v })} />
            <MultiSelect label="交易所" options={exchangeOpts} selected={filter.exchanges ?? []} onChange={(v) => setFilter({ exchanges: v })} />
          </div>

          {/* 策略 / 标签 */}
          <div className="space-y-1.5">
            <MultiSelect label="策略" options={strategyOpts} selected={filter.strategyIds ?? []} onChange={(v) => setFilter({ strategyIds: v })} />
            <MultiSelect label="标签" options={tagOpts} selected={filter.tagIds ?? []} onChange={(v) => setFilter({ tagIds: v })} />
            <Segmented
              value={filter.tagMode ?? 'any'}
              onChange={(v) => setFilter({ tagMode: (v as 'any' | 'all') ?? 'any' })}
              options={[
                { value: 'any', label: '命中任一' },
                { value: 'all', label: '全部包含' },
              ]}
            />
          </div>

          {/* 入场 / 出场理由标签（带预设候选） */}
          <div className="space-y-1.5">
            <TagChipsInput
              label="入场理由标签"
              values={filter.entryTags ?? []}
              onChange={(v) => setFilter({ entryTags: v.length ? v : undefined })}
              suggestions={ENTRY_REASON_PRESETS}
            />
            <Segmented
              value={filter.entryTagMode ?? 'any'}
              onChange={(v) => setFilter({ entryTagMode: (v as 'any' | 'all') ?? 'any' })}
              options={[
                { value: 'any', label: '入场命中任一' },
                { value: 'all', label: '入场全部包含' },
              ]}
            />
            <TagChipsInput
              label="出场理由标签"
              values={filter.exitTags ?? []}
              onChange={(v) => setFilter({ exitTags: v.length ? v : undefined })}
              suggestions={EXIT_REASON_PRESETS}
            />
            <Segmented
              value={filter.exitTagMode ?? 'any'}
              onChange={(v) => setFilter({ exitTagMode: (v as 'any' | 'all') ?? 'any' })}
              options={[
                { value: 'any', label: '出场命中任一' },
                { value: 'all', label: '出场全部包含' },
              ]}
            />
          </div>

          {/* 数值区间 · 盈亏 / 杠杆 / 持仓 */}
          <div className="space-y-1.5">
            <div className="text-xs text-slate-500">净利润区间 (USD)</div>
            <div className="flex gap-2">
              <NumField value={filter.minPnl} onChange={(v) => setFilter({ minPnl: v })} placeholder="最小" />
              <NumField value={filter.maxPnl} onChange={(v) => setFilter({ maxPnl: v })} placeholder="最大" />
            </div>
            <div className="text-xs text-slate-500">杠杆区间</div>
            <div className="flex gap-2">
              <NumField value={filter.minLeverage} onChange={(v) => setFilter({ minLeverage: v })} placeholder="最小" />
              <NumField value={filter.maxLeverage} onChange={(v) => setFilter({ maxLeverage: v })} placeholder="最大" />
            </div>
            <div className="text-xs text-slate-500">持仓时长 (分钟)</div>
            <div className="flex gap-2">
              <NumField value={filter.minHoldMinutes} onChange={(v) => setFilter({ minHoldMinutes: v })} placeholder="最短" />
              <NumField value={filter.maxHoldMinutes} onChange={(v) => setFilter({ maxHoldMinutes: v })} placeholder="最长" />
            </div>
          </div>

          {/* 数值区间 · 成本与规模 */}
          <div className="space-y-1.5">
            <div className="text-xs text-slate-500">手续费区间 (USD)</div>
            <div className="flex gap-2">
              <NumField value={filter.minFee} onChange={(v) => setFilter({ minFee: v })} placeholder="最小" />
              <NumField value={filter.maxFee} onChange={(v) => setFilter({ maxFee: v })} placeholder="最大" />
            </div>
            <div className="text-xs text-slate-500">资金费区间 (USD)</div>
            <div className="flex gap-2">
              <NumField value={filter.minFunding} onChange={(v) => setFilter({ minFunding: v })} placeholder="最小" />
              <NumField value={filter.maxFunding} onChange={(v) => setFilter({ maxFunding: v })} placeholder="最大" />
            </div>
            <div className="text-xs text-slate-500">成交额区间 (USD，开仓价×数量)</div>
            <div className="flex gap-2">
              <NumField value={filter.minVolume} onChange={(v) => setFilter({ minVolume: v })} placeholder="最小" />
              <NumField value={filter.maxVolume} onChange={(v) => setFilter({ maxVolume: v })} placeholder="最大" />
            </div>
            <div className="text-xs text-slate-500">下单数量区间</div>
            <div className="flex gap-2">
              <NumField value={filter.minQuantity} onChange={(v) => setFilter({ minQuantity: v })} placeholder="最小" />
              <NumField value={filter.maxQuantity} onChange={(v) => setFilter({ maxQuantity: v })} placeholder="最大" />
            </div>
          </div>

          {/* 时间维度：时段 / 星期 / 小时 */}
          <div className="space-y-1.5">
            <MultiSelect
              label="交易时段（UTC）"
              options={[
                { value: 'ASIA', label: '亚洲 00–08' },
                { value: 'LONDON', label: '伦敦 08–16' },
                { value: 'NEW_YORK', label: '纽约 13–21' },
                { value: 'OTHER', label: '其他' },
              ]}
              selected={(filter.sessions ?? []) as string[]}
              onChange={(v) => setFilter({ sessions: v as FilterSet['sessions'] })}
            />
            <div className="text-xs text-slate-500">星期（按平仓日 UTC）</div>
            <div className="flex flex-wrap gap-1">
              {WEEKDAYS.map((w) => {
                const on = (filter.weekdays ?? []).includes(w.v);
                return (
                  <button
                    key={w.v}
                    type="button"
                    onClick={() =>
                      setFilter({
                        weekdays: on
                          ? (filter.weekdays ?? []).filter((x) => x !== w.v)
                          : [...(filter.weekdays ?? []), w.v],
                      })
                    }
                    className={`rounded-md border px-2 py-1 text-xs ${
                      on ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300' : 'border-line bg-surface text-slate-400'
                    }`}
                  >
                    {w.label}
                  </button>
                );
              })}
            </div>
            <div className="text-xs text-slate-500">小时区间（UTC，0–23）</div>
            <div className="flex items-center gap-2">
              <select
                value={filter.hours?.[0] ?? ''}
                onChange={(e) => {
                  const lo = e.target.value === '' ? null : Number(e.target.value);
                  const hi = filter.hours && filter.hours.length > 1 ? filter.hours[filter.hours.length - 1] : 23;
                  setFilter({ hours: lo === null ? undefined : Array.from({ length: hi - lo + 1 }, (_, i) => lo + i) });
                }}
                className="w-full rounded-md border border-line bg-surface px-2 py-1.5 text-xs text-slate-200 outline-none"
              >
                <option value="">不限</option>
                {Array.from({ length: 24 }, (_, i) => (
                  <option key={i} value={i}>{String(i).padStart(2, '0')}:00</option>
                ))}
              </select>
              <span className="text-xs text-slate-500">→</span>
              <select
                value={filter.hours && filter.hours.length > 0 ? filter.hours[filter.hours.length - 1] : ''}
                onChange={(e) => {
                  const hi = e.target.value === '' ? null : Number(e.target.value);
                  const lo = filter.hours?.[0] ?? 0;
                  setFilter({ hours: hi === null ? undefined : Array.from({ length: Math.max(0, hi - lo + 1) }, (_, i) => lo + i) });
                }}
                className="w-full rounded-md border border-line bg-surface px-2 py-1.5 text-xs text-slate-200 outline-none"
              >
                <option value="">不限</option>
                {Array.from({ length: 24 }, (_, i) => (
                  <option key={i} value={i}>{String(i).padStart(2, '0')}:59</option>
                ))}
              </select>
            </div>
          </div>

          {/* 归档开关 */}
          <div className="flex items-end">
            <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-300">
              <input
                type="checkbox"
                checked={!!filter.includeArchived}
                onChange={(e) => setFilter({ includeArchived: e.target.checked })}
                className="accent-emerald-500"
              />
              包含已归档交易
            </label>
          </div>
        </div>
      ) : null}
    </div>
  );
}
