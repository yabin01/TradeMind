import { execFile } from 'node:child_process';

/**
 * Hyperliquid 只读客户端。
 *
 * 与 OKX 最大的区别：Hyperliquid 的 `/info` 端点全部是**公开只读**的——
 * 只要知道钱包地址（42 位 0x 地址）就能读取该地址的成交与持仓，
 * **不需要 API Key、不需要 EIP-712 签名**，因此天然不存在「交易/提币权限」风险。
 * 这也是它能拿到最干净的「只读接入」的原因：TradeMind 只保存一个地址。
 *
 * 文档：https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint
 *
 * 实测要点（2026-09-27）：
 *  - 手续费 `fee` 符号约定：**正数 = 支出，负数 = 返佣**。
 *    交叉验证：userFees.userCrossRate = "0.000144"（taker 付费，正）/ userAddRate = "-0.00003"（maker 返佣，负）。
 *    因此落到本项目的 fees（成本口径，正=支出）就是 `fees = fee`。
 *  - `closedPnl` 为**不含手续费**的已实现价格盈亏，与本项目 grossPnl 口径一致。
 *  - `userFills` 只返回最近 2000 笔、且平台只保留最近 10000 笔；
 *    要取更久历史需用 `userFillsByTime` 从 `startTime` 向后翻页（每次最多 2000 笔，升序返回）。
 */

export type HyperliquidCredentials = {
  /** 42 位 0x 钱包地址（公开信息，只读） */
  walletAddress: string;
};

const CURL =
  process.platform === 'win32' && process.env.SystemRoot
    ? `${process.env.SystemRoot}\\System32\\curl.exe`
    : (process.env.CURL_PATH ?? 'curl');

/** HL 大陆可直连；如需代理设 HL_PROXY=http://127.0.0.1:7890 */
function proxyArgs(): string[] {
  const proxy = process.env.HL_PROXY ?? 'direct';
  return proxy && proxy !== 'direct' ? ['-x', proxy] : [];
}

const HL_BASE = process.env.HL_API_BASE ?? 'https://api.hyperliquid.xyz';

/** POST /info（Hyperliquid 所有读取都走这一个端点，靠 body 里的 type 区分） */
async function hlInfo<T>(body: Record<string, unknown>): Promise<T> {
  const payload = JSON.stringify(body);
  const args = [
    '-sS',
    '-m',
    '40',
    '--ssl-no-revoke',
    '--retry',
    '4',
    '--retry-all-errors',
    '--retry-delay',
    '1',
    '--retry-max-time',
    '60',
    ...proxyArgs(),
    `${HL_BASE}/info`,
    '-X',
    'POST',
    '-H',
    'Content-Type: application/json',
    '--data-binary',
    payload,
  ];
  const raw = await new Promise<string>((resolve, reject) => {
    execFile(CURL, args, { windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`curl 失败: ${err.message}${stderr ? ` | ${stderr.trim()}` : ''}`));
      resolve(stdout);
    });
  });
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`Hyperliquid 返回非 JSON：${raw.slice(0, 200)}`);
  }
}

/** 成交单条（Hyperliquid 原始字段，数值均为字符串） */
export type HyperliquidFill = {
  coin: string;
  px: string;
  sz: string;
  /** B = 买，A = 卖 */
  side: 'B' | 'A';
  /** 成交时间（毫秒） */
  time: number;
  /** 成交前持仓（带符号；空仓为 "0"） */
  startPosition?: string;
  /** Open Long / Close Long / Open Short / Close Short / Long > Short / Short > Long / Settlement */
  dir: string;
  closedPnl: string;
  /** 正数 = 支出，负数 = 返佣 */
  fee: string;
  tid: number;
  oid: number;
  hash: string;
  crossed: boolean;
  feeToken?: string;
  cloid?: string | null;
};

