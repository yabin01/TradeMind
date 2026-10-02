'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { api, filterQuery, getTrades, getFacets, batchUpdateTrades, batchDeleteTrades } from '../../lib/api';
import { useFilterStore } from '../../lib/store';
import { fmtDuration, fmtPct, fmtTs, fmtUsd, fmtUsdCompact, pnlClass } from '../../lib/format';
import { Section } from '../../components/ui';
import { TradeFilter } from '../../components/trade-filter';
import { MultiSelect } from '../../components/multi-select';
import { ENTRY_REASON_PRESETS, EXIT_REASON_PRESETS } from '../../lib/reason-presets';
import type { UnifiedTrade } from '@trademind/trading-core';

/** 名义价值 = 开仓价 × 数量 */
function notional(t: UnifiedTrade): number {
  return t.entryPrice * t.quantity;
}
function holdingMinutes(t: UnifiedTrade): number | null {
  if (!t.closeTime) return null;
  return (new Date(t.closeTime).getTime() - new Date(t.openTime).getTime()) / 60000;
}
function cost(t: UnifiedTrade): number {
  return Math.abs(t.fees) + Math.abs(t.funding);
}
function dirLabel(t: UnifiedTrade): string {
  return t.positionSide === 'NET' ? (t.side === 'BUY' ? '做多' : '做空') : t.positionSide === 'SHORT' ? '做空' : '做多';
}
function dirClass(t: UnifiedTrade): string {
  return t.positionSide === 'SHORT' || (t.positionSide === 'NET' && t.side === 'SELL') ? 'text-down' : 'text-up';
}
function maeMfe(t: UnifiedTrade): { mae: number; mfe: number } | null {
  if (!t.closeTime || t.exitPrice === null) return null;
  const ex = (t.metadata ?? {}).extremes as { high?: unknown; low?: unknown } | undefined;
  if (!ex || !Number.isFinite(Number(ex.high)) || !Number.isFinite(Number(ex.low))) return null;
  const high = Number(ex.high);
  const low = Number(ex.low);
  const dir = t.positionSide === 'NET' ? (t.side === 'BUY' ? 'LONG' : 'SHORT') : t.positionSide === 'SHORT' ? 'SHORT' : 'LONG';
  const sign = dir === 'LONG' ? 1 : -1;
  const adversePrice = dir === 'LONG' ? low : high;
  const favorablePrice = dir === 'LONG' ? high : low;
  return {
    mae: (adversePrice - t.entryPrice) * t.quantity * sign,
    mfe: (favorablePrice - t.entryPrice) * t.quantity * sign,
  };
}

interface ColDef {
  id: string;
  label: string;
  defaultVisible: boolean;
  numeric?: boolean;
  cell: (t: UnifiedTrade) => React.ReactNode;
  footer?: (a: { totalNotional: number; totalGross: number; totalCost: number; totalNet: number }) => React.ReactNode;
}

