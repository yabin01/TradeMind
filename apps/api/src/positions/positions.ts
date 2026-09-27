import { Body, Controller, Get, HttpException, Module, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { and, eq } from 'drizzle-orm';
import {
  accounts as accountsTable,
  connections as connectionsTable,
  positionNotes,
} from '@trademind/database';
import { createTradeRepo } from '../common/trades-repo';
import { workspaceOf } from '../common/workspace';
import {
  fetchOpenPositions,
  fetchSwapCtValMap,
  type OkxCredentials,
} from '../connections/okx-client';
import {
  fetchClearinghouseState,
  isValidWalletAddress,
  type HyperliquidCredentials,
} from '../connections/hyperliquid-client';

/** 持仓标注（用户手动补充部分） */
export interface PositionAnnotation {
  entryTags: string[];
  tags: string[];
  notes: string | null;
  updatedAt: string | null;
}

/** 对外输出的实时持仓视图（交易所字段 + 标注合并） */
export interface PositionView {
  key: string;
  accountId: string;
  accountName: string;
  exchange: string;
  connectionId: string | null;
  symbol: string;
  /** 交易所原始持仓方向（LONG | SHORT | NET） */
  positionSide: string;
  /** 展示用方向：NET 模式按持仓张数正负推断多空 */
  direction: 'LONG' | 'SHORT';
  contracts: number;
  quantity: number;
  ctVal: number | null;
  quantityUnit: 'base' | 'contracts';
  avgPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  unrealizedPnlRatio: number;
  leverage: number;
  margin: number;
  liquidationPrice: number | null;
  notionalUsd: number;
  marginMode: string;
  adl: number;
  openedAt: string | null;
  updatedAt: string | null;
  annotation: PositionAnnotation;
}

export class PositionsService {
  private repo = createTradeRepo();

  /**
   * 实时持仓：对工作区内每个账户用其连接凭证调 OKX `/account/positions`，
   * 过滤空仓后合并 position_notes 里的用户标注返回。
   * 单个账户失败不影响其它账户（错误进 errors 数组）。
   */
  async list(workspaceId: string) {
    const accountRows = await this.repo.db
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

    const annRows = await this.repo.db
      .select()
      .from(positionNotes)
      .where(eq(positionNotes.workspaceId, workspaceId));
    const annMap = new Map(annRows.map((a) => [`${a.accountId}:${a.symbol}:${a.positionSide}`, a]));

    const ctValMap = await fetchSwapCtValMap();

    const positions: PositionView[] = [];
    const errors: { accountId: string; accountName: string; error: string }[] = [];

    for (const acc of accountRows) {
      const keyOf = (symbol: string, positionSide: string) => `${acc.id}:${symbol}:${positionSide}`;
      const annotationOf = (symbol: string, positionSide: string): PositionAnnotation => {
        const a = annMap.get(keyOf(symbol, positionSide));
        return {
          entryTags: (a?.entryTags as string[]) ?? [],
          tags: (a?.tags as string[]) ?? [],
          notes: a?.notes ?? null,
          updatedAt: a?.updatedAt ? a.updatedAt.toISOString() : null,
        };
      };

      try {
        // ---------- Hyperliquid：公开链上只读（只需钱包地址） ----------
        if (acc.exchange === 'HYPERLIQUID') {
          const cred = (acc.credentials ?? {}) as HyperliquidCredentials;
          if (!isValidWalletAddress(cred.walletAddress ?? '')) {
            errors.push({ accountId: acc.id, accountName: acc.name, error: '连接缺少有效钱包地址，请重新绑定' });
            continue;
          }
          const state = await fetchClearinghouseState(cred.walletAddress);
          for (const ap of state.assetPositions) {
            const p = ap.position;
            const signedSize = Number(p.szi) || 0;
            const size = Math.abs(signedSize);
            const direction: 'LONG' | 'SHORT' = signedSize >= 0 ? 'LONG' : 'SHORT';
            const positionValue = Number(p.positionValue) || 0;
            const leverageValue = Math.round(Number(p.leverage?.value)) || 1;
            const marginMode = p.leverage?.type === 'isolated' ? 'isolated' : 'cross';
            // HL 只给持仓名义价值，标记价由 名义价值 / 数量 反推
            const markPrice = size > 0 ? positionValue / size : 0;
            positions.push({
              key: keyOf(p.coin, direction),
              accountId: acc.id,
              accountName: acc.name,
              exchange: acc.exchange,
              connectionId: acc.connectionId,
              symbol: p.coin,
              positionSide: direction,
              direction,
              contracts: size,
              quantity: size,
              // HL 的 sz 本身就是币数量，无需合约面值换算
              ctVal: 1,
              quantityUnit: 'base',
              avgPrice: Number(p.entryPx) || 0,
              markPrice,
              unrealizedPnl: Number(p.unrealizedPnl) || 0,
              unrealizedPnlRatio: Number(p.returnOnEquity) || 0,
              leverage: leverageValue,
              margin: Number(p.marginUsed) || 0,
              liquidationPrice: p.liquidationPx ? Number(p.liquidationPx) : null,
              notionalUsd: positionValue,
              marginMode,
              adl: 0,
              // clearinghouseState 不提供开仓时间，留空由前端显示「—」
              openedAt: null,
              updatedAt: state.time ? new Date(state.time).toISOString() : null,
              annotation: annotationOf(p.coin, direction),
            });
          }
          continue;
        }

        // ---------- OKX：私有只读 API ----------
        const cred = (acc.credentials ?? {}) as OkxCredentials;
        if (!cred.apiKey || !cred.secretKey || !cred.passphrase) {
          errors.push({ accountId: acc.id, accountName: acc.name, error: '连接缺少凭证，请重新绑定' });
          continue;
        }
        const raw = await fetchOpenPositions(cred, { instType: 'SWAP' });
        for (const r of raw) {
          const posSide = (r.posSide || 'net').toUpperCase();
          const signedContracts = Number(r.pos) || 0;
          const contracts = Math.abs(signedContracts);
          const ctVal = ctValMap.get(r.instId) ?? null;
          const quantity = ctVal != null ? contracts * ctVal : contracts;
          const direction: 'LONG' | 'SHORT' =
            posSide === 'NET' ? (signedContracts >= 0 ? 'LONG' : 'SHORT') : posSide === 'SHORT' ? 'SHORT' : 'LONG';
          positions.push({
            key: keyOf(r.instId, posSide),
            accountId: acc.id,
            accountName: acc.name,
            exchange: acc.exchange,
            connectionId: acc.connectionId,
            symbol: r.instId,
            positionSide: posSide,
            direction,
            contracts,
            quantity,
            ctVal,
            quantityUnit: ctVal != null ? 'base' : 'contracts',
            avgPrice: Number(r.avgPx) || 0,
            markPrice: Number(r.markPx) || 0,
            unrealizedPnl: Number(r.upl) || 0,
            unrealizedPnlRatio: Number(r.uplRatio) || 0,
            leverage: Math.round(Number(r.lever)) || 1,
            margin: Number(r.margin) || 0,
            liquidationPrice: r.liqPx ? Number(r.liqPx) : null,
            notionalUsd: Number(r.notionalUsd) || 0,
            marginMode: r.mgnMode,
            adl: Number(r.adl) || 0,
            openedAt: r.cTime ? new Date(Number(r.cTime)).toISOString() : null,
            updatedAt: r.uTime ? new Date(Number(r.uTime)).toISOString() : null,
            annotation: annotationOf(r.instId, posSide),
          });
        }
      } catch (e) {
        errors.push({
          accountId: acc.id,
          accountName: acc.name,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    // 未实现盈亏绝对值大的排前面
    positions.sort((x, y) => Math.abs(y.unrealizedPnl) - Math.abs(x.unrealizedPnl));
    return { positions, errors, fetchedAt: new Date().toISOString() };
  }

  /** 写入/更新某持仓的标注（入场理由 / 标签 / 备注），键 = 账户 + 标的 + 持仓方向 */
  async saveAnnotation(
    workspaceId: string,
    body: {
      accountId?: string;
      symbol?: string;
      positionSide?: string;
      entryTags?: string[];
      tags?: string[];
      notes?: string | null;
    },
  ) {
    const accountId = String(body.accountId ?? '').trim();
    const symbol = String(body.symbol ?? '').trim();
    const positionSide = String(body.positionSide ?? '').trim().toUpperCase();
    if (!accountId || !symbol || !positionSide) {
      throw new HttpException('accountId / symbol / positionSide 必填', 400);
    }
    // 账户必须属于当前工作区，避免跨工作区写入
    const [acc] = await this.repo.db
      .select({ id: accountsTable.id })
      .from(accountsTable)
      .where(and(eq(accountsTable.id, accountId), eq(accountsTable.workspaceId, workspaceId)));
    if (!acc) throw new HttpException('账户不存在', 404);

    const entryTags = Array.isArray(body.entryTags) ? body.entryTags.map(String) : undefined;
    const tags = Array.isArray(body.tags) ? body.tags.map(String) : undefined;
    const notes = body.notes === undefined ? undefined : body.notes;

    const [row] = await this.repo.db
      .insert(positionNotes)
      .values({
        workspaceId,
        accountId,
        symbol,
        positionSide,
        entryTags: entryTags ?? [],
        tags: tags ?? [],
        notes: notes ?? null,
      })
      .onConflictDoUpdate({
        target: [positionNotes.workspaceId, positionNotes.accountId, positionNotes.symbol, positionNotes.positionSide],
        set: {
          ...(entryTags !== undefined ? { entryTags } : {}),
          ...(tags !== undefined ? { tags } : {}),
          ...(notes !== undefined ? { notes } : {}),
          updatedAt: new Date(),
        },
      })
      .returning();

    return {
      ...row,
      entryTags: (row.entryTags as string[]) ?? [],
      tags: (row.tags as string[]) ?? [],
    };
  }
}

@Controller('positions')
export class PositionsController {
  constructor(private readonly service: PositionsService) {}

  /** 当前实时持仓（OKX）+ 已保存的标注 */
  @Get()
  list(@Req() req: Request) {
    return this.service.list(workspaceOf(req));
  }

  /** 保存持仓标注（入场理由 / 标签 / 备注） */
  @Put('annotation')
  saveAnnotation(@Req() req: Request, @Body() body: Record<string, unknown>) {
    return this.service.saveAnnotation(workspaceOf(req), body ?? {});
  }
}

@Module({
  controllers: [PositionsController],
  providers: [PositionsService],
})
export class PositionsModule {}