/** 未平仓仓位中的 position 对象 */
export type HyperliquidPositionInfo = {
  coin: string;
  /** 带符号持仓量（正 = 多，负 = 空） */
  szi: string;
  entryPx: string;
  leverage: { type: string; value: number };
  liquidationPx: string | null;
  marginUsed: string;
  positionValue: string;
  unrealizedPnl: string;
  returnOnEquity: string;
  cumFunding?: { allTime: string; sinceOpen: string; sinceChange: string };
};

export type HyperliquidAssetPosition = {
  type: string;
  position: HyperliquidPositionInfo;
};

export type HyperliquidClearinghouseState = {
  marginSummary: { accountValue: string; totalNtlPos: string; totalMarginUsed: string };
  withdrawable: string;
  assetPositions: HyperliquidAssetPosition[];
  time: number;
};

export function isValidWalletAddress(addr: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(String(addr ?? '').trim());
}

/** 当前未平仓永续持仓（已过滤 szi = 0 的记录） */
export async function fetchClearinghouseState(address: string): Promise<HyperliquidClearinghouseState> {
  const state = await hlInfo<HyperliquidClearinghouseState>({ type: 'clearinghouseState', user: address });
  if (!state || typeof state !== 'object') throw new Error('Hyperliquid 返回结构异常');
  return {
    ...state,
    assetPositions: (state.assetPositions ?? []).filter((p) => Math.abs(Number(p?.position?.szi) || 0) > 1e-12),
  };
}

const USER_FILLS_PAGE = 2000;
/** 平台只保留最近约 10000 笔成交，多翻无意义，这里给足冗余 */
const MAX_FILL_TOTAL = 24000;
/** 回看窗口上限；实际窗口按成交密度自适应（见 fetchUserFills） */
const MAX_WINDOW_MS = 730 * 86_400_000;
const MIN_WINDOW_MS = 5 * 60_000;

/** 按时间区间取成交（升序返回，最多 2000 笔） */
function fillsByTime(address: string, startTime: number, endTime: number): Promise<HyperliquidFill[]> {
  return hlInfo<HyperliquidFill[]>({ type: 'userFillsByTime', user: address, startTime, endTime });
}

/**
 * 拉取成交明细（**倒序自适应分页，保证最新成交一定拿到、且时间区间连续无缺口**）。
 *
 * 为什么不用「从最早向后翻页」：`userFillsByTime` 在区间过大时返回的是该区间内**最早**的
 * 2000 笔，从最早的 startTime 一路向后翻，容量用尽后就停在历史中段 —— 最新成交反而丢了。
 *
 * 为什么不用「从最早向后翻页」：`userFillsByTime` 在区间过大时返回的是该区间内**最早**的
 * 2000 笔，从最早的 startTime 一路向后翻，容量用尽后就停在历史中段 —— 最新成交反而丢了。
 *
 * 本实现：
 *  1. 先用 `userFills` 取最新一页（1 次调用），既保证最新数据一定到手，
 *     又用这一页覆盖的时长估算出「每 2000 笔大约对应多长时间」；
 *  2. 以这一页最早成交时间为游标，按估算窗口往过去取：
 *     - 一次取完（< 2000 笔）→ 收录、游标前移；空窗放大 4 倍、明显稀疏放大 2 倍；
 *     - 被截断（= 2000 笔）→ 说明窗口偏宽，收紧到该页实际覆盖的时长后重取（不收录，避免丢区间）。
 *
 * 因为顺序是「最新 → 更早」，超出页数/时间预算时丢掉的只是更早的历史，最新数据一定完整。
 *
 * @param sinceMs 回看下界（不早于此时间），默认不限
 * @param maxPages 最多翻页数（每页 2000 笔）
 * @param timeBudgetMs 时间预算（毫秒），超时即停，避免高频账户同步卡太久
 * @returns fills 升序成交列表；truncated 是否因页数/容量/时间预算用尽而未能取完
 */
