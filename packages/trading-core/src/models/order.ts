import type { Exchange, OrderStatus, OrderType, Side } from '../types';

export interface UnifiedOrder {
  orderId: string;
  workspaceId: string;
  accountId: string;
  tradeId: string | null;
  exchange: Exchange;
  symbol: string;
  side: Side;
  type: OrderType;
  price: number | null;
  quantity: number;
  status: OrderStatus;
  timestamp: string;
}

export interface UnifiedExecution {
  executionId: string;
  orderId: string;
  price: number;
  quantity: number;
  fee: number;
  timestamp: string;
}
