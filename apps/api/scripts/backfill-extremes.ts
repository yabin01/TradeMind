/**
 * MAE/MFE 极值回填（最近 N 天已平仓交易）。
 *
 * 原理：OKX 公共 1m K 线（免签名）→ 持仓期间最高/最低价 → trades.metadata.extremes = { high, low }。
 * trade-detail.ts 已支持从 metadata.extremes 自动启用计算，无需改任何分析代码。
 *
 * 运行：pnpm --filter @trademind/api exec tsx scripts/backfill-extremes.ts [--days=90] [--limit=2000]
 * 幂等：已有 extremes 或已标记 extremesMissing 的交易自动跳过。
 */
import { and, desc, eq, gte, isNotNull } from 'drizzle-orm';
import { createDb, trades as tradesTable } from '@trademind/database';
import { fetchCandles1m, extremesOf, type CandlePoint } from '../src/market/candles';

const args = process.argv.slice(2);
const days = Number(args.find((a) => a.startsWith('--days='))?.slice(7) ?? 90);
const limit = Number(args.find((a) => a.startsWith('--limit='))?.slice(8) ?? 2000);
const resetMissing = args.includes('--reset-missing');
const workspaceId = process.env.WORKSPACE_ID ?? '22222222-2222-2222-2222-222222222222';

const OKX_SWAP = /^[A-Z0-9]{1,20}-(USDT|USD|BTC|ETH|USDC)-SWAP$/;

/** 把滑动窗口对齐到分钟边界，否则槽位时间戳与 OKX K 线的分钟边界永远对不上（缓存命中率为 0） */
function alignStart(ms: number): number {
  return Math.floor(ms / 60_000) * 60_000;
}
function alignEnd(ms: number): number {
  return Math.ceil(ms / 60_000) * 60_000;
}

async function main() {
  const { db } = createDb();
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await db
    .select()
    .from(tradesTable)
    .where(
      and(
        eq(tradesTable.workspaceId, workspaceId),
        isNotNull(tradesTable.closeTime),
        gte(tradesTable.closeTime, since),
      ),
    )
    .orderBy(desc(tradesTable.closeTime))
    .limit(limit);

  const pending = rows.filter((r) => {
    if (r.exchange !== 'OKX') return false;
    if (!OKX_SWAP.test(r.symbol)) return false;
    const md = (r.metadata ?? {}) as Record<string, unknown>;
    return !md.extremes && !md.extremesMissing;
  });

  console.log(
    `[backfill] 最近 ${days} 天已平仓 ${rows.length} 笔，其中待回填（OKX SWAP 且无极值）${pending.length} 笔`,
  );

  // 分钟级缓存：同一标的的重叠持仓只拉一次
  const cache = new Map<string, Map<number, CandlePoint>>();
  const cacheOf = (instId: string) => {
    let m = cache.get(instId);
    if (!m) {
      m = new Map();
      cache.set(instId, m);
    }
    return m;
  };

  async function candlesForRange(instId: string, startMs: number, endMs: number): Promise<CandlePoint[]> {
    const c = cacheOf(instId);
    const s0 = alignStart(startMs);
    const e0 = alignEnd(endMs);
    const slots: number[] = [];
    for (let ts = s0; ts < e0; ts += 60_000) slots.push(ts);
    const missing = slots.filter((ts) => !c.has(ts));
    if (missing.length > 0) {
      // 连续缺失段合并成尽量少的区间请求
      const ranges: Array<[number, number]> = [];
      let rs = missing[0];
      let prev = missing[0];
      for (let i = 1; i <= missing.length; i++) {
        const cur = missing[i];
        if (cur === undefined || cur !== prev + 60_000) {
          ranges.push([rs, prev + 60_000]);
          rs = cur;
        }
        if (cur !== undefined) prev = cur;
      }
      for (const [s, e] of ranges) {
        const page = await fetchCandles1m(instId, s, e);
        for (const cd of page) c.set(cd.time * 1000, cd);
      }
    }
    const out: CandlePoint[] = [];
    for (const ts of slots) {
      const cd = c.get(ts);
      if (cd) out.push(cd);
    }
    return out;
  }

  let updated = 0;
  let noData = 0;
  let failed = 0;
  const t0 = Date.now();

  // --reset-missing：清掉上一轮因槽位对齐 bug 误标的 extremesMissing，让这些交易重新参与回填（清完即退出，下一轮正常回填会重新统计 pending）
  if (resetMissing) {
    let cleared = 0;
    for (const r of rows) {
      const md = (r.metadata ?? {}) as Record<string, unknown>;
      if (md.extremesMissing && !md.extremes) {
        const next = { ...md };
        delete next.extremesMissing;
        await db.update(tradesTable).set({ metadata: next }).where(eq(tradesTable.id, r.id));
        cleared += 1;
      }
    }
    console.log(`[backfill] --reset-missing 清除误标 ${cleared} 笔，请重新运行不带 --reset-missing 的回填。`);
    process.exit(0);
  }

  for (let i = 0; i < pending.length; i++) {
    const r = pending[i];
    const startMs = r.openTime.getTime();
    const endMs = (r.closeTime as Date).getTime() + 60_000; // 含平仓所在分钟
    try {
      const candles = await candlesForRange(r.symbol, startMs, endMs);
      const ex = extremesOf(candles);
      const md = (r.metadata ?? {}) as Record<string, unknown>;
      const next = { ...md };
      if (ex) {
        next.extremes = ex;
        updated += 1;
      } else {
        next.extremesMissing = true; // 无 K 线数据（过新或已下架），下次跳过
        noData += 1;
      }
      next.extremesCheckedAt = new Date().toISOString();
      await db
        .update(tradesTable)
        .set({ metadata: next })
        .where(eq(tradesTable.id, r.id));
    } catch (e) {
      failed += 1;
      console.warn(`[backfill] ✗ ${r.symbol} ${r.openTime.toISOString()} : ${(e as Error).message}`);
    }
    // 每笔都打印一行，便于观察是否存在「卡在某笔」的异常（重试风暴 / 长持仓）
    if ((i + 1) % 5 === 0 || i === pending.length - 1) {
      process.stdout.write(
        `[backfill] · ${i + 1}/${pending.length} 更新 ${updated} · 无数据 ${noData} · 失败 ${failed}\n`,
      );
    }
    if ((i + 1) % 25 === 0 || i === pending.length - 1) {
      const rate = ((i + 1) / ((Date.now() - t0) / 1000)).toFixed(1);
      console.log(`[backfill] 进度 ${i + 1}/${pending.length}（${rate} 笔/s） 更新 ${updated} · 无数据 ${noData} · 失败 ${failed}`);
    }
  }

  console.log(`[backfill] 完成：更新 ${updated}，无数据 ${noData}，失败 ${failed}，耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  process.exit(0);
}

main().catch((e) => {
  console.error('[backfill] 致命错误:', e);
  process.exit(1);
});