export async function fetchUserFills(
  address: string,
  opts: { maxPages?: number; sinceMs?: number; timeBudgetMs?: number } = {},
): Promise<{ fills: HyperliquidFill[]; truncated: boolean }> {
  const maxPages = opts.maxPages ?? 10;
  const deadline = Date.now() + (opts.timeBudgetMs ?? 90_000);
  const floor = opts.sinceMs && opts.sinceMs > 0 ? opts.sinceMs : 0;
  const out: HyperliquidFill[] = [];
  const seen = new Set<number>();
  let truncated = false;

  const collect = (rows: HyperliquidFill[]) => {
    for (const r of rows) {
      if (r && typeof r.tid === 'number' && !seen.has(r.tid)) {
        seen.add(r.tid);
        out.push(r);
      }
    }
  };
  const done = () => {
    out.sort((x, y) => (Number(x.time) - Number(y.time)) || (Number(x.tid) - Number(y.tid)));
    return { fills: out, truncated };
  };

  // 第 1 步（也是锚点）：最新一页。一次调用就保证「最新成交一定拿到」，
  // 同时用这一页覆盖的时长作为后面每页 2000 笔的密度估计，避免在无成交的空窗上白跑。
  const latest = await hlInfo<HyperliquidFill[]>({ type: 'userFills', user: address });
  const first = Array.isArray(latest) ? latest : [];
  collect(first);
  // 不足一页 → 平台保留范围内（约 10000 笔）的历史已全部到手
  if (first.length < USER_FILLS_PAGE) return done();

  const times = first.map((r) => Number(r.time) || 0).filter((t) => t > 0);
  if (times.length === 0) return done();
  let cursor = Math.min(...times) - 1;
  let window = Math.max(MIN_WINDOW_MS, Math.max(...times) - Math.min(...times));
  let pages = 1;

  while (pages < maxPages && cursor > floor && out.length < MAX_FILL_TOTAL && Date.now() < deadline) {
    const start = Math.max(floor, cursor - window);
    let rows: HyperliquidFill[];
    try {
      rows = await fillsByTime(address, start, cursor);
    } catch (e) {
      // 单页失败：已有数据照常返回，避免整次同步失败
      if (out.length > 0) {
        truncated = true;
        break;
      }
      throw e;
    }
    if (!Array.isArray(rows)) rows = [];

    if (rows.length >= USER_FILLS_PAGE) {
      // 窗口太宽被截断：收紧到该页实际覆盖的时长（不收录，避免与后续页重叠丢区间）
      const maxTime = Math.max(...rows.map((r) => Number(r.time) || 0));
      const covered = maxTime - start;
      if (covered < MIN_WINDOW_MS) {
        // 已细到 5 分钟仍是满页（极端高频），只能收下这一页并接受缺口
        collect(rows);
        pages++;
        cursor = Math.max(floor, Math.min(...rows.map((r) => Number(r.time) || Date.now())) - 1);
        truncated = true;
        continue;
      }
      // 没有任何推进空间（页内最大时间 = 游标）→ 强制减半，保证收敛
      window = covered >= window ? Math.floor(window / 2) : covered;
      continue;
    }

    // 该窗口已完整取完
    collect(rows);
    pages++;
    cursor = start - 1;
    // 空窗 → 大幅加速回看；明显稀疏 → 适度放大；密度正常 → 维持（避免反复截断）
    if (rows.length === 0) window = Math.min(MAX_WINDOW_MS, window * 4);
    else if (rows.length < USER_FILLS_PAGE / 2) window = Math.min(MAX_WINDOW_MS, window * 2);
  }

  if ((pages >= maxPages || Date.now() >= deadline) && cursor > floor) truncated = true;
  return done();
}

