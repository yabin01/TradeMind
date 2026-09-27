import { execFile } from 'node:child_process';
import { createHmac } from 'node:crypto';

/**
 * OKX v5 REST 客户端（MVP）。
 * 传输层用 curl 子进程走本地代理（本机 Python requests 经代理访问 OKX 会 502，curl 实测正常）。
 * 代理可通过 OKX_PROXY 环境变量覆盖；设为 "direct" 则直连。
 * 签名规则：OK-ACCESS-SIGN = Base64(HMAC-SHA256(secret, timestamp + method + requestPath + body))。
 * 文档：https://www.okx.com/docs-v5/en/  GET /api/v5/account/positions-history
 */

export type OkxCredentials = {
  apiKey: string;
  secretKey: string;
  passphrase: string;
  /** 0 = 实盘（默认），1 = 模拟盘 */
  flag?: '0' | '1';
};

export type OkxResponse<T> = { code: string; msg: string; data: T };

const CURL =
  process.platform === 'win32' && process.env.SystemRoot
    ? `${process.env.SystemRoot}\\System32\\curl.exe`
    : (process.env.CURL_PATH ?? 'curl');

function proxyArgs(): string[] {
  const proxy = process.env.OKX_PROXY ?? 'http://127.0.0.1:7890';
  return proxy && proxy !== 'direct' ? ['-x', proxy] : [];
}

function curlJson(url: string, headers: string[] = []): Promise<unknown> {
  const args = [
    '-sS',
    '-m',
    '30',
    '--ssl-no-revoke',
    '--retry',
    '5',
    '--retry-all-errors',
    '--retry-delay',
    '1',
    '--retry-max-time',
    '60',
    ...proxyArgs(),
    url,
    ...headers.flatMap((h) => ['-H', h]),
  ];
  return new Promise((resolve, reject) => {
    execFile(CURL, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`curl 失败: ${err.message}${stderr ? ` | ${stderr.trim()}` : ''}`));
      try {
        resolve(JSON.parse(stdout) as unknown);
      } catch {
        reject(new Error(`OKX 返回非 JSON：${stdout.slice(0, 200)}`));
      }
    });
  });
}

function sign(secretKey: string, timestamp: string, method: string, requestPath: string, body = ''): string {
  return createHmac('sha256', secretKey).update(`${timestamp}${method}${requestPath}${body}`).digest('base64');
}

function authHeaders(cred: OkxCredentials, method: string, requestPath: string): string[] {
  const timestamp = new Date().toISOString(); // 2026-09-26T06:08:49.123Z
  const headers = [
    `OK-ACCESS-KEY: ${cred.apiKey}`,
    `OK-ACCESS-SIGN: ${sign(cred.secretKey, timestamp, method, requestPath)}`,
    `OK-ACCESS-TIMESTAMP: ${timestamp}`,
    `OK-ACCESS-PASSPHRASE: ${cred.passphrase}`,
  ];
  if (cred.flag === '1') headers.push('x-simulated-trading: 1');
  return headers;
}

async function okxGet<T>(requestPath: string, cred: OkxCredentials): Promise<T> {
  const res = (await curlJson(`https://www.okx.com${requestPath}`, authHeaders(cred, 'GET', requestPath))) as OkxResponse<T>;
  if (res.code !== '0') throw new Error(`OKX ${res.code}: ${res.msg || '请求失败'}`);
  return res.data;
}

