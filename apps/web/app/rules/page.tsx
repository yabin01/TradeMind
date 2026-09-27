'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '../../lib/api';
import { fmtTs } from '../../lib/format';
import { PnlText, Section } from '../../components/ui';

type RuleTypeMeta = {
  type: string;
  label: string;
  description: string;
  params: { key: string; label: string; kind: 'number' | 'hours'; default: unknown; hint: string }[];
};

type Rule = {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  params: Record<string, unknown>;
};

type Suggestion = {
  name: string;
  type: string;
  params: Record<string, unknown>;
  rationale: string;
  estimatedHits: number;
  enabled: boolean;
};

/** 规则模板（GET /rules/templates）：每种规则类型一套可直接应用的默认参数 */
type RuleTemplate = {
  key: string;
  name: string;
  type: string;
  description: string;
  recommended: boolean;
  params: Record<string, unknown>;
};

type Evaluation = {
  evaluatedAt: string;
  trades: number;
  rules: number;
  enabledRules: number;
  total: number;
  affectedTrades: number;
  byRule: { ruleId: string; ruleName: string; ruleType: string; count: number; pnl: number }[];
  violationPnl: number;
  shareOfTrades: number;
};

type ViolationRow = {
  id: string;
  tradeId: string;
  ruleId: string;
  detail: string;
  ruleName: string;
  ruleType: string | null;
  trade: {
    symbol: string;
    side: string;
    positionSide: string;
    netPnl: number;
    leverage: number;
    openTime: string;
    closeTime: string | null;
  } | null;
};

const HOURS = Array.from({ length: 24 }, (_, i) => i);

function paramSummary(type: string, params: Record<string, unknown>, meta: RuleTypeMeta[]): string {
  const m = meta.find((x) => x.type === type);
  if (!m) return JSON.stringify(params);
  return m.params
    .map((p) => {
      const v = params[p.key];
      if (p.kind === 'hours') {
        const arr = Array.isArray(v) ? (v as number[]) : [];
        return `${p.label}：${arr.length > 0 ? arr.map((h) => `${String(h).padStart(2, '0')}:00`).join('、') : '未设置'}`;
      }
      return `${p.label}：${v ?? '—'}`;
    })
    .join(' · ');
}

