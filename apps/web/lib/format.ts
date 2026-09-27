export function fmtUsd(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const sign = v > 0 ? '+' : '';
  return `${sign}$${v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function fmtPct(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(digits)}%`;
}

export function fmtNum(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return v.toFixed(digits);
}

export function pnlClass(v: number): string {
  return v > 0 ? 'text-up' : v < 0 ? 'text-down' : 'text-slate-400';
}

/** 分钟数 → 人类可读持仓时长（1h 20m / 2d 3h） */
export function fmtDuration(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return '—';
  if (minutes < 1) return `${Math.round(minutes * 60)}s`;
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h < 24) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh > 0 ? `${d}d ${rh}h` : `${d}d`;
}

/** 北京时间（UTC+8，与 OKX 后台一致）格式化器；sv-SE locale 输出 "2026-09-26 07:55:24" */
const BEIJING_DTF = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/**
 * UTC ISO 字符串 → 北京时间显示（与 OKX 后台一致）。
 * 默认输出 "YYYY-MM-DD HH:mm"，withSeconds 为 true 时带秒。
 * 非法/空输入原样返回，便于兜底。
 */
export function fmtTs(iso: string | null | undefined, withSeconds = false): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const s = BEIJING_DTF.format(d);
  return withSeconds ? s : s.slice(0, 16);
}

/** UTC ISO → 北京时间仅日期 "YYYY-MM-DD" */
export function fmtTsDate(iso: string | null | undefined): string {
  return fmtTs(iso).slice(0, 10);
}

/** 大额金额紧凑显示（$1.2M / $3.4K），用于名义敞口等可能很大的数字 */
export function fmtUsdCompact(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const sign = v < 0 ? '-' : '';
  const a = Math.abs(v);
  if (a >= 1_000_000_000) return `${sign}$${(a / 1_000_000_000).toFixed(2)}B`;
  if (a >= 1_000_000) return `${sign}$${(a / 1_000_000).toFixed(2)}M`;
  if (a >= 10_000) return `${sign}$${(a / 1000).toFixed(1)}K`;
  return `${sign}$${a.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}
