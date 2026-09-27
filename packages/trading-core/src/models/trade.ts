import type {
  Direction,
  Exchange,
  PositionSide,
  Side,
} from '../types';

/**
 * 统一交易模型 —— 所有 Connector（交易所 API / CSV / 手动）归一化后的唯一交易形态。
 * 金额字段统一以账户计价币（推荐 USDT）保存。
 */
export interface UnifiedTrade {
  id: string;
  workspaceId: string;
  accountId: string;
  exchange: Exchange;
  symbol: string;
  side: Side;
  positionSide: PositionSide;

  entryPrice: number;
  exitPrice: number | null; // 未平仓为 null
  quantity: number;
  leverage: number; // 现货 = 1

  stopLoss: number | null;
  takeProfit: number | null;

  openTime: string; // ISO8601 UTC
  closeTime: string | null;

  grossPnl: number;
  fees: number;
  funding: number;
  netPnl: number; // = grossPnl - fees - funding

  risk: number | null; // |entry - sl| * qty
  reward: number | null; // |tp - entry| * qty
  rr: number | null; // reward / risk

  strategyId: string | null;
  strategyName?: string | null;

  tags: string[];
  /** 入场理由标签（短标签名，非 id）——参考 TMM Entry Reasons */
  entryTags?: string[];
  /** 出场理由标签 */
  exitTags?: string[];
  /** 归档：true 时移出所有统计（Archive 分类），可随时恢复 */
  archived?: boolean;
  mistakes: string[];
  confidence: number | null;
  marketCondition: string | null;
  notes: string | null;
  screenshots: string[];

  externalTradeId: string | null;

  /** ChanLun 扩展（Phase 5） */
  chanlun?: {
    level: string;
    signal: string;
    macd: string | null;
    divergence: boolean | null;
  } | null;

  metadata: Record<string, unknown>;

  createdAt?: string;
  updatedAt?: string;
}

/** 已平仓交易（分析引擎只处理已平仓） */
export function isClosed(t: UnifiedTrade): boolean {
  return t.closeTime !== null && t.closeTime !== undefined;
}

export function tradeDurationMs(t: UnifiedTrade): number | null {
  if (!isClosed(t)) return null;
  return new Date(t.closeTime as string).getTime() - new Date(t.openTime).getTime();
}

export function tradeDirectionOf(t: UnifiedTrade): Direction {
  if (t.positionSide === 'NET') return t.side === 'BUY' ? 'LONG' : 'SHORT';
  return t.positionSide;
}
