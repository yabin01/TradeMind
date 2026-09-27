/**
 * analytics-worker：指标物化（daily/hourly metrics 重算）。
 * 由 trades:changed 事件触发；也可由定时任务全量重算。
 */
import { Worker } from 'bullmq';

const connection = { host: process.env.REDIS_HOST ?? '127.0.0.1', port: Number(process.env.REDIS_PORT ?? 6379) };

new Worker(
  'analytics',
  async (job) => {
    const { workspaceId, accountId } = job.data as { workspaceId: string; accountId: string };
    console.log(`[analytics-worker] recompute metrics for account ${accountId}`);
    // 复用 API 层 TradesService.recomputeMetrics 的逻辑（Phase 2 抽到 packages/analytics-io 共享）
    return { ok: true, workspaceId, accountId };
  },
  { connection, concurrency: 2 },
);

console.log('[analytics-worker] ready');
