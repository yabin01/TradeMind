import type { UnifiedTrade } from '@trademind/trading-core';

declare global {
  interface Window {
    /** 服务端在运行时注入的真实 API 端口（便携包会自动避让被占用的端口） */
    __TM_API_PORT__?: string | number;
  }
}

/**
 * API 根地址解析（本机 / 局域网 / 手机 / 便携包通用），按优先级：
 * 1. NEXT_PUBLIC_API_URL —— 反向代理把前后端放同一域名下时使用。
 * 2. window.__TM_API_PORT__ —— 服务端在**运行时**注入的真实端口。
 *    便携包启动器会自动避让 3000/4000 等被占用的端口，所以端口不能写死在构建产物里
 *    （NEXT_PUBLIC_* 会被 Next 在构建期内联成常量，改不动）。
 * 3. 跟随当前页面的 host + NEXT_PUBLIC_API_PORT（默认 4000）。
 *    这样手机用 http://192.168.x.x:3000 打开时，API 会自动指向 192.168.x.x:4000，
 *    而不是手机自己的 localhost（这是手机打不开的头号原因）。
 */
function resolveApiBase(): string {
  const configured = process.env.NEXT_PUBLIC_API_URL?.trim();
  if (configured) return configured.replace(/\/+$/, '');

  if (typeof window !== 'undefined') {
    const injected = window.__TM_API_PORT__;
    const port =
      injected !== undefined && injected !== null && String(injected).trim()
        ? String(injected).trim()
        : process.env.NEXT_PUBLIC_API_PORT?.trim() || '4000';
    return `${window.location.protocol}//${window.location.hostname}:${port}/api`;
  }

  // 服务端渲染：运行时环境变量优先（standalone 下不会被构建期内联）
  const port =
    process.env.TRADEMIND_API_PORT?.trim() ||
    process.env.NEXT_PUBLIC_API_PORT?.trim() ||
    '4000';
  return `http://localhost:${port}/api`;
}

// 延迟解析：确保首屏注入脚本已经执行完毕
let cachedApiBase: string | null = null;
function getApiBase(): string {
  if (cachedApiBase === null) cachedApiBase = resolveApiBase();
  return cachedApiBase;
}

export function getWorkspaceId(): string {
  if (typeof window === 'undefined') return '22222222-2222-2222-2222-222222222222';
  return localStorage.getItem('trademind-workspace') ?? '22222222-2222-2222-2222-222222222222';
}

export function setWorkspaceId(id: string): void {
  localStorage.setItem('trademind-workspace', id);
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${getApiBase()}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'x-workspace-id': getWorkspaceId(),
      ...(init?.headers ?? {}),
    },
    cache: 'no-store',
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export function filterQuery(filter: object): string {
  const hasAny = Object.values(filter).some(
    (v) => v !== null && v !== undefined && (!Array.isArray(v) || v.length > 0),
  );
  if (!hasAny) return '';
  return `?filter=${encodeURIComponent(JSON.stringify(filter))}`;
}

export interface TradeListResult {
  items: UnifiedTrade[];
  total: number;
  page: number;
  pageSize: number;
}

/** 拉取（可分页）交易列表 */
export function getTrades(filter: object, page = 1, pageSize = 50): Promise<TradeListResult> {
  return api<TradeListResult>(`/trades${filterQuery(filter)}&page=${page}&pageSize=${pageSize}`);
}

/** 单笔更新（归档 / 标签 / 笔记 等白名单字段） */
export function patchTrade(id: string, patch: Record<string, unknown>): Promise<unknown> {
  return api(`/trades/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
}

/** 批量更新：归档切换 + 按名称合并 标签/入场理由/出场理由 */
export function batchUpdateTrades(ids: string[], patch: Record<string, unknown>): Promise<{ updated: number }> {
  return api<{ updated: number }>(`/trades/batch-update`, {
    method: 'POST',
    body: JSON.stringify({ ids, patch }),
  });
}

/** 批量删除 */
export function batchDeleteTrades(ids: string[]): Promise<{ deleted: number }> {
  return api<{ deleted: number }>(`/trades/batch`, {
    method: 'DELETE',
    body: JSON.stringify({ ids }),
  });
}

/** 重命名连接（API 名称）；后端会级联更新其下账户名，顶栏选择器同步生效 */
export function renameConnection(id: string, name: string): Promise<unknown> {
  return api(`/connections/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) });
}

/** 实时持仓标注（用户补充部分） */
export interface PositionAnnotation {
  entryTags: string[];
  tags: string[];
  notes: string | null;
  updatedAt: string | null;
}

/** 实时持仓视图（交易所字段 + 标注） */
export interface PositionView {
  key: string;
  accountId: string;
  accountName: string;
  exchange: string;
  connectionId: string | null;
  symbol: string;
  positionSide: string;
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

export interface PositionsResult {
  positions: PositionView[];
  errors: { accountId: string; accountName: string; error: string }[];
  fetchedAt: string;
}

/** 拉取当前实时持仓（OKX）+ 已保存的标注 */
export function getPositions(): Promise<PositionsResult> {
  return api<PositionsResult>('/positions');
}

/** 保存某持仓的标注（入场理由 / 标签 / 备注） */
export function savePositionAnnotation(body: {
  accountId: string;
  symbol: string;
  positionSide: string;
  entryTags?: string[];
  tags?: string[];
  notes?: string | null;
}): Promise<unknown> {
  return api('/positions/annotation', { method: 'PUT', body: JSON.stringify(body) });
}

/** 筛选面板候选值：标的 / 交易所 / 策略 / 标签 */
export function getFacets(): Promise<{
  symbols: string[];
  exchanges: string[];
  strategies: { id: string; name: string }[];
  tags: { id: string; name: string }[];
  accounts: { id: string; name: string; exchange: string; connectionId: string | null; apiKeyMasked: string | null }[];
}> {
  return api('/references/facets');
}
