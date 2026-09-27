import type { Session, UnifiedTrade } from '@trademind/trading-core';
import { DOW_LABELS, SESSION_LABELS, isClosed } from '@trademind/trading-core';

export interface SessionConfig {
  /** 时区偏移（分钟），默认 0 = UTC */
  tzOffsetMinutes: number;
  /** 各时段的本地分钟区间 [start, end)（按优先级 NEW_YORK > LONDON > ASIA 匹配） */
  newYork: [number, number];
  london: [number, number];
  asia: [number, number];
}

export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  tzOffsetMinutes: 0,
  newYork: [13 * 60, 21 * 60],
  london: [8 * 60, 16 * 60],
  asia: [0, 8 * 60],
};

export function getSession(iso: string, cfg: SessionConfig = DEFAULT_SESSION_CONFIG): Session {
  const d = new Date(iso);
  const localMin =
    (d.getUTCHours() * 60 + d.getUTCMinutes() + cfg.tzOffsetMinutes + 1440) % 1440;
  const inRange = (r: [number, number]) => localMin >= r[0] && localMin < r[1];
  if (inRange(cfg.newYork)) return 'NEW_YORK';
  if (inRange(cfg.london)) return 'LONDON';
  if (inRange(cfg.asia)) return 'ASIA';
  return 'OTHER';
}

export type TimeBucketKind = 'hour' | 'dayOfWeek' | 'day' | 'week' | 'month' | 'session' | 'duration';

export interface BucketStats {
  key: string;
  label: string;
  trades: number;
  wins: number;
  winRate: number;
  pnl: number;
}

const DURATION_BUCKETS: [string, string, (min: number) => boolean][] = [
  ['0-5m', '< 5m', (m) => m < 5],
  ['5-15m', '5–15m', (m) => m >= 5 && m < 15],
  ['15-60m', '15–60m', (m) => m >= 15 && m < 60],
  ['1-4h', '1–4h', (m) => m >= 60 && m < 240],
  ['4-24h', '4–24h', (m) => m >= 240 && m < 1440],
  ['24h+', '> 24h', (m) => m >= 1440],
];

function weekKey(d: Date): string {
  // ISO week（简化：以周一为起点）
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - day + 1);
  return date.toISOString().slice(0, 10);
}

function bucketOf(t: UnifiedTrade, kind: TimeBucketKind): string {
  const d = new Date((t.closeTime ?? t.openTime) as string);
  switch (kind) {
    case 'hour':
      return String(d.getUTCHours()).padStart(2, '0');
    case 'dayOfWeek':
      return String(d.getUTCDay());
    case 'day':
      return d.toISOString().slice(0, 10);
    case 'week':
      return weekKey(d);
    case 'month':
      return d.toISOString().slice(0, 7);
    case 'session':
      return getSession(t.closeTime ?? t.openTime);
    case 'duration': {
      const ms =
        new Date(t.closeTime as string).getTime() - new Date(t.openTime).getTime();
      const min = ms / 60000;
      const hit = DURATION_BUCKETS.find(([, , pred]) => pred(min));
      return hit ? hit[0] : '24h+';
    }
  }
}

function labelOf(kind: TimeBucketKind, key: string): string {
  switch (kind) {
    case 'hour':
      return `${key}:00`;
    case 'dayOfWeek':
      return DOW_LABELS[Number(key)];
    case 'session':
      return SESSION_LABELS[key as Session];
    case 'duration':
      return DURATION_BUCKETS.find((b) => b[0] === key)?.[1] ?? key;
    default:
      return key;
  }
}

export function aggregateByTime(
  trades: UnifiedTrade[],
  kind: TimeBucketKind,
): BucketStats[] {
  const cs = trades.filter(isClosed);
  const map = new Map<string, { trades: number; wins: number; pnl: number }>();
  for (const t of cs) {
    const key = bucketOf(t, kind);
    const agg = map.get(key) ?? { trades: 0, wins: 0, pnl: 0 };
    agg.trades++;
    if (t.netPnl > 0) agg.wins++;
    agg.pnl += t.netPnl;
    map.set(key, agg);
  }
  const order: Map<string, number> = new Map();
  if (kind === 'hour') for (let h = 0; h < 24; h++) order.set(String(h).padStart(2, '0'), h);
  if (kind === 'dayOfWeek') for (let d = 0; d < 7; d++) order.set(String(d), d);
  if (kind === 'session') order.set('ASIA', 0), order.set('LONDON', 1), order.set('NEW_YORK', 2), order.set('OTHER', 3);
  if (kind === 'duration') DURATION_BUCKETS.forEach((b, i) => order.set(b[0], i));

  return [...map.entries()]
    .map(([key, agg]) => ({
      key,
      label: labelOf(kind, key),
      trades: agg.trades,
      wins: agg.wins,
      winRate: agg.trades > 0 ? agg.wins / agg.trades : 0,
      pnl: agg.pnl,
    }))
    .sort((a, b) => {
      const ia = order.get(a.key);
      const ib = order.get(b.key);
      if (ia !== undefined && ib !== undefined) return ia - ib;
      return a.key.localeCompare(b.key);
    });
}
