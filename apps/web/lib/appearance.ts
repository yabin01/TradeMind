'use client';

/**
 * 外观设置：明暗主题 + 盈亏配色自定义（对齐 TraderMake 的 Appearance 设置）
 *
 * - theme: 'dark' | 'light'，写在 <html data-theme> 上，Tailwind 与 globals.css 据此切换 token
 * - pnlUp / pnlDown: 十六进制色值，写入 CSS 变量 --pnl-up / --pnl-down（RGB 通道形式，
 *   这样 Tailwind 的 bg-up/15 这类透明度修饰符仍然可用）
 *
 * 默认「红涨绿跌」（中国习惯），可在设置页一键切到国际习惯。
 */

export type ThemeMode = 'dark' | 'light';

export interface Appearance {
  theme: ThemeMode;
  /** 盈利 / 上涨色 */
  pnlUp: string;
  /** 亏损 / 下跌色 */
  pnlDown: string;
}

export const APPEARANCE_KEY = 'trademind-appearance-v1';

export const DEFAULT_APPEARANCE: Appearance = {
  theme: 'dark',
  pnlUp: '#ef4444', // 红涨
  pnlDown: '#22c55e', // 绿跌
};

export const PNL_PRESETS: { label: string; up: string; down: string }[] = [
  { label: '红涨绿跌（中国习惯）', up: '#ef4444', down: '#22c55e' },
  { label: '绿涨红跌（国际习惯）', up: '#22c55e', down: '#ef4444' },
  { label: '蓝涨橙跌', up: '#3b82f6', down: '#f97316' },
  { label: '紫涨灰跌', up: '#a855f7', down: '#94a3b8' },
];

/** '#ef4444' → '239 68 68'（Tailwind 的 rgb(var(--x) / <alpha-value>) 需要通道形式） */
export function hexToRgbChannels(hex: string): string {
  const s = hex.trim().replace('#', '');
  const full = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return '239 68 68';
  return `${parseInt(full.slice(0, 2), 16)} ${parseInt(full.slice(2, 4), 16)} ${parseInt(full.slice(4, 6), 16)}`;
}

export function loadAppearance(): Appearance {
  if (typeof window === 'undefined') return DEFAULT_APPEARANCE;
  try {
    const raw = localStorage.getItem(APPEARANCE_KEY);
    if (!raw) return DEFAULT_APPEARANCE;
    const parsed = JSON.parse(raw) as Partial<Appearance>;
    return {
      theme: parsed.theme === 'light' ? 'light' : 'dark',
      pnlUp: typeof parsed.pnlUp === 'string' ? parsed.pnlUp : DEFAULT_APPEARANCE.pnlUp,
      pnlDown: typeof parsed.pnlDown === 'string' ? parsed.pnlDown : DEFAULT_APPEARANCE.pnlDown,
    };
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

export function saveAppearance(a: Appearance): void {
  try {
    localStorage.setItem(APPEARANCE_KEY, JSON.stringify(a));
  } catch {
    /* ignore */
  }
}

/** 把外观写入 DOM（<html data-theme> + CSS 变量） */
export function applyAppearance(a: Appearance): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset.theme = a.theme;
  root.classList.toggle('dark', a.theme === 'dark');
  root.style.setProperty('--pnl-up', hexToRgbChannels(a.pnlUp));
  root.style.setProperty('--pnl-down', hexToRgbChannels(a.pnlDown));
}

/** 变更事件：多组件（设置页 / 顶栏开关）之间同步 */
export const APPEARANCE_EVENT = 'trademind-appearance-change';

/** 保存 + 立即生效 + 广播 */
export function setAppearance(a: Appearance): void {
  saveAppearance(a);
  applyAppearance(a);
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(APPEARANCE_EVENT));
}

/** 首屏防闪烁脚本（内联到 <head>，在 CSS/ hydration 之前执行） */
export const APPEARANCE_BOOTSTRAP_SCRIPT = `(function(){try{var raw=localStorage.getItem('${APPEARANCE_KEY}');var a=raw?JSON.parse(raw):null;var r=document.documentElement;var th=(a&&a.theme==='light')?'light':'dark';r.setAttribute('data-theme',th);r.classList.toggle('dark',th==='dark');function ch(x){x=String(x||'').replace('#','');if(x.length===3){x=x.split('').map(function(c){return c+c;}).join('');}if(!/^[0-9a-fA-F]{6}$/.test(x))return null;return parseInt(x.slice(0,2),16)+' '+parseInt(x.slice(2,4),16)+' '+parseInt(x.slice(4,6),16);}r.style.setProperty('--pnl-up',ch(a&&a.pnlUp)||'239 68 68');r.style.setProperty('--pnl-down',ch(a&&a.pnlDown)||'34 197 94');}catch(e){}})();`;
