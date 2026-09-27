'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { usePathname } from 'next/navigation';
import { useFilterStore } from '../lib/store';
import { getFacets, renameConnection } from '../lib/api';
import { AppearanceToggle } from './appearance-toggle';

const PRESETS: { key: '7d' | '30d' | '90d' | 'all'; label: string }[] = [
  { key: '7d', label: '近7天' },
  { key: '30d', label: '近30天' },
  { key: '90d', label: '近90天' },
  { key: 'all', label: '全部' },
];

/** 交易日志页顶栏：API 选择器（最左）+ 年/月/周/今日 视图切换 */
function JournalTopBar() {
  const qc = useQueryClient();
  const { data: facets } = useQuery({ queryKey: ['facets'], queryFn: getFacets, staleTime: 5 * 60_000 });
  const accounts = facets?.accounts ?? [];
  const { filter, setFilter, journal, goJournal } = useFilterStore();
  const selectedId = filter.accountIds?.[0] ?? '';
  const selected = accounts.find((a) => a.id === selectedId) ?? null;
  const [renaming, setRenaming] = useState(false);
  const [renameVal, setRenameVal] = useState('');

  const level: 'year' | 'month' | 'week' | 'day' = journal.date
    ? 'day'
    : journal.weekStart
      ? 'week'
      : journal.monthKey
        ? 'month'
        : 'year';
  const isToday = level === 'day' && journal.date === new Date().toISOString().slice(0, 10);

  const views: { key: 'year' | 'month' | 'week' | 'today'; label: string; active: boolean }[] = [
    { key: 'year', label: '年', active: level === 'year' },
    { key: 'month', label: '月', active: level === 'month' },
    { key: 'week', label: '周', active: level === 'week' },
    { key: 'today', label: '今日', active: isToday },
  ];

  async function doRename() {
    const n = renameVal.trim();
    setRenaming(false);
    if (!selected?.connectionId || !n || n === selected.name) return;
    try {
      await renameConnection(selected.connectionId, n);
      void qc.invalidateQueries({ queryKey: ['facets'] });
    } catch (e) {
      console.error('重命名失败', e);
    }
  }

  return (
    <div className="flex h-12 items-center gap-2 border-b border-line bg-panel px-4">
      <select
        value={filter.accountIds?.[0] ?? ''}
        onChange={(e) => setFilter({ accountIds: e.target.value ? [e.target.value] : [] })}
        className="max-w-44 rounded-md border border-line bg-surface px-2 py-1 text-xs text-slate-300"
        title="按数据源 / API 账户筛选，全局生效"
      >
        <option value="">全部 API</option>
        {accounts.map((a) => {
          const dup = accounts.filter((x) => x.name === a.name).length > 1;
          return (
            <option key={a.id} value={a.id}>
              {a.name}
              {dup && a.apiKeyMasked ? ` (${a.apiKeyMasked})` : ''} · {a.exchange}
            </option>
          );
        })}
      </select>
      {selected?.connectionId ? (
        renaming ? (
          <span className="flex items-center gap-1">
            <input
              autoFocus
              value={renameVal}
              onChange={(e) => setRenameVal(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void doRename();
                if (e.key === 'Escape') setRenaming(false);
              }}
              className="w-36 rounded border border-line bg-surface px-1.5 py-1 text-xs text-slate-100"
            />
            <button onClick={() => void doRename()} className="text-xs text-up hover:underline">保存</button>
            <button onClick={() => setRenaming(false)} className="text-xs text-slate-400 hover:underline">取消</button>
          </span>
        ) : (
          <button
            onClick={() => {
              setRenameVal(selected.name);
              setRenaming(true);
            }}
            title="重命名当前 API"
            className="rounded-md border border-line px-1.5 py-1 text-xs text-slate-400 hover:text-sky-300"
          >
            ✎
          </button>
        )
      ) : null}
      <div className="ml-3 flex items-center gap-1">
        {views.map((v) => (
          <button
            key={v.key}
            onClick={() => goJournal(v.key)}
            className={`rounded-md px-3 py-1 text-xs transition-colors ${
              v.active ? 'bg-surface text-slate-100' : 'text-slate-400 hover:bg-surface/60'
            }`}
          >
            {v.label}
          </button>
        ))}
      </div>
      <div className="ml-auto flex items-center gap-2">
        <AppearanceToggle />
      </div>
    </div>
  );
}

