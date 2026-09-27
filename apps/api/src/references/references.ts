import { Controller, Get, Module, Req } from '@nestjs/common';
import type { Request } from 'express';
import { and, eq } from 'drizzle-orm';
import {
  createDb,
  accounts as accountsTable,
  connections as connectionsTable,
  strategies as strategiesTable,
  tags as tagsTable,
  trades as tradesTable,
} from '@trademind/database';
import { workspaceOf } from '../common/workspace';

export interface ReferenceFacets {
  symbols: string[];
  exchanges: string[];
  strategies: { id: string; name: string }[];
  tags: { id: string; name: string }[];
  /** 交易所属账户（一个连接可对应多个账户），供顶栏「API 账户」筛选 */
  accounts: { id: string; name: string; exchange: string; connectionId: string | null; apiKeyMasked: string | null }[];
}

export class ReferencesService {
  private db = createDb().db;

  async strategies(workspaceId: string) {
    const rows = await this.db
      .select({ id: strategiesTable.id, name: strategiesTable.name })
      .from(strategiesTable)
      .where(eq(strategiesTable.workspaceId, workspaceId));
    return rows;
  }

  async tags(workspaceId: string) {
    const rows = await this.db
      .select({ id: tagsTable.id, name: tagsTable.name })
      .from(tagsTable)
      .where(eq(tagsTable.workspaceId, workspaceId));
    return rows;
  }

  /**
   * 筛选面板所需的全部候选值：标的 / 交易所（来自 trades 去重），策略 / 标签（来自各自表）。
   * 一次性返回，前端缓存即可。
   */
  async facets(workspaceId: string): Promise<ReferenceFacets> {
    const tradeRows = await this.db
      .select({ symbol: tradesTable.symbol, exchange: tradesTable.exchange })
      .from(tradesTable)
      .where(eq(tradesTable.workspaceId, workspaceId));

    const symbols = [...new Set(tradeRows.map((r) => r.symbol))].sort();
    const exchanges = [...new Set(tradeRows.map((r) => r.exchange))].sort();
    const strategies = await this.strategies(workspaceId);
    const tags = await this.tags(workspaceId);
    const accountRows = await this.db
      .select({
        id: accountsTable.id,
        name: accountsTable.name,
        exchange: accountsTable.exchange,
        connectionId: accountsTable.connectionId,
        credentials: connectionsTable.credentials,
      })
      .from(accountsTable)
      .leftJoin(connectionsTable, eq(accountsTable.connectionId, connectionsTable.id))
      .where(eq(accountsTable.workspaceId, workspaceId));
    const accounts = accountRows.map((r) => {
      // 数据库存的是原始凭证，这里按 connections 的规则只输出掩码（绝不外泄明文 key）
      const cred = (r.credentials ?? {}) as Record<string, unknown>;
      const key = typeof cred.apiKey === 'string' ? cred.apiKey : null;
      const wallet = typeof cred.walletAddress === 'string' ? cred.walletAddress : null;
      return {
        id: r.id,
        name: r.name,
        exchange: r.exchange,
        connectionId: r.connectionId,
        // Hyperliquid 没有 API Key，用掩码后的钱包地址区分（公开信息，仍不输出明文）
        apiKeyMasked: key
          ? `${key.slice(0, 4)}****${key.slice(-4)}`
          : wallet
            ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}`
            : null,
      };
    });
    return { symbols, exchanges, strategies, tags, accounts };
  }
}

@Controller('references')
export class ReferencesController {
  constructor(private readonly service: ReferencesService) {}

  @Get('strategies')
  strategies(@Req() req: Request) {
    return this.service.strategies(workspaceOf(req));
  }

  @Get('tags')
  tags(@Req() req: Request) {
    return this.service.tags(workspaceOf(req));
  }

  @Get('facets')
  facets(@Req() req: Request) {
    return this.service.facets(workspaceOf(req));
  }
}

@Module({
  controllers: [ReferencesController],
  providers: [ReferencesService],
})
export class ReferencesModule {}
