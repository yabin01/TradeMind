import { Module } from '@nestjs/common';
import { Controller, Get, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { FilterSet } from '@trademind/trading-core';
import type { UnifiedTrade } from '@trademind/trading-core';
import { eq } from 'drizzle-orm';
import { accounts as accountsTable, mistakes as mistakesTable, strategies as strategiesTable, tags as tagsTable, trades as tradesTable } from '@trademind/database';
import {
  aggregateByMistake,
  aggregateBySide,
  aggregateByStrategy,
  aggregateBySymbol,
  aggregateByTag,
  aggregateByTime,
  computeCalendar,
  computeDashboard,
  computeAdvancedMetrics,
  METRIC_META,
  type DimensionStats,
  type BucketStats,
  type DayStats,
  type DrawdownStats,
  type CoreMetrics,
  type MetricMeta,
} from '@trademind/analytics';
import { createTradeRepo } from '../common/trades-repo';
import { parseFilter, workspaceOf } from '../common/workspace';

type TimeKind = 'hour' | 'dayOfWeek' | 'day' | 'week' | 'month' | 'session' | 'duration';

export interface DashboardResponse {
  kpis: CoreMetrics;
  equity: DrawdownStats;
  daily: DayStats[];
  symbols: DimensionStats[];
  longShort: DimensionStats[];
  strategies: DimensionStats[];
  tags: DimensionStats[];
  mistakes: DimensionStats[];
  recentTrades: UnifiedTrade[];
}

export class AnalyticsService {
  private repo = createTradeRepo();

  private async ctx(workspaceId: string, filter: FilterSet) {
    const trades = await this.repo.loadTrades(workspaceId, filter);
    const strategies = await this.repo.db
      .select()
      .from(strategiesTable)
      .where(eq(strategiesTable.workspaceId, workspaceId));
    const nameOf = (id: string) => strategies.find((s) => s.id === id)?.name ?? id;
    const account = (
      await this.repo.db
        .select()
        .from(accountsTable)
        .where(eq(accountsTable.workspaceId, workspaceId))
    )[0];
    return { trades, nameOf, startingBalance: account?.startingBalance ?? 0 };
  }

  async dashboard(workspaceId: string, filter: FilterSet): Promise<DashboardResponse> {
    const { trades, nameOf, startingBalance } = await this.ctx(workspaceId, filter);
    return computeDashboard(trades, { startingBalance, strategyNameOf: nameOf });
  }

  /**
   * 高级指标（风险调整收益 / 连胜连亏 / 成本拖累 / 稳定性）。
   * 同时返回 METRIC_META，让前端能渲染「口径说明」，避免指标被误读。
   */
  async advanced(workspaceId: string, filter: FilterSet) {
    const { trades, startingBalance } = await this.ctx(workspaceId, filter);
    return {
      metrics: computeAdvancedMetrics(trades, { startingBalance }),
      meta: METRIC_META as MetricMeta[],
    };
  }

  async breakdown(workspaceId: string, filter: FilterSet, symbolOnly: boolean) {
    const { trades, nameOf } = await this.ctx(workspaceId, filter);
    if (symbolOnly) return { symbols: aggregateBySymbol(trades) };
    return {
      symbols: aggregateBySymbol(trades),
      longShort: aggregateBySide(trades),
      strategies: aggregateByStrategy(trades, nameOf),
      tags: aggregateByTag(trades),
      mistakes: aggregateByMistake(trades),
      hour: aggregateByTime(trades, 'hour'),
      dayOfWeek: aggregateByTime(trades, 'dayOfWeek'),
      session: aggregateByTime(trades, 'session'),
      duration: aggregateByTime(trades, 'duration'),
    };
  }

  async time(workspaceId: string, filter: FilterSet, kind: TimeKind) {
    const { trades } = await this.ctx(workspaceId, filter);
    const buckets: BucketStats[] = aggregateByTime(trades, kind);
    return { kind, buckets };
  }

  async calendar(workspaceId: string, filter: FilterSet) {
    const { trades } = await this.ctx(workspaceId, filter);
    return { days: computeCalendar(trades) };
  }

  async strategies(workspaceId: string, filter: FilterSet) {
    const { trades, nameOf } = await this.ctx(workspaceId, filter);
    const rows = await this.repo.db
      .select()
      .from(strategiesTable)
      .where(eq(strategiesTable.workspaceId, workspaceId));
    const stats = aggregateByStrategy(trades, nameOf);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      stats: stats.find((s) => s.key === r.name) ?? null,
    }));
  }

  /** 全局 Filter 可选项：策略 / 标签 / 错误 / 标的 / 账户 */
  async taxonomy(workspaceId: string) {
    const tagRows = await this.repo.db.select().from(tagsTable).where(eq(tagsTable.workspaceId, workspaceId));
    const mistakeRows = await this.repo.db
      .select()
      .from(mistakesTable)
      .where(eq(mistakesTable.workspaceId, workspaceId));
    const accountRows = await this.repo.db
      .select()
      .from(accountsTable)
      .where(eq(accountsTable.workspaceId, workspaceId));
    const strategyRows = await this.repo.db
      .select()
      .from(strategiesTable)
      .where(eq(strategiesTable.workspaceId, workspaceId));
    const tradeRows = await this.repo.db
      .select({ symbol: tradesTable.symbol })
      .from(tradesTable)
      .where(eq(tradesTable.workspaceId, workspaceId));
    return {
      tags: tagRows,
      mistakes: mistakeRows,
      accounts: accountRows,
      strategies: strategyRows,
      symbols: [...new Set(tradeRows.map((r) => r.symbol))],
    };
  }
}