export function FilterBar() {
  const pathname = usePathname();
  const isJournal = pathname?.startsWith('/journal') ?? false;
  const isNotes = pathname?.startsWith('/notes') ?? false;
  const isPositions = pathname?.startsWith('/positions') ?? false;
  if (isJournal) return <JournalTopBar />;
  if (isNotes) return <NotesTopBar />;
  if (isPositions) return <PositionsTopBar />;
  return <DefaultTopBar />;
}

/** 账户选择器（含 ✎ 重命名），供 日志 / 持仓 等专用顶栏复用 */
function AccountSelect() {
  const qc = useQueryClient();
  const { data: facets } = useQuery({ queryKey: ['facets'], queryFn: getFacets, staleTime: 5 * 60_000 });
  const accounts = facets?.accounts ?? [];
  const { filter, setFilter } = useFilterStore();
  const selectedId = filter.accountIds?.[0] ?? '';
  const selected = accounts.find((a) => a.id === selectedId) ?? null;
  const [renaming, setRenaming] = useState(false);
  const [renameVal, setRenameVal] = useState('');

  async function doRename() {
    const n = renameVal.trim();
    setRenaming(false);
    if (!selected?.connectionId || !n || n === selected.name) return;
    try {
      await renameConnection(selected.connectionId, n);
      void qc.invalidateQueries({ queryKey: ['facets'] });
    } catch (e) {
      console.error('重命名失败', e);
    }
  }

  return (
    <>
      <select
        value={selectedId}
        onChange={(e) => setFilter({ accountIds: e.target.value ? [e.target.value] : [] })}
        className="max-w-44 rounded-md border border-line bg-surface px-2 py-1 text-xs text-slate-300"
        title="按数据源 / API 账户筛选，全局生效"
      >
        <option value="">全部 API</option>
        {accounts.map((a) => {
          const dup = accounts.filter((x) => x.name === a.name).length > 1;
          return (
            <option key={a.id} value={a.id}>
              {a.name}
              {dup && a.apiKeyMasked ? ` (${a.apiKeyMasked})` : ''} · {a.exchange}
            </option>
          );
        })}
      </select>
      {selected?.connectionId ? (
        renaming ? (
          <span className="flex items-center gap-1">
            <input
              autoFocus
              value={renameVal}
              onChange={(e) => setRenameVal(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void doRename();
                if (e.key === 'Escape') setRenaming(false);
              }}
              className="w-36 rounded border border-line bg-surface px-1.5 py-1 text-xs text-slate-100"
            />
            <button onClick={() => void doRename()} className="text-xs text-up hover:underline">保存</button>
            <button onClick={() => setRenaming(false)} className="text-xs text-slate-400 hover:underline">取消</button>
          </span>
        ) : (
          <button
            onClick={() => {
              setRenameVal(selected.name);
              setRenaming(true);
            }}
            title="重命名当前 API"
            className="rounded-md border border-line px-1.5 py-1 text-xs text-slate-400 hover:text-sky-300"
          >
            ✎
          </button>
        )
      ) : null}
    </>
  );
}

/** 持仓页顶栏：账户选择 + 配色（时段/方向/标的对持仓无意义） */
function PositionsTopBar() {
  return (
    <div className="flex h-12 items-center gap-2 border-b border-line bg-panel px-4">
      <AccountSelect />
      <span className="ml-3 text-xs text-slate-500">实时持仓（OKX / Hyperliquid）</span>
      <div className="ml-auto flex items-center gap-2">
        <AppearanceToggle />
      </div>
    </div>
  );
}

/** 笔记页顶栏：账户/时段筛选对笔记无意义，只保留标题与配色切换 */
function NotesTopBar() {
  return (
    <div className="flex h-12 items-center gap-2 border-b border-line bg-panel px-4">
      <span className="text-xs text-slate-400">交易复盘笔记</span>
      <div className="ml-auto flex items-center gap-2">
        <AppearanceToggle />
      </div>
    </div>
  );
}

