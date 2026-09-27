'use client';

import { useMemo, useState } from 'react';
import { tagTone } from '../lib/reason-presets';

const TONE_CLS = {
  normal: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
  risk: 'border-down/50 bg-down/10 text-down',
  good: 'border-up/50 bg-up/10 text-up',
} as const;

const TONE_SUGGEST_CLS = {
  normal: 'border-line bg-surface text-slate-400 hover:border-emerald-500/50 hover:text-emerald-300',
  risk: 'border-line bg-surface text-slate-400 hover:border-down/60 hover:text-down',
  good: 'border-line bg-surface text-slate-400 hover:border-up/60 hover:text-up',
} as const;

/** 自由文本标签输入（用于入场理由 / 出场理由等无固定候选集的名称标签） */
export function TagChipsInput({
  label,
  values,
  onChange,
  placeholder = '输入后回车添加',
  suggestions,
  suggestionLabel = '常用',
  maxSuggestions = 12,
}: {
  label: string;
  values: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  /** 预设候选：点击即添加，已存在的会被隐藏 */
  suggestions?: string[];
  suggestionLabel?: string;
  maxSuggestions?: number;
}) {
  const [draft, setDraft] = useState('');
  const [showAll, setShowAll] = useState(false);

  const available = useMemo(() => {
    if (!suggestions?.length) return [];
    return suggestions.filter((s) => !values.includes(s));
  }, [suggestions, values]);
  const shown = showAll ? available : available.slice(0, maxSuggestions);

  function add(v?: string) {
    const next = (v ?? draft).trim();
    if (!next) return;
    if (!values.includes(next)) onChange([...values, next]);
    setDraft('');
  }

  function remove(v: string) {
    onChange(values.filter((x) => x !== v));
  }

  // 输入时对预设做前缀提示（取前 6 个）
  const hints = useMemo(() => {
    const q = draft.trim();
    if (!q || !suggestions?.length) return [];
    return suggestions.filter((s) => s.includes(q) && !values.includes(s)).slice(0, 6);
  }, [draft, suggestions, values]);

  return (
    <div className="space-y-1.5">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="flex flex-wrap gap-1.5">
        {values.map((v) => {
          const tone = tagTone(v);
          return (
            <span
              key={v}
              className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${TONE_CLS[tone]}`}
            >
              {v}
              <button
                type="button"
                onClick={() => remove(v)}
                className="opacity-70 hover:opacity-100"
              >
                ×
              </button>
            </span>
          );
        })}
        {values.length === 0 ? <span className="text-xs text-slate-600">未设置</span> : null}
      </div>

      {suggestions?.length ? (
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-slate-600">{suggestionLabel}</span>
            {shown.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => add(s)}
                className={`rounded-full border px-1.5 py-0.5 text-[11px] transition-colors ${TONE_SUGGEST_CLS[tagTone(s)]}`}
              >
                + {s}
              </button>
            ))}
            {available.length > maxSuggestions ? (
              <button
                type="button"
                onClick={() => setShowAll((o) => !o)}
                className="text-[11px] text-slate-500 hover:text-slate-300"
              >
                {showAll ? '收起' : `全部 ${available.length} 项`}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="relative">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          onBlur={() => add()}
          placeholder={placeholder}
          className="w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs text-slate-200 outline-none focus:border-slate-500"
        />
        {hints.length > 0 ? (
          <div className="absolute left-0 right-0 top-full z-30 mt-1 flex flex-wrap gap-1 rounded-md border border-line bg-panel p-1.5 shadow-lg">
            {hints.map((h) => (
              <button
                key={h}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  add(h);
                }}
                className="rounded border border-line bg-surface px-1.5 py-0.5 text-[11px] text-slate-300 hover:border-slate-500"
              >
                {h}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