const ALL_COLS: ColDef[] = [
  { id: 'symbol', label: '标的', defaultVisible: true, cell: (t) => <Link href={`/trades/${t.id}`} className="hover:underline">{t.symbol}</Link> },
  { id: 'dir', label: '方向', defaultVisible: true, cell: (t) => <span className={dirClass(t)}>{dirLabel(t)}</span> },
  { id: 'entry', label: '开仓价', defaultVisible: true, numeric: true, cell: (t) => t.entryPrice.toPrecision(6) },
  { id: 'exit', label: '平仓价', defaultVisible: true, numeric: true, cell: (t) => t.exitPrice?.toPrecision(6) ?? '—' },
  { id: 'qty', label: '数量', defaultVisible: true, numeric: true, cell: (t) => t.quantity },
  { id: 'notional', label: '名义价值', defaultVisible: true, numeric: true, cell: (t) => <span className="text-slate-400" title="开仓价 × 数量">{fmtUsdCompact(notional(t))}</span>, footer: (a) => <span>{fmtUsdCompact(a.totalNotional)}</span> },
  { id: 'lev', label: '杠杆', defaultVisible: true, cell: (t) => `${t.leverage}x` },
  { id: 'open', label: '开仓时间', defaultVisible: true, cell: (t) => <span className="text-slate-400" title="北京时间">{fmtTs(t.openTime)}</span> },
  { id: 'close', label: '平仓时间', defaultVisible: true, cell: (t) => <span className="text-slate-400" title="北京时间">{t.closeTime ? fmtTs(t.closeTime) : '持仓中'}</span> },
  { id: 'hold', label: '持仓', defaultVisible: true, cell: (t) => { const h = holdingMinutes(t); return <span className="text-slate-400">{h === null ? '持仓中' : fmtDuration(h)}</span>; } },
  { id: 'mfe', label: 'MFE', defaultVisible: true, numeric: true, cell: (t) => { const mm = maeMfe(t); return <span className={`${mm ? pnlClass(mm.mfe) : 'text-slate-600'}`} title={mm ? '最大有利偏移' : '暂无极值数据'}>{mm ? fmtUsd(mm.mfe) : '—'}</span>; } },
  { id: 'mae', label: 'MAE', defaultVisible: true, numeric: true, cell: (t) => { const mm = maeMfe(t); return <span className={`${mm ? pnlClass(mm.mae) : 'text-slate-600'}`} title={mm ? '最大不利偏移' : '暂无极值数据'}>{mm ? fmtUsd(mm.mae) : '—'}</span>; } },
  { id: 'gross', label: '毛利', defaultVisible: true, numeric: true, cell: (t) => <span className={pnlClass(t.grossPnl)}>{fmtUsd(t.grossPnl)}</span>, footer: (a) => <span className={pnlClass(a.totalGross)}>{fmtUsd(a.totalGross)}</span> },
  { id: 'cost', label: '成本', defaultVisible: true, numeric: true, cell: (t) => { const c = cost(t); const eats = t.grossPnl > 0 && c > t.grossPnl; return <span className={eats ? 'text-down' : 'text-slate-400'} title={t.grossPnl > 0 ? `成本占毛利 ${((c / t.grossPnl) * 100).toFixed(0)}%` : '手续费 + 资金费'}>{fmtUsd(-c)}</span>; }, footer: (a) => <span className="text-down">{fmtUsd(-a.totalCost)}</span> },
  { id: 'net', label: '净利润', defaultVisible: true, numeric: true, cell: (t) => <span className={pnlClass(t.netPnl)}>{fmtUsd(t.netPnl)}</span>, footer: (a) => <span className={pnlClass(a.totalNet)}>{fmtUsd(a.totalNet)}</span> },
  { id: 'tags', label: '标签', defaultVisible: false, cell: (t) => <span className="text-slate-400">{(t.tags ?? []).length}</span> },
  { id: 'entryTags', label: '入场理由', defaultVisible: false, cell: (t) => <span className="text-slate-400">{(t.entryTags ?? []).join('、') || '—'}</span> },
  { id: 'exitTags', label: '出场理由', defaultVisible: false, cell: (t) => <span className="text-slate-400">{(t.exitTags ?? []).join('、') || '—'}</span> },
  { id: 'archived', label: '归档', defaultVisible: false, cell: (t) => <span className={t.archived ? 'text-amber-400' : 'text-slate-600'}>{t.archived ? '已归档' : '—'}</span> },
];

const COL_STORAGE_KEY = 'trademind-columns-v1';

// ── 自定义标签列（#15）：把某个标签/理由做成独立的 ✔ 列，对齐 TMM 的 custom tag columns ──
type CustomColScope = 'any' | 'entryTags' | 'exitTags' | 'tags';
interface CustomCol {
  id: string;
  label: string;
  tagName: string;
  scope: CustomColScope;
}
const CUSTOM_COL_KEY = 'trademind-custom-cols-v1';
const SCOPE_LABEL: Record<CustomColScope, string> = {
  any: '任意（入场/出场/标签）',
  entryTags: '入场理由',
  exitTags: '出场理由',
  tags: '标签',
};

