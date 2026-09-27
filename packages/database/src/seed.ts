/**
 * Seed 脚本：生成 120 天 × ~300 笔合成交易（含可被 AI 检测的行为模式），
 * 用于本地验证 Dashboard / Analytics / Calendar。
 * 运行：pnpm --filter @trademind/database seed
 */
import {
  computeCoreMetrics,
  buildEquityCurve,
} from '@trademind/analytics';
import type { UnifiedTrade } from '@trademind/trading-core';
import { createDb } from './client';
import {
  accounts,
  connections,
  mistakes,
  portfolios,
  strategies,
  tags,
  trades,
  users,
  workspaces,
} from './schema';

// 固定 ID 方便 API demo 默认值
export const DEMO_USER_ID = '11111111-1111-1111-1111-111111111111';
export const DEMO_WORKSPACE_ID = '22222222-2222-2222-2222-222222222222';
export const DEMO_PORTFOLIO_ID = '33333333-3333-3333-3333-333333333333';
export const DEMO_CONNECTION_ID = '44444444-4444-4444-4444-444444444444';
export const DEMO_ACCOUNT_ID = '55555555-5555-5555-5555-555555555555';

// 可复现的伪随机
let seedState = 42;
function rnd(): number {
  seedState = (seedState * 1664525 + 1013904223) % 4294967296;
  return seedState / 4294967296;
}
function pick<T>(arr: T[]): T {
  return arr[Math.floor(rnd() * arr.length)];
}
function between(min: number, max: number): number {
  return min + rnd() * (max - min);
}

const BASE_PRICES: Record<string, number> = {
  BTCUSDT: 60000,
  ETHUSDT: 2600,
  SOLUSDT: 150,
  XRPUSDT: 0.6,
};

const STRATEGY_NAMES = ['Breakout', 'Trend Following', 'Mean Reversion', 'ChanLun'];
const TAG_NAMES = ['Breakout', 'Trend', 'Range', 'London', 'NewYork', 'High Confidence', 'FOMO', 'Late Entry'];
const MISTAKE_NAMES = ['FOMO', 'Late Entry', 'Early Exit', 'Overtrading', 'No Stop Loss', 'Oversizing', 'Moving Stop'];

