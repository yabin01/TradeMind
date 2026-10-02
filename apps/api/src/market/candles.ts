import { fetchJson, sleep, transportDiagnostic } from './http';

/**
 * 单笔交易的行情 K 线（用于详情页「开仓点 vs 平仓点」对照图）。
 *
 * 数据源全部是各交易所的**免签名公开行情接口**（不碰任何 API Key）：
 *   - OKX        GET  /api/v5/market/history-candles   （每页最多 100 根）
 *   - Hyperliquid POST /info  {"type":"candleSnapshot"}（单次最多 5000 根）
 *   - Binance    GET  /api/v3/klines                   （单次最多 1000 根）
 *
 * 设计原则：
 *   1. **不伪造数据**：取不到就返回 available:false + 具体原因 + 修复建议，绝不用合成数据糊图。
 *   2. **周期自适应**：按持仓时长自动选周期，目标 300~800 根，避免 3 天持仓塞 4000 根 1m 把浏览器拖死。
 *   3. **内存缓存**：已完结区间缓存 30 分钟，进行中的区间缓存 45 秒；同一 key 的并发请求共享同一个 Promise。
 */

export type CandleBar = '1m' | '5m' | '15m' | '1H' | '4H' | '1D';

/** 只提供三大交易所都支持的交集，避免「切到某个周期就空白」 */
export const CANDLE_BARS: CandleBar[] = ['1m', '5m', '15m', '1H', '4H', '1D'];

export const BAR_MS: Record<CandleBar, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1H': 3_600_000,
  '4H': 14_400_000,
  '1D': 86_400_000,
};

export const BAR_LABEL: Record<CandleBar, string> = {
  '1m': '1 分',
  '5m': '5 分',
  '15m': '15 分',
  '1H': '1 小时',
  '4H': '4 小时',
  '1D': '1 天',
};

export function isCandleBar(v: unknown): v is CandleBar {
  return typeof v === 'string' && (CANDLE_BARS as string[]).includes(v);
}

export interface CandlePoint {
  /** 秒级 Unix 时间戳（K 线开盘时间），lightweight-charts 需要秒 */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** 计价货币成交额（USDT）；拿不到时为 null */
  volume: number | null;
}

/** 极值统计口径：'exact' = 由 1m K 线得出；否则为该周期 K 线的近似值 */
export interface HoldingRange {
  high: number;
  low: number;
  amplitudePct: number;
  exact: boolean;
}

export interface TradeCandlesOk {
  available: true;
  venue: string;
  instId: string;
  bar: CandleBar;
  /** 当前持仓时长下可选的周期（含当前选中项） */
  barOptions: CandleBar[];
  autoBar: CandleBar;
  candles: CandlePoint[];
  entry: { time: number; price: number };
  exit: { time: number; price: number } | null;
  isOpen: boolean;
  /** 图表覆盖的时间范围（含两侧留白），秒 */
  span: { from: number; to: number };
  /** 持仓区间（不含留白）内的高/低，供与图上读数对照 */
  holdingRange: HoldingRange | null;
  warnings: string[];
  fetchedAt: string;
}

export interface TradeCandlesUnavailable {
  available: false;
  venue: string;
  reason: string;
  hint: string | null;
}

export type TradeCandlesPayload = TradeCandlesOk | TradeCandlesUnavailable;

/** 只依赖这几个字段，避免把数据库行类型引进来 */
export interface TradeCandleInput {
  exchange: string;
  symbol: string;
  entryPrice: number;
  exitPrice: number | null;
  openTime: Date;
  closeTime: Date | null;
}

const OKX_SWAP = /^[A-Z0-9]{1,20}-(USDT|USDC|USD|BTC|ETH)-SWAP$/;
const OKX_ANY = /^[A-Z0-9]{1,20}-(USDT|USDC|USD|BTC|ETH)(-SWAP)?$/;

/**
 * 计价币按长度降序，拆 ETHUSDT 这类「归一化写法」时才不会把 ETHBTC 拆错。
 * 长在前：USD 必须在 USDT/USDC 之后匹配。
 */
const QUOTES = ['USDT', 'USDC', 'USD', 'BTC', 'ETH'];