function loadCustomCols(): CustomCol[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(CUSTOM_COL_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as CustomCol[];
    return Array.isArray(arr) ? arr.filter((c) => c && typeof c.tagName === 'string') : [];
  } catch {
    return [];
  }
}

function matchesTag(t: UnifiedTrade, col: CustomCol, tagNameById: Map<string, string>): boolean {
  const q = col.tagName.trim();
  if (!q) return false;
  const entry = t.entryTags ?? [];
  const exit = t.exitTags ?? [];
  const names = (t.tags ?? []).map((id) => tagNameById.get(id) ?? id);
  const pool =
    col.scope === 'entryTags' ? entry : col.scope === 'exitTags' ? exit : col.scope === 'tags' ? names : [...entry, ...exit, ...names];
  return pool.some((n) => n === q || n.includes(q));
}

function customToCol(c: CustomCol, tagNameById: Map<string, string>): ColDef {
  return {
    id: `custom:${c.id}`,
    label: c.label || c.tagName,
    defaultVisible: true,
    cell: (t) =>
      matchesTag(t, c, tagNameById) ? (
        <span className="text-up" title={`命中：${c.tagName}（${SCOPE_LABEL[c.scope]}）`}>
          ✔
        </span>
      ) : (
        <span className="text-slate-600">·</span>
      ),
  };
}

function loadVisible(pool: ColDef[]): string[] {
  const fallback = () => pool.filter((c) => c.defaultVisible).map((c) => c.id);
  if (typeof window === 'undefined') return fallback();
  try {
    const raw = localStorage.getItem(COL_STORAGE_KEY);
    if (raw) {
      const ids = JSON.parse(raw) as string[];
      return pool.filter((c) => ids.includes(c.id)).map((c) => c.id);
    }
  } catch {
    /* ignore */
  }
  return fallback();
}

