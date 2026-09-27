'use client';

import { create } from 'zustand';
import type { FilterSet } from '@trademind/trading-core';

interface FilterState {
  filter: FilterSet;
  setFilter: (patch: Partial<FilterSet>) => void;
  applyPreset: (preset: '7d' | '30d' | '90d' | 'all') => void;
  reset: () => void;
}

function rangeFor(preset: '7d' | '30d' | '90d' | 'all'): Partial<FilterSet> {
  if (preset === 'all') return { from: null, to: null };
  const days = preset === '7d' ? 7 : preset === '30d' ? 30 : 90;
  const from = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  return { from };
}

// ── 交易日志（/journal）视图状态：顶栏「年/月/周/今日」与页面共用 ──
type JournalLevel = 'year' | 'month' | 'week' | 'day';

export interface JournalState {
  year: number;
  monthKey: string | null;
  weekStart: string | null;
  date: string | null;
}

/** UTC 今天（diary 聚合按平仓日 UTC 归属） */
function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

/** 某天所在周的周一（UTC，diary 周口径一致） */
function mondayOf(d: Date): string {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
  return x.toISOString().slice(0, 10);
}

interface FullState extends FilterState {
  journal: JournalState;
  /** 页面内部导航（点卡片、面包屑等） */
  setJournal: (patch: Partial<JournalState>) => void;
  /** 顶栏视图切换：year / month / week / today（跳到今天的日视图） */
  goJournal: (target: JournalLevel | 'today') => void;
}

export const useFilterStore = create<FullState>((set) => ({
  filter: rangeFor('90d'),
  setFilter: (patch) => set((s) => ({ filter: { ...s.filter, ...patch } })),
  applyPreset: (preset) => set((s) => ({ filter: { ...s.filter, ...rangeFor(preset) } })),
  reset: () => set({ filter: {} }),

  journal: { year: new Date().getUTCFullYear(), monthKey: null, weekStart: null, date: null },
  setJournal: (patch) => set((s) => ({ journal: { ...s.journal, ...patch } })),
  goJournal: (target) =>
    set((s) => {
      const j = s.journal;
      if (target === 'year') return { journal: { ...j, monthKey: null, weekStart: null, date: null } };
      if (target === 'month') {
        const today = utcToday();
        return { journal: { ...j, year: Number(today.slice(0, 4)), monthKey: today.slice(0, 7), weekStart: null, date: null } };
      }
      if (target === 'week') {
        const ws = mondayOf(new Date());
        return { journal: { ...j, year: Number(ws.slice(0, 4)), monthKey: ws.slice(0, 7), weekStart: ws, date: null } };
      }
      // today → 今天的日视图
      const today = utcToday();
      const ws = mondayOf(new Date());
      return {
        journal: { ...j, year: Number(today.slice(0, 4)), monthKey: today.slice(0, 7), weekStart: ws, date: today },
      };
    }),
}));