/** 带 body 的签名请求（用于权限探测：参数必然非法，不可能成交） */
async function okxPostRaw(
  requestPath: string,
  cred: OkxCredentials,
  body: string,
): Promise<OkxResponse<unknown>> {
  const timestamp = new Date().toISOString();
  const headers = [
    `OK-ACCESS-KEY: ${cred.apiKey}`,
    `OK-ACCESS-SIGN: ${sign(cred.secretKey, timestamp, 'POST', requestPath, body)}`,
    `OK-ACCESS-TIMESTAMP: ${timestamp}`,
    `OK-ACCESS-PASSPHRASE: ${cred.passphrase}`,
    'Content-Type: application/json',
  ];
  if (cred.flag === '1') headers.push('x-simulated-trading: 1');
  const args = [
    '-sS',
    '-m',
    '30',
    ...proxyArgs(),
    `https://www.okx.com${requestPath}`,
    ...headers.flatMap((h) => ['-H', h]),
    '-X',
    'POST',
    '--data-binary',
    body,
  ];
  const raw = await new Promise<string>((resolve, reject) => {
    execFile(CURL, args, { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`curl 失败: ${err.message}${stderr ? ` | ${stderr.trim()}` : ''}`));
      resolve(stdout);
    });
  });
  try {
    return JSON.parse(raw) as OkxResponse<unknown>;
  } catch {
    return { code: '-1', msg: `非 JSON 响应：${raw.slice(0, 200)}`, data: null };
  }
}

/**
 * 无权限错误码（实测）：
 *   POST /api/v5/trade/order   -> code 50120 "This API key doesn't have permission to use this function"
 * 只有「密钥本身有效但没有该权限」才会返回 50120；有权限时返回的是参数类错误码。
 */
const NO_PERMISSION_CODE = '50120';

export interface PermissionProbe {
  /** 三项权限都不可用 → 视为只读密钥（TradeMind 只需要读权限） */
  readOnly: boolean;
  read: { ok: boolean; code?: string; msg?: string };
  trade: { granted: boolean; code?: string; msg?: string };
  withdraw: { granted: boolean; code?: string; msg?: string };
  checkedAt: string;
}

/**
 * 只读校验：确认密钥「可读 + 不可交易 + 不可提币」。
 *
 * 探测方式：向交易/提币接口发送**必然被参数校验拒绝**的请求（sz=0 / 空参数），
 * 因此不可能真的下单或提币。
 *   - 返回 50120 → 密钥无该权限（安全）
 *   - 返回其他码（参数错误等）→ 说明权限校验已通过，密钥**具备**该权限（风险）
 */
export async function probePermissions(cred: OkxCredentials): Promise<PermissionProbe> {
  const checkedAt = new Date().toISOString();

  // 1) 读权限：账户余额
  let read: PermissionProbe['read'];
  try {
    await okxGet<unknown[]>('/api/v5/account/balance?ccy=USDT', cred);
    read = { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    read = { ok: false, msg };
  }

  // 2) 交易权限：sz="0" 必然参数失败，不可能成交
  let trade: PermissionProbe['trade'];
  try {
    const p = '/api/v5/trade/order';
    const body = JSON.stringify({
      instId: 'BTC-USDT-SWAP',
      tdMode: 'cross',
      side: 'buy',
      ordType: 'limit',
      sz: '0',
      px: '1',
    });
    const res = await okxPostRaw(p, cred, body);
    trade = { granted: res.code !== NO_PERMISSION_CODE, code: res.code, msg: res.msg };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    trade = { granted: false, msg };
  }

  // 3) 提币权限：空参数必然失败
  let withdraw: PermissionProbe['withdraw'];
  try {
    const p = '/api/v5/asset/withdrawal';
    const body = JSON.stringify({ ccy: 'USDT', amt: '0', dest: '4', toAddr: '' });
    const res = await okxPostRaw(p, cred, body);
    withdraw = { granted: res.code !== NO_PERMISSION_CODE, code: res.code, msg: res.msg };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    withdraw = { granted: false, msg };
  }

  return {
    readOnly: read.ok && !trade.granted && !withdraw.granted,
    read,
    trade,
    withdraw,
    checkedAt,
  };
}

/** 公共行情接口（无需签名）：instId -> 每张合约面值（ctVal） */
export async function fetchSwapCtValMap(): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    const res = (await curlJson('https://www.okx.com/api/v5/public/instruments?instType=SWAP')) as OkxResponse<
      { instId: string; ctVal: string }[]
    >;
    if (res.code === '0') for (const it of res.data) map.set(it.instId, Number(it.ctVal) || 1);
  } catch {
    // 拉不到面值就退化为「张」为单位，不阻断同步
  }
  return map;
}