async function main(): Promise<void> {
  const { db, sql } = createDb();
  console.log('连接数据库…');

  await db.delete(trades);
  await db.delete(accounts);
  await db.delete(connections);
  await db.delete(portfolios);
  await db.delete(strategies);
  await db.delete(tags);
  await db.delete(mistakes);
  await db.delete(workspaces);
  await db.delete(users);

  await db.insert(users).values({ id: DEMO_USER_ID, email: 'demo@trademind.local', name: 'Demo Trader' });
  await db.insert(workspaces).values({ id: DEMO_WORKSPACE_ID, userId: DEMO_USER_ID, name: "Alex's Trading" });
  await db.insert(portfolios).values({ id: DEMO_PORTFOLIO_ID, workspaceId: DEMO_WORKSPACE_ID, name: 'Crypto', type: 'CRYPTO' });
  await db.insert(connections).values({
    id: DEMO_CONNECTION_ID,
    workspaceId: DEMO_WORKSPACE_ID,
    exchange: 'CSV',
    name: 'CSV Import',
    status: 'CONNECTED',
  });
  await db.insert(accounts).values({
    id: DEMO_ACCOUNT_ID,
    workspaceId: DEMO_WORKSPACE_ID,
    portfolioId: DEMO_PORTFOLIO_ID,
    connectionId: DEMO_CONNECTION_ID,
    name: 'OKX Perp (Demo)',
    exchange: 'OKX',
    type: 'PERPETUAL',
    startingBalance: 10000,
  });

  const strategyRows = await db
    .insert(strategies)
    .values(
      STRATEGY_NAMES.map((name) => ({
        workspaceId: DEMO_WORKSPACE_ID,
        name,
        description: `Demo strategy: ${name}`,
      })),
    )
    .returning();
  const tagRows = await db
    .insert(tags)
    .values(TAG_NAMES.map((name) => ({ workspaceId: DEMO_WORKSPACE_ID, name })))
    .returning();
  const mistakeRows = await db
    .insert(mistakes)
    .values(MISTAKE_NAMES.map((name) => ({ workspaceId: DEMO_WORKSPACE_ID, name })))
    .returning();

  // 预设模式（供 AI Pattern Detection 检测）：
  // - NY session Short 胜率低（32%）
  // - FOMO 标签亏损
  // - Mean Reversion 策略整体亏损
  const now = Date.now();
  const rows: (typeof trades.$inferInsert)[] = [];
  for (let i = 0; i < 300; i++) {
    const symbol = pick(Object.keys(BASE_PRICES));
    const strategy = pick(strategyRows);
    const openTs = now - Math.floor(between(0, 120) * 86400000) - Math.floor(between(0, 20) * 3600000);
    const hourUtc = new Date(openTs).getUTCHours();
    const session = hourUtc < 8 ? 'ASIA' : hourUtc < 13 ? 'LONDON' : 'NEW_YORK';

    const shortBias = rnd() < 0.45;
    const isShort = shortBias;
    const basePrice = BASE_PRICES[symbol] * (0.9 + (120 - (now - openTs) / 86400000) * 0.003);
    const entry = basePrice * between(0.995, 1.005);
    const qty = symbol === 'BTCUSDT' ? between(0.01, 0.05) : symbol === 'ETHUSDT' ? between(0.2, 1) : between(10, 200);

    // 行为模式注入
    let winProb = 0.5;
    if (strategy.name === 'Mean Reversion') winProb = 0.38;
    if (strategy.name === 'Breakout') winProb = 0.55;
    if (session === 'NEW_YORK' && isShort) winProb = 0.32;

    const win = rnd() < winProb;
    const rMultiple = win ? between(0.8, 2.5) : -between(0.6, 1.1);
    const riskPct = between(0.004, 0.012);
    const riskAmount = entry * qty * riskPct;
    const grossPnl = riskAmount * rMultiple;
    const exit = entry + (isShort ? -1 : 1) * (grossPnl / qty);

    const notional = entry * qty;
    const fees = notional * 0.0004 * 2;
    const funding = (rnd() < 0.6 ? 1 : -1) * notional * 0.00005;
    const netPnl = grossPnl - fees - funding;

    const hasSl = rnd() < 0.7;
    const stopLoss = hasSl ? entry * (isShort ? 1 + riskPct : 1 - riskPct) : null;
    const takeProfit = hasSl ? entry * (isShort ? 1 - riskPct * 2 : 1 + riskPct * 2) : null;
    const risk = hasSl ? Math.abs(entry - (stopLoss as number)) * qty : null;
    const reward = hasSl ? Math.abs((takeProfit as number) - entry) * qty : null;

    const tradeTags: string[] = [];
    if (strategy.name === 'Breakout') tradeTags.push(tagRows[0].id);
    if (rnd() < 0.25) tradeTags.push(pick(tagRows).id);
    const tradeMistakes: string[] = [];
    if (rnd() < 0.3) tradeMistakes.push(pick(mistakeRows).id);
    if (rnd() < 0.12) tradeMistakes.push(mistakeRows[0].id); // FOMO 加权

    const holdMinutes = between(10, 1400);
    const closeTs = openTs + holdMinutes * 60000;

    rows.push({
      workspaceId: DEMO_WORKSPACE_ID,
      accountId: DEMO_ACCOUNT_ID,
      exchange: 'OKX',
      symbol,
      side: isShort ? 'SELL' : 'BUY',
      positionSide: isShort ? 'SHORT' : 'LONG',
      entryPrice: entry,
      exitPrice: exit,
      quantity: qty,
      leverage: Math.floor(between(2, 10)),
      stopLoss,
      takeProfit,
      openTime: new Date(openTs),
      closeTime: new Date(closeTs),
      grossPnl,
      fees,
      funding,
      netPnl,
      risk,
      reward,
      rr: risk && reward ? reward / risk : null,
      strategyId: strategy.id,
      tags: tradeTags,
      mistakes: tradeMistakes,
      confidence: Math.floor(between(1, 6)),
      marketCondition: pick(['TRENDING', 'RANGE', 'BREAKOUT']),
      notes: null,
      screenshots: [],
      externalTradeId: `SEED-${i}`,
      metadata: {},
    });
  }

  for (let i = 0; i < rows.length; i += 50) {
    await db.insert(trades).values(rows.slice(i, i + 50));
  }
  console.log(`已插入 ${rows.length} 笔交易`);

  // 用分析引擎打印摘要（同时验证数据管道）
  const allTrades: UnifiedTrade[] = rows.map((r, i) => ({
    id: String(i),
    workspaceId: DEMO_WORKSPACE_ID,
    accountId: DEMO_ACCOUNT_ID,
    exchange: 'OKX',
    symbol: r.symbol,
    side: r.side as 'BUY' | 'SELL',
    positionSide: r.positionSide as 'LONG' | 'SHORT',
    entryPrice: r.entryPrice,
    exitPrice: r.exitPrice ?? null,
    quantity: r.quantity,
    leverage: r.leverage ?? 1,
    stopLoss: r.stopLoss ?? null,
    takeProfit: r.takeProfit ?? null,
    openTime: (r.openTime as Date).toISOString(),
    closeTime: (r.closeTime as Date).toISOString(),
    grossPnl: r.grossPnl ?? 0,
    fees: r.fees ?? 0,
    funding: r.funding ?? 0,
    netPnl: r.netPnl ?? 0,
    risk: r.risk ?? null,
    reward: r.reward ?? null,
    rr: r.rr ?? null,
    strategyId: r.strategyId ?? null,
    tags: (r.tags as string[]) ?? [],
    mistakes: (r.mistakes as string[]) ?? [],
    confidence: r.confidence ?? null,
    marketCondition: r.marketCondition ?? null,
    notes: r.notes ?? null,
    screenshots: [],
    externalTradeId: r.externalTradeId ?? null,
    metadata: {},
  }));
  const m = computeCoreMetrics(allTrades);
  const dd = buildEquityCurve(allTrades, 10000);
  console.log(
    `Net PNL: ${m.netPnl.toFixed(2)} | Win Rate: ${(m.winRate * 100).toFixed(1)}% | PF: ${
      Number.isFinite(m.profitFactor) ? m.profitFactor.toFixed(2) : '∞'
    } | MaxDD: ${dd.maxDrawdown.toFixed(2)}`,
  );

  await sql.end();
  console.log('Seed 完成 ✓');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
