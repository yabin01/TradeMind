/**
 * K 线取数自检脚本（无需启动 API）。
 *
 * 用途：
 *   1. 验证各交易所公开行情接口在本机网络下是否可达（含代理/直连回退）；
 *   2. 验证「持仓窗口 → 周期选择 → 开仓/平仓点吸附」这条链路的结果是否正确；
 *   3. 出问题时快速定位是「网络不通」还是「交易所没有这段数据」。
 *
 * 运行：pnpm --filter @trademind/api exec tsx scripts/check-candles.ts [--limit=6] [--bar=5m]
 */
import { desc, eq } from 'drizzle-orm';
import { createDb, trades as tradesTable } from '@trademind/database';
import { getTradeCandles, BAR_LABEL } from '../src/market/candles';

const args = process.argv.slice(2);
const limit = Number(args.find((a) => a.startsWith('--limit='))?.slice(8) ?? 6);
const forcedBar = args.find((a) => a.startsWith('--bar='))?.slice(6);
const workspaceId = process.env.WORKSPACE_ID ?? '22222222-2222-2222-2222-222222222222';

const fmt = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

async function main() {
  const { db } = createDb();
  const rows = await db
    .select()
    .from(tradesTable)
    .where(eq(tradesTable.workspaceId, workspaceId))
    .orderBy(desc(tradesTable.closeTime))
    .limit(limit);

  if (rows.length === 0) {
    console.log('库里没有交易，无法自检');
    process.exit(0);
  }

  for (const r of rows) {
    const openMs = r.openTime.getTime();
    const closeMs = r.closeTime ? r.closeTime.getTime() : Date.now();
    const holdMin = Math.round((closeMs - openMs) / 60_000);
    const res = await getTradeCandles(
      {
        exchange: r.exchange,
        symbol: r.symbol,
        entryPrice: r.entryPrice,
        exitPrice: r.exitPrice,
        openTime: r.openTime,
        closeTime: r.closeTime,
      },
      forcedBar,
    );

    console.log('─'.repeat(78));
    console.log(`${r.exchange.padEnd(12)} ${r.symbol.padEnd(26)} 持仓 ${holdMin} 分钟  开仓 ${fmt(openMs)}`);
    if (!res.available) {
      console.log(`  ✗ 不可用：${res.reason}`);
      if (res.hint) console.log(`    建议：${res.hint}`);
      continue;
    }

    const { candles, entry, exit, bar, barOptions, holdingRange, warnings } = res;
    console.log(
      `  ✓ ${res.instId}  周期 ${BAR_LABEL[bar]}(${bar})  可选 ${barOptions.join('/')}  K线 ${candles.length} 根`,
    );
    console.log(
      `    区间 ${fmt(res.span.from * 1000)} → ${fmt(res.span.to * 1000)}`,
    );
    console.log(
      `    开仓标注 t=${fmt(entry.time * 1000)} 价=${entry.price}   平仓标注 ${
        exit ? `t=${fmt(exit.time * 1000)} 价=${exit.price}` : '（持仓中，无）'
      }`,
    );
    // 标注时间必须落在返回的 K 线里，否则 lightweight-charts 会让标注整条消失
    const times = new Set(candles.map((c) => c.time));
    const entryOk = times.has(entry.time);
    const exitOk = exit ? times.has(exit.time) : true;
    console.log(`    标注命中 K 线：开仓 ${entryOk ? '✓' : '✗'}  平仓 ${exitOk ? '✓' : '✗'}`);
    if (holdingRange) {
      console.log(
        `    持仓区间高/低 ${holdingRange.high} / ${holdingRange.low}  振幅 ${holdingRange.amplitudePct.toFixed(
          2,
        )}%${holdingRange.exact ? '（1m 精确）' : '（该周期近似）'}`,
      );
    }
    for (const w of warnings) console.log(`    ⚠ ${w}`);
    if (!entryOk || !exitOk) process.exitCode = 1;
  }
  console.log('─'.repeat(78));
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error('自检失败：', e);
  process.exit(1);
});
