/**
 * Workspace 隔离（Phase 1 简化实现）：
 * 请求头 x-workspace-id 指定工作区，缺省用 demo 工作区。
 * Phase 2 换成 JWT + workspace 成员校验。
 */
export const DEMO_WORKSPACE_ID = '22222222-2222-2222-2222-222222222222';
export const DEMO_ACCOUNT_ID = '55555555-5555-5555-5555-555555555555';

export function workspaceOf(req: { headers: Record<string, unknown> }): string {
  const v = req.headers['x-workspace-id'];
  return typeof v === 'string' && v.length > 0 ? v : DEMO_WORKSPACE_ID;
}

export function parseFilter(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || raw === '') return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}
