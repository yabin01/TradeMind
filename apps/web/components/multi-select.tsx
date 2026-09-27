'use client';

import { useEffect, useRef, useState } from 'react';

export interface Option {
  value: string;
  label: string;
}

/** 可搜索的多选下拉（用于标的 / 交易所 / 策略 / 标签等固定候选集） */
export function MultiSelect({
  label,
  options,
  selected,
  onChange,
  searchable = true,
  placeholder = '全部',
}: {
  label: string;
  options: Option[];
  selected: string[];
  onChange: (next: string[]) => void;
  searchable?: boolean;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const q = query.trim().toLowerCase();
  const filtered = q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;

  function toggle(v: string) {
    onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
  }

  const summary =
    selected.length === 0
      ? placeholder
      : selected.length <= 2
        ? options
            .filter((o) => selected.includes(o.value))
            .map((o) => o.label)
            .join('、')
        : `已选 ${selected.length} 项`;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-1 rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs text-slate-200 hover:border-slate-500"
      >
        <span className="truncate">
          <span className="text-slate-500">{label}：</span>
          {summary}
        </span>
        <span className="text-slate-500">{open ? '▴' : '▾'}</span>
      </button>
      {open ? (
        <div className="absolute z-30 mt-1 w-56 rounded-md border border-line bg-panel shadow-lg">
          {searchable ? (
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索…"
              className="w-full border-b border-line bg-surface px-2.5 py-1.5 text-xs text-slate-200 outline-none"
            />
          ) : null}
          <div className="max-h-56 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <p className="px-2.5 py-2 text-xs text-slate-500">无匹配</p>
            ) : (
              filtered.map((o) => (
                <label
                  key={o.value}
                  className="flex cursor-pointer items-center gap-2 px-2.5 py-1 text-xs text-slate-200 hover:bg-surface"
                >
                  <input
                    type="checkbox"
                    checked={selected.includes(o.value)}
                    onChange={() => toggle(o.value)}
                    className="accent-emerald-500"
                  />
                  <span className="truncate">{o.label}</span>
                </label>
              ))
            )}
          </div>
          {selected.length > 0 ? (
            <button
              type="button"
              onClick={() => onChange([])}
              className="w-full border-t border-line px-2.5 py-1.5 text-xs text-slate-400 hover:text-slate-200"
            >
              清除选择
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
