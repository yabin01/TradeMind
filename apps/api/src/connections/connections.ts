import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  Injectable,
  Module,
  OnModuleInit,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { and, eq } from 'drizzle-orm';
import { accounts, connections as connectionsTable, trades as tradesTable } from '@trademind/database';
import { createTradeRepo } from '../common/trades-repo';
import { workspaceOf } from '../common/workspace';
import {
  fetchPositionsHistory,
  fetchSwapCtValMap,
  probePermissions,
  type OkxCredentials,
  type OkxPositionHistoryRow,
  type PermissionProbe,
} from './okx-client';
import {
  fetchClearinghouseState,
  fetchUserFills,
  isValidWalletAddress,
  probeHyperliquid,
  reconstructTradesFromFills,
  type HlTrade,
  type HyperliquidCredentials,
} from './hyperliquid-client';

export type ConnectionRow = typeof connectionsTable.$inferSelect;

/**
 * 对外输出时脱敏：不回传 secret/passphrase（OKX）也不回传明文地址之外的东西。
 * Hyperliquid 只需钱包地址，本身就是公开信息，这里同样只给掩码。
 */
function maskConnection(row: ConnectionRow) {
  if (row.exchange === 'HYPERLIQUID') {
    const cred = (row.credentials ?? {}) as Partial<HyperliquidCredentials>;
    const addr = typeof cred.walletAddress === 'string' ? cred.walletAddress : '';
    const masked = addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : null;
    return {
      ...row,
      credentials: {
        apiKeyMasked: masked,
        walletAddressMasked: masked,
        mode: '链上（只读）',
        kind: 'WALLET' as const,
      },
      permissions: (row.permissions as PermissionProbe | null) ?? null,
    };
  }
  const cred = (row.credentials ?? {}) as Partial<OkxCredentials>;
  return {
    ...row,
    credentials: {
      apiKeyMasked: cred.apiKey ? `${cred.apiKey.slice(0, 4)}****${cred.apiKey.slice(-4)}` : null,
      mode: cred.flag === '1' ? '模拟盘' : '实盘',
      kind: 'APIKEY' as const,
    },
    permissions: (row.permissions as PermissionProbe | null) ?? null,
  };
}

function toOkxCredentials(body: { credentials?: unknown }): OkxCredentials {
  const c = (body.credentials ?? {}) as Partial<OkxCredentials>;
  if (!c.apiKey || !c.secretKey || !c.passphrase) {
    throw new HttpException('缺少凭证：需要 apiKey / secretKey / passphrase', 400);
  }
  return {
    apiKey: c.apiKey,
    secretKey: c.secretKey,
    passphrase: c.passphrase,
    flag: c.flag === '1' ? '1' : '0',
  };
}

function toHlCredentials(body: { credentials?: unknown }): HyperliquidCredentials {
  const c = (body.credentials ?? {}) as Partial<HyperliquidCredentials> & { address?: string };
  const walletAddress = String(c.walletAddress ?? c.address ?? '').trim();
  if (!walletAddress) throw new HttpException('缺少凭证：需要 walletAddress（Hyperliquid 钱包地址）', 400);
  if (!isValidWalletAddress(walletAddress)) {
    throw new HttpException('钱包地址格式不正确，应为 0x 开头的 42 位十六进制地址', 400);
  }
  return { walletAddress };
}

const CLOSE_TYPE_LABEL: Record<string, string> = {
  '1': '部分平仓',
  '2': '全部平仓',
  '3': '强制平仓',
  '4': '部分强平',
  '5': 'ADL（未全平）',
  '6': 'ADL（全平）',
};

/**
 * OKX 仓位历史 -> UnifiedTrade 行。
 * 口径（与 GP/GL 基准一致）：
 *   grossPnl = pnl + settledPnl（价格盈亏）
 *   fees     = -fee - liqPenalty（fee 为负代表扣费；liqPenalty 为负代表罚金）
 *   funding  = -fundingFee（负值代表支付）
 *   netPnl   = realizedPnl（OKX 口径：pnl+fee+fundingFee+liqPenalty+settledPnl）
 * 恒等式 Net = GP - Fees - Funding 成立。
 */