function DefaultTopBar() {
  const { filter, setFilter, applyPreset, reset } = useFilterStore();
  const qc = useQueryClient();
  const { data: facets } = useQuery({ queryKey: ['facets'], queryFn: getFacets, staleTime: 5 * 60_000 });
  const accounts = facets?.accounts ?? [];
  const selectedId = filter.accountIds?.[0] ?? '';
  const selected = accounts.find((a) => a.id === selectedId) ?? null;
  const [renaming, setRenaming] = useState(false);
  const [renameVal, setRenameVal] = useState('');

  async function doRename() {
    const n = renameVal.trim();
    setRenaming(false);
    if (!selected?.connectionId || !n || n === selected.name) return;
    try {
      await renameConnection(selected.connectionId, n);
      void qc.invalidateQueries({ queryKey: ['facets'] });
    } catch (e) {
      console.error('重命名失败', e);
    }
  }
  const activePreset =
    PRESETS.find((p) => {
      if (p.key === 'all') return !filter.from && !filter.to;
      const days = p.key === '7d' ? 7 : p.key === '30d' ? 30 : 90;
      return filter.from?.slice(0, 10) === new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    })?.key ?? null;

  return (
    <div className="flex h-12 items-center gap-2 border-b border-line bg-panel px-4">
      <span className="mr-1 text-xs text-slate-500">筛选</span>
      {PRESETS.map((p) => (
        <button
          key={p.key}
          onClick={() => applyPreset(p.key)}
          className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
            activePreset === p.key ? 'bg-surface text-slate-100' : 'text-slate-400 hover:bg-surface/60'
          }`}
        >
          {p.label}
        </button>
      ))}
      {accounts.length > 0 ? (
        <select
          value={filter.accountIds?.[0] ?? ''}
          onChange={(e) => setFilter({ accountIds: e.target.value ? [e.target.value] : [] })}
          className="max-w-40 rounded-md border border-line bg-surface px-2 py-1 text-xs text-slate-300"
          title="按数据源 / API 账户筛选，全局生效"
        >
          <option value="">全部 API</option>
          {accounts.map((a) => {
            // 同名账户（如 OKX 主账户/子账户）用掩码 API Key 区分
            const dup = accounts.filter((x) => x.name === a.name).length > 1;
            return (
              <option key={a.id} value={a.id}>
                {a.name}
                {dup && a.apiKeyMasked ? ` (${a.apiKeyMasked})` : ''} · {a.exchange}
              </option>
            );
          })}
        </select>
      ) : null}
      {selected?.connectionId ? (
        renaming ? (
          <span className="flex items-center gap-1">
            <input
              autoFocus
              value={renameVal}
              onChange={(e) => setRenameVal(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void doRename();
                if (e.key === 'Escape') setRenaming(false);
              }}
              className="w-36 rounded border border-line bg-surface px-1.5 py-1 text-xs text-slate-100"
            />
            <button onClick={() => void doRename()} className="text-xs text-up hover:underline">保存</button>
            <button onClick={() => setRenaming(false)} className="text-xs text-slate-400 hover:underline">取消</button>
          </span>
        ) : (
          <button
            onClick={() => {
              setRenameVal(selected.name);
              setRenaming(true);
            }}
            title="重命名当前 API"
            className="rounded-md border border-line px-1.5 py-1 text-xs text-slate-400 hover:text-sky-300"
          >
            ✎
          </button>
        )
      ) : null}
      <select
        value={filter.sides?.[0] ?? ''}
        onChange={(e) => setFilter({ sides: e.target.value ? [e.target.value as 'LONG' | 'SHORT'] : [] })}
        className="rounded-md border border-line bg-surface px-2 py-1 text-xs text-slate-300"
      >
        <option value="">全部方向</option>
        <option value="LONG">做多</option>
        <option value="SHORT">做空</option>
      </select>
      <input
        value={filter.symbols?.[0] ?? ''}
        onChange={(e) => setFilter({ symbols: e.target.value ? [e.target.value.toUpperCase()] : [] })}
        placeholder="标的（如 BTCUSDT）"
        className="w-44 rounded-md border border-line bg-surface px-2 py-1 text-xs text-slate-300 placeholder:text-slate-600"
      />
      <div className="ml-auto flex items-center gap-2">
        <button
          onClick={reset}
          className="rounded-md border border-line px-2.5 py-1 text-xs text-slate-400 hover:text-slate-200"
        >
          重置
        </button>
        <AppearanceToggle />
      </div>
    </div>
  );
}