/** 重建出的「一笔往返交易」 */
export interface HlTrade {
  coin: string;
  direction: 'LONG' | 'SHORT';
  entryPrice: number;
  exitPrice: number;
  /** 平掉的币数量（base 单位，HL 的 sz 本身就是币） */
  quantity: number;
  openTimeMs: number;
  closeTimeMs: number;
  /** 价格盈亏（不含手续费），与 grossPnl 同口径 */
  grossPnl: number;
  /** 成本口径（正 = 支出；maker 返佣为负） */
  fees: number;
  /** Hyperliquid 成交数据不含资金费，固定 0 */
  funding: number;
  netPnl: number;
  fillCount: number;
  openTid: number;
  closeTid: number;
  /** 首次出现的成交已经是持仓状态（历史被平台截断），入场价不完整 */
  partialEntry: boolean;
}

const EPS = 1e-12;

/** 持仓量相等判定（容忍浮点误差） */
function samePos(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(1e-6, Math.abs(a) * 1e-9);
}

/** 成交带来的持仓变化（带符号） */
function deltaOf(f: HyperliquidFill): number {
  return (f.side === 'B' ? 1 : -1) * (Number(f.sz) || 0);
}

const posKey = (v: number): string => v.toFixed(8);

/**
 * 同一毫秒内的成交做「因果链重排」。
 *
 * 实测发现：Hyperliquid 返回的成交在**同一时间戳内并非因果顺序**——同一毫秒内多笔成交的
 * `startPosition` 会在两个水平之间来回跳（例如 429.7835 → 419.4354 → 429.4179 …），
 * 说明数组顺序不等于真实撮合顺序。若直接顺序累加，持仓轨迹会漂移，
 * 导致重建出的交易边界随「拉到多少历史」而变（同一笔交易换一个 id → 重复入库）。
 *
 * 解法：用每笔的 `startPosition` + 数量构成有向链，从「不是任何一笔终态的起点」出发串起来。
 * 串不成（起点不唯一 / 有缺口）就退回原顺序，不影响正确性上限。
 */
function causalOrder(group: HyperliquidFill[]): HyperliquidFill[] {
  if (group.length <= 1) return group;
  for (const f of group) if (!Number.isFinite(Number(f.startPosition))) return group;

  const buckets = new Map<string, HyperliquidFill[]>();
  for (const f of group) {
    const k = posKey(Number(f.startPosition));
    const arr = buckets.get(k);
    if (arr) arr.push(f);
    else buckets.set(k, [f]);
  }
  const afterKeys = new Set<string>();
  for (const f of group) afterKeys.add(posKey(Number(f.startPosition) + deltaOf(f)));

  const starts = [...buckets.keys()].filter((k) => !afterKeys.has(k));
  if (starts.length !== 1) return group;

  const ordered: HyperliquidFill[] = [];
  let cur = starts[0];
  while (ordered.length < group.length) {
    const arr = buckets.get(cur);
    if (!arr || arr.length === 0) break;
    const f = arr.pop() as HyperliquidFill;
    ordered.push(f);
    cur = posKey(Number(f.startPosition) + deltaOf(f));
  }
  return ordered.length === group.length ? ordered : group;
}

/** 按时间排序，并对每个「同一毫秒」分组做因果重排 */
function orderFillsCausally(list: HyperliquidFill[]): HyperliquidFill[] {
  const sorted = list
    .slice()
    .sort((x, y) => Number(x.time) - Number(y.time) || Number(x.tid) - Number(y.tid));
  const out: HyperliquidFill[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i + 1;
    while (j < sorted.length && Number(sorted[j].time) === Number(sorted[i].time)) j++;
    out.push(...causalOrder(sorted.slice(i, j)));
    i = j;
  }
  return out;
}

type Episode = {
  direction: 'LONG' | 'SHORT';
  entryNotional: number;
  entrySize: number;
  openTimeMs: number;
  openTid: number;
  partialEntry: boolean;
};

type Acc = {
  closeNotional: number;
  closeSize: number;
  grossPnl: number;
  fees: number;
  fillCount: number;
  lastTimeMs: number;
  closeTid: number;
};