function escapeCsv(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportCsv(rows: UnifiedTrade[]) {
  const header = ['id', '标的', '方向', '开仓价', '平仓价', '数量', '杠杆', '开仓时间(UTC+8)', '平仓时间(UTC+8)', '持仓(分)', '毛利', '手续费', '资金费', '净利', '标签', '入场理由', '出场理由', '归档', '笔记'];
  const lines = rows.map((t) =>
    [
      t.id,
      t.symbol,
      dirLabel(t),
      t.entryPrice,
      t.exitPrice ?? '',
      t.quantity,
      t.leverage,
      fmtTs(t.openTime, true),
      t.closeTime ? fmtTs(t.closeTime, true) : '',
      holdingMinutes(t) ?? '',
      t.grossPnl,
      t.fees,
      t.funding,
      t.netPnl,
      (t.tags ?? []).join('|'),
      (t.entryTags ?? []).join('|'),
      (t.exitTags ?? []).join('|'),
      t.archived ? '是' : '否',
      t.notes ?? '',
    ]
      .map(escapeCsv)
      .join(','),
  );
  const csv = '﻿' + [header.join(','), ...lines].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `trademind-trades-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function TradesPage() {
  const filter = useFilterStore((s) => s.filter);
  const applyPreset = useFilterStore((s) => s.applyPreset);
  const [customCols, setCustomCols] = useState<CustomCol[]>(loadCustomCols);
  const [visible, setVisible] = useState<string[]>(() =>
    loadVisible([...ALL_COLS, ...loadCustomCols().map((c) => customToCol(c, new Map()))]),
  );
  const [showColSettings, setShowColSettings] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [tagDialog, setTagDialog] = useState<null | { category: 'tags' | 'entryTags' | 'exitTags'; text: string }>(null);
  const [newColName, setNewColName] = useState('');
  const [newColScope, setNewColScope] = useState<CustomColScope>('any');

  const { data: facets } = useQuery({ queryKey: ['facets'], queryFn: getFacets, staleTime: 5 * 60 * 1000 });
  const tagNameById = useMemo(
    () => new Map((facets?.tags ?? []).map((t) => [t.id, t.name])),
    [facets],
  );
  const accountNameById = useMemo(() => {
    const accs = facets?.accounts ?? [];
    return new Map(
      accs.map((a) => {
        const dup = accs.filter((x) => x.name === a.name).length > 1;
        return [a.id, a.name + (dup && a.apiKeyMasked ? ` (${a.apiKeyMasked})` : '')] as const;
      }),
    );
  }, [facets]);
  const accountCol = useMemo<ColDef>(
    () => ({
      id: 'account',
      label: 'API 账户',
      defaultVisible: false,
      cell: (t) => <span className="text-slate-400">{accountNameById.get(t.accountId) ?? '—'}</span>,
    }),
    [accountNameById],
  );
  const allCols = useMemo(
    () => {
      const base = [...ALL_COLS];
      const idx = base.findIndex((c) => c.id === 'dir');
      base.splice(idx + 1, 0, accountCol);
      return [...base, ...customCols.map((c) => customToCol(c, tagNameById))];
    },
    [accountCol, customCols, tagNameById],
  );

  useEffect(() => {
    try {
      localStorage.setItem(COL_STORAGE_KEY, JSON.stringify(visible));
    } catch {
      /* ignore */
    }
  }, [visible]);

  useEffect(() => {
    try {
      localStorage.setItem(CUSTOM_COL_KEY, JSON.stringify(customCols));
    } catch {
      /* ignore */
    }
  }, [customCols]);

  function addCustomCol() {
    const name = newColName.trim();
    if (!name) return;
    const col: CustomCol = {
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      label: name,
      tagName: name,
      scope: newColScope,
    };
    setCustomCols((cs) => [...cs, col]);
    setVisible((v) => (v.includes(`custom:${col.id}`) ? v : [...v, `custom:${col.id}`]));
    setNewColName('');
  }
  function removeCustomCol(id: string) {
    setCustomCols((cs) => cs.filter((c) => c.id !== id));
    setVisible((v) => v.filter((x) => x !== `custom:${id}`));
  }

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['trades', filter],
    queryFn: () => api<{ items: UnifiedTrade[]; total: number }>(`/trades${filterQuery(filter)}`),
  });

  const items = data?.items ?? [];

  // 默认时间窗口是「近 90 天」，而链上账户（如 Hyperliquid）的历史常常更早，
  // 于是同步成功却像「没数据」。这里在结果偏少且带时间条件时，反查一次「去掉时间条件」的总数，
  // 若被时间挡掉的是大多数，就在表格上方明确提示并给一键放宽。
  // （仅当结果 < 25 笔才发这个额外请求，正常浏览大数据集时不会触发。）
  const hasTimeWindow = Boolean(filter.from || filter.to);
  const shownTotal = data?.total ?? 0;
  const noTimeFilter = useMemo(() => ({ ...filter, from: null, to: null }), [filter]);
  const { data: probe } = useQuery({
    queryKey: ['trades-no-time-total', noTimeFilter],
    queryFn: () => getTrades(noTimeFilter, 1, 1),
    // 注意 data != null：shownTotal 在首屏数据未到位时读到的是兜底的 0，
    // 若不判 data 就会每次进页面都白发一次这个反查请求（拿到的结果也没用处）。
    enabled: hasTimeWindow && data != null && shownTotal < 25,
    staleTime: 30_000,
  });
  const hiddenByTime = hasTimeWindow && probe?.total != null ? Math.max(0, probe.total - shownTotal) : 0;
  const timeHidesMost = hiddenByTime > 0 && hiddenByTime > shownTotal;

  const agg = useMemo(() => {
    const totalNotional = items.reduce((a, t) => a + notional(t), 0);
    const totalGross = items.reduce((a, t) => a + t.grossPnl, 0);
    const totalCost = items.reduce((a, t) => a + cost(t), 0);
    const totalNet = items.reduce((a, t) => a + t.netPnl, 0);
    const grossProfit = items.reduce((a, t) => a + Math.max(0, t.grossPnl), 0);
    return { totalNotional, totalGross, totalCost, totalNet, costRatio: grossProfit > 0 ? totalCost / grossProfit : null };
  }, [items]);

  const cols = allCols.filter((c) => visible.includes(c.id));

  const pageIds = items.map((t) => t.id);
  const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));

  function toggleSelect(id: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }
  function togglePageAll() {
    setSelected((s) => {
      const n = new Set(s);
      if (allPageSelected) pageIds.forEach((id) => n.delete(id));
      else pageIds.forEach((id) => n.add(id));
      return n;
    });
  }
  async function selectAllFiltered() {
    setBusy(true);
    try {
      const res = await getTrades(filter, 1, 5000);
      setSelected(new Set(res.items.map((t) => t.id)));
    } finally {
      setBusy(false);
    }
  }

  async function applyArchive(archived: boolean) {
    setBusy(true);
    try {
      await batchUpdateTrades([...selected], { archived });
      setSelected(new Set());
      await refetch();
    } finally {
      setBusy(false);
    }
  }
  async function applyDelete() {
    if (!confirm(`确认删除选中的 ${selected.size} 笔交易？此操作不可撤销。`)) return;
    setBusy(true);
    try {
      await batchDeleteTrades([...selected]);
      setSelected(new Set());
      await refetch();
    } finally {
      setBusy(false);
    }
  }
  async function applyTag() {
    if (!tagDialog) return;
    const names = tagDialog.text.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean);
    if (names.length === 0) return;
    setBusy(true);
    try {
      await batchUpdateTrades([...selected], { [tagDialog.category]: names });
      setTagDialog(null);
      setSelected(new Set());
      await refetch();
    } finally {
      setBusy(false);
    }
  }
  async function doExport() {
    setBusy(true);
    try {
      const res = await getTrades(filter, 1, 5000);
      const rows = selected.size > 0 ? res.items.filter((t) => selected.has(t.id)) : res.items;
      exportCsv(rows);
    } finally {
      setBusy(false);
    }
  }

  if (isLoading) return <p className="text-sm text-slate-500">加载中…</p>;
  if (error) return <p className="text-sm text-down">{(error as Error).message}</p>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-medium">交易记录（{data?.total ?? 0}）</h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowColSettings((o) => !o)}
            className="rounded-md border border-line px-2.5 py-1.5 text-xs text-slate-300 hover:border-slate-500"
          >
            列设置
          </button>
          <button
            type="button"
            onClick={doExport}
            disabled={busy}
            className="rounded-md border border-line px-2.5 py-1.5 text-xs text-slate-300 hover:border-slate-500"
          >
            导出 CSV
          </button>
        </div>
      </div>

      <TradeFilter />

      {showColSettings ? (
        <div className="rounded-xl border border-line bg-panel p-4">
          <div className="mb-2 text-sm font-medium text-slate-200">显示列</div>
          <div className="flex flex-wrap gap-2">
            {allCols.map((c) => (
              <label key={c.id} className="flex cursor-pointer items-center gap-1.5 rounded-md border border-line bg-surface px-2 py-1 text-xs text-slate-300">
                <input
                  type="checkbox"
                  checked={visible.includes(c.id)}
                  onChange={(e) =>
                    setVisible((v) => (e.target.checked ? [...v, c.id] : v.filter((x) => x !== c.id)))
                  }
                  className="accent-emerald-500"
                />
                {c.label}
              </label>
            ))}
          </div>

          <div className="mt-4 border-t border-line pt-3">
            <div className="mb-2 text-sm font-medium text-slate-200">自定义标签列</div>
            <p className="mb-2 text-xs text-slate-500">
              把常用的入场理由 / 出场理由 / 标签做成独立一列：命中该标签的交易在列里显示 ✔，一眼扫出「这周有多少笔是强平 / FOMO」。
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <div>
                <div className="mb-1 text-xs text-slate-500">标签名</div>
                <input
                  value={newColName}
                  onChange={(e) => setNewColName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') addCustomCol();
                  }}
                  placeholder="例如：强平 / FOMO 追单"
                  className="w-56 rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs text-slate-200 outline-none focus:border-slate-500"
                />
              </div>
              <div>
                <div className="mb-1 text-xs text-slate-500">匹配范围</div>
                <select
                  value={newColScope}
                  onChange={(e) => setNewColScope(e.target.value as CustomColScope)}
                  className="rounded-md border border-line bg-surface px-2 py-1.5 text-xs text-slate-200 outline-none"
                >
                  {(Object.keys(SCOPE_LABEL) as CustomColScope[]).map((s) => (
                    <option key={s} value={s}>{SCOPE_LABEL[s]}</option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                onClick={addCustomCol}
                disabled={!newColName.trim()}
                className="rounded-md bg-emerald-500/20 px-3 py-1.5 text-xs text-emerald-200 disabled:opacity-40"
              >
                添加自定义列
              </button>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {(newColScope === 'entryTags' ? ENTRY_REASON_PRESETS : newColScope === 'exitTags' ? EXIT_REASON_PRESETS : [...EXIT_REASON_PRESETS, ...ENTRY_REASON_PRESETS])
                .slice(0, 8)
                .map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setNewColName(p)}
                    className="rounded-full border border-line bg-surface px-2 py-0.5 text-[11px] text-slate-400 hover:border-slate-500"
                  >
                    {p}
                  </button>
                ))}
            </div>
            {customCols.length > 0 ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {customCols.map((c) => (
                  <span
                    key={c.id}
                    className="flex items-center gap-1 rounded-md border border-line bg-surface px-2 py-1 text-xs text-slate-300"
                  >
                    {c.label}
                    <span className="text-[11px] text-slate-500">（{SCOPE_LABEL[c.scope]}）</span>
                    <button type="button" onClick={() => removeCustomCol(c.id)} className="text-slate-500 hover:text-down">
                      ×
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* 汇总条 */}
      <div className="flex flex-wrap gap-x-6 gap-y-1 rounded-lg border border-line bg-surface px-4 py-2.5 text-xs text-slate-400">
        <span>
          累计名义敞口 <span className="text-slate-200">{fmtUsdCompact(agg.totalNotional)}</span>
        </span>
        <span>
          毛利 <span className={pnlClass(agg.totalGross)}>{fmtUsd(agg.totalGross)}</span>
        </span>
        <span>
          成本 <span className="text-down">{fmtUsd(-agg.totalCost)}</span>
          {agg.costRatio !== null ? (
            <span className={agg.costRatio > 0.3 ? 'ml-1 text-down' : 'ml-1'}>（占毛利 {fmtPct(agg.costRatio, 0)}）</span>
          ) : null}
        </span>
        <span>
          净利 <span className={pnlClass(agg.totalNet)}>{fmtUsd(agg.totalNet)}</span>
        </span>
      </div>

      {/* 批量操作栏 */}
      {selected.size > 0 ? (
        <div className="sticky top-2 z-20 flex flex-wrap items-center gap-2 rounded-lg border border-emerald-500/40 bg-panel px-4 py-2.5 text-sm">
          <span className="text-emerald-300">已选 {selected.size} 笔</span>
          <button type="button" onClick={() => applyArchive(true)} disabled={busy} className="rounded-md border border-line px-2.5 py-1 text-xs text-slate-200 hover:border-slate-500">归档</button>
          <button type="button" onClick={() => applyArchive(false)} disabled={busy} className="rounded-md border border-line px-2.5 py-1 text-xs text-slate-200 hover:border-slate-500">取消归档</button>
          <button type="button" onClick={() => setTagDialog({ category: 'tags', text: '' })} disabled={busy} className="rounded-md border border-line px-2.5 py-1 text-xs text-slate-200 hover:border-slate-500">加标签</button>
          <button type="button" onClick={() => setTagDialog({ category: 'entryTags', text: '' })} disabled={busy} className="rounded-md border border-line px-2.5 py-1 text-xs text-slate-200 hover:border-slate-500">加入场理由</button>
          <button type="button" onClick={() => setTagDialog({ category: 'exitTags', text: '' })} disabled={busy} className="rounded-md border border-line px-2.5 py-1 text-xs text-slate-200 hover:border-slate-500">加出场理由</button>
          <button type="button" onClick={applyDelete} disabled={busy} className="rounded-md border border-down/50 px-2.5 py-1 text-xs text-down hover:bg-down/10">删除</button>
          <button type="button" onClick={doExport} disabled={busy} className="rounded-md border border-line px-2.5 py-1 text-xs text-slate-200 hover:border-slate-500">导出选中</button>
          <button type="button" onClick={() => setSelected(new Set())} className="ml-auto rounded-md px-2.5 py-1 text-xs text-slate-400 hover:text-slate-200">取消选择</button>
        </div>
      ) : null}

      {tagDialog ? (
        <div className="rounded-lg border border-line bg-panel p-3 text-sm">
          <div className="mb-2 text-slate-300">
            为选中 {selected.size} 笔添加{tagDialog.category === 'tags' ? '标签' : tagDialog.category === 'entryTags' ? '入场理由' : '出场理由'}（按逗号/换行分隔，自动合并去重）
          </div>
          <textarea
            value={tagDialog.text}
            onChange={(e) => setTagDialog({ ...tagDialog, text: e.target.value })}
            rows={2}
            placeholder="例如：突破, 回踩, 假突破"
            className="w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs text-slate-200 outline-none"
          />
          <div className="mt-2 flex gap-2">
            <button type="button" onClick={applyTag} disabled={busy} className="rounded-md bg-emerald-500/20 px-3 py-1 text-xs text-emerald-200">确认添加</button>
            <button type="button" onClick={() => setTagDialog(null)} className="rounded-md border border-line px-3 py-1 text-xs text-slate-400">取消</button>
          </div>
        </div>
      ) : null}

      <Section title="全部交易">
        {timeHidesMost ? (
          <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
            <span>
              时间范围只显示了 <b>{shownTotal}</b> 笔，另有 <b>{hiddenByTime}</b> 笔更早的记录被挡在外面（多为该账户的
              历史数据，例如 Hyperliquid 的链上成交）。
            </span>
            <button
              type="button"
              onClick={() => applyPreset('all')}
              className="rounded border border-amber-500/60 px-2 py-0.5 font-medium hover:bg-amber-500/20"
            >
              查看全部时间
            </button>
          </div>
        ) : null}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500">
                <th className="pb-2">
                  <input
                    type="checkbox"
                    checked={allPageSelected}
                    onChange={togglePageAll}
                    className="accent-emerald-500"
                  />
                </th>
                {cols.map((c) => (
                  <th key={c.id} className={`pb-2 font-normal ${c.numeric ? 'text-right' : ''}`}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((t) => (
                <tr key={t.id} className="border-t border-line/60 hover:bg-surface/50">
                  <td className="py-1.5">
                    <input
                      type="checkbox"
                      checked={selected.has(t.id)}
                      onChange={() => toggleSelect(t.id)}
                      className="accent-emerald-500"
                    />
                  </td>
                  {cols.map((c) => (
                    <td key={c.id} className={`whitespace-nowrap py-1.5 ${c.numeric ? 'text-right' : ''}`}>
                      {c.cell(t)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            {items.length > 0 ? (
              <tfoot>
                <tr className="border-t border-line text-xs text-slate-400">
                  <td className="py-2">
                    <button type="button" onClick={selectAllFiltered} disabled={busy} className="text-emerald-400 hover:underline">
                      全选筛选 ({data?.total ?? 0})
                    </button>
                  </td>
                  {cols.map((c) => (
                    <td key={c.id} className={`py-2 ${c.numeric ? 'text-right' : ''}`}>
                      {c.footer ? c.footer(agg) : null}
                    </td>
                  ))}
                </tr>
              </tfoot>
            ) : null}
          </table>
        </div>
        {items.length === 0 ? (
          <p className="py-8 text-center text-sm text-slate-500">
            没有符合条件的交易。可调整筛选条件，或到「数据源」绑定交易所并同步。
          </p>
        ) : null}
      </Section>
    </div>
  );
}
