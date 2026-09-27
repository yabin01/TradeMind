'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, getWorkspaceId, setWorkspaceId } from '../../lib/api';
import { fmtTs, fmtTsDate } from '../../lib/format';
import { Section } from '../../components/ui';
import { AppearanceSettings } from '../../components/appearance-settings';
import { ExchangeBindForm } from '../../components/exchange-bind-form';

type PermissionProbe = {
  readOnly: boolean;
  read: { ok: boolean; msg?: string };
  trade: { granted: boolean; code?: string; msg?: string };
  withdraw: { granted: boolean; code?: string; msg?: string };
  checkedAt: string;
};

type Connection = {
  id: string;
  exchange: string;
  name: string;
  status: string;
  lastSyncAt: string | null;
  createdAt: string;
  credentials: { apiKeyMasked: string | null; mode: string; walletAddressMasked?: string | null };
  autoSync?: boolean;
  syncIntervalMin?: number;
  lastError?: string | null;
  permissions?: PermissionProbe | null;
};

const INTERVALS = [15, 30, 60, 180, 360];

const STATUS_LABEL: Record<string, { text: string; cls: string }> = {
  CONNECTED: { text: '已连接', cls: 'bg-sky-500/15 text-sky-400' },
  SYNCING: { text: '同步中', cls: 'bg-amber-500/15 text-amber-400' },
  SUCCESS: { text: '同步成功', cls: 'bg-up/15 text-up' },
  FAILED: { text: '同步失败', cls: 'bg-down/15 text-down' },
};

const EXCHANGE_LABEL: Record<string, string> = {
  OKX: 'OKX',
  HYPERLIQUID: 'Hyperliquid',
};