/** 仓位历史单条记录（OKX 原始字符串字段） */
export type OkxPositionHistoryRow = {
  posId: string;
  instType: string;
  instId: string;
  mgnMode: string;
  type: string; // 1 部分平仓 2 全部平仓 3 强平 4 部分强平 5 ADL未全平 6 ADL全平
  direction: string; // long | short
  posSide: string; // long | short | net
  openAvgPx: string;
  closeAvgPx: string;
  closeTotalPos: string;
  openMaxPos: string;
  lever: string;
  realizedPnl: string;
  pnl: string;
  fee: string;
  fundingFee: string;
  liqPenalty: string;
  settledPnl: string;
  pnlRatio: string;
  ccy: string;
  cTime: string;
  uTime: string;
};

/**
 * 实时持仓单条记录（GET /api/v5/account/positions）。
 * OKX 原始字段均为字符串；空仓时接口通常返回 `pos = "0"` 的记录（前端/服务端需过滤）。
 */
export type OkxPositionRow = {
  instType: string;
  mgnMode: string; // cross | isolated
  posId: string;
  posSide: string; // long | short | net
  pos: string; // 持仓张数（合约）
  baseCcy: string;
  quoteCcy: string;
  ccy: string;
  avgPx: string;
  markPx: string;
  upl: string; // 未实现盈亏（USDT）
  uplRatio: string; // 未实现收益率
  lever: string;
  liqPx: string; // 预估强平价
  imr: string;
  margin: string; // 保证金
  mmr: string;
  notionalUsd: string;
  adl: string;
  last: string;
  cTime: string; // 建仓时间（ms）
  uTime: string; // 最新更新时间（ms）
  instId: string;
};

/**
 * 拉取当前未平仓的 USDT 永续持仓。
 * 过滤掉 pos = 0 的空记录（OKX 会在开过仓后保留 0 张记录）。
 */
export async function fetchOpenPositions(
  cred: OkxCredentials,
  opts: { instType?: string } = {},
): Promise<OkxPositionRow[]> {
  const instType = opts.instType ?? 'SWAP';
  const rows = await okxGet<OkxPositionRow[]>(`/api/v5/account/positions?instType=${instType}`, cred);
  if (!Array.isArray(rows)) return [];
  return rows.filter((r) => Math.abs(Number(r.pos) || 0) > 0);
}

/**
 * 拉取 USDT 永续已平仓仓位历史（最近 3 个月内）。
 * 返回按 uTime 倒序；分页用 after=上一页最早 uTime，直到取完或达到 maxPages。
 */
export async function fetchPositionsHistory(
  cred: OkxCredentials,
  opts: { instType?: string; maxPages?: number } = {},
): Promise<OkxPositionHistoryRow[]> {
  const instType = opts.instType ?? 'SWAP';
  const maxPages = opts.maxPages ?? 30;
  const out: OkxPositionHistoryRow[] = [];
  const seen = new Set<string>();
  let after = '';
  for (let page = 0; page < maxPages; page++) {
    const qs = `/api/v5/account/positions-history?instType=${instType}&limit=100${after ? `&after=${after}` : ''}`;
    const rows = await okxGet<OkxPositionHistoryRow[]>(qs, cred);
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const r of rows) {
      const key = `${r.posId}:${r.uTime}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(r);
      }
    }
    if (rows.length < 100) break;
    const oldest = rows[rows.length - 1].uTime;
    // 游标未推进（同一 uTime 的记录会被整批返回），避免死循环
    if (!oldest || oldest === after) break;
    after = oldest;
  }
  return out;
}
