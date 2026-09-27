import { randomUUID } from 'crypto';
import type { Exchange, PositionSide, Side } from './types';
import { tradeDirection } from './types';
import type { UnifiedTrade } from './models/trade';

/** 极简 CSV 解析：支持引号包裹、字段内逗号、转义引号、\r\n */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      field = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  row.push(field);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

/** 列名同义词映射（大小写不敏感，支持中英文） */
const HEADER_SYNONYMS: Record<string, string[]> = {
  symbol: ['symbol', 'pair', 'instrument', '合约', '交易对'],
  side: ['side', '方向'],
  positionSide: ['positionside', 'position side', '持仓方向'],
  entryPrice: ['entryprice', 'entry price', 'avgentryprice', 'entry', '开仓价', '开仓均价'],
  exitPrice: ['exitprice', 'exit price', 'avgexitprice', 'exit', '平仓价', '平仓均价'],
  quantity: ['quantity', 'qty', 'size', 'filledqty', '数量', '成交数量'],
  leverage: ['leverage', '杠杆'],
  stopLoss: ['stoploss', 'stop loss', 'sl', '止损'],
  takeProfit: ['takeprofit', 'take profit', 'tp', '止盈'],
  openTime: ['opentime', 'open time', 'entrytime', 'entry time', '开仓时间', 'time', 'date', '时间'],
  closeTime: ['closetime', 'close time', 'exittime', 'exit time', '平仓时间'],
  fees: ['fees', 'fee', 'commission', '手续费'],
  funding: ['funding', 'fundingfee', 'funding fee', '资金费'],
  grossPnl: ['grosspnl', 'gross pnl', 'pnl', 'realizedpnl', 'realized pnl', '盈亏', '已实现盈亏'],
  externalTradeId: ['externaltradeid', 'tradeid', 'id', 'orderid', '成交id'],
  strategy: ['strategy', '策略'],
  tags: ['tags', 'tag', '标签'],
  notes: ['notes', 'note', '备注'],
  marketCondition: ['marketcondition', '市场状态'],
  confidence: ['confidence', '信心'],
};

function matchHeader(name: string): string | null {
  const norm = name.trim().toLowerCase().replace(/[\s_-]/g, '');
  for (const [field, synonyms] of Object.entries(HEADER_SYNONYMS)) {
    if (synonyms.some((s) => s.replace(/[\s_-]/g, '') === norm)) return field;
  }
  return null;
}