@Controller()
export class AnalyticsController {
  constructor(private readonly service: AnalyticsService) {}

  @Get('dashboard')
  dashboard(@Req() req: Request, @Query('filter') filter?: string) {
    return this.service.dashboard(workspaceOf(req), parseFilter(filter) as FilterSet);
  }

  /** 高级指标 + 口径元数据 */
  @Get('analytics/advanced')
  advanced(@Req() req: Request, @Query('filter') filter?: string) {
    return this.service.advanced(workspaceOf(req), parseFilter(filter) as FilterSet);
  }

  @Get('analytics')
  breakdown(@Req() req: Request, @Query('filter') filter?: string) {
    return this.service.breakdown(workspaceOf(req), parseFilter(filter) as FilterSet, false);
  }

  @Get('analytics/time')
  time(
    @Req() req: Request,
    @Query('filter') filter?: string,
    @Query('kind') kind?: string,
  ) {
    const kinds: TimeKind[] = ['hour', 'dayOfWeek', 'day', 'week', 'month', 'session', 'duration'];
    const k = (kinds.includes(kind as TimeKind) ? kind : 'hour') as TimeKind;
    return this.service.time(workspaceOf(req), parseFilter(filter) as FilterSet, k);
  }

  @Get('analytics/symbol')
  symbol(@Req() req: Request, @Query('filter') filter?: string) {
    return this.service.breakdown(workspaceOf(req), parseFilter(filter) as FilterSet, true);
  }

  @Get('analytics/strategy')
  strategy(@Req() req: Request, @Query('filter') filter?: string) {
    return this.service.breakdown(workspaceOf(req), parseFilter(filter) as FilterSet, false);
  }

  @Get('calendar')
  calendar(@Req() req: Request, @Query('filter') filter?: string) {
    return this.service.calendar(workspaceOf(req), parseFilter(filter) as FilterSet);
  }

  @Get('strategies')
  strategies(@Req() req: Request, @Query('filter') filter?: string) {
    return this.service.strategies(workspaceOf(req), parseFilter(filter) as FilterSet);
  }

  @Get('taxonomy')
  taxonomy(@Req() req: Request) {
    return this.service.taxonomy(workspaceOf(req));
  }
}

@Module({
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
})
export class AnalyticsModule {}