function mapPosition(row: OkxPositionHistoryRow, workspaceId: string, accountId: string, ctValMap: Map<string, number>) {
  const ctVal = ctValMap.get(row.instId);
  const contracts = Number(row.closeTotalPos) || 0;
  const quantity = ctVal != null ? contracts * ctVal : contracts;
  const direction = (row.direction || row.posSide || 'net').toLowerCase();
  const closeType = CLOSE_TYPE_LABEL[row.type] ?? `平仓(type=${row.type})`;
  return {
    workspaceId,
    accountId,
    exchange: 'OKX',
    symbol: row.instId,
    side: direction === 'short' ? 'BUY' : 'SELL', // 平仓方向：空仓用买平，多仓用卖平
    positionSide: direction.toUpperCase(),
    entryPrice: Number(row.openAvgPx) || 0,
    exitPrice: Number(row.closeAvgPx) || 0,
    quantity,
    leverage: Math.round(Number(row.lever)) || 1,
    openTime: new Date(Number(row.cTime)),
    closeTime: new Date(Number(row.uTime)),
    grossPnl: Number(row.pnl) + Number(row.settledPnl || 0),
    fees: -Number(row.fee) - Number(row.liqPenalty || 0),
    funding: -Number(row.fundingFee),
    netPnl: Number(row.realizedPnl),
    // OKX 会复用 posId：每个 posId 下有多行，每行是一次独立平仓（往返交易）。
    // 因此去重键必须带上 uTime，否则同一 posId 的几十笔会被压成 1 笔。
    externalTradeId: `okx:pos:${row.posId}:${row.uTime}`,
    notes: row.type === '1' || row.type === '2' ? null : closeType,
    metadata: {
      source: 'okx:positions-history',
      posId: row.posId,
      closeType,
      pnlRatio: Number(row.pnlRatio) || 0,
      ctVal: ctVal ?? null,
      quantityUnit: ctVal != null ? 'base' : 'contracts',
      marginMode: row.mgnMode,
      marginCcy: row.ccy,
      okxRaw: row,
    },
  };
}

/** Hyperliquid 往返交易的外部去重键：用平仓那一笔的 tid（一旦平掉就永久稳定） */
function hlExternalId(t: HlTrade): string {
  return `hl:${t.coin}:${t.closeTid}`;
}

/**
 * Hyperliquid 往返交易 -> UnifiedTrade 行。
 * 口径：
 *   grossPnl = 该往返内 closedPnl 之和（HL 的 closedPnl 不含手续费，与 GP 一致）
 *   fees     = 进出场两端手续费之和（HL 的 fee 正数=支出、负数=返佣）
 *   funding  = 0（HL 成交明细不含资金费）
 *   netPnl   = grossPnl - fees
 */
function mapHlTrade(t: HlTrade, workspaceId: string, accountId: string) {
  return {
    workspaceId,
    accountId,
    exchange: 'HYPERLIQUID',
    symbol: t.coin,
    // 平仓方向：多仓卖出平，空仓买入平（与 OKX 映射口径一致）
    side: t.direction === 'LONG' ? 'SELL' : 'BUY',
    positionSide: t.direction,
    entryPrice: t.entryPrice,
    exitPrice: t.exitPrice,
    quantity: t.quantity,
    // HL 成交明细没有杠杆字段：中性取 1 并在 metadata 标注，避免误触发杠杆类规则
    leverage: 1,
    openTime: new Date(t.openTimeMs),
    closeTime: new Date(t.closeTimeMs),
    grossPnl: t.grossPnl,
    fees: t.fees,
    funding: t.funding,
    netPnl: t.netPnl,
    externalTradeId: hlExternalId(t),
    notes: null,
    metadata: {
      source: 'hyperliquid:fills',
      coin: t.coin,
      fillCount: t.fillCount,
      openTid: t.openTid,
      closeTid: t.closeTid,
      /** 首笔已是持仓态（平台只保留最近 10000 笔成交），入场价可能不完整 */
      partialEntry: t.partialEntry,
      leverageUnknown: true,
      fundingUnavailable: true,
      quantityUnit: 'base',
    },
  };
}

export class ConnectionsService {
  private repo = createTradeRepo();

  async list(workspaceId: string) {
    const rows = await this.repo.db
      .select()
      .from(connectionsTable)
      .where(eq(connectionsTable.workspaceId, workspaceId));
    return rows.map(maskConnection);
  }

  async create(workspaceId: string, body: { exchange: string; name: string; credentials?: unknown }) {
    const exchange = String(body.exchange ?? '').toUpperCase();
    if (exchange !== 'OKX' && exchange !== 'HYPERLIQUID') {
      throw new HttpException(`暂不支持 ${exchange}，当前支持 OKX / HYPERLIQUID`, 400);
    }
    if (!body.name?.trim()) throw new HttpException('请填写连接名称', 400);
    const credentials = exchange === 'HYPERLIQUID' ? toHlCredentials(body) : toOkxCredentials(body);
    const [row] = await this.repo.db
      .insert(connectionsTable)
      .values({
        workspaceId,
        exchange,
        name: body.name.trim(),
        status: 'CONNECTED',
        credentials,
      })
      .returning();
    return maskConnection(row);
  }