export function toNumber(v: string | undefined): number | null {
  if (v === undefined || v === null) return null;
  const cleaned = v.trim().replace(/[$,%]/g, '');
  if (cleaned === '' || cleaned.toLowerCase() === 'null' || cleaned === '-') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** 时间解析：ISO8601 / epoch(ms|s) / "YYYY-MM-DD HH:mm:ss"（按 UTC 或指定偏移） */
export function toIsoTime(v: string | undefined, tzOffsetMinutes = 0): string | null {
  if (!v) return null;
  const s = v.trim();
  if (!s) return null;
  if (/^\d{10}$/.test(s)) return new Date(Number(s) * 1000).toISOString();
  if (/^\d{13}$/.test(s)) return new Date(Number(s)).toISOString();
  const normalized = s.includes('T') ? s : s.replace(' ', 'T');
  const withZone = /[Zz]|[+-]\d{2}:?\d{2}$/.test(normalized)
    ? normalized
    : `${normalized}${tzOffsetMinutes === 0 ? 'Z' : buildOffset(tzOffsetMinutes)}`;
  const d = new Date(withZone);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function buildOffset(minutes: number): string {
  const sign = minutes >= 0 ? '+' : '-';
  const abs = Math.abs(minutes);
  const h = String(Math.floor(abs / 60)).padStart(2, '0');
  const m = String(abs % 60).padStart(2, '0');
  return `${sign}${h}:${m}`;
}

export interface CsvImportOptions {
  workspaceId: string;
  accountId: string;
  exchange: Exchange;
  tzOffsetMinutes?: number;
}

export interface CsvImportResult {
  trades: UnifiedTrade[];
  errors: string[];
}

/**
 * 通用 CSV → UnifiedTrade。任何 Connector/手动导入都必须经过本归一化，
 * 再由 dedupeTrades 去重后入库。
 */
export function mapCsvToTrades(text: string, opts: CsvImportOptions): CsvImportResult {
  const rows = parseCsv(text);
  if (rows.length < 2) return { trades: [], errors: ['CSV 为空或缺少数据行'] };
  const header = rows[0];
  const colMap = new Map<number, string>();
  header.forEach((h, i) => {
    const field = matchHeader(h);
    if (field && !([...colMap.values()].includes(field))) colMap.set(i, field);
  });
  if (!([...colMap.values()].includes('symbol'))) {
    return { trades: [], errors: [`无法识别 symbol 列，表头: ${header.join(', ')}`] };
  }

  const tz = opts.tzOffsetMinutes ?? 0;
  const trades: UnifiedTrade[] = [];
  const errors: string[] = [];

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const get = (field: string): string | undefined => {
      for (const [i, f] of colMap) if (f === field) return row[i];
      return undefined;
    };
    try {
      const symbol = (get('symbol') ?? '').trim().toUpperCase();
      if (!symbol) {
        errors.push(`第 ${r + 1} 行: symbol 为空`);
        continue;
      }
      const sideRaw = (get('side') ?? 'BUY').trim().toUpperCase();
      const side: Side = sideRaw.includes('SELL') || sideRaw === 'SHORT' ? 'SELL' : 'BUY';
      const posRaw = (get('positionSide') ?? '').trim().toUpperCase();
      const positionSide: PositionSide =
        posRaw === 'LONG' || posRaw === 'SHORT'
          ? (posRaw as PositionSide)
          : 'NET';

      const entryPrice = toNumber(get('entryPrice')) ?? 0;
      const exitPrice = toNumber(get('exitPrice'));
      const quantity = toNumber(get('quantity')) ?? 0;
      const leverage = toNumber(get('leverage')) ?? 1;
      const fees = toNumber(get('fees')) ?? 0;
      const funding = toNumber(get('funding')) ?? 0;
      const grossPnlInput = toNumber(get('grossPnl'));

      // 毛利：优先用 CSV 提供值；否则由 entry/exit/qty 推导
      let grossPnl = grossPnlInput ?? 0;
      if (grossPnlInput === null && exitPrice !== null && entryPrice > 0 && quantity > 0) {
        const dir = tradeDirection({ positionSide, side }) === 'LONG' ? 1 : -1;
        grossPnl = (exitPrice - entryPrice) * quantity * dir;
      }
      const netPnl = grossPnl - fees - funding;

      const stopLoss = toNumber(get('stopLoss'));
      const takeProfit = toNumber(get('takeProfit'));
      let risk: number | null = null;
      let reward: number | null = null;
      let rr: number | null = null;
      if (stopLoss !== null && entryPrice > 0) {
        risk = Math.abs(entryPrice - stopLoss) * quantity;
        if (takeProfit !== null) {
          reward = Math.abs(takeProfit - entryPrice) * quantity;
          rr = risk > 0 ? reward / risk : null;
        }
      }

      const openTime = toIsoTime(get('openTime'), tz) ?? new Date().toISOString();
      const closeTime = toIsoTime(get('closeTime'), tz);

      const strategyName = get('strategy')?.trim() || null;
      const tags = (get('tags') ?? '')
        .split(/[;|,，]/)
        .map((t) => t.trim())
        .filter(Boolean);

      trades.push({
        id: randomUUID(),
        workspaceId: opts.workspaceId,
        accountId: opts.accountId,
        exchange: opts.exchange,
        symbol,
        side,
        positionSide,
        entryPrice,
        exitPrice,
        quantity,
        leverage,
        stopLoss,
        takeProfit,
        openTime,
        closeTime,
        grossPnl,
        fees,
        funding,
        netPnl,
        risk,
        reward,
        rr,
        strategyId: null, // 由入库层按名字解析
        strategyName,
        tags,
        mistakes: [],
        confidence: toNumber(get('confidence')),
        marketCondition: get('marketCondition')?.trim() || null,
        notes: get('notes')?.trim() || null,
        screenshots: [],
        externalTradeId: get('externalTradeId')?.trim() || null,
        metadata: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    } catch (e) {
      errors.push(`第 ${r + 1} 行解析失败: ${(e as Error).message}`);
    }
  }
  return { trades, errors };
}