export default function SettingsPage() {
  const [ws, setWs] = useState('');

  // 连接列表
  const [conns, setConns] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => setWs(getWorkspaceId()), []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setConns(await api<Connection[]>('/connections'));
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function sync(id: string) {
    setBusyId(id);
    setMessage(null);
    try {
      const r = await api<{
        fetched: number;
        inserted: number;
        skipped: number;
        fills?: number;
        truncated?: boolean;
        openPositions?: number;
        oldestCloseTime?: string | null;
      }>(`/connections/${id}/sync`, { method: 'POST' });
      const parts =
        r.fills != null
          ? [`成交 ${r.fills} 笔重建出 ${r.fetched} 笔往返交易`, `新增 ${r.inserted} 笔`, `跳过重复 ${r.skipped} 笔`]
          : [`拉取 ${r.fetched} 笔已平仓仓位`, `新增 ${r.inserted} 笔`, `跳过重复 ${r.skipped} 笔`];
      // 链上账户的历史常远早于交易记录默认的「近 90 天」窗口，这里主动提醒，
      // 否则用户同步完去交易记录会以为「没同步进来」。
      const oldestMs = r.oldestCloseTime ? new Date(r.oldestCloseTime).getTime() : NaN;
      const olderThanWindow = Number.isFinite(oldestMs) && oldestMs < Date.now() - 90 * 86_400_000;
      setMessage({
        ok: true,
        text: `同步完成：${parts.join('，')}${r.openPositions != null ? `；当前未平仓 ${r.openPositions} 个` : ''}${
          r.truncated ? '（成交笔数较多，仅覆盖了最近一段历史）' : ''
        }${
          olderThanWindow
            ? `。⚠ 最早一笔在 ${fmtTsDate(r.oldestCloseTime!)}，超出「交易记录」默认的近 90 天范围，可在该页筛选里把时间切成「全部」查看`
            : ''
        }`,
      });
      await load();
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) });
      await load();
    } finally {
      setBusyId(null);
    }
  }

  /** 只读校验：确认密钥可读、不可下单、不可提币 */
  async function validate(id: string) {
    setBusyId(id);
    setMessage(null);
    try {
      const r = await api<{ permissions: PermissionProbe; warnings: string[] }>(
        `/connections/${id}/validate`,
        { method: 'POST' },
      );
      const p = r.permissions;
      const tag = p.readOnly ? '只读密钥（安全）' : '⚠️ 非只读密钥';
      setMessage({
        ok: p.readOnly,
        text: `${tag} · 读取 ${p.read.ok ? '可用' : '不可用'} · 下单 ${p.trade.granted ? '允许' : '禁止'} · 提币 ${p.withdraw.granted ? '允许' : '禁止'}${
          r.warnings.length > 0 ? `。${r.warnings.join(' ')}` : ''
        }`,
      });
      await load();
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusyId(null);
    }
  }

  async function setAutoSync(id: string, patch: { autoSync?: boolean; syncIntervalMin?: number }) {
    setBusyId(id);
    setMessage(null);
    try {
      await api(`/connections/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
      await load();
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusyId(null);
    }
  }

  async function remove(id: string) {
    if (!window.confirm('删除连接会同时删除该连接同步的交易，确认删除？')) return;
    setBusyId(id);
    try {
      await api(`/connections/${id}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-medium">设置</h2>

      <Section title="交易所连接">
        <ExchangeBindForm onCreated={load} />
        <p className="mt-3 text-xs text-slate-600">
          OKX 走本机代理 <code className="text-slate-400">127.0.0.1:7890</code> 访问，IP 白名单请填代理出口
          IP；密钥明文存于本地数据库，请勿复用带交易权限的 Key。Hyperliquid 读取公开链上数据，无需任何密钥。
        </p>

        {message ? (
          <div className={`mt-3 rounded px-3 py-2 text-xs ${message.ok ? 'bg-up/10 text-up' : 'bg-down/10 text-down'}`}>
            {message.text}
          </div>
        ) : null}

        <div className="mt-4">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500">
                <th className="pb-2 font-normal">名称</th>
                <th className="pb-2 font-normal">交易所</th>
                <th className="pb-2 font-normal">标识</th>
                <th className="pb-2 font-normal">权限</th>
                <th className="pb-2 font-normal">状态</th>
                <th className="pb-2 font-normal">自动同步</th>
                <th className="pb-2 font-normal">最近同步</th>
                <th className="pb-2 font-normal text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {conns.map((c) => {
                const st = STATUS_LABEL[c.status] ?? { text: c.status, cls: 'bg-slate-500/15 text-slate-400' };
                return (
                  <tr key={c.id} className="border-t border-line/60">
                    <td className="py-2">{c.name}</td>
                    <td className="py-2 text-xs text-slate-300">{EXCHANGE_LABEL[c.exchange] ?? c.exchange}</td>
                    <td className="py-2 font-mono text-xs text-slate-400">
                      <div>{c.credentials.apiKeyMasked ?? '—'}</div>
                      <div className="text-[11px] text-slate-600">{c.credentials.mode}</div>
                    </td>
                    <td className="py-2">
                      {c.permissions ? (
                        <span
                          className={`rounded px-1.5 py-0.5 text-xs ${
                            c.permissions.readOnly
                              ? 'bg-up/15 text-up'
                              : 'bg-down/15 text-down'
                          }`}
                          title={
                            `读取：${c.permissions.read.ok ? '可用' : '不可用'}\n` +
                            `下单：${c.permissions.trade.granted ? '允许' : '禁止'}\n` +
                            `提币：${c.permissions.withdraw.granted ? '允许' : '禁止'}\n` +
                            `探测时间：${fmtTs(c.permissions.checkedAt, true)}`
                          }
                        >
                          {c.permissions.readOnly ? '只读 ✓' : '有风险 ⚠'}
                        </span>
                      ) : (
                        <span className="text-xs text-slate-600">未校验</span>
                      )}
                    </td>
                    <td className="py-2">
                      <span className={`rounded px-1.5 py-0.5 text-xs ${st.cls}`}>{st.text}</span>
                      {c.lastError ? (
                        <div className="mt-1 max-w-[16rem] truncate text-[11px] text-down" title={c.lastError}>
                          {c.lastError}
                        </div>
                      ) : null}
                    </td>
                    <td className="py-2">
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() => setAutoSync(c.id, { autoSync: !c.autoSync })}
                          disabled={busyId === c.id}
                          className={`rounded px-1.5 py-0.5 text-xs disabled:opacity-40 ${
                            c.autoSync ? 'bg-up/15 text-up' : 'bg-slate-700/60 text-slate-400'
                          }`}
                          title="开启后调度器会按间隔自动增量同步（幂等，不会重复入库）"
                        >
                          {c.autoSync ? '已开启' : '已关闭'}
                        </button>
                        <select
                          value={c.syncIntervalMin ?? 15}
                          onChange={(e) => setAutoSync(c.id, { syncIntervalMin: Number(e.target.value) })}
                          disabled={busyId === c.id || !c.autoSync}
                          className="rounded border border-line bg-surface px-1 py-0.5 text-xs disabled:opacity-40"
                        >
                          {INTERVALS.map((m) => (
                            <option key={m} value={m}>
                              {m >= 60 ? `${m / 60}h` : `${m}m`}
                            </option>
                          ))}
                        </select>
                      </div>
                    </td>
                    <td className="py-2 text-xs text-slate-400">
                      {c.lastSyncAt ? fmtTs(c.lastSyncAt, true) : '—'}
                    </td>
                    <td className="py-2 text-right">
                      <button
                        onClick={() => sync(c.id)}
                        disabled={busyId === c.id || c.status === 'SYNCING'}
                        className="mr-2 rounded bg-sky-600/80 px-2 py-1 text-xs text-white hover:bg-sky-500 disabled:opacity-40"
                      >
                        {busyId === c.id ? '处理中…' : '同步'}
                      </button>
                      <button
                        onClick={() => validate(c.id)}
                        disabled={busyId === c.id}
                        className="mr-2 rounded border border-line px-2 py-1 text-xs text-slate-300 hover:border-slate-500 disabled:opacity-40"
                        title="探测该密钥是否只读（不会下单，请求参数必然被拒）"
                      >
                        校验权限
                      </button>
                      <button
                        onClick={() => remove(c.id)}
                        disabled={busyId === c.id}
                        className="rounded border border-line px-2 py-1 text-xs text-slate-400 hover:text-down disabled:opacity-40"
                      >
                        删除
                      </button>
                    </td>
                  </tr>
                );
              })}
              {!loading && conns.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-6 text-center text-slate-500">
                    尚未绑定交易所，用上方表单绑定 OKX 或 Hyperliquid
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="工作区">
        <label className="block text-xs text-slate-500">Workspace ID（Phase 1 简化鉴权；Phase 2 换 JWT）</label>
        <div className="mt-1 flex gap-2">
          <input value={ws} onChange={(e) => setWs(e.target.value)} className="w-96 rounded border border-line bg-surface px-2 py-1.5 font-mono text-xs" />
          <button onClick={() => setWorkspaceId(ws)} className="rounded bg-sky-600 px-3 py-1.5 text-sm text-white hover:bg-sky-500">保存</button>
        </div>
      </Section>
      <AppearanceSettings />
      <Section title="Session 时区">
        <p className="text-sm text-slate-400">Phase 1 默认 UTC：Asia 00–08 / London 08–16 / New York 13–21（NY 优先）。时区可配置将在 Settings API 中开放。</p>
      </Section>
    </div>
  );
}
