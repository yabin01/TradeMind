import type { UnifiedTrade } from '@trademind/trading-core';
import {
  RULE_TYPES,
  defaultRules,
  evaluateRules,
  summarizeViolations,
  suggestRules,
  dayKey,
  type RuleDef,
} from '../rules';

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

let seq = 0;
function mk(
  partial: Partial<UnifiedTrade> & { id: string; netPnl: number; openTime: string; closeTime: string },
): UnifiedTrade {
  seq++;
  return {
    id: partial.id,
    workspaceId: 'ws',
    accountId: 'acc',
    exchange: 'OKX',
    symbol: partial.symbol ?? 'ETH-USDT-SWAP',
    side: partial.side ?? 'SELL',
    positionSide: partial.positionSide ?? 'SHORT',
    entryPrice: partial.entryPrice ?? 3000,
    exitPrice: partial.exitPrice ?? 3010,
    quantity: partial.quantity ?? 1,
    leverage: partial.leverage ?? 1,
    stopLoss: null,
    takeProfit: null,
    openTime: partial.openTime,
    closeTime: partial.closeTime,
    grossPnl: partial.grossPnl ?? partial.netPnl,
    fees: partial.fees ?? 0,
    funding: partial.funding ?? 0,
    netPnl: partial.netPnl,
    risk: null,
    reward: null,
    rr: partial.rr ?? null,
    strategyId: null,
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

const rule = (
  id: string,
  type: RuleDef['type'],
  params: Record<string, unknown>,
  name: string = type,
  enabled = true,
): RuleDef => ({ id, name, type, enabled, params });

console.log('rules 自测');

// ── 1. MAX_LOSS_PER_TRADE ──────────────────────────────────────────
{
  const t = [
    mk({ id: 'a', netPnl: -150, openTime: '2026-01-01T10:00:00Z', closeTime: '2026-01-01T10:10:00Z' }),
    mk({ id: 'b', netPnl: -50, openTime: '2026-01-01T11:00:00Z', closeTime: '2026-01-01T11:10:00Z' }),
  ];
  const v = evaluateRules(t, [rule('r1', 'MAX_LOSS_PER_TRADE', { value: 100 }, '单笔亏损≤100')]);
  ok('单笔亏损超阈值：只命中 a', v.length === 1 && v[0].tradeId === 'a', JSON.stringify(v));
  ok('违规 detail 含实际亏损', v[0]?.detail.includes('-150.00'), v[0]?.detail ?? '');
  const off = evaluateRules(t, [rule('r1', 'MAX_LOSS_PER_TRADE', { value: 100 }, 'x', false)]);
  ok('规则禁用后不产出违规', off.length === 0);
}

// ── 2. MAX_DAILY_LOSS（按 UTC 日聚合） ──────────────────────────────
{
  const t = [
    mk({ id: 'd1', netPnl: -200, openTime: '2026-02-01T10:00:00Z', closeTime: '2026-02-01T10:30:00Z' }),
    mk({ id: 'd2', netPnl: -150, openTime: '2026-02-01T12:00:00Z', closeTime: '2026-02-01T12:30:00Z' }),
    mk({ id: 'd3', netPnl: +900, openTime: '2026-02-02T12:00:00Z', closeTime: '2026-02-02T12:30:00Z' }),
  ];
  const v = evaluateRules(t, [rule('r2', 'MAX_DAILY_LOSS', { value: 300 })]);
  ok('当日合计 -350 ≤ -300：d1/d2 都被标记', v.length === 2, String(v.length));
  ok('盈利日不被标记', !v.some((x) => x.tradeId === 'd3'));
  ok('detail 含当日合计', v[0]?.detail.includes('-350.00'), v[0]?.detail ?? '');
  const v2 = evaluateRules(t, [rule('r2', 'MAX_DAILY_LOSS', { value: 400 })]);
  ok('阈值放宽到 400 后无违规', v2.length === 0, String(v2.length));
  ok('UTC 日键正确', dayKey('2026-02-01T23:59:00Z') === '2026-02-01');
}

// ── 3. REVENGE_AFTER_LOSS（冷却期） ────────────────────────────────
{
  const t = [
    mk({ id: 'p', netPnl: -100, openTime: '2026-03-01T10:00:00Z', closeTime: '2026-03-01T10:30:00Z' }),
    // 亏损平仓后 10 分钟开新仓 → 违规
    mk({ id: 'q', netPnl: -20, openTime: '2026-03-01T10:40:00Z', closeTime: '2026-03-01T11:00:00Z' }),
    // 亏损平仓后 90 分钟开新仓 → 不违规
    mk({ id: 'r', netPnl: +30, openTime: '2026-03-01T12:10:00Z', closeTime: '2026-03-01T12:30:00Z' }),
  ];
  const v = evaluateRules(t, [rule('r3', 'REVENGE_AFTER_LOSS', { withinMinutes: 30 })]);
  ok('冷却期内开仓被标记：q', v.length === 1 && v[0].tradeId === 'q', JSON.stringify(v.map((x) => x.tradeId)));
  ok('detail 含间隔分钟数', v[0]?.detail.includes('10 分钟'), v[0]?.detail ?? '');
  // 上一笔盈利 → 不触发
  const t2 = [
    mk({ id: 'w', netPnl: +100, openTime: '2026-03-01T10:00:00Z', closeTime: '2026-03-01T10:30:00Z' }),
    mk({ id: 'x', netPnl: -20, openTime: '2026-03-01T10:35:00Z', closeTime: '2026-03-01T10:50:00Z' }),
  ];
  ok('上一笔盈利不触发冷却', evaluateRules(t2, [rule('r3', 'REVENGE_AFTER_LOSS', { withinMinutes: 30 })]).length === 0);
}

// ── 4. MAX_LEVERAGE / MIN_RR ───────────────────────────────────────
{
  const t = [
    mk({ id: 'L', netPnl: 10, openTime: '2026-04-01T10:00:00Z', closeTime: '2026-04-01T10:30:00Z', leverage: 20 }),
    mk({ id: 'l', netPnl: 10, openTime: '2026-04-01T11:00:00Z', closeTime: '2026-04-01T11:30:00Z', leverage: 5 }),
  ];
  const v = evaluateRules(t, [rule('r4', 'MAX_LEVERAGE', { value: 10 })]);
  ok('杠杆 20x 触发，5x 不触发', v.length === 1 && v[0].tradeId === 'L', JSON.stringify(v));

  const t2 = [
    mk({ id: 'rr1', netPnl: 10, openTime: '2026-04-02T10:00:00Z', closeTime: '2026-04-02T10:30:00Z', rr: 0.8 }),
    mk({ id: 'rr2', netPnl: 10, openTime: '2026-04-02T11:00:00Z', closeTime: '2026-04-02T11:30:00Z', rr: 3 }),
    mk({ id: 'rr3', netPnl: 10, openTime: '2026-04-02T12:00:00Z', closeTime: '2026-04-02T12:30:00Z', rr: null }),
  ];
  const v2 = evaluateRules(t2, [rule('r5', 'MIN_RR', { value: 1.5 })]);
  ok('R:R 0.8 触发', v2.length === 1 && v2[0].tradeId === 'rr1', JSON.stringify(v2));
  ok('未标注 R:R 的交易不误判', !v2.some((x) => x.tradeId === 'rr3'));
}

// ── 5. SESSION_BLACKLIST（UTC 小时） ────────────────────────────────
{
  const t = [
    mk({ id: 'h22', netPnl: -30, openTime: '2026-05-01T22:15:00Z', closeTime: '2026-05-01T22:45:00Z' }),
    mk({ id: 'h09', netPnl: -30, openTime: '2026-05-01T09:15:00Z', closeTime: '2026-05-01T09:45:00Z' }),
  ];
  const v = evaluateRules(t, [rule('r6', 'SESSION_BLACKLIST', { hours: [22, 13] })]);
  ok('22:15 开仓命中黑名单', v.length === 1 && v[0].tradeId === 'h22', JSON.stringify(v));
  ok('空黑名单不产出违规', evaluateRules(t, [rule('r6', 'SESSION_BLACKLIST', { hours: [] })]).length === 0);
}

// ── 6. MAX_HOLDING_MINUTES ─────────────────────────────────────────
{
  const t = [
    mk({ id: 'long', netPnl: -5, openTime: '2026-06-01T08:00:00Z', closeTime: '2026-06-01T14:00:00Z' }), // 360min
    mk({ id: 'short', netPnl: -5, openTime: '2026-06-01T08:00:00Z', closeTime: '2026-06-01T09:00:00Z' }), // 60min
  ];
  const v = evaluateRules(t, [rule('r7', 'MAX_HOLDING_MINUTES', { value: 240 })]);
  ok('持仓 360 分钟触发', v.length === 1 && v[0].tradeId === 'long', JSON.stringify(v));
  ok('detail 含实际分钟数', v[0]?.detail.includes('360'), v[0]?.detail ?? '');
}

// ── 7. 去重 & 汇总 ─────────────────────────────────────────────────
{
  const t = [
    mk({ id: 'm1', netPnl: -500, openTime: '2026-07-01T22:00:00Z', closeTime: '2026-07-01T22:30:00Z', leverage: 25 }),
    mk({ id: 'm2', netPnl: +10, openTime: '2026-07-01T09:00:00Z', closeTime: '2026-07-01T09:30:00Z' }),
  ];
  const rules: RuleDef[] = [
    rule('A', 'MAX_LOSS_PER_TRADE', { value: 100 }),
    rule('B', 'MAX_LEVERAGE', { value: 10 }),
    rule('C', 'SESSION_BLACKLIST', { hours: [22] }),
  ];
  const v = evaluateRules(t, rules);
  ok('同一笔命中 3 条规则 → 3 条违规', v.length === 3, String(v.length));
  const s = summarizeViolations(t, v);
  ok('受影响交易数 = 1（去重）', s.affectedTrades === 1, String(s.affectedTrades));
  ok('违规交易合计盈亏 = -500', Math.abs(s.violationPnl + 500) < 1e-6, String(s.violationPnl));
  ok('占比 = 0.5', Math.abs(s.shareOfTrades - 0.5) < 1e-6, String(s.shareOfTrades));
  ok('byRule 有 3 项', s.byRule.length === 3, String(s.byRule.length));
  // 重复评估不产生重复（幂等，DB 唯一索引兜底）
  const v2 = evaluateRules(t, rules.concat(rules));
  ok('重复传入同一规则仍只产出 3 条', v2.length === 3, String(v2.length));
}

// ── 8. 规则元数据 & 默认规则 ────────────────────────────────────────
{
  const types = RULE_TYPES.map((r) => r.type);
  const defs = defaultRules();
  ok('默认规则全部使用已知类型', defs.every((d) => types.includes(d.type)));
  ok('每种类型都有中文标签与描述', RULE_TYPES.every((r) => r.label.length > 0 && r.description.length > 0));
  ok('每种类型都有参数定义', RULE_TYPES.every((r) => r.params.length > 0));
  ok('默认规则含冷却期（默认关闭）', defs.some((d) => d.type === 'REVENGE_AFTER_LOSS' && d.enabled === false));
  // 默认规则可直接跑通全量交易
  const t = [mk({ id: 'z', netPnl: -999, openTime: '2026-08-01T10:00:00Z', closeTime: '2026-08-01T10:30:00Z' })];
  const v = evaluateRules(t, defs.map((d, i) => ({ ...d, id: `def-${i}` })));
  ok('默认规则集可正常评估', Array.isArray(v) && v.length > 0, String(v.length));
}

// ── 9. 阈值推荐（避免「写死默认值命中 100%」的废规则） ──────────────
{
  // 100 笔：杠杆 90 笔 20x + 10 笔 100x；亏损 90 笔 -5 + 10 笔 -200
  const t: UnifiedTrade[] = [];
  for (let i = 0; i < 90; i++) {
    t.push(mk({
      id: `n${i}`, netPnl: -5, leverage: 20,
      openTime: `2026-09-01T${String(9 + (i % 8)).padStart(2, '0')}:00:00Z`,
      closeTime: `2026-09-01T${String(9 + (i % 8)).padStart(2, '0')}:30:00Z`,
    }));
  }
  for (let i = 0; i < 10; i++) {
    t.push(mk({
      id: `x${i}`, netPnl: -200, leverage: 100,
      openTime: `2026-09-02T${String(9 + i).padStart(2, '0')}:00:00Z`,
      closeTime: `2026-09-02T${String(9 + i).padStart(2, '0')}:30:00Z`,
    }));
  }
  const sug = suggestRules(t);
  ok('推荐规则非空', sug.length >= 4, String(sug.length));
  const lev = sug.find((s) => s.type === 'MAX_LEVERAGE');
  ok('杠杆阈值 = 20（P90），不是写死的 10', lev?.params.value === 20, JSON.stringify(lev));
  ok('杠杆命中 = 10 笔（10%）', lev?.estimatedHits === 10, JSON.stringify(lev));
  ok('杠杆规则默认启用', lev?.enabled === true);
  // 亏损额：90 笔 -5 + 10 笔 -200，P90 落在 5 那一档 → 只点名那 10 笔 -200
  const loss = sug.find((s) => s.type === 'MAX_LOSS_PER_TRADE');
  ok('单笔亏损阈值取 P90=5', loss?.params.value === 5, JSON.stringify(loss));
  ok('单笔亏损只命中 10 笔（10%）', loss?.estimatedHits === 10, JSON.stringify(loss));
  ok('命中 10% 的规则默认启用', loss?.enabled === true);
  ok('每条推荐都有依据文案', sug.every((s) => s.rationale.length > 0));
  ok('MIN_RR 在样本不足时不出现', !sug.some((s) => s.type === 'MIN_RR'));

  // 阈值真正生效：用推荐值评估，被点名的交易占比应远低于写死阈值
  const defs: RuleDef[] = sug.map((s, i) => ({ id: `s${i}`, name: s.name, type: s.type, enabled: s.enabled, params: s.params }));
  const v = evaluateRules(t, defs);
  const affected = summarizeViolations(t, v).affectedTrades;
  ok('推荐阈值下被点名交易 < 50%', affected < t.length * 0.5, `${affected}/${t.length}`);

  // 极端反例：写死的 10x 会命中 100 笔（100%），说明默认阈值不可用
  const naive = evaluateRules(t, [rule('bad', 'MAX_LEVERAGE', { value: 10 })]);
  ok('写死 10x 会命中 100 笔（证明需要推荐阈值）', naive.length === 100, String(naive.length));
}

// ── 10. 空数据不崩 ─────────────────────────────────────────────────
{
  ok('空交易集推荐为空', suggestRules([]).length === 0);
  ok('空交易集评估无违规', evaluateRules([], [rule('e', 'MAX_LOSS_PER_TRADE', { value: 1 })]).length === 0);
}

console.log(`\n通过 ${pass}，失败 ${fail}`);
if (fail > 0) process.exit(1);
