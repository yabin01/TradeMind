import { and, eq, isNotNull } from 'drizzle-orm';
import type { FilterSet, UnifiedTrade } from '@trademind/trading-core';
import { createDb, trades as tradesTable } from '@trademind/database';

export type DbRow = typeof tradesTable.$inferSelect;

/** DB 行 → UnifiedTrade（读路径统一转换） */
export function rowToTrade(r: DbRow): UnifiedTrade {
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    accountId: r.accountId,
    exchange: r.exchange as UnifiedTrade['exchange'],
    symbol: r.symbol,
    side: r.side as 'BUY' | 'SELL',
    positionSide: r.positionSide as UnifiedTrade['positionSide'],
    entryPrice: r.entryPrice,
    exitPrice: r.exitPrice,
    quantity: r.quantity,
    leverage: r.leverage,
    stopLoss: r.stopLoss,
    takeProfit: r.takeProfit,
    openTime: r.openTime.toISOString(),
    closeTime: r.closeTime ? r.closeTime.toISOString() : null,
    grossPnl: r.grossPnl,
    fees: r.fees,
    funding: r.funding,
    netPnl: r.netPnl,
    risk: r.risk,
    reward: r.reward,
    rr: r.rr,
    strategyId: r.strategyId,
    tags: (r.tags as string[]) ?? [],
    entryTags: (r.entryTags as string[]) ?? [],
    exitTags: (r.exitTags as string[]) ?? [],
    archived: r.archived ?? false,
    mistakes: (r.mistakes as string[]) ?? [],
    confidence: r.confidence,
    marketCondition: r.marketCondition,
    notes: r.notes,
    screenshots: (r.screenshots as string[]) ?? [],
    externalTradeId: r.externalTradeId,
    chanlun: (r.chanlun as UnifiedTrade['chanlun']) ?? null,
    metadata: (r.metadata as Record<string, unknown>) ?? {},
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/**
 * MVP 读路径：加载 workspace 全部交易后在内存中 applyFilter（数据量 < 10 万笔足够快）。
 * Phase 2 迁移到 SQL 下推 + 指标物化表。
 */
/** 允许通过 API 更新的交易字段（白名单，避免误改只读派生字段） */
export interface TradePatch {
  archived?: boolean;
  tags?: string[];
  entryTags?: string[];
  exitTags?: string[];
  notes?: string | null;
  strategyId?: string | null;
  mistakes?: string[];
  confidence?: number | null;
  marketCondition?: string | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
  risk?: number | null;
  reward?: number | null;
  rr?: number | null;
}

export type TradeRepo = {
  db: ReturnType<typeof createDb>['db'];
  sql: ReturnType<typeof createDb>['sql'];
  loadTrades: (workspaceId: string, filter?: FilterSet) => Promise<UnifiedTrade[]>;
  existingExternalIds: (workspaceId: string) => Promise<Set<string>>;
  rowToTrade: (r: DbRow) => UnifiedTrade;
  updateTrade: (workspaceId: string, id: string, patch: TradePatch) => Promise<UnifiedTrade | null>;
};

export function createTradeRepo(databaseUrl?: string): TradeRepo {
  const { db, sql } = createDb(databaseUrl);

  async function loadTrades(workspaceId: string, filter?: FilterSet): Promise<UnifiedTrade[]> {
    const rows = await db.select().from(tradesTable).where(eq(tradesTable.workspaceId, workspaceId));
    const { applyFilter } = await import('@trademind/analytics');
    const mapped = rows.map(rowToTrade);
    return applyFilter(mapped, filter ?? {});
  }

  async function existingExternalIds(workspaceId: string): Promise<Set<string>> {
    const rows = await db
      .select({ ext: tradesTable.externalTradeId })
      .from(tradesTable)
      .where(and(eq(tradesTable.workspaceId, workspaceId), isNotNull(tradesTable.externalTradeId)));
    return new Set(rows.map((r) => r.ext as string));
  }

  async function updateTrade(workspaceId: string, id: string, patch: TradePatch): Promise<UnifiedTrade | null> {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    const boolFields = ['archived'] as const;
    const arrFields = ['tags', 'entryTags', 'exitTags', 'mistakes'] as const;
    const strFields = ['notes', 'strategyId', 'marketCondition'] as const;
    const numFields = ['confidence', 'stopLoss', 'takeProfit', 'risk', 'reward', 'rr'] as const;
    for (const f of boolFields) if (patch[f] !== undefined) set[f] = patch[f];
    for (const f of arrFields) if (patch[f] !== undefined) set[f] = patch[f];
    for (const f of strFields) if (patch[f] !== undefined) set[f] = patch[f];
    for (const f of numFields) if (patch[f] !== undefined) set[f] = patch[f];

    await db.update(tradesTable).set(set).where(and(eq(tradesTable.id, id), eq(tradesTable.workspaceId, workspaceId)));
    const rows = await db
      .select()
      .from(tradesTable)
      .where(and(eq(tradesTable.id, id), eq(tradesTable.workspaceId, workspaceId)));
    return rows.length > 0 ? rowToTrade(rows[0]) : null;
  }

  return { db, sql, loadTrades, existingExternalIds, rowToTrade, updateTrade };
}
