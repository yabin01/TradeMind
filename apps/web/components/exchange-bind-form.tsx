'use client';

import { useState } from 'react';
import { api } from '../lib/api';

export type BindExchange = 'OKX' | 'HYPERLIQUID';

const EXCHANGE_META: Record<BindExchange, { label: string; defaultName: string; hint: React.ReactNode }> = {
  OKX: {
    label: 'OKX',
    defaultName: 'OKX 账户',
    hint: (
      <>
        绑定 OKX API 后可一键同步<b className="text-slate-300"> USDT 永续已平仓仓位</b>（最近 3 个月，含已实现盈亏 /
        手续费 / 资金费）。<b className="text-slate-300">强烈建议只填「只读」权限的 Key</b>（读取 ✔ / 交易 ✘ / 提现
        ✘）——绑定后点「校验权限」即可确认，探测请求的参数必然被拒，不会真的下单。
      </>
    ),
  },
  HYPERLIQUID: {
    label: 'Hyperliquid',
    defaultName: 'Hyperliquid 账户',
    hint: (
      <>
        绑定后同步该地址的<b className="text-slate-300"> 永续成交并自动重建为往返交易</b>（开仓→平仓为一笔，含分批加减仓与
        多空翻转），同时「持仓」页也会显示其实时仓位。
        <b className="text-slate-300"> 只需要钱包地址</b>——Hyperliquid 的行情/成交/持仓都是公开链上数据，
        读取无需 API Key、<span className="text-down">更不需要私钥或助记词，请绝对不要填写它们</span>。
      </>
    ),
  },
};

const inputCls = 'w-full rounded border border-line bg-surface px-2 py-1.5 text-sm';
const labelCls = 'block text-xs text-slate-500 mb-1';

function isValidAddress(v: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(v.trim());
}

export function ExchangeBindForm({
  onCreated,
  showHint = true,
}: {
  onCreated?: () => void;
  showHint?: boolean;
}) {
  const [exchange, setExchange] = useState<BindExchange>('OKX');
  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [flag, setFlag] = useState<'0' | '1'>('0');
  const [walletAddress, setWalletAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const isOkx = exchange === 'OKX';
  const meta = EXCHANGE_META[exchange];
  const canSubmit = isOkx
    ? Boolean(apiKey.trim() && secretKey.trim() && passphrase.trim())
    : isValidAddress(walletAddress);

  async function bind() {
    setBusy(true);
    setMessage(null);
    try {
      await api('/connections', {
        method: 'POST',
        body: JSON.stringify({
          exchange,
          name: name.trim() || meta.defaultName,
          credentials: isOkx
            ? { apiKey: apiKey.trim(), secretKey: secretKey.trim(), passphrase: passphrase.trim(), flag }
            : { walletAddress: walletAddress.trim() },
        }),
      });
      setName('');
      setApiKey('');
      setSecretKey('');
      setPassphrase('');
      setWalletAddress('');
      setMessage({
        ok: true,
        text: isOkx ? '绑定成功，点击「同步」拉取已平仓仓位' : '绑定成功，点击「同步」重建历史往返交易',
      });
      onCreated?.();
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {showHint ? <p className="mb-3 text-xs text-slate-500">{meta.hint}</p> : null}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <div>
          <label className={labelCls}>交易所</label>
          <select
            value={exchange}
            onChange={(e) => {
              setExchange(e.target.value as BindExchange);
              setMessage(null);
            }}
            className={inputCls}
          >
            {(Object.keys(EXCHANGE_META) as BindExchange[]).map((k) => (
              <option key={k} value={k}>
                {EXCHANGE_META[k].label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls}>连接名称</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={meta.defaultName}
            className={inputCls}
          />
        </div>

        {isOkx ? (
          <>
            <div>
              <label className={labelCls}>API Key</label>
              <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} className={`${inputCls} font-mono`} />
            </div>
            <div>
              <label className={labelCls}>Secret Key</label>
              <input
                type="password"
                value={secretKey}
                onChange={(e) => setSecretKey(e.target.value)}
                className={`${inputCls} font-mono`}
              />
            </div>
            <div>
              <label className={labelCls}>Passphrase</label>
              <input
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                className={`${inputCls} font-mono`}
              />
            </div>
            <div>
              <label className={labelCls}>模式</label>
              <select value={flag} onChange={(e) => setFlag(e.target.value as '0' | '1')} className={inputCls}>
                <option value="0">实盘</option>
                <option value="1">模拟盘</option>
              </select>
            </div>
          </>
        ) : (
          <div className="col-span-2">
            <label className={labelCls}>
              钱包地址 <span className="text-slate-600">（0x 开头的 42 位地址，公开信息）</span>
            </label>
            <input
              value={walletAddress}
              onChange={(e) => setWalletAddress(e.target.value)}
              placeholder="0x1234…abcd"
              spellCheck={false}
              className={`${inputCls} font-mono`}
            />
            {walletAddress.trim() && !isValidAddress(walletAddress) ? (
              <div className="mt-1 text-[11px] text-down">地址格式不对，应为 0x + 40 位十六进制字符</div>
            ) : null}
          </div>
        )}

        <div className="flex items-end">
          <button
            onClick={bind}
            disabled={!canSubmit || busy}
            className="w-full rounded bg-sky-600 px-3 py-1.5 text-sm text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? '绑定中…' : `绑定 ${meta.label}`}
          </button>
        </div>
      </div>

      {message ? (
        <div className={`mt-3 rounded px-3 py-2 text-xs ${message.ok ? 'bg-up/10 text-up' : 'bg-down/10 text-down'}`}>
          {message.text}
        </div>
      ) : null}
    </div>
  );
}
