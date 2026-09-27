'use client';

import { useAppearance } from '../lib/use-appearance';

/** 顶栏 / 侧边栏用的紧凑明暗切换按钮 */
export function AppearanceToggle({ className = '' }: { className?: string }) {
  const [a, setA, ready] = useAppearance();
  return (
    <button
      type="button"
      title={a.theme === 'dark' ? '切换到亮色主题' : '切换到暗色主题'}
      onClick={() => setA({ ...a, theme: a.theme === 'dark' ? 'light' : 'dark' })}
      className={`rounded-md border border-line px-2 py-1 text-xs text-slate-400 transition-colors hover:border-slate-500 hover:text-slate-200 ${className}`}
    >
      {!ready ? '◐' : a.theme === 'dark' ? '🌙 暗色' : '☀️ 亮色'}
    </button>
  );
}
