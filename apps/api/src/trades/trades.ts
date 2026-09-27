import { Body, Controller, Delete, Get, Module, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { and, eq, inArray } from 'drizzle-orm';
import {
  dedupeTrades,
  mapCsvToTrades,
  type FilterSet,
  type UnifiedTrade,
} from '@trademind/trading-core';
import {
  accounts,
  dailyMetrics,
  hourlyMetrics as hourlyMetricsTable,
  strategies as strategiesTable,
  tags as tagsTable,
  trades as tradesTable,
} from '@trademind/database';
import { computeCalendar } from '@trademind/analytics';
import { createTradeRepo, type TradePatch } from '../common/trades-repo';
import { parseFilter, workspaceOf } from '../common/workspace';

/** 批量更新载荷：归档切换 + 按名称合并标签/入场理由/出场理由 */
export interface BatchPatch {
  archived?: boolean;
  tags?: string[]; // 标签名（不存在则创建），按 id 合并进 tags
  entryTags?: string[]; // 名称直接合并
  exitTags?: string[]; // 名称直接合并
}

export class TradesService {
  private repo = createTradeRepo();

  async list(workspaceId: string, page: number, pageSize: number, filter: FilterSet) {
    const all = await this.repo.loadTrades(workspaceId, filter);
    const sorted = [...all].sort(
      (a, b) =>
        new Date(b.closeTime ?? b.openTime).getTime() -
        new Date(a.closeTime ?? a.openTime).getTime(),
    );
    const start = (page - 1) * pageSize;
    return { items: sorted.slice(start, start + pageSize), total: sorted.length, page, pageSize };
  }

  async get(workspaceId: string, id: string): Promise<UnifiedTrade | null> {
    const rows = await this.repo.db
      .select()
      .from(tradesTable)
      .where(and(eq(tradesTable.id, id), eq(tradesTable.workspaceId, workspaceId)));
    return rows.length > 0 ? this.repo.rowToTrade(rows[0]) : null;
  }

  /**
   * 单笔交易的完整明细：原始字段 + 派生口径（名义价值、持仓时长、成本占比、R 倍数、是否触发止损…）。
   * MAE/MFE 需要持仓期间价格路径，当前数据源不具备，返回 null 并附原因（不做估算）。
   */
  async getDetail(workspaceId: string, id: string) {
    const t = await this.get(workspaceId, id);
    if (!t) return null;
    const all = await this.repo.loadTrades(workspaceId);
    const { buildTradeDetail } = await import('@trademind/analytics');
    return { trade: t, detail: buildTradeDetail(t, all) };
  }

  /**
   * CSV 导入：解析 → 归一化 → 策略/标签解析 → 批内去重 + 库内去重 → 入库 → 重算指标。
   */
  async importCsv(
    workspaceId: string,
    body: { csv: string; accountId?: string; exchange?: string; tzOffsetMinutes?: number },
  ) {
    const accountId = body.accountId ?? (await this.defaultAccount(workspaceId));
    const { trades: mapped, errors } = mapCsvToTrades(body.csv, {
      workspaceId,
      accountId,
      exchange: (body.exchange ?? 'CSV') as UnifiedTrade['exchange'],
      tzOffsetMinutes: body.tzOffsetMinutes ?? 0,
    });

    // 解析策略名 → strategyId（不存在则创建）
    const strategyMap = await this.ensureStrategies(workspaceId, mapped);
    const tagMap = await this.ensureTags(workspaceId, mapped);

    for (const t of mapped) {
      if (t.strategyName) t.strategyId = strategyMap.get(t.strategyName) ?? null;
      t.tags = t.tags
        .map((name) => tagMap.get(name))
        .filter((id): id is string => Boolean(id));
    }

    // 去重：批内 + 库内（externalTradeId）
    const { trades: deduped, duplicates } = dedupeTrades(mapped);
    const existing = await this.repo.existingExternalIds(workspaceId);
    const toInsert = deduped.filter((t) => !t.externalTradeId || !existing.has(t.externalTradeId));
    const skipped = mapped.length - toInsert.length;

    const rows = toInsert.map((t) => ({
      workspaceId: t.workspaceId,
      accountId: t.accountId,
      exchange: t.exchange,
      symbol: t.symbol,
      side: t.side,
      positionSide: t.positionSide,
      entryPrice: t.entryPrice,
      exitPrice: t.exitPrice,
      quantity: t.quantity,
      leverage: Math.round(t.leverage),
      stopLoss: t.stopLoss,
      takeProfit: t.takeProfit,
      openTime: new Date(t.openTime),
      closeTime: t.closeTime ? new Date(t.closeTime) : null,
      grossPnl: t.grossPnl,
      fees: t.fees,
      funding: t.funding,
      netPnl: t.netPnl,
      risk: t.risk,
      reward: t.reward,
      rr: t.rr,
      strategyId: t.strategyId,
      tags: t.tags,
      mistakes: t.mistakes,
      confidence: t.confidence ? Math.round(t.confidence) : null,
      marketCondition: t.marketCondition,
      notes: t.notes,
      screenshots: t.screenshots,
      externalTradeId: t.externalTradeId,
      metadata: t.metadata,
    }));

    for (let i = 0; i < rows.length; i += 100) {
      await this.repo.db.insert(tradesTable).values(rows.slice(i, i + 100));
    }

    await this.recomputeMetrics(workspaceId, accountId);
    return { imported: rows.length, skipped, duplicates, errors };
  }

  async createManual(workspaceId: string, body: Record<string, unknown>) {
    const accountId = (body.accountId as string) ?? (await this.defaultAccount(workspaceId));
    const csvOf = [
      'symbol,side,positionSide,entryPrice,exitPrice,quantity,leverage,openTime,closeTime,fees,funding,stopLoss,takeProfit,strategy,tags,notes',
      [
        body.symbol,
        body.side,
        body.positionSide ?? '',
        body.entryPrice,
        body.exitPrice,
        body.quantity,
        body.leverage ?? 1,
        body.openTime,
        body.closeTime,
        body.fees ?? 0,
        body.funding ?? 0,
        body.stopLoss ?? '',
        body.takeProfit ?? '',
        body.strategyName ?? '',
        (body.tags as string[] | undefined)?.join('|') ?? '',
        body.notes ?? '',
      ].join(','),
    ].join('\n');
    return this.importCsv(workspaceId, { csv: csvOf, accountId, exchange: 'MANUAL' });
  }

  async remove(workspaceId: string, id: string) {
    await this.repo.db
      .delete(tradesTable)
      .where(and(eq(tradesTable.id, id), eq(tradesTable.workspaceId, workspaceId)));
    return { deleted: true };
  }

  /** 单笔更新（归档 / 标签 / 笔记 / 止损止盈 等白名单字段） */
  async update(workspaceId: string, id: string, patch: TradePatch) {
    return this.repo.updateTrade(workspaceId, id, patch);
  }

  /** 批量更新：归档切换 + 按名称合并 标签 / 入场理由 / 出场理由（标签名不存在则创建） */
  async batchUpdate(workspaceId: string, ids: string[], patch: BatchPatch) {
    const idSet = new Set(ids);
    const all = await this.repo.loadTrades(workspaceId);
    const targets = all.filter((t) => idSet.has(t.id));
    let tagIdMap = new Map<string, string>();
    if (patch.tags && patch.tags.length > 0) {
      tagIdMap = await this.ensureTags(workspaceId, [{ tags: patch.tags } as unknown as UnifiedTrade]);
    }
    let updated = 0;
    for (const t of targets) {
      const next: TradePatch = {};
      if (patch.archived !== undefined) next.archived = patch.archived;
      if (patch.tags && patch.tags.length > 0) {
        const addIds = patch.tags.map((n) => tagIdMap.get(n)).filter((x): x is string => Boolean(x));
        next.tags = Array.from(new Set([...(t.tags ?? []), ...addIds]));
      }
      if (patch.entryTags && patch.entryTags.length > 0) {
        next.entryTags = Array.from(new Set([...(t.entryTags ?? []), ...patch.entryTags]));
      }
      if (patch.exitTags && patch.exitTags.length > 0) {
        next.exitTags = Array.from(new Set([...(t.exitTags ?? []), ...patch.exitTags]));
      }
      await this.repo.updateTrade(workspaceId, t.id, next);
      updated += 1;
    }
    return { updated };
  }

  /** 批量删除（需显式传 ids，避免误删） */
  async batchRemove(workspaceId: string, ids: string[]) {
    if (!ids || ids.length === 0) return { deleted: 0 };
    await this.repo.db
      .delete(tradesTable)
      .where(and(eq(tradesTable.workspaceId, workspaceId), inArray(tradesTable.id, ids)));
    return { deleted: ids.length };
  }

  /** 指标物化：daily_metrics + hourly_metrics */
  async recomputeMetrics(workspaceId: string, accountId: string) {
    const all = await this.repo.loadTrades(workspaceId);
    const forAccount = all.filter((t) => t.accountId === accountId);

    const daily = computeCalendar(forAccount);
    for (const d of daily) {
      await this.repo.db
        .insert(dailyMetrics)
        .values({
          workspaceId,
          accountId,
          day: d.date,
          trades: d.trades,
          wins: d.wins,
          pnl: d.pnl,
          winRate: d.winRate,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [dailyMetrics.accountId, dailyMetrics.day],
          set: {
            trades: d.trades,
            wins: d.wins,
            pnl: d.pnl,
            winRate: d.winRate,
            updatedAt: new Date(),
          },
        });
    }

    const hourlyMap = new Map<string, { trades: number; wins: number; pnl: number }>();
    for (const t of forAccount) {
      if (!t.closeTime) continue;
      const d = new Date(t.closeTime);
      d.setUTCMinutes(0, 0, 0);
      const key = d.toISOString();
      const agg = hourlyMap.get(key) ?? { trades: 0, wins: 0, pnl: 0 };
      agg.trades++;
      if (t.netPnl > 0) agg.wins++;
      agg.pnl += t.netPnl;
      hourlyMap.set(key, agg);
    }
    for (const [key, agg] of hourlyMap) {
      await this.repo.db
        .insert(hourlyMetricsTable)
        .values({
          workspaceId,
          accountId,
          hourBucket: new Date(key),
          trades: agg.trades,
          wins: agg.wins,
          pnl: agg.pnl,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [hourlyMetricsTable.accountId, hourlyMetricsTable.hourBucket],
          set: {
            trades: agg.trades,
            wins: agg.wins,
            pnl: agg.pnl,
            updatedAt: new Date(),
          },
        });
    }
    return { dailyDays: daily.length, hourlyBuckets: hourlyMap.size };
  }

  private async defaultAccount(workspaceId: string): Promise<string> {
    const rows = await this.repo.db
      .select()
      .from(accounts)
      .where(eq(accounts.workspaceId, workspaceId));
    if (rows.length === 0) throw new Error('workspace has no account; create one first');
    return rows[0].id;
  }

  private async ensureStrategies(workspaceId: string, ts: UnifiedTrade[]) {
    const names = [...new Set(ts.map((t) => t.strategyName).filter((n): n is string => Boolean(n)))];
    const map = new Map<string, string>();
    if (names.length === 0) return map;
    const existing = await this.repo.db
      .select()
      .from(strategiesTable)
      .where(eq(strategiesTable.workspaceId, workspaceId));
    for (const s of existing) map.set(s.name, s.id);
    for (const name of names) {
      if (!map.has(name)) {
        const [row] = await this.repo.db
          .insert(strategiesTable)
          .values({ workspaceId, name })
          .returning();
        map.set(name, row.id);
      }
    }
    return map;
  }

  private async ensureTags(workspaceId: string, ts: UnifiedTrade[]) {
    const names = [...new Set(ts.flatMap((t) => t.tags))];
    const map = new Map<string, string>();
    if (names.length === 0) return map;
    const existing = await this.repo.db.select().from(tagsTable).where(eq(tagsTable.workspaceId, workspaceId));
    for (const s of existing) map.set(s.name, s.id);
    for (const name of names) {
      if (!map.has(name)) {
        const [row] = await this.repo.db.insert(tagsTable).values({ workspaceId, name }).returning();
        map.set(name, row.id);
      }
    }
    return map;
  }
}

@Controller('trades')
export class TradesController {
  constructor(private readonly service: TradesService) {}

  @Get()
  list(
    @Req() req: Request,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('filter') filter?: string,
  ) {
    return this.service.list(
      workspaceOf(req),
      Number(page ?? 1),
      Number(pageSize ?? 50),
      parseFilter(filter) as FilterSet,
    );
  }

  @Get(':id')
  get(@Req() req: Request, @Param('id') id: string) {
    return this.service.get(workspaceOf(req), id);
  }

  /** 单笔交易明细（含派生字段） */
  @Get(':id/detail')
  detail(@Req() req: Request, @Param('id') id: string) {
    return this.service.getDetail(workspaceOf(req), id);
  }

  @Post('import')
  import(
    @Req() req: Request,
    @Body()
    body: {
      csv: string;
      accountId?: string;
      exchange?: string;
      tzOffsetMinutes?: number;
    },
  ) {
    return this.service.importCsv(workspaceOf(req), body);
  }

  @Post()
  create(@Req() req: Request, @Body() body: Record<string, unknown>) {
    return this.service.createManual(workspaceOf(req), body);
  }

  /** 批量删除（须位于 :id 之前，否则会被 :id 路由捕获为 id="batch"） */
  @Delete('batch')
  batchRemove(@Req() req: Request, @Body() body: { ids: string[] }) {
    return this.service.batchRemove(workspaceOf(req), body.ids ?? []);
  }

  @Delete(':id')
  remove(@Req() req: Request, @Param('id') id: string) {
    return this.service.remove(workspaceOf(req), id);
  }

  /** 单笔更新（归档 / 标签 / 笔记 等） */
  @Patch(':id')
  update(@Req() req: Request, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    const patch: TradePatch = {};
    const boolFields = ['archived'] as const;
    const arrFields = ['tags', 'entryTags', 'exitTags', 'mistakes'] as const;
    const strFields = ['notes', 'strategyId', 'marketCondition'] as const;
    const numFields = ['confidence', 'stopLoss', 'takeProfit', 'risk', 'reward', 'rr'] as const;
    for (const f of boolFields) if (body[f] !== undefined) (patch as Record<string, unknown>)[f] = body[f];
    for (const f of arrFields) if (Array.isArray(body[f])) (patch as Record<string, unknown>)[f] = body[f];
    for (const f of strFields) if (body[f] !== undefined) (patch as Record<string, unknown>)[f] = body[f] ?? null;
    for (const f of numFields) if (body[f] !== undefined && body[f] !== null && body[f] !== '') (patch as Record<string, unknown>)[f] = Number(body[f]);
    return this.service.update(workspaceOf(req), id, patch);
  }

  /** 批量更新（归档切换 + 按名称合并标签/入场理由/出场理由） */
  @Post('batch-update')
  batchUpdate(
    @Req() req: Request,
    @Body() body: { ids: string[]; patch: BatchPatch },
  ) {
    return this.service.batchUpdate(workspaceOf(req), body.ids ?? [], body.patch ?? {});
  }
}

@Module({
  controllers: [TradesController],
  providers: [TradesService],
})
export class TradesModule {}