/**
 * 把 BASEQUOTE（如 ETHUSDT）拆成 { base, quote }，拆不出来返回 null。
 * 交易库里 symbol 可能是归一化写法（CSV 导入 / 部分同步路径），
 * 而交易所公开行情接口要的是各家的规范代码，所以必须先拆再拼。
 */
function splitPair(symbol: string): { base: string; quote: string } | null {
  const s = symbol.trim().toUpperCase();
  for (const q of QUOTES) {
    if (s.length > q.length && s.endsWith(q)) return { base: s.slice(0, s.length - q.length), quote: q };
  }
  return null;
}

/**
 * OKX 的 instId 候选：永续在前、现货在后。
 * 本产品以合约为主，所以先试 BASE-QUOTE-SWAP；拿不到 K 线（比如是现货成交、
 * 或该合约从没上过永续）再退到 BASE-QUOTE。回退命中率比只认一种写法高得多。
 */
export function okxCodes(symbol: string): string[] {
  const s = symbol.trim().toUpperCase();
  if (OKX_ANY.test(s)) return [s];
  const pair = splitPair(s);
  if (!pair) return [];
  return [`${pair.base}-${pair.quote}-SWAP`, `${pair.base}-${pair.quote}`];
}

/** Hyperliquid 只认基础币（ETH / BTC / SOL…），不带计价币 */
function hlCoins(symbol: string): string[] {
  const s = symbol.trim().toUpperCase().replace(/-SWAP$/, '');
  if (s.includes('-')) return [s.split('-')[0]];
  const pair = splitPair(s);
  return [(pair ? pair.base : s) || s];
}

/** Binance 现货是 BASEQUOTE 连写（ETHUSDT） */
function binanceCodes(symbol: string): string[] {
  const s = symbol.trim().toUpperCase().replace(/-SWAP$/, '').replace(/-/g, '');
  const pair = splitPair(s);
  if (!pair) return s ? [s] : [];
  return [`${pair.base}${pair.quote}`];
}

/** 目标根数：低于此数不切更大周期 */
const TARGET_CANDLES = 800;
/** 硬上限：超过就拒绝，避免一次拉几千根把前端拖死 */
const MAX_CANDLES = 2500;
/** 单次请求翻页上限（OKX 每页 100 根 → 最多 4000 根） */
const MAX_REQUESTS = 40;

// ---------------------------------------------------------------- 周期选择

/** 按持仓时长挑一个「看得清又不臃肿」的周期 */
export function pickBar(windowMs: number): CandleBar {
  for (const bar of CANDLE_BARS) {
    if (windowMs / BAR_MS[bar] <= TARGET_CANDLES) return bar;
  }
  return '1D';
}

export function barOptionsFor(windowMs: number): CandleBar[] {
  return CANDLE_BARS.filter((bar) => windowMs / BAR_MS[bar] <= MAX_CANDLES);
}

// ---------------------------------------------------------------- 各交易所取数

interface OkxResponse {
  code: string;
  msg: string;
  data: string[][] | null;
}

async function okxCandles(
  instId: string,
  bar: CandleBar,
  startMs: number,
  endMs: number,
  paceMs: number,
  maxRequests = MAX_REQUESTS,
): Promise<CandlePoint[]> {
  const out: CandlePoint[] = [];
  let cursor = endMs;
  let lastSeen = Number.POSITIVE_INFINITY;

  for (let i = 0; i < maxRequests; i++) {
    const url =
      `https://www.okx.com/api/v5/market/history-candles?instId=${encodeURIComponent(instId)}` +
      `&bar=${encodeURIComponent(bar)}&limit=100&after=${cursor}`;
    const res = await fetchJson<OkxResponse>(url);
    if (res.code !== '0') throw new Error(`OKX ${res.code}：${res.msg || 'K 线请求被拒绝'}`);
    const rows = res.data ?? [];
    if (rows.length === 0) break;

    for (const r of rows) {
      const ts = Number(r[0]);
      if (ts >= startMs && ts < endMs) {
        out.push({
          time: Math.floor(ts / 1000),
          open: Number(r[1]),
          high: Number(r[2]),
          low: Number(r[3]),
          close: Number(r[4]),
          volume: Number.isFinite(Number(r[7])) ? Number(r[7]) : null,
        });
      }
    }

    // OKX 的 after 语义是「早于该时间戳」；仍加一道游标必须前进的保护，防止死循环
    const oldest = Number(rows[rows.length - 1][0]);
    if (oldest <= startMs || oldest >= lastSeen || oldest >= cursor) break;
    lastSeen = oldest;
    cursor = oldest;
    if (i < maxRequests - 1) await sleep(paceMs);
  }

  out.reverse(); // OKX 倒序返回 → 统一升序
  return out;
}