  /** 按账户确保存在（trades.accountId 必填；账户名取自连接名，改名时由 update 级联） */
  private async ensureAccount(
    workspaceId: string,
    connectionId: string,
    name: string,
    exchange: string,
    currency: string,
  ) {
    let [account] = await this.repo.db
      .select()
      .from(accounts)
      .where(and(eq(accounts.connectionId, connectionId), eq(accounts.workspaceId, workspaceId)));
    if (!account) {
      [account] = await this.repo.db
        .insert(accounts)
        .values({
          workspaceId,
          connectionId,
          name,
          exchange,
          type: 'PERPETUAL',
          currency,
        })
        .returning();
    }
    return account;
  }

  async sync(workspaceId: string, id: string, opts: { sinceDays?: number } = {}) {
    const [conn] = await this.repo.db
      .select()
      .from(connectionsTable)
      .where(and(eq(connectionsTable.id, id), eq(connectionsTable.workspaceId, workspaceId)));
    if (!conn) throw new HttpException('连接不存在', 404);

    if (conn.exchange === 'HYPERLIQUID') return this.syncHyperliquid(workspaceId, conn, opts);
    if (conn.exchange !== 'OKX') throw new HttpException(`暂不支持 ${conn.exchange} 同步`, 400);

    return this.syncOkx(workspaceId, conn);
  }

  /**
   * OKX 同步：USDT 永续已平仓仓位（positions-history，最近 3 个月）-> trades。
   * 去重：externalTradeId = okx:pos:{posId}:{uTime}。
   */
  private async syncOkx(workspaceId: string, conn: ConnectionRow) {
    const id = conn.id;
    await this.repo.db
      .update(connectionsTable)
      .set({ status: 'SYNCING' })
      .where(eq(connectionsTable.id, id));

    try {
      const cred = (conn.credentials ?? {}) as OkxCredentials;
      if (!cred.apiKey || !cred.secretKey || !cred.passphrase) {
        throw new Error('连接缺少完整凭证，请删除后重新绑定');
      }

      // 1. 确保账户存在（trades.accountId 必填）
      const account = await this.ensureAccount(workspaceId, id, conn.name, 'OKX', 'USDT');

      // 2. 合约面值表（张 -> 币）
      const ctValMap = await fetchSwapCtValMap();

      // 3. 拉取仓位历史
      const rows = await fetchPositionsHistory(cred, { instType: 'SWAP' });

      // 4. 清理旧版脏数据：早期版本用 okx:pos:{posId} 去重，导致同一 posId 的多笔被压成 1 笔。
      //    这些行会被本轮以「posId:uTime」粒度重新插入，因此删除不会丢数据。
      const repaired = await this.repo
        .sql`DELETE FROM trades WHERE account_id = ${account.id} AND external_trade_id ~ '^okx:pos:[0-9]+$' RETURNING id`;

      // 5. 去重入库
      const existing = await this.repo.existingExternalIds(workspaceId);
      const toInsert = rows
        .filter((r) => !existing.has(`okx:pos:${r.posId}:${r.uTime}`))
        .map((r) => mapPosition(r, workspaceId, account.id, ctValMap));
      if (toInsert.length > 0) {
        await this.repo.db.insert(tradesTable).values(toInsert).onConflictDoNothing();
      }

      const [row] = await this.repo.db
        .update(connectionsTable)
        .set({ status: 'SUCCESS', lastSyncAt: new Date() })
        .where(eq(connectionsTable.id, id))
        .returning();
      return {
        connection: maskConnection(row),
        fetched: rows.length,
        inserted: toInsert.length,
        skipped: rows.length - toInsert.length,
        repaired: repaired.count ?? 0, // 清理掉的旧版聚合脏数据
      };
    } catch (e) {
      await this.repo.db
        .update(connectionsTable)
        .set({ status: 'FAILED', lastError: e instanceof Error ? e.message : String(e) })
        .where(eq(connectionsTable.id, id));
      const msg = e instanceof Error ? e.message : String(e);
      throw new HttpException(`同步失败：${msg}`, 502);
    }
  }

