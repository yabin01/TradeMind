'use client';

import { useAppearance } from '../lib/use-appearance';
import { DEFAULT_APPEARANCE, PNL_PRESETS } from '../lib/appearance';
import { Section } from './ui';

/** 设置页「外观」区块：明暗主题 + 盈亏配色自定义 */
export function AppearanceSettings() {
  const [a, setA, ready] = useAppearance();

  return (
    <Section title="外观（主题 / 盈亏配色）">
      <div className="space-y-4">
        <div>
          <div className="mb-1.5 text-xs text-slate-500">主题</div>
          <div className="flex gap-2">
            {(['dark', 'light'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setA({ ...a, theme: m })}
                className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                  (ready ? a.theme : 'dark') === m
                    ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300'
                    : 'border-line bg-surface text-slate-400 hover:text-slate-200'
                }`}
              >
                {m === 'dark' ? '🌙 暗色' : '☀️ 亮色'}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="mb-1.5 text-xs text-slate-500">盈亏配色预设</div>
          <div className="flex flex-wrap gap-2">
            {PNL_PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => setA({ ...a, pnlUp: p.up, pnlDown: p.down })}
                className="flex items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs text-slate-300 hover:border-slate-500"
              >
                <span style={{ background: p.up }} className="inline-block h-3 w-3 rounded-sm" />
                <span style={{ background: p.down }} className="inline-block h-3 w-3 rounded-sm" />
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
          <div>
            <label className="mb-1 block text-xs text-slate-500">盈利 / 上涨色</label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={a.pnlUp}
                onChange={(e) => setA({ ...a, pnlUp: e.target.value })}
                className="h-8 w-10 cursor-pointer rounded border border-line bg-surface"
              />
              <input
                value={a.pnlUp}
                onChange={(e) => setA({ ...a, pnlUp: e.target.value })}
                className="w-full rounded border border-line bg-surface px-2 py-1.5 font-mono text-xs"
              />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-500">亏损 / 下跌色</label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={a.pnlDown}
                onChange={(e) => setA({ ...a, pnlDown: e.target.value })}
                className="h-8 w-10 cursor-pointer rounded border border-line bg-surface"
              />
              <input
                value={a.pnlDown}
                onChange={(e) => setA({ ...a, pnlDown: e.target.value })}
                className="w-full rounded border border-line bg-surface px-2 py-1.5 font-mono text-xs"
              />
            </div>
          </div>
          <div className="flex items-end">
            <button
              type="button"
              onClick={() => setA(DEFAULT_APPEARANCE)}
              className="rounded border border-line px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200"
            >
              恢复默认
            </button>
          </div>
        </div>

        <div className="rounded border border-line bg-surface px-3 py-2 text-xs text-slate-400">
          预览：
          <span style={{ color: a.pnlUp }} className="mx-1 font-medium">
            +$1,234.00（盈利）
          </span>
          ·
          <span style={{ color: a.pnlDown }} className="mx-1 font-medium">
            -$567.00（亏损）
          </span>
          · 设置保存在本地浏览器（localStorage），刷新后立即生效。
        </div>
      </div>
    </Section>
  );
}
