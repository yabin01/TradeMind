'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getPositions,
  getFacets,
  savePositionAnnotation,
  type PositionView,
} from '../../lib/api';
import { useFilterStore } from '../../lib/store';
import { fmtNum, fmtTs, fmtUsd, fmtUsdCompact, pnlClass } from '../../lib/format';
import { KpiCard, Section } from '../../components/ui';
import { TagChipsInput } from '../../components/tag-chips-input';
import { ENTRY_REASON_PRESETS, GENERAL_TAG_PRESETS } from '../../lib/reason-presets';

/** 数量显示：有面值时按币计，否则按张计 */
function qtyText(p: PositionView): string {
  if (p.quantityUnit === 'base') {
    const base = p.symbol.split('-')[0];
    return `${fmtNum(p.quantity, 4)} ${base}`;
  }
  return `${fmtNum(p.contracts, 0)} 张`;
}

/** 单行：本地维护标注状态，改动即保存（无需整表刷新） */
function PositionRow({ p }: { p: PositionView }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [entryTags, setEntryTags] = useState<string[]>(p.annotation.entryTags);
  const [tags, setTags] = useState<string[]>(p.annotation.tags);
  const [notes, setNotes] = useState(p.annotation.notes ?? '');
  const [savedNotes, setSavedNotes] = useState(p.annotation.notes ?? '');
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const { data: facets } = useQuery({ queryKey: ['facets'], queryFn: getFacets, staleTime: 5 * 60_000 });
  const tagSuggestions = useMemo(
    () => [...new Set([...GENERAL_TAG_PRESETS, ...(facets?.tags ?? []).map((t) => t.name)])],
    [facets],
  );

  const save = useMutation({
    mutationFn: (patch: { entryTags?: string[]; tags?: string[]; notes?: string | null }) =>
      savePositionAnnotation({
        accountId: p.accountId,
        symbol: p.symbol,
        positionSide: p.positionSide,
        ...patch,
      }),
    onSuccess: () => {
      setErr(null);
      setSavedAt(new Date().toISOString());
    },
    onError: (e) => setErr(e instanceof Error ? e.message : String(e)),
  });

  const dirCls = p.direction === 'LONG' ? 'bg-up/15 text-up' : 'bg-down/15 text-down';
  const emptyAnnotation = entryTags.length === 0 && tags.length === 0 && !notes.trim();

  /** 备注仅在内容变化时保存，避免 onBlur 与按钮重复提交 */
  function persistNotes() {
    if (notes === savedNotes) return;
    setSavedNotes(notes);
    save.mutate({ notes: notes || null });
  }

  return (
    <>
      <tr className="border-t border-line/60 align-middle">
        <td className="py-2 pr-3 text-slate-300">{p.accountName}</td>
        <td className="py-2 pr-3 font-medium text-slate-200">{p.symbol}</td>
        <td className="py-2 pr-3">
          <span className={`rounded px-1.5 py-0.5 text-xs ${dirCls}`}>
            {p.direction === 'LONG' ? '做多' : '做空'}
          </span>
        </td>
        <td className="py-2 pr-3 text-slate-400">{p.leverage}x</td>
        <td className="py-2 pr-3 text-slate-300">{qtyText(p)}</td>
        <td className="py-2 pr-3 text-slate-300">{fmtNum(p.avgPrice, 4)}</td>
        <td className="py-2 pr-3 text-slate-300">{p.markPrice ? fmtNum(p.markPrice, 4) : '—'}</td>
        <td className={`py-2 pr-3 ${pnlClass(p.unrealizedPnl)}`}>
          {fmtUsd(p.unrealizedPnl)}
          <span className="ml-1 text-xs text-slate-500">({fmtNum(p.unrealizedPnlRatio * 100, 2)}%)</span>
        </td>
        <td className="py-2 pr-3 text-slate-300">{fmtUsdCompact(p.margin)}</td>
        <td className="py-2 pr-3 text-down">{p.liquidationPrice ? fmtNum(p.liquidationPrice, 4) : '—'}</td>
        <td className="py-2 pr-3 text-xs text-slate-400" title="北京时间">
          {p.openedAt ? fmtTs(p.openedAt) : '—'}
        </td>
        <td className="py-2 pr-3">
          <div className="flex flex-wrap gap-1">
            {entryTags.slice(0, 2).map((t) => (
              <span key={t} className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[11px] text-emerald-300">
                {t}
              </span>
            ))}
            {tags.slice(0, 1).map((t) => (
              <span key={t} className="rounded-full border border-line bg-surface px-1.5 py-0.5 text-[11px] text-slate-400">
                {t}
              </span>
            ))}
            {emptyAnnotation ? <span className="text-[11px] text-slate-600">未标注</span> : null}
          </div>
        </td>
        <td className="py-2">
          <button
            onClick={() => setOpen((o) => !o)}
            className="rounded-md border border-line px-2 py-1 text-xs text-slate-300 hover:border-slate-500"
          >
            {open ? '收起' : '标注'}
          </button>
        </td>
      </tr>
      {open ? (
        <tr className="border-t border-line/60 bg-surface/40">
          <td colSpan={13} className="px-1 py-3">
            <div className="space-y-3">
              <div className="grid gap-4 md:grid-cols-3">
                <TagChipsInput
                  label="入场理由"
                  values={entryTags}
                  onChange={(v) => {
                    setEntryTags(v);
                    save.mutate({ entryTags: v });
                  }}
                  suggestions={ENTRY_REASON_PRESETS}
                  placeholder="点选常用理由，或输入自定义后回车"
                />
                <TagChipsInput
                  label="标签"
                  values={tags}
                  onChange={(v) => {
                    setTags(v);
                    save.mutate({ tags: v });
                  }}
                  suggestions={tagSuggestions}
                  placeholder="输入后回车添加"
                />
                <div className="space-y-1.5">
                  <div className="text-xs text-slate-500">备注</div>
                  <textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    onBlur={persistNotes}
                    placeholder="记录这笔持仓的计划、止损位、加减仓思路…"
                    className="h-24 w-full resize-none rounded-lg border border-line bg-surface p-2.5 text-xs text-slate-200 placeholder:text-slate-600 focus:border-slate-500 focus:outline-none"
                  />
                  <div className="flex items-center gap-2">
                    <button
                      onClick={persistNotes}
                      disabled={save.isPending || notes === savedNotes}
                      className="rounded-md bg-up/20 px-2.5 py-1 text-xs text-up hover:bg-up/30 disabled:opacity-50"
                    >
                      {save.isPending ? '保存中…' : '保存备注'}
                    </button>
                    {savedAt ? <span className="text-[11px] text-slate-500">已保存 {fmtTs(savedAt, true)}</span> : null}
                    {err ? <span className="text-[11px] text-down">保存失败：{err}</span> : null}
                  </div>
                </div>
              </div>
              <p className="text-[11px] text-slate-600">
                入场理由 / 标签改动即时保存；持仓平仓后标注会保留在数据库（键 = 账户 + 标的 + 方向）。
              </p>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

export default function PositionsPage() {
  const qc = useQueryClient();
  const accountIds = useFilterStore((s) => s.filter.accountIds) ?? [];

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['positions'],
    queryFn: getPositions,
    refetchInterval: 30_000,
    staleTime: 10_000,
  });

  const all = data?.positions ?? [];
  const list = accountIds.length > 0 ? all.filter((p) => accountIds.includes(p.accountId)) : all;

  const totals = useMemo(() => {
    return list.reduce(
      (acc, p) => ({
        pnl: acc.pnl + p.unrealizedPnl,
        notional: acc.notional + p.notionalUsd,
        margin: acc.margin + p.margin,
      }),
      { pnl: 0, notional: 0, margin: 0 },
    );
  }, [list]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-medium">持仓</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            实时读取 OKX / Hyperliquid 未平仓仓位，可补充入场理由与标签
            {data?.fetchedAt ? ` · 更新于 ${fmtTs(data.fetchedAt, true)}` : ''}
          </p>
        </div>
        <button
          onClick={() => {
            void refetch();
            void qc.invalidateQueries({ queryKey: ['facets'] });
          }}
          disabled={isFetching}
          className="rounded-md border border-line px-3 py-1.5 text-xs text-slate-300 hover:border-slate-500 disabled:opacity-50"
        >
          {isFetching ? '刷新中…' : '刷新'}
        </button>
      </div>

      {data?.errors?.length ? (
        <div className="space-y-1 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          {data.errors.map((e) => (
            <p key={e.accountId}>
              ⚠️ {e.accountName}：拉取持仓失败 — {e.error}
            </p>
          ))}
        </div>
      ) : null}

      {list.length > 0 ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <KpiCard label="持仓数" value={`${list.length}`} sub="未平仓仓位" />
          <KpiCard
            label="未实现盈亏"
            value={fmtUsd(totals.pnl)}
            tone={totals.pnl > 0 ? 'up' : totals.pnl < 0 ? 'down' : 'neutral'}
          />
          <KpiCard label="名义价值" value={fmtUsdCompact(totals.notional)} sub="合计" />
          <KpiCard label="占用保证金" value={fmtUsdCompact(totals.margin)} />
        </div>
      ) : null}

      <Section title={`当前仓位${list.length ? `（${list.length}）` : ''}`}>
        {isLoading ? (
          <p className="text-sm text-slate-500">加载中…</p>
        ) : list.length === 0 ? (
          <div className="space-y-1 py-6 text-center">
            <p className="text-sm text-slate-400">当前没有未平仓仓位</p>
            <p className="text-xs text-slate-600">
              该页面实时读取你在「数据源」中绑定的 OKX / Hyperliquid 账户持仓；开仓后刷新即可看到，并可在此补充入场理由与标签。
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500">
                  <th className="pb-2 pr-3 font-normal">账户</th>
                  <th className="pb-2 pr-3 font-normal">标的</th>
                  <th className="pb-2 pr-3 font-normal">方向</th>
                  <th className="pb-2 pr-3 font-normal">杠杆</th>
                  <th className="pb-2 pr-3 font-normal">持仓量</th>
                  <th className="pb-2 pr-3 font-normal">开仓均价</th>
                  <th className="pb-2 pr-3 font-normal">标记价</th>
                  <th className="pb-2 pr-3 font-normal">未实现盈亏</th>
                  <th className="pb-2 pr-3 font-normal">保证金</th>
                  <th className="pb-2 pr-3 font-normal">强平价</th>
                  <th className="pb-2 pr-3 font-normal">开仓时间</th>
                  <th className="pb-2 pr-3 font-normal">标注</th>
                  <th className="pb-2 font-normal">操作</th>
                </tr>
              </thead>
              <tbody>
                {list.map((p) => (
                  <PositionRow key={p.key} p={p} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}