interface HlCandle {
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string;
}

const HL_INTERVAL: Record<CandleBar, string> = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '1H': '1h',
  '4H': '4h',
  '1D': '1d',
};

async function hyperliquidCandles(
  coin: string,
  bar: CandleBar,
  startMs: number,
  endMs: number,
): Promise<CandlePoint[]> {
  const body = {
    type: 'candleSnapshot',
    req: { coin, interval: HL_INTERVAL[bar], startTime: startMs, endTime: endMs },
  };
  const rows = await fetchJson<HlCandle[]>('https://api.hyperliquid.xyz/info', { method: 'POST', body });
  if (!Array.isArray(rows)) throw new Error('Hyperliquid 返回了非预期的结构');
  return rows
    .map((r) => {
      const close = Number(r.c);
      const base = Number(r.v);
      return {
        time: Math.floor(Number(r.t) / 1000),
        open: Number(r.o),
        high: Number(r.h),
        low: Number(r.l),
        close,
        // Hyperliquid 只给基础币成交量，这里折算成计价额以便与 OKX/Binance 同轴显示
        volume: Number.isFinite(base) && Number.isFinite(close) ? base * close : null,
      };
    })
    .filter((c) => Number.isFinite(c.open) && Number.isFinite(c.close))
    .sort((a, b) => a.time - b.time);
}

/** Binance 单次最多 1000 根，所以按 1000 根分页 */
async function binanceCandles(
  symbol: string,
  bar: CandleBar,
  startMs: number,
  endMs: number,
): Promise<CandlePoint[]> {
  const interval = bar === '1H' ? '1h' : bar === '4H' ? '4h' : bar === '1D' ? '1d' : bar;
  const step = BAR_MS[bar] * 1000;
  const out: CandlePoint[] = [];
  let cursor = startMs;

  for (let i = 0; i < MAX_REQUESTS; i++) {
    const url =
      `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}` +
      `&startTime=${cursor}&endTime=${endMs}&limit=1000`;
    const rows = await fetchJson<unknown[][]>(url);
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const r of rows) {
      const ts = Number(r[0]);
      if (ts >= startMs && ts < endMs) {
        out.push({
          time: Math.floor(ts / 1000),
          open: Number(r[1]),
          high: Number(r[2]),
          low: Number(r[3]),
          close: Number(r[4]),
          volume: Number.isFinite(Number(r[7])) ? Number(r[7]) : null,
        });
      }
    }
    if (rows.length < 1000) break;
    const next = Number(rows[rows.length - 1][0]) + step;
    if (next <= cursor) break;
    cursor = next;
    await sleep(120);
  }

  out.sort((a, b) => a.time - b.time);
  return out;
}

// ---------------------------------------------------------------- 窗口与装配

function alignFloor(ms: number, step: number): number {
  return Math.floor(ms / step) * step;
}

/** 把事件时间吸附到所属 K 线的开盘时间（否则 lightweight-charts 找不到该时间点，标注会整条消失） */
function snapTime(ms: number, bar: CandleBar, firstTs: number, lastTs: number): number {
  const step = BAR_MS[bar];
  const snapped = alignFloor(ms, step) / 1000;
  if (snapped < firstTs) return firstTs;
  if (snapped > lastTs) return lastTs;
  return snapped;
}