const newEpisode = (
  direction: 'LONG' | 'SHORT' = 'LONG',
  entrySize = 0,
  entryNotional = 0,
  openTimeMs = 0,
  openTid = 0,
  partialEntry = false,
): Episode => ({ direction, entrySize, entryNotional, openTimeMs, openTid, partialEntry });

const newAcc = (): Acc => ({
  closeNotional: 0,
  closeSize: 0,
  grossPnl: 0,
  fees: 0,
  fillCount: 0,
  lastTimeMs: 0,
  closeTid: 0,
});

function emit(e: Episode, a: Acc, coin: string): HlTrade {
  const entryPrice = e.entrySize > EPS ? e.entryNotional / e.entrySize : 0;
  const exitPrice = a.closeSize > EPS ? a.closeNotional / a.closeSize : 0;
  return {
    coin,
    direction: e.direction,
    entryPrice,
    exitPrice,
    quantity: a.closeSize,
    openTimeMs: e.openTimeMs,
    closeTimeMs: a.lastTimeMs,
    grossPnl: a.grossPnl,
    fees: a.fees,
    funding: 0,
    netPnl: a.grossPnl - a.fees,
    fillCount: a.fillCount,
    openTid: e.openTid,
    closeTid: a.closeTid,
    partialEntry: e.partialEntry,
  };
}

/**
 * 把逐笔成交重建为「往返交易」（一开一平为一个 episode）。
 *
 * 关键点：
 *  1. **以成交自带的 `startPosition` 为权威**推演持仓（而不是自己累加）——
 *     这样每笔成交的「前 / 后持仓」都由交易所给出，重建结果与「拉到多少历史」无关，
 *     同一笔交易在任何一次同步里都会得到同一个 closeTid，天然幂等；
 *     同一毫秒内的成交先经 `orderFillsCausally` 还原因果顺序。
 *  2. 同向成交 = 加仓（并入入场均价）；反向成交 = 平仓（并入出场均价与 closedPnl）；
 *     反向且数量超过原持仓 = **翻转**，先结算旧方向这笔，再以剩余量开新方向的新 episode。
 *  3. 手续费按「平掉量 : 新开量」比例拆分到两笔交易上；进出场两端手续费都计入成本。
 *  4. 现货（coin 以 `@` 开头）不参与——本项目只统计永续往返。
 *
 * 外部去重键（见 connections.ts）：`hl:{coin}:{closeTid}`。
 * 用「平仓那一笔的 tid」而不是首笔 tid，因为一笔往返交易一旦平掉就永久固定。
 */
