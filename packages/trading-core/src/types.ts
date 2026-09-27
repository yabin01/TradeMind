export type Exchange =
  | 'BINANCE'
  | 'BYBIT'
  | 'OKX'
  | 'HYPERLIQUID'
  | 'BITGET'
  | 'COINBASE'
  | 'KRAKEN'
  | 'MT4'
  | 'MT5'
  | 'TRADINGVIEW'
  | 'CSV'
  | 'MANUAL';

export type Side = 'BUY' | 'SELL';
export type PositionSide = 'LONG' | 'SHORT' | 'NET';
export type PositionType = 'SPOT' | 'MARGIN' | 'PERPETUAL' | 'FUTURES';
export type OrderType =
  | 'MARKET'
  | 'LIMIT'
  | 'STOP'
  | 'STOP_MARKET'
  | 'TAKE_PROFIT'
  | 'REDUCE_ONLY'
  | 'POST_ONLY';
export type OrderStatus =
  | 'NEW'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'CANCELED'
  | 'REJECTED'
  | 'EXPIRED';
export type Session = 'ASIA' | 'LONDON' | 'NEW_YORK' | 'OTHER';
export type Direction = 'LONG' | 'SHORT';

/**
 * 交易方向推导：合约持仓有明确 positionSide；现货/净持仓按 side 推导。
 */
export function tradeDirection(t: {
  positionSide: PositionSide;
  side: Side;
}): Direction {
  if (t.positionSide === 'NET') {
    return t.side === 'BUY' ? 'LONG' : 'SHORT';
  }
  return t.positionSide;
}

export const SESSION_LABELS: Record<Session, string> = {
  ASIA: 'Asia',
  LONDON: 'London',
  NEW_YORK: 'New York',
  OTHER: 'Other',
};

export const DOW_LABELS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;