/** 每个交易所对应的「本所标的名」候选列表 */
function venueCandidates(
  exchange: string,
  symbol: string,
): { venue: string; codes: string[]; supported: boolean; hint: string | null } {
  const upper = exchange.toUpperCase();
  if (upper === 'OKX') {
    // 已下架合约形如 ETH-USDT-SWAP-OFF20260702-2，历史 K 线通常也拿不到了
    if (/-OFF\d{8}/.test(symbol)) {
      return { venue: 'OKX', codes: [], supported: false, hint: '该合约已下架，交易所不再提供历史 K 线' };
    }
    const codes = okxCodes(symbol);
    return {
      venue: 'OKX',
      codes,
      supported: codes.length > 0,
      hint:
        codes.length > 0
          ? null
          : `无法识别 OKX 合约代码「${symbol}」，需要 BASE-QUOTE（现货）或 BASE-QUOTE-SWAP（永续）这种写法`,
    };
  }
  if (upper === 'HYPERLIQUID') {
    const coins = hlCoins(symbol);
    return { venue: 'Hyperliquid', codes: coins, supported: coins.length > 0, hint: null };
  }
  if (upper === 'BINANCE') {
    const codes = binanceCodes(symbol);
    return { venue: 'Binance', codes, supported: codes.length > 0, hint: null };
  }
  return {
    venue: upper,
    codes: [],
    supported: false,
    hint: '当前只支持 OKX / Hyperliquid / Binance 的公开行情',
  };
}

// ---------------------------------------------------------------- 缓存

interface CacheEntry {
  at: number;
  promise: Promise<TradeCandlesPayload>;
}

const cache = new Map<string, CacheEntry>();
const CACHE_MAX = 200;

function cacheKey(venue: string, code: string, bar: CandleBar, startMs: number, endMs: number): string {
  const step = BAR_MS[bar];
  return `${venue}|${code}|${bar}|${alignFloor(startMs, step)}|${alignFloor(endMs, step)}`;
}

function evictIfNeeded(): void {
  if (cache.size <= CACHE_MAX) return;
  const entries = [...cache.entries()].sort((a, b) => a[1].at - b[1].at);
  for (const [key] of entries.slice(0, cache.size - CACHE_MAX)) cache.delete(key);
}

// ---------------------------------------------------------------- 主入口

/** 持仓区间内至少要有这么多根 K 线，图才有意义；低于此值只在没有更好选择时兜底使用 */
const MIN_HOLDING_BARS = 8;

interface Attempt {
  bar: CandleBar;
  /** 实际取到数据的那个「本所代码」（可能是候选列表里的第二个） */
  code: string;
  candles: CandlePoint[];
  start: number;
  end: number;
  /** 落在持仓区间内的那部分（统计极值用，不含两侧留白） */
  inHolding: CandlePoint[];
}

