'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, renameConnection } from '../../lib/api';
import { Section } from '../../components/ui';
import { ExchangeBindForm } from '../../components/exchange-bind-form';
import { fmtTsDate } from '../../lib/format';

interface ConnectionRow {
  id: string;
  exchange: string;
  name: string;
  status: string;
  lastSyncAt: string | null;
}

const EXCHANGE_LABEL: Record<string, string> = {
  OKX: 'OKX',
  HYPERLIQUID: 'Hyperliquid',
  CSV: 'CSV',
};

const STATUS_TONE: Record<string, string> = {
  CONNECTED: 'text-up',
  SYNCING: 'text-amber-400',
  SUCCESS: 'text-up',
  FAILED: 'text-down',
  EXPIRED: 'text-slate-500',
};

export default function ConnectionsPage() {
  const qc = useQueryClient();
  const [csv, setCsv] = useState('');
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');

  async function saveName(id: string) {
    const n = editName.trim();
    setEditId(null);
    const cur = (data ?? []).find((x) => x.id === id)?.name;
    if (!n || n === cur) return;
    try {
      await renameConnection(id, n);
      void qc.invalidateQueries({ queryKey: ['connections'] });
      void qc.invalidateQueries({ queryKey: ['facets'] });
    } catch (e) {
      setImportMsg((e as Error).message);
    }
  }

  const { data } = useQuery({ queryKey: ['connections'], queryFn: () => api<ConnectionRow[]>('/connections') });

  async function sync(id: string) {
    setSyncMsg('同步中…');
    try {
      const r = await api<{
        fetched: number;
        inserted: number;
        skipped: number;
        fills?: number;
        truncated?: boolean;
        oldestCloseTime?: string | null;
      }>(`/connections/${id}/sync`, { method: 'POST' });
      // 链上账户历史常早于交易记录默认的近 90 天窗口，主动提醒避免「以为没同步进来」
      const oldestMs = r.oldestCloseTime ? new Date(r.oldestCloseTime).getTime() : NaN;
      const olderHint =
        Number.isFinite(oldestMs) && oldestMs < Date.now() - 90 * 86_400_000
          ? `；⚠ 最早一笔在 ${fmtTsDate(r.oldestCloseTime!)}，超出交易记录默认的近 90 天，去该页把时间切「全部」即可看到`
          : '';
      setSyncMsg(
        (r.fills != null
          ? `完成：成交 ${r.fills} 笔 → 往返交易 ${r.fetched} 笔，新增 ${r.inserted} 笔${r.truncated ? '（仅覆盖最近一段历史）' : ''}`
          : `完成：拉取 ${r.fetched} 笔，新增 ${r.inserted} 笔，跳过 ${r.skipped} 笔`) + olderHint,
      );
      void qc.invalidateQueries({ queryKey: ['connections'] });
      void qc.invalidateQueries();
    } catch (e) {
      setSyncMsg((e as Error).message);
    }
  }

  async function importCsv() {
    setImportMsg('导入中…');
    try {
      const res = await api<{ imported: number; skipped: number; duplicates: number; errors: string[] }>(
        '/trades/import',
        { method: 'POST', body: JSON.stringify({ csv, exchange: 'CSV' }) },
      );
      setImportMsg(`导入 ${res.imported} 笔，跳过重复 ${res.skipped} 笔${res.errors.length > 0 ? `，错误 ${res.errors.length} 条` : ''}`);
      setCsv('');
      void qc.invalidateQueries();
    } catch (e) {
      setImportMsg((e as Error).message);
    }
  }

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-medium">数据源</h2>

      <Section title="新增交易所连接">
        <ExchangeBindForm
          onCreated={() => {
            void qc.invalidateQueries({ queryKey: ['connections'] });
            void qc.invalidateQueries({ queryKey: ['facets'] });
          }}
        />
      </Section>

      <Section title="已连接">
        {syncMsg ? <div className="mb-3 rounded bg-surface px-3 py-2 text-xs text-slate-300">{syncMsg}</div> : null}
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500">
              {['名称', '交易所', '状态', '上次同步', ''].map((h) => <th key={h} className="pb-2 font-normal">{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((c) => (
              <tr key={c.id} className="border-t border-line/60">
                <td className="py-1.5">
                  {editId === c.id ? (
                    <span className="flex items-center gap-1">
                      <input
                        autoFocus
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void saveName(c.id);
                          if (e.key === 'Escape') setEditId(null);
                        }}
                        className="w-40 rounded border border-line bg-surface px-1.5 py-0.5 text-sm text-slate-100"
                      />
                      <button onClick={() => void saveName(c.id)} className="text-xs text-up hover:underline">保存</button>
                      <button onClick={() => setEditId(null)} className="text-xs text-slate-400 hover:underline">取消</button>
                    </span>
                  ) : (
                    <button
                      onClick={() => {
                        setEditId(c.id);
                        setEditName(c.name);
                      }}
                      className="text-slate-200 hover:text-sky-300 hover:underline"
                      title="点击重命名 API"
                    >
                      {c.name}
                    </button>
                  )}
                </td>
                <td className="text-slate-300">{EXCHANGE_LABEL[c.exchange] ?? c.exchange}</td>
                <td className={STATUS_TONE[c.status] ?? 'text-slate-400'}>{c.status}</td>
                <td className="text-slate-400">{c.lastSyncAt ? c.lastSyncAt.slice(0, 19).replace('T', ' ') : '—'}</td>
                <td>
                  <button onClick={() => void sync(c.id)} className="text-xs text-sky-400 hover:underline">同步</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="CSV 导入">
        <textarea
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
          rows={6}
          placeholder={'symbol,side,entryPrice,exitPrice,quantity,openTime,closeTime,fees,strategy,tags\nBTCUSDT,BUY,60000,61000,0.1,2026-09-01 08:00,2026-09-01 10:00,4.8,Breakout,Breakout|NewYork'}
          className="w-full rounded-md border border-line bg-surface p-2 font-mono text-xs text-slate-300"
        />
        <div className="mt-2 flex items-center gap-3">
          <button onClick={importCsv} disabled={!csv.trim()} className="rounded bg-sky-600 px-3 py-1.5 text-sm text-white hover:bg-sky-500 disabled:opacity-50">
            导入
          </button>
          {importMsg ? <span className="text-xs text-slate-400">{importMsg}</span> : null}
        </div>
      </Section>
    </div>
  );
}
