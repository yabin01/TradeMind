import { spawn } from 'node:child_process';

/**
 * 行情数据的 HTTP 传输层（仅用于免签名的公开行情接口）。
 *
 * 为什么用 curl 子进程而不是 fetch/axios：
 *   Python/Node 的原生 TLS 经本地代理访问部分交易所域名会握手失败或返回 502，
 *   而 curl 实测稳定（见 okx-candles.ts 的历史注释）。这里统一为一处。
 *
 * 代理策略——「先试代理，失败即直连，并记住哪条路通」：
 *   - 中国大陆用户需要走本地代理（默认 127.0.0.1:7890，可用 OKX_PROXY 覆盖）；
 *   - 海外用户机器上根本没有代理进程，硬走代理会直接连接被拒。
 *   两条路都试一遍，谁成功就把它记下来作为后续首选，避免每次请求都付双倍延迟。
 *   OKX_PROXY=direct 可强制直连（完全不碰代理）。
 */

const CURL =
  process.platform === 'win32' && process.env.SystemRoot
    ? `${process.env.SystemRoot}\\System32\\curl.exe`
    : (process.env.CURL_PATH ?? 'curl');

type Transport = 'proxy' | 'direct';

let preferred: Transport | null = null;
let lastFailure = '';

function proxyUrl(): string {
  return process.env.OKX_PROXY ?? 'http://127.0.0.1:7890';
}

function transportOrder(): Transport[] {
  const proxy = proxyUrl();
  const canProxy = Boolean(proxy) && proxy !== 'direct';
  if (!canProxy) return ['direct'];
  if (preferred === 'proxy') return ['proxy', 'direct'];
  if (preferred === 'direct') return ['direct', 'proxy'];
  return ['proxy', 'direct'];
}

function runCurl(args: string[], body?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(CURL, args, { windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let bytes = 0;
    let oversized = false;

    child.stdout.on('data', (d: Buffer) => {
      bytes += d.length;
      if (bytes > 32 * 1024 * 1024) {
        oversized = true;
        child.kill();
        return;
      }
      out.push(d);
    });
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (oversized) return reject(new Error('响应体过大（>32MB），已中止'));
      if (code !== 0) {
        const message = Buffer.concat(err).toString('utf8').trim();
        return reject(new Error(`curl 退出码 ${code}${message ? `：${message}` : ''}`));
      }
      resolve(Buffer.concat(out).toString('utf8'));
    });

    if (body !== undefined) {
      child.stdin.write(body);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
  });
}

/** 单次请求（指定走哪条路） */
async function once(
  url: string,
  opts: { method: 'GET' | 'POST'; body?: string; timeoutSec: number },
  transport: Transport,
): Promise<string> {
  // --ssl-no-revoke：Windows schannel 默认做证书吊销检查，经代理时常偶发 TLS 握手失败（curl 35）。
  // --retry 保持有界：只兜极短暂瞬故障，避免大量请求失败时形成重试风暴。
  const args = [
    '-sS',
    '-m',
    String(opts.timeoutSec),
    '--ssl-no-revoke',
    '--retry',
    '2',
    '--retry-delay',
    '1',
    '--retry-max-time',
    String(opts.timeoutSec * 3),
  ];
  if (transport === 'proxy') args.push('-x', proxyUrl());
  if (opts.method === 'POST') {
    args.push('-X', 'POST', '-H', 'Content-Type: application/json', '--data-binary', '@-');
  }
  args.push(url);
  return runCurl(args, opts.body);
}

/** 拉取 JSON：按「首选路径 → 备用路径」依次尝试，返回第一个成功的结果。 */
export async function fetchJson<T>(
  url: string,
  opts: { method?: 'GET' | 'POST'; body?: unknown; timeoutSec?: number } = {},
): Promise<T> {
  const method = opts.method ?? 'GET';
  const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  const timeoutSec = opts.timeoutSec ?? 12;
  const order = transportOrder();
  let lastError: Error | null = null;

  for (const transport of order) {
    try {
      const text = await once(url, { method, body, timeoutSec }, transport);
      if (transport !== preferred) preferred = transport;
      return JSON.parse(text) as T;
    } catch (e) {
      lastError = e as Error;
      lastFailure = `${transport}: ${lastError.message}`;
    }
  }
  throw new Error(lastError?.message ?? '请求失败');
}

/** 最近一次请求失败的诊断信息（用于把「为什么没图」讲清楚，而不是只给一句「加载失败」） */
export function transportDiagnostic(): { preferred: Transport | null; lastFailure: string } {
  return { preferred, lastFailure };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
