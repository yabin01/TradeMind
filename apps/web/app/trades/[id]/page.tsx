'use client';

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { api, patchTrade, getFacets } from '../../../lib/api';
import { fmtDuration, fmtTs, fmtUsd, pnlClass } from '../../../lib/format';
import { Section } from '../../../components/ui';
import { TagChipsInput } from '../../../components/tag-chips-input';
import { ENTRY_REASON_PRESETS, EXIT_REASON_PRESETS, GENERAL_TAG_PRESETS } from '../../../lib/reason-presets';
import type { UnifiedTrade } from '@trademind/trading-core';

interface TradeDetail {
  id: string;
  symbol: string;
  exchange: string;
  direction: 'LONG' | 'SHORT';
  isClosed: boolean;
  entryPrice: number;
  exitPrice: number | null;
  quantity: number;
  notional: number;
  leverage: number;
  marginEstimate: number | null;
  openTime: string;
  closeTime: string | null;
  holdingMinutes: number | null;
  session: string;
  weekday: string;
  hourUtc: number;
  sequenceInDay: number | null;
  grossPnl: number;
  fees: number;
  funding: number;
  netPnl: number;
  totalCost: number;
  isWin: boolean | null;
  priceChangePct: number | null;
  netPnlPctOfNotional: number | null;
  costPctOfNotional: number | null;
  costRatioOfGross: number | null;
  pnlPerHour: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  risk: number | null;
  reward: number | null;
  rr: number | null;
  rMultiple: number | null;
  hitStopLoss: boolean | null;
  hitTakeProfit: boolean | null;
  mae: number | null;
  mfe: number | null;
  maeMfeAvailable: boolean;
  maeMfeReason: string | null;
  strategyId: string | null;
  tags: string[];
  mistakes: string[];
  confidence: number | null;
  marketCondition: string | null;
  notes: string | null;
  externalTradeId: string | null;
}

const SESSION_LABEL: Record<string, string> = {
  ASIA: '亚洲时段',
  LONDON: '伦敦时段',
  NEW_YORK: '纽约时段',
  OTHER: '其他时段',
};