export async function getTradeCandles(
  trade: TradeCandleInput,
  requestedBar?: string,
): Promise<TradeCandlesPayload> {
  const { venue, codes, supported, hint } = venueCandidates(trade.exchange, trade.symbol);
  const openMs = trade.openTime.getTime();
  const closeMs = trade.closeTime ? trade.closeTime.getTime() : Date.now();
  const isOpen = !trade.closeTime;

  if (!supported) {
    return {
      available: false,
      venue,
      reason:
        hint ??
        `暂不支持 ${venue} 的行情 K 线（${trade.symbol}）`,
      hint: 'OKX / Hyperliquid / Binance 之外的成交记录仍可在下方看到完整盈亏明细，只是没有分时走势。',
    };
  }
  if (!Number.isFinite(openMs) || openMs <= 0) {
    return { available: false, venue, reason: '这笔交易缺少有效的开仓时间，无法定位历史行情', hint: null };
  }

  const windowMs = Math.max(closeMs - openMs, BAR_MS['1m']);
  const autoBar = pickBar(windowMs);
  const barOptions = barOptionsFor(windowMs);

  let bar: CandleBar = autoBar;
  const warnings: string[] = [];
  if (isCandleBar(requestedBar)) {
    if (barOptions.includes(requestedBar)) {
      bar = requestedBar;
    } else {
      warnings.push(
        `持仓 ${(windowMs / 86_400_000).toFixed(1)} 天，${BAR_LABEL[requestedBar]}周期要拉 ${Math.round(
          windowMs / BAR_MS[requestedBar],
        )} 根 K 线（超过 ${MAX_CANDLES} 根上限），已自动改用 ${BAR_LABEL[autoBar]}。`,
      );
    }
  }
  if (barOptions.length === 0) {
    return {
      available: false,
      venue,
      reason: `持仓长达 ${Math.round(windowMs / 86_400_000)} 天，即使按日线也超过 ${MAX_CANDLES} 根 K 线的上限`,
      hint: '超长持仓的走势图可在「交易回放」中按区间分段查看。',
    };
  }

  // 两侧留白：让开仓/平仓点不在最边缘，看得出前后走势
  const padMs = Math.min(Math.max(windowMs * 0.12, BAR_MS[bar] * 3), BAR_MS[bar] * 60);
  const startMs = alignFloor(openMs - padMs, BAR_MS[bar]);
  const endMs = alignFloor(closeMs + padMs, BAR_MS[bar]) + BAR_MS[bar];

  const key = cacheKey(venue, codes[0], bar, startMs, endMs);
  const hit = cache.get(key);
  const ttl = isOpen ? 45_000 : 30 * 60_000;
  if (hit && Date.now() - hit.at < ttl) return hit.promise;

  const promise = (async (): Promise<TradeCandlesPayload> => {
    // 周期降级阶梯：交易所对细粒度历史的保留深度往往很短
    // （实测 Hyperliquid 的 1m 只能回溯约 4 天、5m 约两周），
    // 所以某个周期拿不到数据时自动换更粗的周期，而不是直接给用户一张空白图。
    const ladder: CandleBar[] = [
      bar,
      ...CANDLE_BARS.filter((b) => BAR_MS[b] > BAR_MS[bar] && barOptions.includes(b)),
    ];

    const fetchBar = (target: CandleBar, code: string, s: number, e: number): Promise<CandlePoint[]> => {
      if (venue === 'OKX') return okxCandles(code, target, s, e, 140);
      if (venue === 'Hyperliquid') return hyperliquidCandles(code, target, s, e);
      return binanceCandles(code, target, s, e);
    };

    let picked: Attempt | null = null; // 数据量够用的最优解
    let fallback: Attempt | null = null; // 有数据但不多的兜底解
    const tried: { bar: CandleBar; count: number }[] = [];
    let firstError: Error | null = null;

    for (const candidate of ladder) {
      const padMs = Math.min(
        Math.max(windowMs * 0.12, BAR_MS[candidate] * 3),
        BAR_MS[candidate] * 60,
      );
      const s = alignFloor(openMs - padMs, BAR_MS[candidate]);
      const e = alignFloor(closeMs + padMs, BAR_MS[candidate]) + BAR_MS[candidate];

      // 同一个周期下再按候选代码逐个试：ETHUSDT 可能对应 ETH-USDT-SWAP，
      // 也可能只有现货 ETH-USDT 有历史；哪个先返回数据就用哪个。
      let candles: CandlePoint[] = [];
      let codeUsed = codes[0];
      for (const code of codes) {
        try {
          candles = await fetchBar(candidate, code, s, e);
        } catch (err) {
          firstError ??= err as Error;
          candles = [];
          continue;
        }
        if (candles.length > 0) {
          codeUsed = code;
          break;
        }
      }

      tried.push({ bar: candidate, count: candles.length });
      if (candles.length === 0) continue;

      const inHolding = candles.filter(
        (c) => c.time * 1000 >= openMs - BAR_MS[candidate] && c.time * 1000 <= closeMs + BAR_MS[candidate],
      );
      const attempt: Attempt = { bar: candidate, code: codeUsed, candles, start: s, end: e, inHolding };
      if (inHolding.length >= MIN_HOLDING_BARS) {
        picked = attempt;
        break;
      }
      if (!fallback && inHolding.length > 0) fallback = attempt;
    }

    const chosen = picked ?? fallback;
    if (!chosen) {
      const triedText = tried.map((t) => BAR_LABEL[t.bar]).join('、');
      if (firstError && tried.length === 0) {
        const diag = transportDiagnostic();
        return {
          available: false,
          venue,
          reason: `无法从 ${venue} 取得行情：${firstError.message}`,
          hint: `${diag.lastFailure ? `最近一次传输失败：${diag.lastFailure}。` : ''}若你在国内，请确认本地代理可用（默认 127.0.0.1:7890，可用环境变量 OKX_PROXY 指定，设为 direct 表示直连）。`,
        };
      }
      return {
        available: false,
        venue,
        reason: `${venue} 在该时段没有可用的 K 线（已尝试 ${triedText || BAR_LABEL[bar]} 周期）`,
        hint: '已下架合约、或在交易所 K 线保留期之外的成交，通常拿不到分时数据；成交明细与盈亏口径不受影响。',
      };
    }

    const usedBar = chosen.bar;
    const candles = chosen.candles;
    if (usedBar !== bar) {
      warnings.push(
        `${BAR_LABEL[bar]}周期在 ${venue} 已查不到这段历史（该所细粒度 K 线保留期有限），已自动改用 ${BAR_LABEL[usedBar]}。`,
      );
    }
    // 用候选代码里的第二个取到数据时说明一下，避免用户以为拿错了标的
    if (chosen.code !== codes[0]) {
      warnings.push(`这笔记录的标的写作「${trade.symbol}」，${venue} 上按「${chosen.code}」取到了行情（优先试的 ${codes[0]} 没有数据）。`);
    }

    const firstTs = candles[0].time;
    const lastTs = candles[candles.length - 1].time;
    const exitTime = trade.closeTime ? snapTime(closeMs, usedBar, firstTs, lastTs) : null;

    let holdingRange: HoldingRange | null = null;
    if (chosen.inHolding.length > 0) {
      let high = -Infinity;
      let low = Infinity;
      for (const c of chosen.inHolding) {
        if (c.high > high) high = c.high;
        if (c.low < low) low = c.low;
      }
      const mid = (high + low) / 2;
      holdingRange = {
        high,
        low,
        amplitudePct: mid > 0 ? ((high - low) / mid) * 100 : 0,
        exact: usedBar === '1m',
      };
    }

    return {
      available: true,
      venue,
      instId: chosen.code,
      bar: usedBar,
      barOptions,
      autoBar,
      candles,
      entry: { time: snapTime(openMs, usedBar, firstTs, lastTs), price: trade.entryPrice },
      exit: exitTime !== null && trade.exitPrice !== null ? { time: exitTime, price: trade.exitPrice } : null,
      isOpen,
      span: { from: firstTs, to: lastTs },
      holdingRange,
      warnings,
      fetchedAt: new Date().toISOString(),
    };
  })();

  cache.set(key, { at: Date.now(), promise });
  evictIfNeeded();

  try {
    return await promise;
  } catch (e) {
    cache.delete(key);
    return {
      available: false,
      venue,
      reason: `行情处理失败：${(e as Error).message}`,
      hint: null,
    };
  }
}

