import type { PositionType, Side } from '../types';

export interface UnifiedPosition {
  positionId: string;
  workspaceId: string;
  accountId: string;
  symbol: string;
  side: Side;
  type: PositionType;
  entry: number;
  size: number;
  leverage: number;
  margin: number;
  liquidationPrice: number | null;
  unrealizedPnl: number;
  realizedPnl: number;
  openedAt: string;
  closedAt: string | null;
}