  /**
   * Hyperliquid 同步：读取该地址的成交明细（公开只读，无需密钥），
   * 把逐笔成交**重建为往返交易**后入库。
   *
   * 去重：externalTradeId = hl:{coin}:{closeTid}（平仓那一笔的 tid 永久稳定）。
   * 每次同步都按「倒序自适应分页」拉取最新成交（平台只保留最近约 10000 笔），
   * 保证最新数据一定拿到、时间区间连续，重建结果稳定、不会重复。
   */
  private async syncHyperliquid(workspaceId: string, conn: ConnectionRow, opts: { sinceDays?: number }) {
    const id = conn.id;
    await this.repo.db
      .update(connectionsTable)
      .set({ status: 'SYNCING' })
      .where(eq(connectionsTable.id, id));

    try {
      const cred = (conn.credentials ?? {}) as HyperliquidCredentials;
      if (!cred.walletAddress || !isValidWalletAddress(cred.walletAddress)) {
        throw new Error('连接缺少有效的钱包地址，请删除后重新绑定');
      }

      const account = await this.ensureAccount(workspaceId, id, conn.name, 'HYPERLIQUID', 'USDC');

      // sinceDays 给了就按天数回看，否则一路取到平台保留上限
      const sinceMs =
        opts.sinceDays && opts.sinceDays > 0 ? Date.now() - opts.sinceDays * 86_400_000 : undefined;

      const { fills, truncated } = await fetchUserFills(cred.walletAddress, { sinceMs, maxPages: 10 });
      const trades = reconstructTradesFromFills(fills);

      const existing = await this.repo.existingExternalIds(workspaceId);
      const toInsert = trades
        .filter((t) => !existing.has(hlExternalId(t)))
        .map((t) => mapHlTrade(t, workspaceId, account.id));
      if (toInsert.length > 0) {
        await this.repo.db.insert(tradesTable).values(toInsert).onConflictDoNothing();
      }

      const [row] = await this.repo.db
        .update(connectionsTable)
        .set({ status: 'SUCCESS', lastSyncAt: new Date() })
        .where(eq(connectionsTable.id, id))
        .returning();

      const state = await fetchClearinghouseState(cred.walletAddress).catch(() => null);

      // 这批往返交易的时间跨度——链上账户的历史可能远早于前端默认的 90 天窗口，
      // 带上它前端才能提示「去筛选里切到全部时间」，避免同步完却看不到数据。
      const closeMs = trades.map((t) => t.closeTimeMs).filter((n) => Number.isFinite(n));
      const oldestCloseTime = closeMs.length > 0 ? new Date(Math.min(...closeMs)).toISOString() : null;
      const newestCloseTime = closeMs.length > 0 ? new Date(Math.max(...closeMs)).toISOString() : null;

      return {
        connection: maskConnection(row),
        fetched: trades.length,
        fills: fills.length,
        inserted: toInsert.length,
        skipped: trades.length - toInsert.length,
        openPositions: state?.assetPositions.length ?? 0,
        accountValue: state?.marginSummary?.accountValue ?? null,
        // 成交笔数超过本次分页容量时仍可正常入库，只是更早的历史未覆盖
        truncated,
        oldestCloseTime,
        newestCloseTime,
      };
    } catch (e) {
      await this.repo.db
        .update(connectionsTable)
        .set({ status: 'FAILED', lastError: e instanceof Error ? e.message : String(e) })
        .where(eq(connectionsTable.id, id));
      const msg = e instanceof Error ? e.message : String(e);
      throw new HttpException(`同步失败：${msg}`, 502);
    }
  }

  /**
   * 调度器专用：不抛异常，失败时把错误写进 lastError，保证下一轮继续重试。
   */
  async syncQuiet(workspaceId: string, id: string) {
    try {
      const result = await this.sync(workspaceId, id);
      return { ok: true as const, ...result };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      try {
        await this.repo.db
          .update(connectionsTable)
          .set({ status: 'FAILED', lastError: msg })
          .where(eq(connectionsTable.id, id));
      } catch {
        // 写错误失败不影响调度循环
      }
      return { ok: false as const, error: msg };
    }
  }

