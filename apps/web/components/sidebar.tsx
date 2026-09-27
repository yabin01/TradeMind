'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const NAV = [
  { href: '/dashboard', label: '总览' },
  { href: '/journal', label: '交易日志' },
  { href: '/trades', label: '交易记录' },
  { href: '/positions', label: '持仓' },
  { href: '/analytics', label: '分析' },
  { href: '/calendar', label: '日历' },
  { href: '/ai-coach', label: 'AI 教练' },
  { href: '/rules', label: '规则' },
  { href: '/connections', label: '数据源' },
  { href: '/notes', label: '笔记' },
  { href: '/settings', label: '设置' },
];

export function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="w-52 shrink-0 border-r border-line bg-panel">
      <div className="flex h-12 items-center gap-2 border-b border-line px-4">
        <span className="text-base font-medium tracking-wide text-slate-100">TradeMind</span>
      </div>
      <nav className="p-2">
        {NAV.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`mb-0.5 block rounded-md px-3 py-2 text-sm transition-colors ${
                active ? 'bg-surface text-slate-100' : 'text-slate-400 hover:bg-surface/60 hover:text-slate-200'
              }`}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
