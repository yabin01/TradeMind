'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, filterQuery } from '../../lib/api';
import { useFilterStore } from '../../lib/store';
import { fmtUsd, fmtPct, fmtNum, fmtTs, fmtUsdCompact, fmtDuration, pnlClass } from '../../lib/format';
import { useAppearance } from '../../lib/use-appearance';
import { ChartTooltip } from '../../components/charts';
import { Section, KpiCard } from '../../components/ui';
import { PeriodReview } from '../../components/period-review';
import type { UnifiedTrade } from '@trademind/trading-core';

// ── API 返回结构（与 packages/analytics/src/diary.ts 一致）──
interface DiaryStats {
  pnl: number;
  trades: number;
  wins: number;
  winRate: number | null;
  volume: number;
  fees: number;
  funding: number;
  profitFactor: number | null;
  longCount: number;
  shortCount: number;
  avgLeverage: number | null;
  maxLeverage: number | null;
  avgHoldMinutes: number | null;
}
interface DiaryMonth {
  key: string;
  stats: DiaryStats;
  weeks: { start: string; end: string; stats: DiaryStats }[];
}
interface DiaryWeek {
  start: string;
  end: string;
  stats: DiaryStats;
  prev: DiaryStats;
  days: { date: string; stats: DiaryStats }[];
}
interface DiaryDay {
  date: string;
  stats: DiaryStats;
  timeline: { t: string; cumPnl: number }[];
  trades: UnifiedTrade[];
}
interface DiaryNote {
  id: string;
  workspaceId: string;
  scope: 'MONTH' | 'WEEK' | 'DAY';
  periodKey: string;
  rating: number | null;
  content: string | null;
  updatedAt: string;
}

const MONTH_LABELS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];

function addDays(key: string, n: number): string {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function weekStartOf(key: string): string {
  const d = new Date(`${key}T00:00:00Z`);
  const dow = d.getUTCDay();
  const delta = (dow + 6) % 7;
  d.setUTCDate(d.getUTCDate() - delta);
  return d.toISOString().slice(0, 10);
}

/** 周期 KPI 概览 */
function StatRow({ stats }: { stats: DiaryStats }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      <KpiCard label="净盈亏" value={fmtUsd(stats.pnl)} tone={stats.pnl > 0 ? 'up' : stats.pnl < 0 ? 'down' : 'neutral'} />
      <KpiCard label="胜率" value={fmtPct(stats.winRate)} sub={`${stats.wins}/${stats.trades} 笔`} />
      <KpiCard label="盈亏比" value={stats.profitFactor === null ? '∞' : fmtNum(stats.profitFactor)} sub="毛利/毛损" />
      <KpiCard label="成交量" value={fmtUsdCompact(stats.volume)} sub="名义价值合计" />
      <KpiCard label="费用" value={fmtUsd(-(stats.fees + stats.funding))} tone="down" />
      <KpiCard label="均持仓" value={fmtDuration(stats.avgHoldMinutes)} sub={stats.avgLeverage !== null ? `均杠杆 ${fmtNum(stats.avgLeverage, 1)}x` : '—'} />
    </div>
  );
}

function RatingStars({ value, onChange }: { value: number | null; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((i) => (
        <button
          key={i}
          onClick={() => onChange(i === value ? 0 : i)}
          className={`text-lg leading-none ${i <= (value ?? 0) ? 'text-amber-400' : 'text-slate-600 hover:text-slate-400'}`}
          title={`${i} 星`}
        >
          ★
        </button>
      ))}
    </div>
  );
}

function NoteEditor({ scope, periodKey, note, onSaved }: { scope: DiaryNote['scope']; periodKey: string; note?: DiaryNote; onSaved: () => void }) {
  const qc = useQueryClient();
  const [content, setContent] = useState(note?.content ?? '');
  const [rating, setRating] = useState<number | null>(note?.rating ?? null);
  const [saving, setSaving] = useState(false);
  const save = useMutation({
    mutationFn: () => api<DiaryNote>('/diary-notes', { method: 'PUT', body: JSON.stringify({ scope, periodKey, rating, content }) }),
    onSuccess: () => {
      setSaving(false);
      qc.invalidateQueries({ queryKey: ['diary-notes'] });
      onSaved();
    },
  });
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <span className="text-xs text-slate-400">本周自评</span>
        <RatingStars value={rating} onChange={(v) => setRating(v)} />
      </div>
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="记录这段时间的交易反思、执行偏差、市场观察…"
        className="h-24 w-full resize-none rounded-lg border border-line bg-surface p-3 text-sm text-slate-200 placeholder:text-slate-600 focus:border-slate-500 focus:outline-none"
      />
      <div className="flex justify-end">
        <button
          disabled={saving}
          onClick={() => {
            setSaving(true);
            save.mutate();
          }}
          className="rounded-md bg-up/20 px-3 py-1.5 text-xs text-up hover:bg-up/30 disabled:opacity-50"
        >
          {saving ? '保存中…' : '保存复盘'}
        </button>
      </div>
    </div>
  );
}