export default function RulesPage() {
  const [meta, setMeta] = useState<RuleTypeMeta[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null);
  const [violations, setViolations] = useState<ViolationRow[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [templates, setTemplates] = useState<RuleTemplate[]>([]);
  const [suggestTrades, setSuggestTrades] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  // 新建规则表单
  const [newType, setNewType] = useState('MAX_LOSS_PER_TRADE');
  const [newName, setNewName] = useState('');
  const [newValue, setNewValue] = useState('');
  const [newHours, setNewHours] = useState<number[]>([]);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const [m, r, tpl] = await Promise.all([
        api<RuleTypeMeta[]>('/rules/meta'),
        api<Rule[]>('/rules'),
        api<RuleTemplate[]>('/rules/templates'),
      ]);
      setMeta(m);
      setRules(r);
      setTemplates(tpl);
      if (m.length > 0 && !newName) setNewType(m[0].type);
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }, [newName]);

  useEffect(() => {
    void load();
  }, [load]);

  async function evaluate() {
    setBusy(true);
    setMessage(null);
    try {
      const [ev, vio] = await Promise.all([
        api<Evaluation>('/rules/evaluate', { method: 'POST' }),
        api<ViolationRow[]>('/rules/violations'),
      ]);
      setEvaluation(ev);
      setViolations(vio);
      setMessage({
        ok: true,
        text: `评估完成：${ev.trades} 笔交易 / ${ev.enabledRules} 条启用规则 → ${ev.total} 条违规，涉及 ${ev.affectedTrades} 笔交易（${(ev.shareOfTrades * 100).toFixed(1)}%）`,
      });
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  async function loadSuggestions() {
    setBusy(true);
    try {
      const r = await api<{ trades: number; suggestions: Suggestion[] }>('/rules/suggest');
      setSuggestions(r.suggestions);
      setSuggestTrades(r.trades);
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  async function applySuggestions() {
    if (!window.confirm('将用推荐阈值替换当前全部规则（旧规则与其违规记录会被删除），确认？')) return;
    setBusy(true);
    setMessage(null);
    try {
      const r = await api<{ rules: Rule[]; evaluation: Evaluation }>('/rules/apply-suggestions', {
        method: 'POST',
      });
      setRules(r.rules);
      setEvaluation(r.evaluation);
      setSuggestions(null);
      const vio = await api<ViolationRow[]>('/rules/violations');
      setViolations(vio);
      setMessage({
        ok: true,
        text: `已采用 ${r.rules.length} 条推荐阈值 → ${r.evaluation.total} 条违规，涉及 ${r.evaluation.affectedTrades} 笔交易（${(r.evaluation.shareOfTrades * 100).toFixed(1)}%）`,
      });
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    const m = meta.find((x) => x.type === newType);
    if (!m) return;
    const params: Record<string, unknown> = {};
    for (const p of m.params) {
      if (p.kind === 'hours') params[p.key] = newHours;
      else {
        const n = Number(newValue);
        if (!Number.isFinite(n)) {
          setMessage({ ok: false, text: `请填写有效的${p.label}` });
          return;
        }
        params[p.key] = n;
      }
    }
    setBusy(true);
    try {
      await api('/rules', {
        method: 'POST',
        body: JSON.stringify({ name: newName.trim() || m.label, type: newType, params }),
      });
      setNewName('');
      setNewValue('');
      setNewHours([]);
      await load();
      setMessage({ ok: true, text: '规则已创建，点「评估并标记」生效' });
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  /** 一键应用模板：直接用模板默认参数创建一条启用中的规则 */
  async function applyTemplate(tpl: RuleTemplate) {
    if (rules.some((r) => r.type === tpl.type)) {
      if (!window.confirm(`已存在同类型规则「${rules.find((r) => r.type === tpl.type)?.name}」，仍要再加一条吗？`)) return;
    }
    setBusy(true);
    try {
      await api('/rules', {
        method: 'POST',
        body: JSON.stringify({ name: tpl.name, type: tpl.type, params: tpl.params }),
      });
      await load();
      setMessage({ ok: true, text: `已应用模板「${tpl.name}」，点「评估并标记」生效` });
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  async function toggle(r: Rule) {
    setBusy(true);
    try {
      await api(`/rules/${r.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !r.enabled }) });
      await load();
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  async function remove(r: Rule) {
    if (!window.confirm(`删除规则「${r.name}」及其违规记录？`)) return;
    setBusy(true);
    try {
      await api(`/rules/${r.id}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  const inputCls = 'w-full rounded border border-line bg-surface px-2 py-1.5 text-sm';
  const labelCls = 'block text-xs text-slate-500 mb-1';
  const selectedMeta = meta.find((x) => x.type === newType);

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-medium">交易规则与违规标记</h2>
      <p className="text-sm text-slate-400">
        把纪律固化成可量化阈值，逐笔自动打标违规。规则只做<b className="text-slate-300">复盘判定</b>，不干预下单。
      </p>

      {message ? (
        <div className={`rounded px-3 py-2 text-sm ${message.ok ? 'bg-up/10 text-up' : 'bg-down/10 text-down'}`}>
          {message.text}
        </div>
      ) : null}

      {/* 推荐阈值 */}
      <Section
        title="按你的历史推荐阈值"
        actions={
          <div className="flex gap-2">
            <button
              onClick={loadSuggestions}
              disabled={busy}
              className="rounded border border-line px-2.5 py-1 text-xs text-slate-300 hover:border-slate-500 disabled:opacity-40"
            >
              生成推荐
            </button>
            <button
              onClick={applySuggestions}
              disabled={busy || !suggestions || suggestions.length === 0}
              className="rounded bg-sky-600 px-2.5 py-1 text-xs text-white hover:bg-sky-500 disabled:opacity-40"
            >
              采用推荐（替换现有）
            </button>
          </div>
        }
      >
        <p className="mb-3 text-xs text-slate-500">
          写死的通用阈值在你的账户上可能命中 99% 的交易，等于没标。这里用分位数（P90）取「比你现状好一点、但够得着」的线。
        </p>
        {suggestions ? (
          <div className="space-y-2">
            <p className="text-xs text-slate-400">
              基于 <b className="text-slate-200">{suggestTrades}</b> 笔交易生成 {suggestions.length} 条建议：
            </p>
            {suggestions.map((s) => (
              <div key={s.type} className="rounded border border-line/70 bg-surface/60 px-3 py-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-slate-200">
                    {s.name}
                    <span className={`ml-2 rounded px-1.5 py-0.5 text-[11px] ${s.enabled ? 'bg-up/15 text-up' : 'bg-slate-700/60 text-slate-400'}`}>
                      {s.enabled ? '建议启用' : '建议关闭'}
                    </span>
                  </span>
                  <span className="text-xs text-slate-500">预计命中 {s.estimatedHits} 笔</span>
                </div>
                <p className="mt-1 text-xs text-slate-500">{s.rationale}</p>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-slate-600">点「生成推荐」查看基于你真实数据的阈值建议。</p>
        )}
      </Section>

      {/* 规则列表 */}
      <Section
        title={`规则列表（${rules.length}）`}
        actions={
          <button
            onClick={evaluate}
            disabled={busy}
            className="rounded bg-sky-600 px-2.5 py-1 text-xs text-white hover:bg-sky-500 disabled:opacity-40"
          >
            {busy ? '处理中…' : '评估并标记'}
          </button>
        }
      >
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500">
              <th className="pb-2 font-normal">规则</th>
              <th className="pb-2 font-normal">类型</th>
              <th className="pb-2 font-normal">阈值</th>
              <th className="pb-2 font-normal">状态</th>
              <th className="pb-2 font-normal text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => {
              const m = meta.find((x) => x.type === r.type);
              return (
                <tr key={r.id} className="border-t border-line/60">
                  <td className="py-2 text-slate-200">{r.name}</td>
                  <td className="py-2 text-xs text-slate-400">{m?.label ?? r.type}</td>
                  <td className="py-2 text-xs text-slate-400">{paramSummary(r.type, r.params, meta)}</td>
                  <td className="py-2">
                    <button
                      onClick={() => toggle(r)}
                      disabled={busy}
                      className={`rounded px-1.5 py-0.5 text-xs disabled:opacity-40 ${
                        r.enabled ? 'bg-up/15 text-up' : 'bg-slate-700/60 text-slate-400'
                      }`}
                    >
                      {r.enabled ? '启用' : '停用'}
                    </button>
                  </td>
                  <td className="py-2 text-right">
                    <button
                      onClick={() => remove(r)}
                      disabled={busy}
                      className="rounded border border-line px-2 py-1 text-xs text-slate-400 hover:text-down disabled:opacity-40"
                    >
                      删除
                    </button>
                  </td>
                </tr>
              );
            })}
            {rules.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-6 text-center text-slate-500">
                  暂无规则，可用上方「生成推荐」一键创建
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </Section>

      {/* 规则模板库 */}
      <Section title="规则模板库（一键应用）">
        <p className="mb-3 text-xs text-slate-500">
          不想自己填参数？这里按规则类型给出可直接用的默认阈值。标记
          <span className="mx-1 rounded bg-emerald-500/15 px-1.5 py-0.5 text-emerald-300">推荐</span>
          的三条（单笔最大亏损 / 单日最大亏损 / 最大杠杆）是绝大多数账户的起步配置。
        </p>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {templates.map((t) => {
            const m = meta.find((x) => x.type === t.type);
            const existing = rules.filter((r) => r.type === t.type).length;
            return (
              <div key={t.key} className="flex flex-col rounded-lg border border-line bg-surface p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="text-sm text-slate-200">{t.name}</div>
                  {t.recommended ? (
                    <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[11px] text-emerald-300">推荐</span>
                  ) : null}
                </div>
                <p className="mt-1 flex-1 text-xs text-slate-500">{t.description}</p>
                <div className="mt-2 text-[11px] text-slate-500">
                  默认参数：
                  <span className="text-slate-300">
                    {m ? paramSummary(t.type, t.params, meta) : JSON.stringify(t.params)}
                  </span>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => applyTemplate(t)}
                    disabled={busy}
                    className="rounded bg-sky-600/85 px-2.5 py-1 text-xs text-white hover:bg-sky-500 disabled:opacity-40"
                  >
                    应用模板
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setNewType(t.type);
                      setNewName(t.name);
                      const m2 = meta.find((x) => x.type === t.type);
                      const num = m2?.params.find((p) => p.kind === 'number');
                      if (num) setNewValue(String(t.params[num.key] ?? ''));
                      const hr = m2?.params.find((p) => p.kind === 'hours');
                      if (hr) setNewHours((t.params[hr.key] as number[]) ?? []);
                      window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
                    }}
                    disabled={busy}
                    className="rounded border border-line px-2.5 py-1 text-xs text-slate-300 hover:border-slate-500"
                  >
                    载入表单
                  </button>
                  {existing > 0 ? <span className="text-[11px] text-slate-600">已有 {existing} 条</span> : null}
                </div>
              </div>
            );
          })}
          {templates.length === 0 ? <p className="text-xs text-slate-500">加载中…</p> : null}
        </div>
      </Section>

      {/* 新建规则 */}
      <Section title="新建规则">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <div>
            <label className={labelCls}>规则类型</label>
            <select value={newType} onChange={(e) => setNewType(e.target.value)} className={inputCls}>
              {meta.map((m) => (
                <option key={m.type} value={m.type}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>名称</label>
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={selectedMeta?.label ?? ''}
              className={inputCls}
            />
          </div>
          {selectedMeta?.params[0]?.kind === 'hours' ? (
            <div className="md:col-span-2">
              <label className={labelCls}>{selectedMeta.params[0].label}（可多选）</label>
              <div className="flex flex-wrap gap-1">
                {HOURS.map((h) => (
                  <button
                    key={h}
                    onClick={() => setNewHours((prev) => (prev.includes(h) ? prev.filter((x) => x !== h) : [...prev, h].sort((a, b) => a - b)))}
                    className={`rounded px-1.5 py-0.5 text-xs ${
                      newHours.includes(h) ? 'bg-sky-600 text-white' : 'bg-surface text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {String(h).padStart(2, '0')}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div>
              <label className={labelCls}>{selectedMeta?.params[0]?.label ?? '阈值'}</label>
              <input
                type="number"
                value={newValue}
                onChange={(e) => setNewValue(e.target.value)}
                placeholder={String(selectedMeta?.params[0]?.default ?? '')}
                className={inputCls}
              />
            </div>
          )}
          <div className="flex items-end">
            <button
              onClick={create}
              disabled={busy}
              className="w-full rounded bg-sky-600 px-3 py-1.5 text-sm text-white hover:bg-sky-500 disabled:opacity-40"
            >
              添加规则
            </button>
          </div>
        </div>
        {selectedMeta ? <p className="mt-2 text-xs text-slate-500">{selectedMeta.description}</p> : null}
      </Section>

      {/* 评估结果 */}
      {evaluation ? (
        <Section title="评估结果">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <div className="rounded border border-line bg-surface px-3 py-2">
              <div className="text-xs text-slate-500">违规条数</div>
              <div className="text-lg text-slate-100">{evaluation.total}</div>
            </div>
            <div className="rounded border border-line bg-surface px-3 py-2">
              <div className="text-xs text-slate-500">涉及交易</div>
              <div className="text-lg text-slate-100">
                {evaluation.affectedTrades}
                <span className="ml-1 text-xs text-slate-500">（{(evaluation.shareOfTrades * 100).toFixed(1)}%）</span>
              </div>
            </div>
            <div className="rounded border border-line bg-surface px-3 py-2">
              <div className="text-xs text-slate-500">违规交易合计盈亏</div>
              <div className="text-lg">
                <PnlText value={evaluation.violationPnl} />
              </div>
            </div>
            <div className="rounded border border-line bg-surface px-3 py-2">
              <div className="text-xs text-slate-500">启用规则</div>
              <div className="text-lg text-slate-100">
                {evaluation.enabledRules} / {evaluation.rules}
              </div>
            </div>
          </div>

          {evaluation.byRule.length > 0 ? (
            <table className="mt-4 w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500">
                  <th className="pb-2 font-normal">规则</th>
                  <th className="pb-2 font-normal text-right">命中</th>
                  <th className="pb-2 font-normal text-right">命中交易盈亏</th>
                </tr>
              </thead>
              <tbody>
                {evaluation.byRule.map((b) => (
                  <tr key={b.ruleId} className="border-t border-line/60">
                    <td className="py-1.5 text-slate-200">{b.ruleName}</td>
                    <td className="py-1.5 text-right text-slate-300">{b.count}</td>
                    <td className="py-1.5 text-right">
                      <PnlText value={b.pnl} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </Section>
      ) : null}

      {/* 违规明细 */}
      <Section title={`违规明细（${violations.length}）`}>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500">
              <th className="pb-2 font-normal">交易</th>
              <th className="pb-2 font-normal">开仓（UTC）</th>
              <th className="pb-2 font-normal text-right">盈亏</th>
              <th className="pb-2 font-normal">命中规则</th>
              <th className="pb-2 font-normal">原因</th>
            </tr>
          </thead>
          <tbody>
            {violations.map((v) => (
              <tr key={v.id} className="border-t border-line/60">
                <td className="py-1.5 text-slate-200">
                  {v.trade ? (
                    <Link href={`/trades/${v.tradeId}`} className="hover:underline">
                      {v.trade.symbol} <span className="text-xs text-slate-500">{v.trade.positionSide}</span>
                    </Link>
                  ) : (
                    <span className="text-slate-500">交易已删除</span>
                  )}
                </td>
                <td className="py-1.5 text-xs text-slate-400" title="北京时间">
                  {v.trade ? fmtTs(v.trade.openTime) : '—'}
                </td>
                <td className="py-1.5 text-right">
                  {v.trade ? <PnlText value={v.trade.netPnl} /> : '—'}
                </td>
                <td className="py-1.5 text-xs text-slate-300">{v.ruleName}</td>
                <td className="py-1.5 text-xs text-slate-400">{v.detail}</td>
              </tr>
            ))}
            {violations.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-6 text-center text-slate-500">
                  暂无违规记录，点「评估并标记」生成
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        {violations.length >= 200 ? (
          <p className="mt-2 text-xs text-slate-600">仅展示最近 200 条。</p>
        ) : null}
      </Section>
    </div>
  );
}