  /**
   * 只读校验：确认密钥可读取行情/账户，但**不能下单、不能提币**。
   * 结果写入 connections.permissions，前端据此展示安全徽标。
   */
  async validate(workspaceId: string, id: string) {
    const [conn] = await this.repo.db
      .select()
      .from(connectionsTable)
      .where(and(eq(connectionsTable.id, id), eq(connectionsTable.workspaceId, workspaceId)));
    if (!conn) throw new HttpException('连接不存在', 404);

    // Hyperliquid：读的是公开链上数据，天然只读，不存在下单/提币权限
    if (conn.exchange === 'HYPERLIQUID') {
      const cred = (conn.credentials ?? {}) as HyperliquidCredentials;
      if (!isValidWalletAddress(cred.walletAddress ?? '')) {
        throw new HttpException('连接缺少有效的钱包地址，请删除后重新绑定', 400);
      }
      const probe = await probeHyperliquid(cred.walletAddress);
      const checkedAt = new Date().toISOString();
      const result: PermissionProbe = probe.ok
        ? {
            readOnly: true,
            read: { ok: true },
            trade: { granted: false, msg: 'Hyperliquid 公开只读接口，不涉及交易权限' },
            withdraw: { granted: false, msg: 'Hyperliquid 只读地址，无法提币' },
            checkedAt,
          }
        : {
            readOnly: false,
            read: { ok: false, msg: probe.msg },
            trade: { granted: false },
            withdraw: { granted: false },
            checkedAt,
          };

      const [row] = await this.repo.db
        .update(connectionsTable)
        .set({ permissions: result })
        .where(eq(connectionsTable.id, id))
        .returning();

      const warnings: string[] = [];
      if (!probe.ok) warnings.push('读取失败，请确认钱包地址是否正确。');
      else warnings.push('仅使用公开链上数据，不需要也不应填入任何私钥/助记词。');

      return { connection: maskConnection(row), permissions: result, warnings, accountValue: probe.accountValue };
    }

    if (conn.exchange !== 'OKX') throw new HttpException(`暂不支持 ${conn.exchange} 校验`, 400);
    const cred = (conn.credentials ?? {}) as OkxCredentials;
    if (!cred.apiKey || !cred.secretKey || !cred.passphrase) {
      throw new HttpException('连接缺少完整凭证，请删除后重新绑定', 400);
    }

    let probe: PermissionProbe;
    try {
      probe = await probePermissions(cred);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new HttpException(`权限校验失败：${msg}`, 502);
    }

    const [row] = await this.repo.db
      .update(connectionsTable)
      .set({ permissions: probe })
      .where(eq(connectionsTable.id, id))
      .returning();

    const warnings: string[] = [];
    if (!probe.read.ok) warnings.push('读权限不可用，同步会失败，请检查密钥与 IP 白名单。');
    if (probe.trade.granted) warnings.push('⚠️ 该密钥具备交易权限，建议改为「只读」密钥以降低风险。');
    if (probe.withdraw.granted) warnings.push('🚨 该密钥具备提币权限，强烈建议立即更换为只读密钥！');

    return { connection: maskConnection(row), permissions: probe, warnings };
  }

  /**
   * 更新连接：自动同步开关 / 间隔 / 名称。
   * 改 name 时级联更新其下所有账户的 name（accounts 由同步时按连接名创建），
   * 保证顶栏「API 账户」选择器立即显示新名称。
   */
  async update(
    workspaceId: string,
    id: string,
    body: { name?: string; autoSync?: boolean; syncIntervalMin?: number },
  ) {
    const patch: Partial<typeof connectionsTable.$inferInsert> = {};
    if (body.name !== undefined) {
      const n = String(body.name).trim();
      if (!n) throw new HttpException('名称不能为空', 400);
      if (n.length > 60) throw new HttpException('名称不能超过 60 个字符', 400);
      patch.name = n;
    }
    if (body.autoSync !== undefined) patch.autoSync = body.autoSync;
    if (body.syncIntervalMin !== undefined) {
      const v = Math.round(Number(body.syncIntervalMin));
      if (!Number.isFinite(v) || v < 5 || v > 1440) {
        throw new HttpException('同步间隔需在 5 ~ 1440 分钟之间', 400);
      }
      patch.syncIntervalMin = v;
    }
    if (Object.keys(patch).length === 0) throw new HttpException('没有需要更新的字段', 400);
    const [row] = await this.repo.db
      .update(connectionsTable)
      .set(patch)
      .where(and(eq(connectionsTable.id, id), eq(connectionsTable.workspaceId, workspaceId)))
      .returning();
    if (!row) throw new HttpException('连接不存在', 404);
    // 级联：同步账户名（accounts.name 初始取自连接名，改名后保持一致）
    if (patch.name) {
      await this.repo.db
        .update(accounts)
        .set({ name: patch.name })
        .where(and(eq(accounts.connectionId, id), eq(accounts.workspaceId, workspaceId)));
    }
    return maskConnection(row);
  }