function Breadcrumb({ items }: { items: { label: string; onClick?: () => void }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-1 text-sm text-slate-400">
      {items.map((it, i) => (
        <span key={i} className="flex items-center gap-1">
          {it.onClick ? (
            <button onClick={it.onClick} className="hover:text-slate-200">{it.label}</button>
          ) : (
            <span className="text-slate-200">{it.label}</span>
          )}
          {i < items.length - 1 ? <span className="text-slate-600">›</span> : null}
        </span>
      ))}
    </div>
  );
}

export default function JournalPage() {
  // 视图状态放全局 store：顶栏「年/月/周/今日」与本页共用（见 lib/store.ts goJournal）
  const journal = useFilterStore((s) => s.journal);
  const setJournal = useFilterStore((s) => s.setJournal);
  const filter = useFilterStore((s) => s.filter);
  const { year, monthKey, weekStart, date } = journal;
  const [appearance] = useAppearance();

  const level: 'year' | 'month' | 'week' | 'day' = date ? 'day' : weekStart ? 'week' : monthKey ? 'month' : 'year';

  // 顶栏 API 账户等筛选 → diary 聚合（后端 applyFilter）
  const fq = filterQuery(filter);

  const { data: notes } = useQuery({
    queryKey: ['diary-notes'],
    queryFn: () => api<DiaryNote[]>('/diary-notes'),
  });
  const { data: yearData } = useQuery({
    queryKey: ['diary-year', year, fq],
    queryFn: () => api<{ year: number; months: DiaryMonth[] }>(`/diary/${year}${fq}`),
    enabled: level === 'year' || level === 'month',
  });
  const { data: weekData } = useQuery({
    queryKey: ['diary-week', weekStart, fq],
    queryFn: () => api<DiaryWeek>(`/diary/week/${weekStart}${fq}`),
    enabled: level === 'week',
  });
  const { data: dayData } = useQuery({
    queryKey: ['diary-day', date, fq],
    queryFn: () => api<DiaryDay>(`/diary/day/${date}${fq}`),
    enabled: level === 'day',
  });

  const noteFor = (scope: DiaryNote['scope'], periodKey: string) =>
    notes?.find((n) => n.scope === scope && n.periodKey === periodKey);

  const months = yearData?.months ?? [];
  const month = monthKey ? months.find((m) => m.key === monthKey) : null;
  const week = weekData ?? null;

  // ── 年视图：12 个月卡片 ──
  if (level === 'year') {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">交易日志（按平仓日归属）</h2>
          <div className="flex items-center gap-2">
            <button onClick={() => setJournal({ year: year - 1 })} className="rounded-md border border-line px-2 py-1 text-sm text-slate-300 hover:bg-surface/60">‹ {year - 1}</button>
            <span className="text-sm text-slate-200">{year} 年</span>
            <button onClick={() => setJournal({ year: year + 1 })} className="rounded-md border border-line px-2 py-1 text-sm text-slate-300 hover:bg-surface/60">{year + 1} ›</button>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {months.map((m) => {
            const mm = Number(m.key.slice(5, 7));
            const n = noteFor('MONTH', m.key);
            return (
              <button
                key={m.key}
                onClick={() => setJournal({ monthKey: m.key })}
                className="rounded-xl border border-line bg-panel p-4 text-left transition-colors hover:border-slate-500"
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-slate-200">{MONTH_LABELS[mm - 1]}</span>
                  {n?.rating ? <span className="text-amber-400">{'★'.repeat(n.rating)}</span> : null}
                </div>
                <div className={`mt-2 text-lg font-medium ${pnlClass(m.stats.pnl)}`}>{fmtUsd(m.stats.pnl)}</div>
                <div className="mt-0.5 text-xs text-slate-400">
                  {m.stats.trades} 笔 · 胜率 {fmtPct(m.stats.winRate)} · 盈亏比 {m.stats.profitFactor === null ? '∞' : fmtNum(m.stats.profitFactor)}
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {m.weeks.map((w) => (
                    <span
                      key={w.start}
                      onClick={(e) => { e.stopPropagation(); setJournal({ weekStart: w.start, monthKey: m.key }); }}
                      className="rounded bg-surface px-1.5 py-0.5 text-[10px] text-slate-400 hover:text-slate-200"
                      title={`${w.start} ~ ${w.end}`}
                    >
                      {w.start.slice(5)}
                    </span>
                  ))}
                </div>
              </button>
            );
          })}
        </div>
        <p className="text-xs text-slate-500">口径：交易按 <span className="text-slate-300">平仓日</span> 归属；周为周一起始（UTC），跨月周在两个月各出现一次；盈亏比 = 毛利 / 毛损。</p>
      </div>
    );
  }

  // ── 月视图 ──
  if (level === 'month' && month) {
    const mm = Number(month.key.slice(5, 7));
    return (
      <div className="space-y-4">
        <Breadcrumb items={[{ label: `${year} 年`, onClick: () => setJournal({ monthKey: null }) }, { label: MONTH_LABELS[mm - 1] }]} />
        <StatRow stats={month.stats} />
        <Section title="周卡片（点击进入周视图）" actions={
          <div className="flex items-center gap-1 text-xs">
            <button onClick={() => { const p = `${year}-${String(mm - 1 === 0 ? 12 : mm - 1).padStart(2, '0')}`; setJournal({ monthKey: p }); }} className="text-slate-400 hover:text-slate-200">上月</button>
            <button onClick={() => { const nx = mm + 1; setJournal({ monthKey: nx > 12 ? `${year + 1}-01` : `${year}-${String(nx).padStart(2, '0')}` }); }} className="text-slate-400 hover:text-slate-200">下月</button>
          </div>
        }>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {month.weeks.map((w) => {
              const n = noteFor('WEEK', w.start);
              return (
                <button
                  key={w.start}
                  onClick={() => setJournal({ weekStart: w.start, monthKey: month.key })}
                  className="rounded-lg border border-line bg-surface p-3 text-left transition-colors hover:border-slate-500"
                >
                  <div className="flex items-center justify-between text-xs text-slate-400">
                    <span>{w.start.slice(5)} ~ {w.end.slice(5)}</span>
                    {n?.rating ? <span className="text-amber-400">{'★'.repeat(n.rating)}</span> : null}
                  </div>
                  <div className={`mt-1 text-base font-medium ${pnlClass(w.stats.pnl)}`}>{fmtUsd(w.stats.pnl)}</div>
                  <div className="text-xs text-slate-500">{w.stats.trades} 笔 · 胜率 {fmtPct(w.stats.winRate)}</div>
                </button>
              );
            })}
          </div>
        </Section>
        <PeriodReview
          from={`${month.key}-01`}
          to={new Date(Date.UTC(Number(month.key.slice(0, 4)), mm, 0)).toISOString().slice(0, 10)}
          buttonLabel="AI 分析本月"
        />
        <Section title="月度复盘">
          <NoteEditor scope="MONTH" periodKey={month.key} note={noteFor('MONTH', month.key)} onSaved={() => {}} />
        </Section>
      </div>
    );
  }

  // ── 周视图 ──
  if (level === 'week' && week) {
    return (
      <div className="space-y-4">
        <Breadcrumb
          items={[
            { label: `${year} 年`, onClick: () => setJournal({ weekStart: null, monthKey: null }) },
            { label: month ? MONTH_LABELS[Number(month.key.slice(5, 7)) - 1] : '—', onClick: () => setJournal({ weekStart: null }) },
            { label: `${week.start.slice(5)} ~ ${week.end.slice(5)}` },
          ]}
        />
        <StatRow stats={week.stats} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Section title="本周 vs 上周">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="text-xs text-slate-400">本周净盈亏</div>
                <div className={`text-lg font-medium ${pnlClass(week.stats.pnl)}`}>{fmtUsd(week.stats.pnl)}</div>
                <div className="text-xs text-slate-500">{week.stats.trades} 笔 · 胜率 {fmtPct(week.stats.winRate)}</div>
              </div>
              <div>
                <div className="text-xs text-slate-400">上周净盈亏</div>
                <div className={`text-lg font-medium ${pnlClass(week.prev.pnl)}`}>{fmtUsd(week.prev.pnl)}</div>
                <div className="text-xs text-slate-500">{week.prev.trades} 笔 · 胜率 {fmtPct(week.prev.winRate)}</div>
              </div>
            </div>
          </Section>
          <Section title="周导航">
            <div className="flex items-center justify-between">
              <button onClick={() => setJournal({ weekStart: addDays(week.start, -7) })} className="rounded-md border border-line px-3 py-1.5 text-sm text-slate-300 hover:bg-surface/60">‹ 上周</button>
              <button onClick={() => setJournal({ weekStart: addDays(week.start, 7) })} className="rounded-md border border-line px-3 py-1.5 text-sm text-slate-300 hover:bg-surface/60">下周 ›</button>
            </div>
          </Section>
        </div>
        <Section title="每日卡片（点击进入日视图）">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
            {week.days.map((d) => (
              <button
                key={d.date}
                onClick={() => setJournal({ date: d.date })}
                className="rounded-lg border border-line bg-surface p-2 text-left text-xs transition-colors hover:border-slate-500"
              >
                <div className="text-slate-400">{d.date.slice(5)}</div>
                <div className={`mt-1 font-medium ${pnlClass(d.stats.pnl)}`}>{fmtUsd(d.stats.pnl)}</div>
                <div className="text-slate-500">{d.stats.trades} 笔</div>
              </button>
            ))}
          </div>
        </Section>
        <PeriodReview from={week.start} to={week.end} buttonLabel="AI 分析本周" />
        <Section title="周复盘">
          <NoteEditor scope="WEEK" periodKey={week.start} note={noteFor('WEEK', week.start)} onSaved={() => {}} />
        </Section>
      </div>
    );
  }

  // ── 日视图 ──
  if (level === 'day' && dayData) {
    const prevWeekStart = weekStartOf(date!);
    const points = dayData.timeline.map((p) => ({ t: p.t.slice(0, 5), cum: Math.round(p.cumPnl * 100) / 100 }));
    // 曲线颜色按当日累计盈亏正负，跟随「设置 → 外观」里的盈亏配色
    const cumColor =
      points.length && points[points.length - 1].cum < 0 ? appearance.pnlDown : appearance.pnlUp;
    return (
      <div className="space-y-4">
        <Breadcrumb
          items={[
            { label: `${year} 年`, onClick: () => setJournal({ date: null, weekStart: null, monthKey: null }) },
            { label: '周', onClick: () => setJournal({ date: null, weekStart: prevWeekStart }) },
            { label: dayData.date },
          ]}
        />
        <StatRow stats={dayData.stats} />
        <div className="grid gap-4 lg:grid-cols-2">
          <Section title="当日累计盈亏时间线">
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={points} margin={{ top: 5, right: 10, bottom: 0, left: 0 }}>
                <XAxis dataKey="t" tick={{ fontSize: 11, fill: '#64748b' }} tickLine={false} axisLine={false} minTickGap={30} />
                <YAxis tick={{ fontSize: 11, fill: '#64748b' }} tickLine={false} axisLine={false} width={70} domain={['auto', 'auto']} />
                <Tooltip content={<ChartTooltip pnlTone />} cursor={{ fill: appearance.theme === 'dark' ? 'rgba(148,163,184,0.10)' : 'rgba(100,116,139,0.10)' }} />
                <Line type="monotone" dataKey="cum" name="累计盈亏" stroke={cumColor} strokeWidth={1.5} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </Section>
          <Section title="当日复盘">
            <NoteEditor scope="DAY" periodKey={dayData.date} note={noteFor('DAY', dayData.date)} onSaved={() => {}} />
          </Section>
        </div>
        <PeriodReview from={dayData.date} to={dayData.date} buttonLabel="AI 分析当日" />
        <Section title={`当日交易（${dayData.trades.length} 笔）`}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500">
                  <th className="pb-2 font-normal">时间</th>
                  <th className="pb-2 font-normal">标的</th>
                  <th className="pb-2 font-normal">方向</th>
                  <th className="pb-2 font-normal">净利润</th>
                  <th className="pb-2 font-normal">持仓</th>
                </tr>
              </thead>
              <tbody>
                {dayData.trades.map((t) => {
                  const dir = t.positionSide === 'NET' ? (t.side === 'BUY' ? 'LONG' : 'SHORT') : t.positionSide;
                  return (
                    <tr key={t.id} className="border-t border-line/60">
                      <td className="py-1.5 text-slate-400" title="北京时间">{fmtTs(t.closeTime ?? t.openTime).slice(5)}</td>
                      <td className="py-1.5">
                        <Link href={`/trades/${t.id}`} className="hover:underline">{t.symbol}</Link>
                      </td>
                      <td className={`py-1.5 ${dir === 'LONG' ? 'text-up' : 'text-down'}`}>{dir}</td>
                      <td className={`py-1.5 ${pnlClass(t.netPnl)}`}>{fmtUsd(t.netPnl)}</td>
                      <td className="py-1.5 text-slate-400">{fmtDuration(t.closeTime ? (new Date(t.closeTime).getTime() - new Date(t.openTime).getTime()) / 60000 : null)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Section>
      </div>
    );
  }

  return <p className="text-sm text-slate-500">加载中…</p>;
}