// ---------------------------------------------------------------- 兼容旧调用

/** 持仓期间极值：high = max(high)，low = min(low)。空数组返回 null。 */
export function extremesOf(candles: { high: number; low: number }[]): { high: number; low: number } | null {
  if (candles.length === 0) return null;
  let high = -Infinity;
  let low = Infinity;
  for (const c of candles) {
    if (c.high > high) high = c.high;
    if (c.low < low) low = c.low;
  }
  return { high, low };
}

/**
 * 拉取 [startMs, endMs) 区间的 1m K 线（MAE/MFE 回填脚本用）。
 * OKX 每页 100 根，250 页 ≈ 25000 根 ≈ 17 天，足够覆盖绝大多数持仓。
 *
 * 传进来的 instId 可能是归一化写法（ETHUSDT），先按候选代码逐个试；
 * 某个代码直接空手而归时 okxCandles 只发一次请求就退出，所以代价可控。
 */
export async function fetchCandles1m(
  instId: string,
  startMs: number,
  endMs: number,
  opts: { paceMs?: number; maxRequests?: number } = {},
): Promise<CandlePoint[]> {
  for (const code of okxCodes(instId)) {
    const rows = await okxCandles(code, '1m', startMs, endMs, opts.paceMs ?? 140, opts.maxRequests ?? 250);
    if (rows.length > 0) return rows;
  }
  return [];
}

export { OKX_SWAP, OKX_ANY };
