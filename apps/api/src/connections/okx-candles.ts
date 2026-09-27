import { execFile } from 'node:child_process';

/**
 * OKX 公共行情 K 线（免签名）—— 用于回填持仓期间极值（MAE/MFE）与出入场标注图。
 *
 * 接口：GET /api/v5/market/history-candles?instId=&bar=1m&after=&limit=100
 *   - after：返回早于该时间戳的记录；返回按时间倒序（最新在前）
 *   - history-candles 可回溯数年；限速 20 次/2s（我们按 ~8 次/s 限速留余量）
 *   - 行结构：[ots, o, h, l, c, vol, volCcy, volCcyQuote, confirm]
 *
 * 传输层沿用 curl 子进程 + 本地代理（Python requests 经代理访问 OKX 会 502，curl 实测正常）。
 */

export interface Candle {
  ts: number; // ms，K 线开盘时间
  open: number;
  high: number;
  low: number;
  close: number;
  /** 0 = 未完结（仅最新一根可能出现） */
  confirmed: boolean;
}

const CURL =
  process.platform === 'win32' && process.env.SystemRoot
    ? `${process.env.SystemRoot}\\System32\\curl.exe`
    : (process.env.CURL_PATH ?? 'curl');

function proxyArgs(): string[] {
  const proxy = process.env.OKX_PROXY ?? 'http://127.0.0.1:7890';
  return proxy && proxy !== 'direct' ? ['-x', proxy] : [];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function curlJson(url: string): Promise<{ code: string; msg: string; data: string[][] }> {
  // --ssl-no-revoke：Windows schannel 默认做证书吊销检查，经代理时常偶发 TLS 握手失败（curl 35）；关闭可规避。
  // 超时与重试保持「有界」：-m 12 避免长时间挂起；--retry 2 仅兜极短暂瞬故障，避免大量页失败时形成重试风暴。
  const args = [
    '-sS',
    '-m',
    '12',
    '--ssl-no-revoke',
    '--retry',
    '2',
    '--retry-delay',
    '1',
    '--retry-max-time',
    '30',
    ...proxyArgs(),
    url,
  ];
  return new Promise((resolve, reject) => {
    execFile(CURL, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`curl 失败: ${err.message}${stderr ? ` | ${stderr.trim()}` : ''}`));
      try {
        resolve(JSON.parse(stdout) as { code: string; msg: string; data: string[][] });
      } catch {
        reject(new Error(`OKX 返回非 JSON：${stdout.slice(0, 200)}`));
      }
    });
  });
}

/** 拉一页 1m K 线：返回 [startTs, endTs) 区间内、早于 `beforeTs` 的最多 limit 根（倒序）。
 *  重试用 curl 自带的 --retry（已设为有界），这里不再做应用层重试，避免大量页失败时形成重试风暴。 */
async function fetchPage(instId: string, beforeTs: number, limit: number): Promise<Candle[]> {
  const url = `https://www.okx.com/api/v5/market/history-candles?instId=${encodeURIComponent(instId)}&bar=1m&limit=${limit}&after=${beforeTs}`;
  const res = await curlJson(url);
  if (res.code !== '0') throw new Error(`OKX ${res.code}: ${res.msg || 'K 线请求失败'}`);
  return (res.data ?? []).map((row) => ({
    ts: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    confirmed: row[8] === '1',
  }));
}

/**
 * 拉取 [startMs, endMs) 的全部 1m K 线（自动分页、限速）。
 * OKX 的 after 语义是「返回早于该 ts 的记录」，所以从 endMs 开始向前翻页，
 * 直到某页最旧一根 ts < startMs 或空页为止。
 */
export async function fetchCandles1m(
  instId: string,
  startMs: number,
  endMs: number,
  opts: { paceMs?: number; maxRequests?: number } = {},
): Promise<Candle[]> {
  const pace = opts.paceMs ?? 140; // ~7 req/s
  const maxRequests = opts.maxRequests ?? 250; // 250 页 = 25000 根 ≈ 17 天，足够覆盖绝大多数持仓；超长持仓截断到该窗口
  const out: Candle[] = [];
  let cursor = endMs;
  for (let i = 0; i < maxRequests; i++) {
    const page = await fetchPage(instId, cursor, 100);
    if (page.length === 0) break;
    for (const c of page) {
      if (c.ts >= startMs && c.ts < endMs) out.push(c);
    }
    const oldest = page[page.length - 1].ts;
    if (oldest <= startMs) break;
    cursor = oldest; // 下一页：早于当前最旧一根
    await sleep(pace);
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

/**
 * 持仓期间极值：high = max(high)，low = min(low)。
 * 区间无 K 线（如刚开仓 <1 分钟或数据缺失）返回 null。
 */
export function extremesOf(candles: Candle[]): { high: number; low: number } | null {
  if (candles.length === 0) return null;
  let high = -Infinity;
  let low = Infinity;
  for (const c of candles) {
    if (c.high > high) high = c.high;
    if (c.low < low) low = c.low;
  }
  return { high, low };
}