export function reconstructTradesFromFills(fills: HyperliquidFill[]): HlTrade[] {
  const byCoin = new Map<string, HyperliquidFill[]>();
  for (const f of fills) {
    if (!f || typeof f.coin !== 'string' || f.coin.startsWith('@')) continue;
    if ((Number(f.sz) || 0) <= 0) continue;
    const list = byCoin.get(f.coin) ?? [];
    list.push(f);
    byCoin.set(f.coin, list);
  }

  const trades: HlTrade[] = [];

  for (const [coin, raw] of byCoin) {
    const list = orderFillsCausally(raw);

    let episode: Episode | null = null;
    let acc = newAcc();
    let tracked = 0; // 仅在 startPosition 缺失时兜底

    for (const f of list) {
      const sz = Number(f.sz) || 0;
      if (sz <= EPS) continue;
      const px = Number(f.px) || 0;
      const delta = deltaOf(f);
      const fee = Number(f.fee) || 0; // 正 = 支出，负 = 返佣
      const cpnl = Number(f.closedPnl) || 0;
      const timeMs = Number(f.time) || 0;
      const tid = Number(f.tid) || 0;

      const rawBefore = Number(f.startPosition);
      const before = Number.isFinite(rawBefore) ? rawBefore : tracked;
      const after = before + delta;

      const beforeSign = samePos(before, 0) ? 0 : Math.sign(before);
      const afterSign = samePos(after, 0) ? 0 : Math.sign(after);
      const sameDir = beforeSign !== 0 && beforeSign === afterSign;
      const flip = beforeSign !== 0 && afterSign !== 0 && beforeSign !== afterSign;

      // 没有进行中的 episode：若此刻已在持仓（窗口起点落在持仓中间），先补一个近似入场
      if (!episode) {
        if (beforeSign !== 0) {
          episode = newEpisode(beforeSign > 0 ? 'LONG' : 'SHORT', Math.abs(before), Math.abs(before) * px, timeMs, tid, true);
        } else if (afterSign !== 0) {
          episode = newEpisode(afterSign > 0 ? 'LONG' : 'SHORT', 0, 0, timeMs, tid, false);
        }
      } else if (flip && (episode.direction === 'LONG' ? 1 : -1) === afterSign) {
        // 异常保护：进行中的方向与交易所给的前置持仓矛盾 → 先把已有 episode 结算掉
        if (acc.closeSize > EPS) trades.push(emit(episode, acc, coin));
        acc = newAcc();
        episode =
          beforeSign !== 0
            ? newEpisode(beforeSign > 0 ? 'LONG' : 'SHORT', Math.abs(before), Math.abs(before) * px, timeMs, tid, true)
            : null;
      }
      if (!episode) {
        tracked = after;
        continue;
      }

      // 拆分为「平掉的量」与「新开的量」，两者之和恒等于 sz
      let closedSz = 0;
      let openedSz = 0;
      if (beforeSign !== 0 && beforeSign !== afterSign) {
        closedSz = Math.abs(before);
        openedSz = Math.abs(after);
      } else if (sameDir) {
        if (Math.abs(after) > Math.abs(before)) openedSz = Math.abs(after) - Math.abs(before);
        else closedSz = Math.abs(before) - Math.abs(after);
      } else {
        openedSz = sz;
      }

      const feeClosed = sz > EPS ? fee * (closedSz / sz) : 0;
      const feeOpened = fee - feeClosed;

      if (openedSz > 0) {
        episode.entrySize += openedSz;
        episode.entryNotional += px * openedSz;
      }
      acc.fillCount += 1;
      acc.lastTimeMs = timeMs;
      acc.closeTid = tid;
      if (closedSz > 0) {
        acc.closeSize += closedSz;
        acc.closeNotional += px * closedSz;
        acc.grossPnl += cpnl;
        acc.fees += feeClosed;
      } else {
        acc.fees += fee;
      }

      if (afterSign === 0) {
        // 归零 → 这笔往返交易完成
        if (acc.closeSize > EPS) trades.push(emit(episode, acc, coin));
        episode = null;
        acc = newAcc();
      } else if (flip) {
        // 翻转：先结算旧方向，再以剩余量开新方向
        if (acc.closeSize > EPS) trades.push(emit(episode, acc, coin));
        episode = newEpisode(afterSign > 0 ? 'LONG' : 'SHORT', openedSz, px * openedSz, timeMs, tid, false);
        acc = newAcc();
        acc.fees += feeOpened;
        acc.fillCount += 1;
        acc.lastTimeMs = timeMs;
        acc.closeTid = tid;
      }

      tracked = after;
    }
    // 结束时仍持仓 → 不产出交易（与「只统计已平仓」口径一致）
  }

  trades.sort((x, y) => x.closeTimeMs - y.closeTimeMs);
  return trades;
}

/** 只读探测：能读到 clearinghouseState 即为可用（Hyperliquid 公开数据天然只读） */
export async function probeHyperliquid(address: string): Promise<{ ok: boolean; accountValue: string | null; msg?: string }> {
  try {
    const st = await fetchClearinghouseState(address);
    return { ok: true, accountValue: st.marginSummary?.accountValue ?? null };
  } catch (e) {
    return { ok: false, accountValue: null, msg: e instanceof Error ? e.message : String(e) };
  }
}
