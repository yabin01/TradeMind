import type { UnifiedTrade } from '@trademind/trading-core';
import {
  patternGroups,
  whatIfExclude,
  whatIfDropWorst,
  detectRevengeTrades,
  buildImprovementPlan,
} from '../counterfactual';

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${extra}`);
  }
}
function near(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) < eps;
}

function mk(partial: Partial<UnifiedTrade> & { id: string; netPnl: number; openTime: string }): UnifiedTrade {
  return {
    id: partial.id,
    workspaceId: 'ws',
    accountId: 'acc',
    exchange: 'OKX',
    symbol: partial.symbol ?? 'ETH-USDT-SWAP',
    side: partial.side ?? 'SELL',
    positionSide: partial.positionSide ?? 'SHORT',
    entryPrice: partial.entryPrice ?? 100,
    exitPrice: partial.exitPrice ?? 101,
    quantity: partial.quantity ?? 1,
    leverage: partial.leverage ?? 1,
    stopLoss: null,
    takeProfit: null,
    openTime: partial.openTime,
    closeTime: partial.closeTime ?? partial.openTime,
    grossPnl: partial.grossPnl ?? partial.netPnl,
    fees: partial.fees ?? 0,
    funding: partial.funding ?? 0,
    netPnl: partial.netPnl,
    risk: null,
    reward: null,
    rr: null,
    strategyId: partial.strategyId ?? null,
    tags: [],
    mistakes: [],
    confidence: null,
    marketCondition: null,
    notes: null,
    screenshots: [],
    externalTradeId: null,
    metadata: {},
    createdAt: partial.openTime,
    updatedAt: partial.openTime,
  } satisfies UnifiedTrade;
}

/**
 * 构造三品种样本（共 140 笔）：
 *   BAD  20 笔 × -100 = -2000（亏损主力，但只占 14% 样本）
 *   MID 100 笔 ×   +5 =  +500（主力品种，保证剔除后样本量足够）
 *   GOOD 20 笔 ×  +50 = +1000
 * 基线净盈亏 = -500
 */
const trades: UnifiedTrade[] = [];
const dayOf = (i: number) => `2026-01-${String((i % 28) + 1).padStart(2, '0')}`;
for (let i = 0; i < 20; i++) {
  trades.push(mk({ id: `bad-${i}`, netPnl: -100, symbol: 'BAD-USDT-SWAP', openTime: `${dayOf(i)}T10:00:00Z` }));
}
for (let i = 0; i < 100; i++) {
  trades.push(mk({ id: `mid-${i}`, netPnl: 5, symbol: 'MID-USDT-SWAP', openTime: `${dayOf(i)}T14:00:00Z` }));
}
for (let i = 0; i < 20; i++) {
  trades.push(mk({ id: `good-${i}`, netPnl: 50, symbol: 'GOOD-USDT-SWAP', openTime: `${dayOf(i)}T14:00:00Z` }));
}

console.log('counterfactual 自测');

// 1. 分组：亏损最重排前面
const groups = patternGroups(trades, 'symbol');
ok('分组按盈亏升序，BAD 排第一', groups[0].key === 'BAD-USDT-SWAP', groups[0].key);
ok('BAD 组盈亏 = -2000', near(groups[0].pnl, -2000), String(groups[0].pnl));
ok('MID 组盈亏 = +500', near(groups[1].pnl, 500), String(groups[1].pnl));
ok('GOOD 组盈亏 = +1000', near(groups[2].pnl, 1000), String(groups[2].pnl));
ok('BAD 胜率 = 0', near(groups[0].winRate, 0));
ok('分组带 tradeRefs', groups[0].tradeRefs.length === 20);

// 2. 反事实：剔除 BAD（仅占 14% 样本）后净盈亏 -500 → +1500，且结论可靠
const wi = whatIfExclude(trades, 'symbol', ['BAD-USDT-SWAP']);
ok('基线净盈亏 = -500', near(wi.baseline.netPnl, -500), String(wi.baseline.netPnl));
ok('情景净盈亏 = +1500', near(wi.scenario.netPnl, 1500), String(wi.scenario.netPnl));
ok('deltaPnl = +2000', near(wi.deltaPnl, 2000), String(wi.deltaPnl));
ok('样本保留率 = 120/140', near(wi.sampleRetention, 120 / 140, 1e-9), String(wi.sampleRetention));
ok('结论可靠', wi.reliable === true);
ok('给出正向建议', wi.advice[0].includes('提升'), wi.advice[0]);
ok('剔除引用 = 20 笔', wi.excludedTradeRefs.length === 20);

// 3. 反事实：剔除盈利组，结论应相反（净盈亏下降）
const wi2 = whatIfExclude(trades, 'symbol', ['GOOD-USDT-SWAP']);
ok('剔除盈利组 deltaPnl < 0', wi2.deltaPnl < 0, String(wi2.deltaPnl));
ok('结论可靠', wi2.reliable === true);
ok('提示不适砍掉', wi2.advice[0].includes('下降'), wi2.advice[0]);

// 4. 自动挑最差分组
const auto = whatIfDropWorst(trades, 'symbol', { topN: 1, minTrades: 5 });
ok('自动选中 BAD', auto.excludedKeys[0] === 'BAD-USDT-SWAP', auto.excludedKeys.join(','));
ok('自动推演 deltaPnl = +2000', near(auto.deltaPnl, 2000));

// 5. 时段维度
const hg = patternGroups(trades, 'hour');
const h10 = hg.find((g) => g.key === '10');
const h14 = hg.find((g) => g.key === '14');
ok('10 点时段亏损 -2000', !!h10 && near(h10.pnl, -2000), String(h10?.pnl));
ok('14 点时段盈利 +1500', !!h14 && near(h14.pnl, 1500), String(h14?.pnl));
ok('时段 label 带 :00', h10?.label === '10:00 时段', h10?.label);

// 6. 报复性交易检测
const revengeTrades: UnifiedTrade[] = [
  mk({ id: 'r1', netPnl: -50, openTime: '2026-02-01T10:00:00Z', closeTime: '2026-02-01T10:30:00Z' }),
  mk({ id: 'r2', netPnl: -30, openTime: '2026-02-01T10:45:00Z', closeTime: '2026-02-01T11:00:00Z' }),
  mk({ id: 'r3', netPnl: 20, openTime: '2026-02-01T11:10:00Z', closeTime: '2026-02-01T11:20:00Z' }),
  mk({ id: 'r4', netPnl: -10, openTime: '2026-02-02T09:00:00Z', closeTime: '2026-02-02T09:10:00Z' }),
];
const rev = detectRevengeTrades(revengeTrades, { windowMinutes: 60 });
ok('检出 1 笔报复性交易（r2）', rev.count === 1 && rev.tradeRefs[0] === 'r2', JSON.stringify(rev.tradeRefs));
ok('报复性交易盈亏 = -30', near(rev.pnl, -30));
ok('占亏损交易比例 = 1/3', near(rev.shareOfLosses, 1 / 3, 1e-6), String(rev.shareOfLosses));

// 7. 改进计划
const plan = buildImprovementPlan(trades);
ok('计划至少 1 条规则', plan.rules.length >= 1, String(plan.rules.length));
ok('规则含时段或品种建议', plan.rules.some((r) => r.title.includes('时段') || r.title.includes('品种')), plan.rules.map((r) => r.title).join('|'));
ok('每条规则都有证据', plan.rules.every((r) => r.evidence.length > 0));

// 8. 统计陷阱：剔除占样本绝大多数的分组时，必须拒绝给出「砍掉」建议
const trapTrades: UnifiedTrade[] = [];
for (let i = 0; i < 100; i++) trapTrades.push(mk({ id: `main-${i}`, netPnl: -10, symbol: 'MAIN-USDT-SWAP', openTime: `2026-03-0${(i % 9) + 1}T10:00:00Z` }));
for (let i = 0; i < 5; i++) trapTrades.push(mk({ id: `side-${i}`, netPnl: 3, symbol: 'SIDE-USDT-SWAP', openTime: `2026-03-0${(i % 9) + 1}T14:00:00Z` }));
const trap = whatIfExclude(trapTrades, 'symbol', ['MAIN-USDT-SWAP']);
ok('剔除主力后 deltaPnl 为正（表面好看）', trap.deltaPnl > 0, String(trap.deltaPnl));
ok('但标记不可靠', trap.reliable === false);
ok('样本保留率 = 5/105', near(trap.sampleRetention, 5 / 105, 1e-9), String(trap.sampleRetention));
ok('明确警告不可作为行动依据', trap.advice[0].includes('不可作为行动依据'), trap.advice[0]);

// 8b. 计划层面对不可靠推演只陈述事实、不下达「暂停」建议
const trapPlan = buildImprovementPlan(trapTrades);
const symRule = trapPlan.rules.find((r) => r.title.includes('MAIN-USDT-SWAP'));
ok('品种规则存在', !!symRule);
ok('不给出「暂停」指令', !!symRule && !symRule.title.startsWith('暂停亏损品种'), symRule?.title);
ok('提示是样本假象', !!symRule && symRule.detail.includes('假象'), symRule?.detail);

// 9. 报复性交易：严格口径（仓位放大）应少于宽松口径
const sizeTrades: UnifiedTrade[] = [
  mk({ id: 's1', netPnl: -50, quantity: 1, openTime: '2026-04-01T10:00:00Z', closeTime: '2026-04-01T10:30:00Z' }),
  mk({ id: 's2', netPnl: -30, quantity: 3, openTime: '2026-04-01T10:45:00Z', closeTime: '2026-04-01T11:00:00Z' }),
  mk({ id: 's3', netPnl: -20, quantity: 0.5, openTime: '2026-04-01T11:05:00Z', closeTime: '2026-04-01T11:20:00Z' }),
];
const loose = detectRevengeTrades(sizeTrades);
const strict = detectRevengeTrades(sizeTrades, { requireLargerSize: true });
ok('宽松口径检出 2 笔', loose.count === 2, String(loose.count));
ok('严格口径只留仓位放大的 1 笔（s2）', strict.count === 1 && strict.tradeRefs[0] === 's2', JSON.stringify(strict.tradeRefs));

console.log(`\n通过 ${pass}，失败 ${fail}`);
if (fail > 0) process.exit(1);