  /** 级联删除：连接同步的交易 -> 关联账户 -> 连接本身 */
  async remove(workspaceId: string, id: string) {
    const accs = await this.repo.db
      .select()
      .from(accounts)
      .where(and(eq(accounts.connectionId, id), eq(accounts.workspaceId, workspaceId)));
    for (const a of accs) {
      await this.repo.db.delete(tradesTable).where(eq(tradesTable.accountId, a.id));
    }
    await this.repo.db
      .delete(accounts)
      .where(and(eq(accounts.connectionId, id), eq(accounts.workspaceId, workspaceId)));
    await this.repo.db
      .delete(connectionsTable)
      .where(and(eq(connectionsTable.id, id), eq(connectionsTable.workspaceId, workspaceId)));
    return { deleted: true, removedTrades: accs.length > 0 ? 'cascade' : 0 };
  }
}

/**
 * 自动同步调度器：每 60 秒巡检一次，对开启 autoSync 且已超过间隔的连接触发增量同步。
 * 同步是幂等的（externalTradeId 去重），重复跑只会带来 inserted=0。
 * 用 DISABLE_AUTO_SYNC=1 可关闭。
 */
@Injectable()
export class SyncScheduler implements OnModuleInit {
  private repo = createTradeRepo();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private readonly connections: ConnectionsService) {}

  onModuleInit(): void {
    if (process.env.DISABLE_AUTO_SYNC === '1') {
      console.log('[sync-scheduler] 已通过 DISABLE_AUTO_SYNC 关闭');
      return;
    }
    this.timer = setInterval(() => void this.tick(), 60_000);
    console.log('[sync-scheduler] 自动同步调度器已启动（每 60s 巡检）');
  }

  async tick(): Promise<void> {
    if (this.running) return; // 上一轮还没跑完
    this.running = true;
    try {
      const rows = await this.repo.db
        .select()
        .from(connectionsTable)
        .where(eq(connectionsTable.autoSync, true));
      const now = Date.now();
      for (const c of rows) {
        const intervalMs = (c.syncIntervalMin ?? 15) * 60_000;
        const last = c.lastSyncAt ? new Date(c.lastSyncAt).getTime() : 0;
        if (now - last < intervalMs) continue;
        console.log(`[sync-scheduler] 触发同步 ${c.name} (${c.id})`);
        const r = await this.connections.syncQuiet(c.workspaceId, c.id);
        console.log(
          `[sync-scheduler] ${r.ok ? `完成：新增 ${r.inserted} 笔（拉取 ${r.fetched}）` : `失败：${r.error}`}`,
        );
      }
    } catch (e) {
      console.error('[sync-scheduler] 巡检异常', e instanceof Error ? e.message : e);
    } finally {
      this.running = false;
    }
  }
}

@Controller('connections')
export class ConnectionsController {
  constructor(private readonly service: ConnectionsService) {}

  @Get()
  list(@Req() req: Request) {
    return this.service.list(workspaceOf(req));
  }

  @Post()
  create(
    @Req() req: Request,
    @Body() body: { exchange: string; name: string; credentials?: unknown },
  ) {
    return this.service.create(workspaceOf(req), body);
  }

  /**
   * 触发同步：
   *  - OKX：永续已平仓仓位（positions-history，最近 3 个月）
   *  - HYPERLIQUID：成交明细重建往返交易（可用 sinceDays 限制回看天数）
   */
  @Post(':id/sync')
  sync(@Req() req: Request, @Param('id') id: string, @Body() body: { sinceDays?: number } = {}) {
    return this.service.sync(workspaceOf(req), id, body ?? {});
  }

  /** 只读权限校验：确认密钥可读但不可交易/提币 */
  @Post(':id/validate')
  validate(@Req() req: Request, @Param('id') id: string) {
    return this.service.validate(workspaceOf(req), id);
  }

  /** 更新连接：名称 / 自动同步开关 / 间隔（分钟） */
  @Patch(':id')
  update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: { name?: string; autoSync?: boolean; syncIntervalMin?: number },
  ) {
    return this.service.update(workspaceOf(req), id, body ?? {});
  }

  @Delete(':id')
  remove(@Req() req: Request, @Param('id') id: string) {
    return this.service.remove(workspaceOf(req), id);
  }
}

@Module({
  controllers: [ConnectionsController],
  providers: [ConnectionsService, SyncScheduler],
  exports: [ConnectionsService],
})
export class ConnectionsModule {}