function n(v: number | null | undefined, digits = 4): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return v.toFixed(digits);
}
function pct(v: number | null | undefined, digits = 3): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`;
}
function mins(v: number | null): string {
  return fmtDuration(v);
}
function ts(v: string | null): string {
  return v ? fmtTs(v, true) : '持仓中';
}

function Row({ k, v, hint }: { k: string; v: React.ReactNode; hint?: string }) {
  return (
    <div className="contents">
      <dt className="text-slate-500" title={hint}>
        {k}
        {hint ? <span className="ml-0.5 text-slate-600">ⓘ</span> : null}
      </dt>
      <dd className={typeof v === 'string' ? 'text-slate-200' : ''}>{v}</dd>
    </div>
  );
}

function Grid({ rows }: { rows: React.ReactNode }) {
  return <dl className="grid grid-cols-2 gap-y-2 gap-x-4 text-sm">{rows}</dl>;
}

export default function TradeDetailPage() {
  const params = useParams<{ id: string }>();
  const { data, isLoading, error } = useQuery({
    queryKey: ['trade-detail', params.id],
    queryFn: () => api<{ trade: UnifiedTrade; detail: TradeDetail } | null>(`/trades/${params.id}/detail`),
  });
  const { data: facets } = useQuery({ queryKey: ['facets'], queryFn: getFacets, staleTime: 5 * 60 * 1000 });

  const [entryTags, setEntryTags] = useState<string[]>([]);
  const [exitTags, setExitTags] = useState<string[]>([]);
  const [tagNames, setTagNames] = useState<string[]>([]);
  const [archived, setArchived] = useState(false);
  const [saving, setSaving] = useState(false);

  const t = data?.trade;
  useEffect(() => {
    if (data?.trade) {
      const tr = data.trade;
      setEntryTags(tr.entryTags ?? []);
      setExitTags(tr.exitTags ?? []);
      setTagNames(
        (tr.tags ?? [])
          .map((id) => facets?.tags.find((f) => f.id === id)?.name ?? id)
          .filter(Boolean),
      );
      setArchived(tr.archived ?? false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  if (isLoading) return <p className="text-sm text-slate-500">加载中…</p>;
  if (error || !data || !t) return <p className="text-sm text-down">未找到交易</p>;

  const d = data.detail;
  const dirText = d.direction === 'LONG' ? '做多' : '做空';
  const strategyName = facets?.strategies.find((s) => s.id === d.strategyId)?.name;
  const costWarning = d.costRatioOfGross !== null && d.costRatioOfGross > 1;

  async function patch(field: string, value: unknown) {
    setSaving(true);
    try {
      await patchTrade(t!.id, { [field]: value });
    } finally {
      setSaving(false);
    }
  }
  async function patchTags(names: string[]) {
    const ids = (names.map((nm) => facets?.tags.find((f) => f.name === nm)?.id).filter(Boolean) as string[]) ?? [];
    setSaving(true);
    try {
      await patchTrade(t!.id, { tags: ids });
    } finally {
      setSaving(false);
    }
  }
  async function toggleArchive() {
    const next = !archived;
    setArchived(next);
    await patch('archived', next);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-3">
        <h2 className="text-lg font-medium">{d.symbol}</h2>
        <span className={`rounded px-2 py-0.5 text-xs ${d.direction === 'LONG' ? 'bg-up/15 text-up' : 'bg-down/15 text-down'}`}>
          {dirText}
        </span>
        <span className={`text-xl ${pnlClass(d.netPnl)}`}>{fmtUsd(d.netPnl)}</span>
        <span className="text-xs text-slate-500">
          {d.isClosed ? '已平仓' : '持仓中'} · {d.exchange} · {d.leverage}x
        </span>
        {archived ? <span className="rounded bg-amber-500/15 px-2 py-0.5 text-xs text-amber-300">已归档</span> : null}
        <button
          type="button"
          onClick={toggleArchive}
          disabled={saving}
          className="ml-auto rounded-md border border-line px-2.5 py-1 text-xs text-slate-300 hover:border-slate-500"
        >
          {archived ? '取消归档' : '归档'}
        </button>
      </div>

      {costWarning ? (
        <div className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          ⚠️ 这笔交易的成本（{fmtUsd(d.totalCost)}）超过了它的价格盈亏（{fmtUsd(Math.abs(d.grossPnl))}），
          成本是毛利的 {(d.costRatioOfGross as number * 100).toFixed(0)}%。持仓 {mins(d.holdingMinutes)} 里手续费吃掉了大部分空间。
        </div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-2">
        <Section title="价格与规模">
          <Grid rows={
            <>
              <Row k="开仓价" v={n(d.entryPrice, 6)} />
              <Row k="平仓价" v={d.exitPrice !== null ? n(d.exitPrice, 6) : '持仓中'} />
              <Row k="数量" v={n(d.quantity)} />
              <Row k="名义价值" v={fmtUsd(d.notional)} hint="开仓价 × 数量，衡量这笔的实际交易规模" />
              <Row k="杠杆" v={`${d.leverage}x`} />
              <Row k="保证金估算" v={d.marginEstimate !== null ? fmtUsd(d.marginEstimate) : '—'} hint="名义价值 ÷ 杠杆，未计维持保证金与全仓/逐仓差异" />
            </>
          } />
        </Section>

        <Section title="时间与持仓">
          <Grid rows={
            <>
              <Row k="开仓时间" v={ts(d.openTime)} hint="北京时间 UTC+8，与 OKX 后台一致" />
              <Row k="平仓时间" v={ts(d.closeTime)} hint="北京时间 UTC+8，与 OKX 后台一致" />
              <Row k="持仓时长" v={mins(d.holdingMinutes)} />
              <Row k="时段（UTC）" v={SESSION_LABEL[d.session] ?? d.session} />
              <Row k="开仓时刻" v={`${d.weekday} ${String(d.hourUtc).padStart(2, '0')}:00 UTC`} />
              <Row k="当日第几笔" v={d.sequenceInDay !== null ? `第 ${d.sequenceInDay} 笔` : '—'} hint="按 UTC 日的平仓顺序" />
            </>
          } />
        </Section>

        <Section title="盈亏拆解">
          <Grid rows={
            <>
              <Row k="价格盈亏（毛利）" v={<span className={pnlClass(d.grossPnl)}>{fmtUsd(d.grossPnl)}</span>} />
              <Row k="手续费" v={fmtUsd(-Math.abs(d.fees))} />
              <Row k="资金费" v={fmtUsd(d.funding)} />
              <Row k="总成本" v={fmtUsd(-d.totalCost)} hint="|手续费| + |资金费|" />
              <Row k="净盈亏" v={<span className={pnlClass(d.netPnl)}>{fmtUsd(d.netPnl)}</span>} />
              <Row k="结果" v={d.isWin === null ? '持仓中' : d.isWin ? '盈利' : d.netPnl === 0 ? '打平' : '亏损'} />
            </>
          } />
        </Section>

        <Section title="相对口径（可跨品种比较）">
          <Grid rows={
            <>
              <Row k="价格有利变动" v={pct(d.priceChangePct)} hint="(平仓价-开仓价)/开仓价，已按方向取正负" />
              <Row k="净盈亏 / 名义价值" v={pct(d.netPnlPctOfNotional)} hint="剔除仓位大小后的资金效率" />
              <Row k="成本 / 名义价值" v={pct(d.costPctOfNotional)} />
              <Row k="成本 / 毛利" v={d.costRatioOfGross !== null ? `${(d.costRatioOfGross * 100).toFixed(0)}%` : '—'} hint="超过 100% 表示手续费比这笔的价格盈亏还大" />
              <Row k="净盈亏 / 小时" v={d.pnlPerHour !== null ? fmtUsd(d.pnlPerHour) : '—'} hint="资金的时间效率" />
              <Row k="R 倍数" v={d.rMultiple !== null ? n(d.rMultiple, 2) : '—'} hint="净盈亏 ÷ 计划风险；需要填写 risk 才能计算" />
            </>
          } />
        </Section>

        <Section title="风险与止损">
          <Grid rows={
            <>
              <Row k="止损价" v={d.stopLoss !== null ? n(d.stopLoss, 6) : '未设置'} />
              <Row k="止盈价" v={d.takeProfit !== null ? n(d.takeProfit, 6) : '未设置'} />
              <Row
                k="是否触发止损"
                v={d.hitStopLoss === null ? '—' : d.hitStopLoss ? <span className="text-down">是</span> : '否'}
                hint="出场价是否触及设置的止损"
              />
              <Row
                k="是否触发止盈"
                v={d.hitTakeProfit === null ? '—' : d.hitTakeProfit ? <span className="text-up">是</span> : '否'}
              />
              <Row k="计划风险 / 回报" v={d.risk && d.reward ? `${n(d.risk)} / ${n(d.reward)}` : '—'} />
              <Row k="计划 R:R" v={d.rr !== null ? n(d.rr, 2) : '—'} />
            </>
          } />
        </Section>

        <Section title="MAE / MFE（持仓期间极值）">
          {d.maeMfeAvailable ? (
            <Grid rows={
              <>
                <Row k="MAE 最大不利偏移" v={<span className={pnlClass(d.mae ?? 0)}>{fmtUsd(d.mae ?? 0)}</span>} />
                <Row k="MFE 最大有利偏移" v={<span className={pnlClass(d.mfe ?? 0)}>{fmtUsd(d.mfe ?? 0)}</span>} />
              </>
            } />
          ) : (
            <div className="space-y-2">
              <p className="text-sm text-slate-400">MAE <span className="text-slate-600">—</span> · MFE <span className="text-slate-600">—</span></p>
              <p className="text-xs text-slate-500">{d.maeMfeReason}</p>
              <p className="text-xs text-slate-600">
                想启用：在交易的 metadata 里补上持仓期间最高/最低价（extremes: {'{'} high, low {'}'}）即可自动计算，无需改代码。
              </p>
            </div>
          )}
        </Section>
      </div>

      {/* 标注编辑 */}
      <Section title="标注编辑（入场/出场理由 · 标签 · 归档）">
        <div className="grid gap-4 md:grid-cols-3">
          <TagChipsInput
            label="入场理由标签"
            values={entryTags}
            onChange={(v) => {
              setEntryTags(v);
              patch('entryTags', v);
            }}
            suggestions={ENTRY_REASON_PRESETS}
            placeholder="点选常用理由，或输入自定义后回车"
          />
          <TagChipsInput
            label="出场理由标签"
            values={exitTags}
            onChange={(v) => {
              setExitTags(v);
              patch('exitTags', v);
            }}
            suggestions={EXIT_REASON_PRESETS}
            placeholder="点选常用动作，或输入自定义后回车"
          />
          <TagChipsInput
            label="标签（按名称，自动匹配/创建）"
            values={tagNames}
            onChange={(v) => {
              setTagNames(v);
              patchTags(v);
            }}
            suggestions={GENERAL_TAG_PRESETS}
            placeholder="输入后回车添加"
          />
        </div>
        <p className="mt-3 text-xs text-slate-500">
          入场/出场理由标签为自由文本，直接保存在交易上；通用标签按名称匹配库中已有标签，不存在则自动创建并写入交易。
          <span className="text-down">红色</span>=风险动作（强平 / 触及风险上限 / 情绪化平仓 / FOMO），
          <span className="text-up">绿色</span>=纪律性止盈动作，其余为中性。
        </p>
      </Section>

      {/* 日志元信息 */}
      <Section title="日志与标注">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2 text-sm">
            <p><span className="text-slate-500">策略：</span>{strategyName ?? '未绑定'}</p>
            <p><span className="text-slate-500">标签：</span>{tagNames.length > 0 ? `${tagNames.length} 个标签` : '无'}</p>
            <p><span className="text-slate-500">错误标记：</span>{d.mistakes.length > 0 ? `${d.mistakes.length} 个错误标记` : '无'}</p>
            <p><span className="text-slate-500">自信度：</span>{d.confidence ? `${d.confidence}/5` : '—'}</p>
            <p><span className="text-slate-500">市场状态：</span>{d.marketCondition ?? '—'}</p>
          </div>
          <div className="space-y-2 text-sm">
            <p><span className="text-slate-500">笔记：</span>{d.notes ?? '—'}</p>
            <p><span className="text-slate-500">截图：</span>{t.screenshots.length > 0 ? `${t.screenshots.length} 张` : '无'}</p>
            <p className="truncate"><span className="text-slate-500">外部 ID：</span>
              <span className="font-mono text-xs text-slate-400">{d.externalTradeId ?? '—'}</span>
            </p>
            {t.chanlun ? (
              <p className="text-slate-400">ChanLun: {t.chanlun.level} · {t.chanlun.signal}{t.chanlun.divergence ? ' · 背驰' : ''}</p>
            ) : null}
          </div>
        </div>
      </Section>
    </div>
  );
}
