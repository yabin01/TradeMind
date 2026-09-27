'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useFilterStore } from '../../lib/store';
import { fmtTs } from '../../lib/format';

type Scope = 'DAY' | 'WEEK' | 'MONTH';

interface DiaryNote {
  id: string;
  workspaceId: string;
  scope: Scope;
  periodKey: string;
  rating: number | null;
  content: string | null;
  updatedAt: string;
}

const SCOPE_LABEL: Record<Scope, string> = { DAY: '日复盘', WEEK: '周复盘', MONTH: '月复盘' };
// 仅使用 globals.css 已做亮色重映射的色阶，保证明暗两套主题都可读
const SCOPE_BADGE: Record<Scope, string> = {
  DAY: 'bg-slate-500/15 text-slate-300',
  WEEK: 'bg-emerald-500/20 text-emerald-300',
  MONTH: 'bg-amber-500/15 text-amber-300',
};
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function periodLabel(scope: Scope, key: string): string {
  if (scope === 'DAY') {
    const d = new Date(`${key}T00:00:00Z`);
    const wd = Number.isNaN(d.getTime()) ? '' : ` ${WEEKDAYS[d.getUTCDay()]}`;
    return `${key}${wd}`;
  }
  if (scope === 'WEEK') {
    const s = new Date(`${key}T00:00:00Z`);
    const e = new Date(s);
    e.setUTCDate(e.getUTCDate() + 6);
    return `${key} ~ ${e.toISOString().slice(5, 10)}`;
  }
  return `${key.slice(0, 4)} 年 ${Number(key.slice(5, 7))} 月`;
}

function Stars({ value }: { value: number }) {
  return (
    <span className="text-xs" title={`${value} 星`}>
      <span className="text-amber-400">{'★'.repeat(value)}</span>
      <span className="text-slate-600">{'★'.repeat(Math.max(0, 5 - value))}</span>
    </span>
  );
}

export default function NotesPage() {
  const router = useRouter();
  const setJournal = useFilterStore((s) => s.setJournal);
  const [tab, setTab] = useState<'ALL' | Scope>('DAY');
  const [q, setQ] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['diary-notes'],
    queryFn: () => api<DiaryNote[]>('/diary-notes'),
  });
  const notes = data ?? [];

  const counts = useMemo(() => {
    const c: Record<'ALL' | Scope, number> = { ALL: notes.length, DAY: 0, WEEK: 0, MONTH: 0 };
    for (const n of notes) c[n.scope] += 1;
    return c;
  }, [notes]);

  const list = useMemo(() => {
    let arr = tab === 'ALL' ? notes : notes.filter((n) => n.scope === tab);
    const kw = q.trim().toLowerCase();
    if (kw) {
      arr = arr.filter(
        (n) => (n.content ?? '').toLowerCase().includes(kw) || n.periodKey.toLowerCase().includes(kw),
      );
    }
    return [...arr].sort((a, b) =>
      // 「全部」按最近编辑排序，单类型按周期时间倒序
      tab === 'ALL' ? b.updatedAt.localeCompare(a.updatedAt) : b.periodKey.localeCompare(a.periodKey),
    );
  }, [notes, tab, q]);

  /** 跳到交易日志对应周期（日/周/月）查看与编辑 */
  function openInJournal(n: DiaryNote) {
    const year = Number(n.periodKey.slice(0, 4));
    if (n.scope === 'DAY') {
      setJournal({ year, monthKey: n.periodKey.slice(0, 7), date: n.periodKey, weekStart: null });
    } else if (n.scope === 'WEEK') {
      setJournal({ year, monthKey: n.periodKey.slice(0, 7), weekStart: n.periodKey, date: null });
    } else {
      setJournal({ year, monthKey: n.periodKey, weekStart: null, date: null });
    }
    router.push('/journal');
  }

  const TABS: { key: 'ALL' | Scope; label: string }[] = [
    { key: 'DAY', label: '日复盘' },
    { key: 'WEEK', label: '周复盘' },
    { key: 'MONTH', label: '月复盘' },
    { key: 'ALL', label: '全部' },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-medium">笔记</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            在「交易日志」中记录的复盘笔记，共 {notes.length} 条
          </p>
        </div>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索笔记内容或日期…"
          className="w-56 rounded-md border border-line bg-surface px-3 py-1.5 text-sm text-slate-200 placeholder:text-slate-600 focus:border-slate-500 focus:outline-none"
        />
      </div>

      <div className="flex flex-wrap items-center gap-1">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`rounded-md px-3 py-1 text-xs transition-colors ${
              tab === t.key ? 'bg-surface text-slate-100' : 'text-slate-400 hover:bg-surface/60'
            }`}
          >
            {t.label} <span className="text-slate-500">{counts[t.key]}</span>
          </button>
        ))}
      </div>

      {isLoading ? (
        <p className="text-sm text-slate-500">加载中…</p>
      ) : list.length === 0 ? (
        <div className="rounded-xl border border-line bg-panel p-8 text-center">
          <p className="text-sm text-slate-400">
            {q.trim()
              ? '没有匹配的笔记'
              : tab === 'DAY'
                ? '还没有日复盘笔记'
                : tab === 'WEEK'
                  ? '还没有周复盘笔记'
                  : tab === 'MONTH'
                    ? '还没有月复盘笔记'
                    : '还没有任何复盘笔记'}
          </p>
          <p className="mt-1 text-xs text-slate-600">
            打开「交易日志」，在 日 / 周 / 月 视图底部的「复盘」区域写下你的反思，会自动汇总到这里。
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {list.map((n) => (
            <div key={n.id} className="rounded-xl border border-line bg-panel p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded px-1.5 py-0.5 text-[11px] ${SCOPE_BADGE[n.scope]}`}>
                  {SCOPE_LABEL[n.scope]}
                </span>
                <span className="text-sm font-medium text-slate-200">{periodLabel(n.scope, n.periodKey)}</span>
                {n.rating ? <Stars value={n.rating} /> : null}
                <button
                  onClick={() => openInJournal(n)}
                  className="ml-auto text-xs text-slate-400 hover:text-slate-200"
                  title="在交易日志中查看 / 编辑这条笔记"
                >
                  在交易日志中查看 ↗
                </button>
              </div>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-slate-300">
                {n.content?.trim() || '（无内容）'}
              </p>
              <p className="mt-2 text-[11px] text-slate-500">更新于 {fmtTs(n.updatedAt, true)}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
